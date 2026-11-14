import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPaseoClient, type PaseoClient } from "@getpaseo/client";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { HostSummary } from "@getpaseo/protocol/hosts";
import type { SandboxHandle } from "microsandbox";
import {
  CREDENTIAL_ALLOWED_HOSTS,
  ERROR_LABEL,
  GUEST_IMAGE,
  GUEST_PATH,
  MICROSANDBOX_VERSION,
  PARENT_DAEMON_VERSION,
  PHASE_LABEL,
  PLUGIN_ID,
  REGISTRATION_PRODUCER_ID,
  REGISTRATION_SOURCE,
  sandboxName,
  type CredentialName,
  type Phase,
} from "../../shared/constants";
import {
  CLAUDE_CODE_VERSION,
  GH_VERSION,
  PROVISIONING_PI_VERSION,
  buildProvisionScript,
  canonicalizePlan,
  provisionStatusPath,
  requiredCredentialsForPlan,
  type CanonicalPlan,
  type LlmId,
} from "../../shared/provisioning";
import {
  secretsDeleteRpc,
  secretsListRpc,
  secretsSetRpc,
  vmCreateRpc,
  vmDeleteRpc,
  vmDetailRpc,
  vmListRpc,
  vmReconcileRpc,
  type SecretsListResult,
  type VmChild,
  type VmCreateResult,
  type VmDeleteResult,
  type VmDetailResult,
  type VmListResult,
  type VmReconcileResult,
} from "../../shared/contracts";
import { safeError } from "../../shared/errors";
import {
  allowedHostNames,
  connectDaemon,
  ensureDirectoryPlugin,
  findValuePaths,
  listManagedSandboxes,
  loadMicrosandbox,
  readGuestEnvironment,
  redact,
  REPO_ROOT,
  runGuest,
  secretEntries,
  waitFor,
  waitForPlugin,
  type MicrosandboxModule,
} from "./fixtures/harness";

const PARENT_URL = process.env.PASEO_PARENT_URL?.trim() ?? "";
const PARENT_PASSWORD = process.env.PASEO_PASSWORD?.trim() || undefined;
const RELEASE_ENABLED =
  process.env.PASEO_MSB_RELEASE_TEST === "1" || PARENT_URL.length > 0;

const CREATE_TIMEOUT_MS = 20 * 60_000;

const MODEL_CREDENTIALS: readonly CredentialName[] = [
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "NEURALWATT_API_KEY",
];

interface PlanCredential {
  readonly name: CredentialName;
  readonly value: string;
  readonly source: "store" | "environment";
}

let daemon: DaemonClient;
let paseo: PaseoClient;
let msb: MicrosandboxModule;
let parentId = "";
let installedByTest = false;
let requiredCredentials: readonly PlanCredential[] = [];
const storedByTest = new Set<CredentialName>();
let createdName = "";
let createdSandboxId = "";
let createdPlan: CanonicalPlan | null = null;
let staleRegistrationId = "";

/**
 * Every RPC output observed by the test. Inputs are deliberately not recorded
 * because `secrets.set` carries the value under test. The final assertion scans
 * the outputs, logs, and guest-visible state for that value.
 */
const observations: unknown[] = [];

async function rpc<T>(method: string, input: unknown = {}): Promise<T> {
  const output = (await daemon.invokePluginRpc(PLUGIN_ID, method, input)) as T;
  observations.push({ method, output });
  return output;
}

function credentialValues(): string[] {
  return requiredCredentials.map((credential) => credential.value);
}

function expectNoStoredValue(label: string, value: unknown): void {
  const text = JSON.stringify(value) ?? "";
  for (const credential of requiredCredentials) {
    if (credential.value.length === 0) continue;
    expect(
      text.includes(credential.value),
      `${label} exposed the ${credential.name} credential value`,
    ).toBe(false);
  }
}

function childPhase(child: VmChild | undefined): Phase | null {
  if (!child) return null;
  return child.kind === "sandbox" ? child.labels[PHASE_LABEL] : child.phase;
}

function planForCredentials(
  names: readonly CredentialName[],
  githubCli: boolean,
): CanonicalPlan {
  const piLlms: LlmId[] = [];
  const providers: CanonicalPlan["providers"] = [];

  for (const name of names) {
    switch (name) {
      case "CLAUDE_CODE_OAUTH_TOKEN":
        providers.push({ provider: "claude", llms: ["anthropic-oauth"] });
        break;
      case "ANTHROPIC_API_KEY":
        piLlms.push("anthropic-api-key");
        break;
      case "OPENAI_API_KEY":
        piLlms.push("openai-api-key");
        break;
      case "GEMINI_API_KEY":
        piLlms.push("gemini-api-key");
        break;
      case "NEURALWATT_API_KEY":
        piLlms.push("neuralwatt");
        break;
      case "GH_TOKEN":
        throw new Error("GH_TOKEN selects the GitHub CLI integration, not a provider");
    }
  }

  if (piLlms.length > 0) providers.push({ provider: "pi", llms: piLlms });
  return canonicalizePlan({
    providers,
    integrations: githubCli ? ["github-cli"] : [],
  });
}

function sandboxLabels(config: unknown): Record<string, string> {
  const labels = (config as { labels?: Record<string, string> } | null)?.labels;
  return labels ?? {};
}

interface ProvisionStatusFile {
  readonly planHash: string;
  readonly ok: boolean;
  readonly steps: readonly { id: string; status: string; exitCode: number | null }[];
  readonly failedStep: string | null;
  readonly error: string | null;
}

async function readProvisionStatus(handle: SandboxHandle): Promise<ProvisionStatusFile> {
  const text = await runGuest(handle, `cat ${provisionStatusPath()}`);
  return JSON.parse(text) as ProvisionStatusFile;
}

interface ProvisionFault {
  readonly step: string;
  readonly restore: () => Promise<void>;
}

/**
 * Makes one real provisioning step fail without touching product code. Claude
 * settings accept a deterministic corrupt file; the GitHub CLI step fails when
 * the binary is gone and its install directory is read-only.
 */
async function injectProvisionFailure(
  handle: SandboxHandle,
  plan: CanonicalPlan,
): Promise<ProvisionFault | null> {
  if (plan.providers.some((provider) => provider.provider === "claude")) {
    await runGuest(
      handle,
      "printf '%s' '{invalid-json' > /home/paseo/.claude/settings.json",
    );
    return {
      step: "claude-settings",
      restore: async () => {
        await runGuest(handle, "rm -f /home/paseo/.claude/settings.json");
      },
    };
  }

  if (plan.integrations.includes("github-cli")) {
    await runGuest(
      handle,
      "rm -f /home/paseo/.local/bin/gh && chmod 0500 /home/paseo/.local/bin",
    );
    return {
      step: "github-cli-install",
      restore: async () => {
        await runGuest(handle, "chmod 0755 /home/paseo/.local/bin");
      },
    };
  }

  return null;
}

function imageReference(config: unknown): string | null {
  const image = (config as { image?: unknown } | null)?.image;
  if (typeof image === "string") return image;
  if (typeof image === "object" && image !== null) {
    const oci = (image as { Oci?: { reference?: unknown } }).Oci;
    if (typeof oci?.reference === "string") return oci.reference;
  }
  return null;
}

async function sandboxesNamed(name: string) {
  const handles = await listManagedSandboxes(msb, parentId);
  return handles.filter((handle) => handle.name === name);
}

async function managedRegistrations(sandboxId: string): Promise<HostSummary[]> {
  const directory = await paseo.hosts.list();
  return directory.hosts.filter(
    (registration) =>
      registration.source?.id === REGISTRATION_PRODUCER_ID &&
      registration.source?.key === sandboxId,
  );
}

async function installJobs(name: string) {
  const handles = await sandboxesNamed(name);
  if (handles.length !== 1) return [];

  const jobs: {
    id: string;
    command: readonly string[];
    state: string;
    exitCode: number | null;
  }[] = [];
  let cursor: string | undefined;
  while (true) {
    const page = await handles[0].listJobsWith((builder) => {
      const configured = builder.all(true).limit(100);
      return cursor ? configured.cursor(cursor) : configured;
    });
    jobs.push(...page.items);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }

  return jobs.filter(
    (job) =>
      createdPlan !== null &&
      job.command.join(" ") === buildProvisionScript(createdPlan).argv.join(" "),
  );
}

describe.skipIf(!RELEASE_ENABLED)("vertical release test", () => {
  beforeAll(async () => {
    requiredCredentials = [];
    storedByTest.clear();

    if (PARENT_URL.length === 0) {
      throw new Error(
        "PASEO_PARENT_URL is required for the release test (for example ws://127.0.0.1:6780/ws)",
      );
    }

    daemon = await connectDaemon(
      PARENT_URL,
      `paseo-msb-release-daemon-${randomUUID()}`,
      PARENT_PASSWORD,
    );

    paseo = createPaseoClient({
      url: PARENT_URL,
      clientId: `paseo-msb-release-client-${randomUUID()}`,
      ...(PARENT_PASSWORD ? { password: PARENT_PASSWORD } : {}),
    });
    await paseo.connect();

    msb = await loadMicrosandbox();
    const msbPackage = JSON.parse(
      await readFile(path.join(REPO_ROOT, "node_modules/microsandbox/package.json"), "utf8"),
    ) as { version?: string };
    expect(
      msbPackage.version,
      "the release test must run on the pinned microsandbox SDK",
    ).toBe(MICROSANDBOX_VERSION);

    const status = await daemon.getDaemonStatus();
    expect(
      (status.version ?? "").includes(PARENT_DAEMON_VERSION),
      "the release test must run on the pinned parent daemon",
    ).toBe(true);

    const directory = await paseo.hosts.list();
    parentId = directory.self.serverId;

    const ensured = await ensureDirectoryPlugin(daemon, PLUGIN_ID, REPO_ROOT);
    installedByTest = ensured.installedByTest;

    const secrets = await rpc<SecretsListResult>(secretsListRpc.name, {});
    const requested = (process.env.PASEO_MSB_RELEASE_CREDENTIALS ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter((name) => name.length > 0);
    const envCredentialName = process.env.PASEO_MSB_RELEASE_ENV_CREDENTIAL?.trim() || null;
    const envCredentialValue = process.env.PASEO_MSB_RELEASE_ENV_VALUE ?? "";
    const githubCli = process.env.PASEO_MSB_RELEASE_GITHUB_CLI === "1";

    const envCredential = envCredentialName
      ? (secrets.secrets.find((entry) => entry.name === envCredentialName)?.name ?? null)
      : null;
    if (envCredentialName && !envCredential) {
      throw new Error(
        `PASEO_MSB_RELEASE_ENV_CREDENTIAL="${envCredentialName}" is not a fixed credential name`,
      );
    }
    if (envCredential && envCredentialValue.length === 0) {
      throw new Error(
        "PASEO_MSB_RELEASE_ENV_VALUE is required with PASEO_MSB_RELEASE_ENV_CREDENTIAL",
      );
    }

    let modelNames: CredentialName[];
    if (requested.length > 0) {
      for (const name of requested) {
        if (!MODEL_CREDENTIALS.includes(name as CredentialName)) {
          throw new Error(
            `PASEO_MSB_RELEASE_CREDENTIALS contains "${name}", which is not a model credential`,
          );
        }
      }
      modelNames = [...new Set(requested)] as CredentialName[];
    } else if (envCredential && MODEL_CREDENTIALS.includes(envCredential)) {
      modelNames = [envCredential];
    } else {
      const candidate = secrets.secrets.find(
        (entry) =>
          MODEL_CREDENTIALS.includes(entry.name) && !entry.stored && !entry.environment,
      );
      if (!candidate) {
        throw new Error(
          "the release test needs at least one unused model credential name; use an isolated PASEO_HOME",
        );
      }
      modelNames = [candidate.name];
    }

    createdPlan = planForCredentials(modelNames, githubCli);
    const planCredentialNames = requiredCredentialsForPlan(createdPlan);
    if (envCredential && !planCredentialNames.includes(envCredential)) {
      throw new Error(
        `PASEO_MSB_RELEASE_ENV_CREDENTIAL="${envCredential}" is not required by the selected plan`,
      );
    }

    for (const name of planCredentialNames) {
      const entry = secrets.secrets.find((candidate) => candidate.name === name);
      if (!entry) throw new Error(`the fixed credential ${name} is missing from secrets.list`);

      if (name === envCredential) {
        if (!entry.environment || entry.stored) {
          throw new Error(
            `${name} must come from the parent daemon environment and not the plugin store`,
          );
        }
        requiredCredentials = [
          ...requiredCredentials,
          { name, value: envCredentialValue, source: "environment" },
        ];
        continue;
      }

      if (entry.stored || entry.environment) {
        throw new Error(
          `${name} is already available; use an isolated PASEO_HOME and an unused credential name`,
        );
      }

      const value = `paseo-msb-release-${randomUUID()}`;
      await rpc(secretsSetRpc.name, { name, value });
      storedByTest.add(name);
      requiredCredentials = [
        ...requiredCredentials,
        { name, value, source: "store" },
      ];
    }

    const afterSet = await rpc<SecretsListResult>(secretsListRpc.name, {});
    for (const credential of requiredCredentials) {
      const entry = afterSet.secrets.find((candidate) => candidate.name === credential.name);
      expect(entry).toMatchObject(
        credential.source === "store"
          ? { stored: true }
          : { stored: false, environment: true },
      );
    }
    expectNoStoredValue("secrets.list", afterSet);

    const list = await rpc<VmListResult>(vmListRpc.name, {});
    expect(
      list.inventory.status === "available",
      `microsandbox inventory is unavailable: ${redact(
        JSON.stringify(list.inventory),
        credentialValues(),
      )}`,
    ).toBe(true);
    const requiredNames = requiredCredentials.map((credential) => credential.name);
    expect(list.credentials).toEqual(expect.arrayContaining(requiredNames));
    expect(list.storedCredentials).toEqual(
      expect.arrayContaining(
        requiredCredentials
          .filter((credential) => credential.source === "store")
          .map((credential) => credential.name),
      ),
    );
    for (const credential of requiredCredentials) {
      if (credential.source === "environment") {
        expect(list.storedCredentials).not.toContain(credential.name);
      }
    }
    expectNoStoredValue("vm.list", list);
  }, 180_000);

  it(
    "creates, reloads, fails, repairs, deletes, and never exposes a credential value",
    async () => {
      const plan = createdPlan;
      if (!plan) {
        throw new Error("the release test did not prepare a provisioning plan");
      }
      if (requiredCredentials.length === 0) {
        throw new Error("the release test did not prepare any credential");
      }

      const requestId = randomUUID();
      const name = sandboxName(requestId);
      createdName = name;

      // vm.create must return before host work. The sandbox does not exist yet.
      const createStartedAt = Date.now();
      const created = await rpc<VmCreateResult>(vmCreateRpc.name, {
        requestId,
        plan,
      });
      const createElapsedMs = Date.now() - createStartedAt;

      expect(created).toEqual({ name });
      expect(
        createElapsedMs,
        "vm.create must return before host-side creation",
      ).toBeLessThan(5_000);

      // Independent list/detail calls observe progress. Reload once while the
      // detached provision job is running, then let recovery finish the work.
      const phases = new Set<Phase>();
      const detailPhases = new Set<Phase>();
      let reloadedDuringInstall = false;
      let finalList: VmListResult | null = null;
      const deadline = Date.now() + CREATE_TIMEOUT_MS;

      while (Date.now() < deadline) {
        let list: VmListResult;
        try {
          list = await rpc<VmListResult>(vmListRpc.name, {});
        } catch {
          // The plugin process is briefly unavailable while reloading.
          await new Promise((resolve) => setTimeout(resolve, 500));
          continue;
        }

        const child = list.children.find((entry) => entry.name === name);
        const phase = childPhase(child);
        if (phase) phases.add(phase);

        if (phase && !detailPhases.has(phase)) {
          detailPhases.add(phase);
          const detail = await rpc<VmDetailResult>(vmDetailRpc.name, { name });
          expect(detail.child?.name).toBe(name);
          expectNoStoredValue(`vm.detail (${phase})`, detail);
        }

        if (child?.kind === "sandbox" && phase === "failed") {
          const code = child.labels[ERROR_LABEL] ?? "create_failed";
          throw new Error(
            redact(
              `child ${name} failed with ${code}: ${child.errorDetail ?? "no detail"}`,
              credentialValues(),
            ),
          );
        }

        if (child?.kind === "pending" && phase === "failed") {
          throw new Error(
            redact(
              `pending child ${name} failed with ${
                child.error?.code ?? "create_failed"
              }: ${child.errorDetail ?? "no detail"}`,
              credentialValues(),
            ),
          );
        }

        if (phase === "installing" && !reloadedDuringInstall) {
          reloadedDuringInstall = true;
          await daemon.reloadPlugin(PLUGIN_ID);
          await waitForPlugin(daemon, PLUGIN_ID);
        }

        if (
          child?.kind === "sandbox" &&
          phase === "ready" &&
          child.registration?.status === "online" &&
          child.registration.serverId
        ) {
          finalList = list;
          break;
        }

        expectNoStoredValue(`vm.list (${phase ?? "absent"})`, list);
        await new Promise((resolve) => setTimeout(resolve, 250));
      }

      if (!finalList) {
        throw new Error(
          `child ${name} did not reach ready and online before the deadline`,
        );
      }

      expect(phases.has("installing"), "installation phase was observed").toBe(
        true,
      );
      expect(
        reloadedDuringInstall,
        "the plugin was reloaded during installation",
      ).toBe(true);
      expect(detailPhases.size).toBeGreaterThanOrEqual(2);

      const child = finalList.children.find((entry) => entry.name === name);
      if (child?.kind !== "sandbox") {
        throw new Error(`child ${name} is not a sandbox after readiness`);
      }

      createdSandboxId = child.id;
      expect(child.registration?.status).toBe("online");
      const childServerId = child.registration?.serverId;
      expect(childServerId).toBeTruthy();

      // Reload must not have produced a second sandbox, job, or registration.
      const handles = await sandboxesNamed(name);
      expect(handles).toHaveLength(1);
      expect(handles[0].id).toBe(createdSandboxId);

      const config = handles[0].config();
      const labels = sandboxLabels(config);
      expect(labels["paseo-msb-id"]).toBeUndefined();
      expect(labels["paseo-msb-job"]).toBeUndefined();
      expect(labels[PHASE_LABEL]).toBe("ready");
      expect(
        imageReference(config),
        "the pinned guest image was not applied",
      ).toBe(GUEST_IMAGE);

      const jobs = await installJobs(name);
      expect(jobs, "exactly one provision job for this attempt").toHaveLength(1);
      expect(
        jobs.every((job) => job.state === "exited" && job.exitCode === 0),
        "the provision script did not complete successfully",
      ).toBe(true);

      const registrations = await managedRegistrations(createdSandboxId);
      expect(registrations).toHaveLength(1);
      expect(registrations[0].status).toBe("online");
      expect(registrations[0].source?.key).toBe(createdSandboxId);

      // The routed child reaches online and exposes the selected providers after a refresh.
      const remote = await paseo.hosts.client(childServerId as string);
      try {
        const refresh = await remote.providers.refresh();
        expect(refresh.acknowledged).toBe(true);

        const snapshot = await remote.providers.snapshot();
        for (const provider of plan.providers) {
          expect(
            snapshot.entries.find((entry) => entry.provider === provider.provider)?.status,
          ).toBe("ready");
        }
      } finally {
        await remote.dispose();
      }

      // Each selected provider and integration is at its pinned version.
      if (plan.providers.some((provider) => provider.provider === "pi")) {
        const piVersion = await runGuest(
          handles[0],
          `PATH=${GUEST_PATH} pi --version`,
        );
        expect(piVersion).toBe(PROVISIONING_PI_VERSION);
      }
      if (plan.providers.some((provider) => provider.provider === "claude")) {
        const claudeVersion = await runGuest(
          handles[0],
          `PATH=${GUEST_PATH} claude --version`,
        );
        expect(claudeVersion).toContain(CLAUDE_CODE_VERSION);
      }
      if (plan.integrations.includes("github-cli")) {
        const ghVersion = await runGuest(
          handles[0],
          `PATH=${GUEST_PATH} gh --version`,
        );
        expect(ghVersion).toContain(GH_VERSION);
      }

      // The content-addressed status file is the provisioning proof.
      const provision = buildProvisionScript(plan);
      const provisionStatus = JSON.parse(
        await runGuest(handles[0], `cat ${provisionStatusPath()}`),
      ) as {
        planHash: string;
        ok: boolean;
        steps: { id: string; status: string; exitCode: number | null }[];
        failedStep: string | null;
      };
      expect(provisionStatus).toMatchObject({
        planHash: provision.planHash,
        ok: true,
        failedStep: null,
      });
      expect(provisionStatus.steps.map((step) => step.id)).toEqual(
        provision.steps.map((step) => step.id),
      );
      for (const step of provisionStatus.steps) {
        expect(["ok", "skipped"]).toContain(step.status);
      }

      // Every selected credential reaches only its fixed microsandbox secret
      // entry, regardless of whether it came from the store or the environment.
      const secrets = secretEntries(config);
      for (const credential of requiredCredentials) {
        const secret = secrets.find((entry) => entry.envVar === credential.name);
        expect(secret, `the ${credential.name} secret entry is missing`).toBeDefined();
        if (!secret) continue;

        expect(
          secret.value === credential.value,
          `the ${credential.name} value did not reach the microsandbox secret entry`,
        ).toBe(true);
        expect(secret.placeholder).toBe(`$MSB_${credential.name}`);
        expect(allowedHostNames(secret)).toEqual([
          ...CREDENTIAL_ALLOWED_HOSTS[credential.name],
        ]);
        expect(secret.substitution?.headers).toBe(true);
        expect(secret.substitution?.query).toBe(false);
        expect(secret.substitution?.body).toBe(false);

        const valuePaths = findValuePaths(config, credential.value);
        expect(valuePaths.length).toBeGreaterThan(0);
        for (const location of valuePaths) {
          expect(
            location.includes(".network.secrets"),
            `${credential.name} leaked outside the secret entry at ${location}`,
          ).toBe(true);
          expect(
            location.endsWith(".value"),
            `${credential.name} leaked outside a secret value at ${location}`,
          ).toBe(true);
        }
      }

      // The guest sees only the placeholders, never the values.
      const guestValues = await readGuestEnvironment(
        handles[0],
        requiredCredentials.map((credential) => credential.name),
      );
      requiredCredentials.forEach((credential, index) => {
        expect(guestValues[index]).toBe(`$MSB_${credential.name}`);
      });

      // Raw microsandbox sandbox, job, and system logs are separate sinks that
      // redaction cannot rewrite after the fact; assert no value reached them.
      const rawSandboxLogs = await handles[0].logs({
        tail: 200,
        sources: ["stdout", "stderr", "output", "system"],
      });
      for (const entry of rawSandboxLogs) {
        for (const credential of requiredCredentials) {
          expect(entry.text()).not.toContain(credential.value);
        }
      }

      const installJob = await handles[0].getJob(jobs[0].id);
      const rawJobLogs = await installJob.logs({ tail: 200 });
      const logDecoder = new TextDecoder();
      for (const entry of rawJobLogs) {
        const text = logDecoder.decode(entry.data);
        for (const credential of requiredCredentials) {
          expect(text).not.toContain(credential.value);
        }
      }

      // Replacing and then removing each value must not disable redaction for
      // the creation-time value persisted in this VM's config.
      for (const credential of requiredCredentials) {
        const replacedValue = `paseo-msb-replaced-${randomUUID()}`;
        await rpc(secretsSetRpc.name, {
          name: credential.name,
          value: replacedValue,
        });
        storedByTest.add(credential.name);
        const afterReplace = await rpc<VmDetailResult>(vmDetailRpc.name, { name });
        expect(JSON.stringify(afterReplace)).not.toContain(credential.value);
        expect(JSON.stringify(afterReplace)).not.toContain(replacedValue);

        await rpc(secretsDeleteRpc.name, { name: credential.name });
        storedByTest.delete(credential.name);
        const afterCredentialRemoval = await rpc<VmDetailResult>(vmDetailRpc.name, {
          name,
        });
        expect(JSON.stringify(afterCredentialRemoval)).not.toContain(
          credential.value,
        );
        expect(JSON.stringify(afterCredentialRemoval)).not.toContain(replacedValue);
      }

      // Repair restores a missing registration without another VM.
      const originalRegistration = registrations[0];
      await paseo.hosts.remove(originalRegistration.registrationId);
      await waitFor(
        "the registration to disappear",
        async () => {
          const remaining = await managedRegistrations(createdSandboxId);
          return remaining.length === 0 ? true : null;
        },
        { timeoutMs: 30_000, secrets: credentialValues() },
      );

      const repaired = await rpc<VmReconcileResult>(vmReconcileRpc.name, {
        name,
      });
      expect(repaired.errors).toEqual([]);
      expect(repaired.repaired).toContain(name);

      const restored = await waitFor(
        "the registration to come back online",
        async () => {
          const entries = await managedRegistrations(createdSandboxId);
          const entry = entries.find(
            (candidate) => candidate.status === "online" && candidate.serverId,
          );
          return entry ?? null;
        },
        { timeoutMs: 180_000, secrets: credentialValues() },
      );
      expect(restored.metadata.name).toBe(name);
      expect(restored.source?.key).toBe(createdSandboxId);

      const afterRepair = await sandboxesNamed(name);
      expect(afterRepair).toHaveLength(1);
      expect(afterRepair[0].id).toBe(createdSandboxId);

      // Inject a real provisioning failure. It must be fatal, keep the sandbox,
      // and a retry must skip work that already completed.
      const fault = await injectProvisionFailure(handles[0], plan);
      if (fault) {
        const provision = buildProvisionScript(plan);
        await runGuest(handles[0], `rm -f ${provisionStatusPath()}`);
        const refreshed = await handles[0].refresh();
        await refreshed.modify({ labels: { [PHASE_LABEL]: "installing" } });

        const failedRepair = await rpc<VmReconcileResult>(vmReconcileRpc.name, { name });
        expect(failedRepair.errors).toEqual([
          {
            name,
            error: safeError(
              "provision_failed",
              `provisioning step ${fault.step} failed`,
            ),
          },
        ]);

        const failedStatus = await readProvisionStatus(handles[0]);
        expect(failedStatus).toMatchObject({
          planHash: provision.planHash,
          ok: false,
          failedStep: fault.step,
        });
        const completedBefore = failedStatus.steps
          .filter((step) => step.status === "ok" || step.status === "skipped")
          .map((step) => step.id);
        expect(completedBefore.length).toBeGreaterThan(0);

        const failedList = await rpc<VmListResult>(vmListRpc.name, {});
        const failedChild = failedList.children.find((entry) => entry.name === name);
        expect(failedChild?.kind).toBe("sandbox");
        if (failedChild?.kind === "sandbox") {
          expect(failedChild.id).toBe(createdSandboxId);
          expect(failedChild.labels[PHASE_LABEL]).toBe("installing");
          expect(failedChild.labels[ERROR_LABEL]).toBe("provision_failed");
          expect(failedChild.errorDetail).toContain(fault.step);
        }

        const keptSandboxes = await sandboxesNamed(name);
        expect(keptSandboxes).toHaveLength(1);
        expect(keptSandboxes[0].id).toBe(createdSandboxId);
        expect((await managedRegistrations(createdSandboxId))[0]?.status).toBe("online");

        await fault.restore();
        const retried = await rpc<VmReconcileResult>(vmReconcileRpc.name, { name });
        expect(retried.errors).toEqual([]);
        expect(retried.repaired).toContain(name);

        const retriedStatus = await readProvisionStatus(handles[0]);
        expect(retriedStatus).toMatchObject({
          planHash: provision.planHash,
          ok: true,
          failedStep: null,
        });
        for (const stepId of completedBefore) {
          expect(
            retriedStatus.steps.find((step) => step.id === stepId)?.status,
            `${stepId} ran again instead of being skipped`,
          ).toBe("skipped");
        }
        expect(
          retriedStatus.steps.find((step) => step.id === fault.step)?.status,
        ).toBe("ok");

        const afterRetry = await rpc<VmListResult>(vmListRpc.name, {});
        const retriedChild = afterRetry.children.find((entry) => entry.name === name);
        expect(retriedChild?.kind).toBe("sandbox");
        if (retriedChild?.kind === "sandbox") {
          expect(retriedChild.id).toBe(createdSandboxId);
          expect(retriedChild.labels[PHASE_LABEL]).toBe("ready");
          expect(retriedChild.labels[ERROR_LABEL]).toBeUndefined();
        }
      }

      // Repair removes a stale plugin-owned registration whose VM is gone.
      // The plugin must create the registration so its producer identity is
      // the real `plugin:paseo-msb`; a plain client would register as `owner`.
      // The stale child still needs every store-backed credential for this phase.
      for (const credential of requiredCredentials) {
        if (credential.source !== "store") continue;
        await rpc(secretsSetRpc.name, {
          name: credential.name,
          value: credential.value,
        });
        storedByTest.add(credential.name);
      }
      const staleRequestId = randomUUID();
      const staleName = sandboxName(staleRequestId);
      await rpc<VmCreateResult>(vmCreateRpc.name, {
        requestId: staleRequestId,
        plan,
      });

      const staleChild = await waitFor(
        "a second plugin-owned registration to reach online",
        async () => {
          const list = await rpc<VmListResult>(vmListRpc.name, {});
          const entry = list.children.find((candidate) => candidate.name === staleName);
          return entry?.kind === "sandbox" &&
            entry.labels[PHASE_LABEL] === "ready" &&
            entry.registration?.status === "online" &&
            entry.registration.serverId
            ? entry
            : null;
        },
        { timeoutMs: CREATE_TIMEOUT_MS, secrets: credentialValues() },
      );
      const staleSandboxId = staleChild.id;

      const staleRegistrations = await managedRegistrations(staleSandboxId);
      expect(staleRegistrations).toHaveLength(1);
      staleRegistrationId = staleRegistrations[0].registrationId;

      // Destroy the VM behind the plugin, leaving only its registration.
      const staleHandle = await msb.Sandbox.get(staleName);
      await staleHandle.destroy({ force: true, timeoutMs: 15_000 });
      await waitFor(
        "the orphaned sandbox to disappear from inventory",
        async () => {
          const remaining = await sandboxesNamed(staleName);
          return remaining.length === 0 ? true : null;
        },
        { timeoutMs: 60_000, secrets: credentialValues() },
      );

      const staleRepair = await rpc<VmReconcileResult>(vmReconcileRpc.name, {});
      expect(staleRepair.repaired).toContain(staleName);
      await waitFor(
        "the stale registration to be removed",
        async () => {
          const remaining = await managedRegistrations(staleSandboxId);
          return remaining.length === 0 ? true : null;
        },
        { timeoutMs: 30_000, secrets: credentialValues() },
      );

      const afterStale = await sandboxesNamed(name);
      expect(afterStale).toHaveLength(1);
      expect(afterStale[0].id).toBe(createdSandboxId);

      // The second child is done; remove the temporary store values again.
      for (const credential of requiredCredentials) {
        if (credential.source !== "store") continue;
        await rpc(secretsDeleteRpc.name, { name: credential.name });
        storedByTest.delete(credential.name);
      }

      // Delete removes exactly this sandbox and its registration.
      const deleted = await rpc<VmDeleteResult>(vmDeleteRpc.name, {
        name,
        id: createdSandboxId,
        confirmName: name,
      });
      expect(deleted).toEqual({ name, removed: true });

      await waitFor(
        "the sandbox to be removed",
        async () => {
          const remaining = await sandboxesNamed(name);
          return remaining.length === 0 ? true : null;
        },
        { timeoutMs: 60_000, secrets: credentialValues() },
      );

      await waitFor(
        "the registration to be removed",
        async () => {
          const remaining = await managedRegistrations(createdSandboxId);
          return remaining.length === 0 ? true : null;
        },
        { timeoutMs: 30_000, secrets: credentialValues() },
      );

      const stillExists = await msb.Sandbox.get(name)
        .then(() => true)
        .catch(() => false);
      expect(stillExists).toBe(false);

      // Repeated delete and Repair are safe and do not create anything.
      const repeated = await rpc<VmDeleteResult>(vmDeleteRpc.name, {
        name,
        id: createdSandboxId,
        confirmName: name,
      });
      expect(repeated).toEqual({ name, removed: true });

      const safeRepair = await rpc<VmReconcileResult>(vmReconcileRpc.name, {
        name,
      });
      expect(safeRepair.repaired).toEqual([]);
      expect(safeRepair.errors).toEqual([
        { name, error: safeError("not_found") },
      ]);

      const afterList = await rpc<VmListResult>(vmListRpc.name, {});
      expect(
        afterList.children.find((entry) => entry.name === name),
      ).toBeUndefined();

      // Nothing observed or logged may contain the stored value.
      for (const observation of observations) {
        expectNoStoredValue("RPC observations", observation);
      }

      const pluginLogs = await daemon.getPluginLogs(PLUGIN_ID);
      expectNoStoredValue("plugin logs", pluginLogs);
    },
    CREATE_TIMEOUT_MS,
  );

  afterAll(async () => {
    if (daemon && createdName && createdSandboxId) {
      await daemon
        .invokePluginRpc(PLUGIN_ID, vmDeleteRpc.name, {
          name: createdName,
          id: createdSandboxId,
          confirmName: createdName,
        })
        .catch(() => {});
    }

    if (msb && createdName) {
      const handle = await msb.Sandbox.get(createdName).catch(() => null);
      if (handle) {
        await handle.destroy({ force: true, timeoutMs: 15_000 }).catch(() => {});
      }
    }

    if (paseo) {
      try {
        const directory = await paseo.hosts.list();
        const owned = directory.hosts.filter(
          (registration) =>
            registration.metadata.source === REGISTRATION_SOURCE &&
            (registration.metadata.vm === createdSandboxId ||
              registration.registrationId === staleRegistrationId),
        );
        for (const registration of owned) {
          await paseo.hosts.remove(registration.registrationId).catch(() => {});
        }
      } catch {
        // The parent may already be closing.
      }
    }

    if (daemon) {
      for (const name of storedByTest) {
        await daemon
          .invokePluginRpc(PLUGIN_ID, secretsDeleteRpc.name, { name })
          .catch(() => {});
      }
    }

    if (daemon && installedByTest) {
      await daemon.removePlugin(PLUGIN_ID).catch(() => {});
    }

    if (paseo) await paseo.close().catch(() => {});
    if (daemon) await daemon.close().catch(() => {});
  }, 180_000);
});

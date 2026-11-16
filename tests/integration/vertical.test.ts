import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPaseoClient, type PaseoClient } from "@getpaseo/client";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { HostSummary } from "@getpaseo/protocol/hosts";
import type { SandboxHandle } from "microsandbox";
import { newGeneratedChildName } from "../../client/generated-name";
import {
  CREDENTIAL_ALLOWED_HOSTS,
  ERROR_LABEL,
  GUEST_IMAGE,
  GUEST_INIT_ARGS,
  GUEST_INIT_COMMAND,
  GUEST_PATH,
  GUEST_USER,
  MANAGED_LABEL,
  MICROSANDBOX_VERSION,
  PARENT_DAEMON_VERSION,
  PARENT_LABEL,
  PHASE_LABEL,
  PLAN_ENV_VAR,
  PLUGIN_ID,
  PLUGIN_VERSION,
  REGISTRATION_PRODUCER_ID,
  REGISTRATION_SOURCE,
  RESOURCES_ENV_VAR,
  RESOURCES_SPECIFIED_ENV_VAR,
  type CredentialName,
  type Phase,
} from "../../shared/constants";
import {
  CLAUDE_CODE_VERSION,
  GH_VERSION,
  PROVISIONING_PI_VERSION,
  PROVISIONING_STATE_DIR,
  buildProvisionScript,
  canonicalizePlan,
  provisionStatusPath,
  requiredCredentialsForPlan,
  type CanonicalPlan,
  type LlmId,
  type ProvisionScript,
} from "../../shared/provisioning";
import {
  secretsDeleteRpc,
  secretsListRpc,
  secretsSetRpc,
  vmCreateRpc,
  vmDeleteRpc,
  vmDetailRpc,
  vmDismissRpc,
  vmListRpc,
  vmReconcileRpc,
  type SecretsListResult,
  type VmChild,
  type VmCreateResult,
  type VmDeleteResult,
  type VmDetailResult,
  type VmListResult,
  type VmReconcileResult,
  type VmResources,
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

/** Every sandbox name the release suite created or discovered for cleanup. */
const trackedNames = new Set<string>();
/** Managed sandboxes by name, used for generation-exact cleanup. */
const managedSandboxes = new Map<string, string>();

function trackSandbox(name: string, id?: string): void {
  trackedNames.add(name);
  if (id) managedSandboxes.set(name, id);
}

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
 * settings accept a deterministic corrupt file; Pi and the GitHub CLI fail when
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

  if (plan.providers.some((provider) => provider.provider === "pi")) {
    await runGuest(
      handle,
      "rm -f /home/paseo/.local/bin/pi && chmod 0500 /home/paseo/.local/bin",
    );
    return {
      step: "pi-install",
      restore: async () => {
        await runGuest(handle, "chmod 0755 /home/paseo/.local/bin");
      },
    };
  }

  return null;
}

type SandboxChild = Extract<VmChild, { kind: "sandbox" }>;

/**
 * The release test reuses the same isolated store across its cases. The first
 * case exercises replace/remove, so later cases restore the creation-time
 * values before starting new lifecycle work.
 */
async function ensureStoredCredentials(): Promise<void> {
  for (const credential of requiredCredentials) {
    if (credential.source !== "store") continue;
    await rpc(secretsSetRpc.name, { name: credential.name, value: credential.value });
    storedByTest.add(credential.name);
  }
}

async function waitForReadySandbox(
  name: string,
  timeoutMs: number,
): Promise<{ readonly child: SandboxChild; readonly list: VmListResult }> {
  return waitFor(
    `child ${name} to reach ready and online`,
    async () => {
      const list = await rpc<VmListResult>(vmListRpc.name, {});
      const child = list.children.find((entry) => entry.name === name);
      return child?.kind === "sandbox" &&
        child.labels[PHASE_LABEL] === "ready" &&
        child.registration?.status === "online" &&
        child.registration.serverId
        ? { child, list }
        : null;
    },
    { timeoutMs, secrets: credentialValues() },
  );
}

/**
 * Verifies the complete credential boundary for one managed child: only the
 * fixed secret entry carries the value, the guest sees the placeholder, and no
 * raw microsandbox sink contains the value.
 */
async function assertManagedSecretBoundary(
  handle: SandboxHandle,
  label: string,
  options: { readonly jobId?: string } = {},
): Promise<void> {
  const refreshed = await handle.refresh();
  const config = refreshed.config();
  const secrets = secretEntries(config);

  for (const credential of requiredCredentials) {
    const secret = secrets.find((entry) => entry.envVar === credential.name);
    expect(secret, `${label}: the ${credential.name} secret entry is missing`).toBeDefined();
    if (!secret) continue;

    expect(
      secret.value === credential.value,
      `${label}: the ${credential.name} value did not reach the secret entry`,
    ).toBe(true);
    expect(secret.placeholder).toBe(`$MSB_${credential.name}`);
    expect(allowedHostNames(secret)).toEqual([
      ...CREDENTIAL_ALLOWED_HOSTS[credential.name],
    ]);
    expect(secret.substitution?.headers).toBe(true);
    expect(secret.substitution?.query).toBe(false);
    expect(secret.substitution?.body).toBe(false);

    const valuePaths = findValuePaths(config, credential.value);
    expect(
      valuePaths.length,
      `${label}: the ${credential.name} value is absent from the stored config`,
    ).toBeGreaterThan(0);
    for (const location of valuePaths) {
      expect(
        location.includes(".network.secrets"),
        `${label}: ${credential.name} leaked outside the secret entry at ${location}`,
      ).toBe(true);
      expect(
        location.endsWith(".value"),
        `${label}: ${credential.name} leaked outside a secret value at ${location}`,
      ).toBe(true);
    }
  }

  const guestValues = await readGuestEnvironment(
    refreshed,
    requiredCredentials.map((credential) => credential.name),
  );
  requiredCredentials.forEach((credential, index) => {
    expect(guestValues[index]).toBe(`$MSB_${credential.name}`);
  });

  const sandboxLogs = await refreshed.logs({
    tail: 200,
    sources: ["stdout", "stderr", "output", "system"],
  });
  for (const entry of sandboxLogs) {
    for (const credential of requiredCredentials) {
      expect(
        entry.text(),
        `${label}: raw sandbox logs exposed the ${credential.name} value`,
      ).not.toContain(credential.value);
    }
  }

  if (options.jobId) {
    const job = await refreshed.getJob(options.jobId);
    const logs = await job.logs({ tail: 200 });
    const decoder = new TextDecoder();
    for (const entry of logs) {
      const text = decoder.decode(entry.data);
      for (const credential of requiredCredentials) {
        expect(
          text,
          `${label}: raw job logs exposed the ${credential.name} value`,
        ).not.toContain(credential.value);
      }
    }
  }
}

/** Fails when any RPC output or plugin log since `start` carries a value. */
async function assertNoCanarySince(start: number): Promise<void> {
  for (const observation of observations.slice(start)) {
    expectNoStoredValue("RPC observations", observation);
  }
  const pluginLogs = await daemon.getPluginLogs(PLUGIN_ID);
  expectNoStoredValue("plugin logs", pluginLogs);
}

/** A different valid plan under the same name must be rejected. */
function alternativePlan(plan: CanonicalPlan): CanonicalPlan {
  return plan.providers.some((provider) => provider.provider === "pi")
    ? canonicalizePlan({
        providers: [{ provider: "claude", llms: ["anthropic-oauth"] }],
        integrations: [],
      })
    : canonicalizePlan({
        providers: [{ provider: "pi", llms: ["anthropic-api-key"] }],
        integrations: [],
      });
}

/**
 * Creates a real sandbox outside the plugin. Foreign fixtures carry no managed
 * labels; managed fixtures persist the plan so recovery can advance them.
 */
async function createFixtureSandbox(options: {
  readonly name: string;
  readonly managed: boolean;
  readonly plan?: CanonicalPlan;
  readonly phase?: Phase;
  /** Managed fixtures may persist the desired resource shape for joining. */
  readonly requestedResources?: VmResources;
  readonly resourcesSpecified?: boolean;
}): Promise<SandboxHandle> {
  let builder = msb.Sandbox.builder(options.name)
    .image(GUEST_IMAGE)
    .cpus(1)
    .memory(msb.MiB(1024))
    .detached(true)
    .init(GUEST_INIT_COMMAND, [...GUEST_INIT_ARGS]);

  if (options.managed) {
    if (!options.plan) throw new Error("a managed fixture needs a plan");
    builder = builder
      .labels({
        [MANAGED_LABEL]: PLUGIN_VERSION,
        [PARENT_LABEL]: parentId,
        [PHASE_LABEL]: options.phase ?? "installing",
      })
      .env("PATH", GUEST_PATH)
      .env(PLAN_ENV_VAR, JSON.stringify(options.plan));

    if (options.requestedResources) {
      builder = builder
        .env(RESOURCES_ENV_VAR, JSON.stringify(options.requestedResources))
        .env(RESOURCES_SPECIFIED_ENV_VAR, options.resourcesSpecified ? "1" : "0");
    }
  } else {
    builder = builder.labels({ "paseo-msb-fixture": "foreign" });
  }

  await builder.create();
  return msb.Sandbox.get(options.name);
}

/** Writes a harmless long-running script at the content-addressed path. */
async function materializeFakeProvisionScript(
  handle: SandboxHandle,
  provision: ProvisionScript,
): Promise<void> {
  await runGuest(
    handle,
    `mkdir -p ${PROVISIONING_STATE_DIR} && { printf '%s\\n' '#!/bin/sh' 'sleep 120'; } > ${provision.path} && chmod 700 ${provision.path}`,
  );
}

/** Launches two detached jobs with the exact provision argv. */
async function startFakeProvisionJobs(
  handle: SandboxHandle,
  provision: ProvisionScript,
): Promise<string[]> {
  const sandbox = await handle.connect();
  const first = await sandbox.execDetachedWith("/bin/sh", (builder) =>
    builder.args([provision.path, provision.planHash]).user(GUEST_USER),
  );
  const second = await sandbox.execDetachedWith("/bin/sh", (builder) =>
    builder.args([provision.path, provision.planHash]).user(GUEST_USER),
  );
  return [first.id, second.id];
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

      const name = newGeneratedChildName();
      createdName = name;

      // vm.create must return before host work. The sandbox does not exist yet.
      const createStartedAt = Date.now();
      const created = await rpc<VmCreateResult>(vmCreateRpc.name, {
        name,
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
      expect(fault, "every release plan must exercise provisioning fault injection").not.toBeNull();
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
        if (fault.step === "pi-install") {
          expect(completedBefore).toEqual([]);
        } else {
          expect(completedBefore.length).toBeGreaterThan(0);
        }

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
      const staleName = newGeneratedChildName();
      trackSandbox(staleName);
      await rpc<VmCreateResult>(vmCreateRpc.name, {
        name: staleName,
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
      trackSandbox(staleName, staleSandboxId);

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
    CREATE_TIMEOUT_MS * 2,
  );

  it(
    "serializes concurrent Create and Repair, repairs registration drift, and reloads after a deleting tombstone",
    async () => {
      const start = observations.length;
      const plan = createdPlan;
      if (!plan) throw new Error("the release test did not prepare a provisioning plan");
      if (requiredCredentials.length === 0) {
        throw new Error("the release test did not prepare any credential");
      }
      await ensureStoredCredentials();

      const name = newGeneratedChildName();
      trackSandbox(name);

      // Two identical Creates must join one attempt. A different plan for the
      // same name is rejected before any host-side work.
      const [first, second] = await Promise.all([
        rpc<VmCreateResult>(vmCreateRpc.name, { name, plan }),
        rpc<VmCreateResult>(vmCreateRpc.name, { name, plan }),
      ]);
      expect(first).toEqual({ name });
      expect(second).toEqual({ name });
      await expect(
        rpc<VmCreateResult>(vmCreateRpc.name, {
          name,
          plan: alternativePlan(plan),
        }),
      ).rejects.toThrow(safeError("invalid_request").message);

      // Repair enters the same per-name lane and must wait for Create rather
      // than advancing the child concurrently.
      const repairPromise = rpc<VmReconcileResult>(vmReconcileRpc.name, { name });

      const ready = await waitForReadySandbox(name, CREATE_TIMEOUT_MS);
      const sandboxId = ready.child.id;
      trackSandbox(name, sandboxId);
      expect(ready.child.plan).toEqual(plan);
      expect(ready.child.labels[PHASE_LABEL]).toBe("ready");

      const repair = await repairPromise;
      expect(repair.errors).toEqual([]);

      const handles = await sandboxesNamed(name);
      expect(handles).toHaveLength(1);
      expect(handles[0].id).toBe(sandboxId);

      const jobs = await installJobs(name);
      expect(jobs, "exactly one provision job for the concurrent attempt").toHaveLength(1);
      expect(
        jobs.every((job) => job.state === "exited" && job.exitCode === 0),
        "the concurrent provision script did not complete successfully",
      ).toBe(true);

      const registrations = await managedRegistrations(sandboxId);
      expect(registrations).toHaveLength(1);
      expect(registrations[0].status).toBe("online");
      expect(registrations[0].metadata.name).toBe(name);
      expect(registrations[0].source?.key).toBe(sandboxId);

      await assertManagedSecretBoundary(handles[0], "concurrent Create", {
        jobId: jobs[0].id,
      });

      // Configuration drift is repaired with one explicit update, never a
      // second registration for the same generation.
      const registration = registrations[0];
      const driftedName = `${name}-drift`;
      await paseo.hosts.update(registration.registrationId, {
        metadata: { source: REGISTRATION_SOURCE, name: driftedName },
      });
      await waitFor(
        "the drifted registration metadata",
        async () => {
          const entries = await managedRegistrations(sandboxId);
          return entries[0]?.metadata.name === driftedName ? true : null;
        },
        { timeoutMs: 30_000, secrets: credentialValues() },
      );

      const repaired = await rpc<VmReconcileResult>(vmReconcileRpc.name, { name });
      expect(repaired.errors).toEqual([]);
      expect(repaired.repaired).toContain(name);

      const restored = await managedRegistrations(sandboxId);
      expect(restored).toHaveLength(1);
      expect(restored[0].registrationId).toBe(registration.registrationId);
      expect(restored[0].metadata.name).toBe(name);
      expect(restored[0].status).toBe("online");
      expect(await sandboxesNamed(name)).toHaveLength(1);

      // Interrupt after the Delete tombstone but before destruction. A reload
      // must complete this exact generation's cleanup and never resume setup.
      const tombstoned = await msb.Sandbox.get(name);
      expect(tombstoned.id).toBe(sandboxId);
      await tombstoned.modify({ labels: { [PHASE_LABEL]: "deleting" } });
      await waitFor(
        "the deleting tombstone",
        async () => {
          const current = await msb.Sandbox.get(name).catch(() => null);
          if (!current) return null;
          const refreshed = await current.refresh();
          return sandboxLabels(refreshed.config())[PHASE_LABEL] === "deleting"
            ? true
            : null;
        },
        { timeoutMs: 30_000, secrets: credentialValues() },
      );

      await daemon.reloadPlugin(PLUGIN_ID);
      await waitForPlugin(daemon, PLUGIN_ID);
      await rpc<VmListResult>(vmListRpc.name, {});

      await waitFor(
        "the tombstoned sandbox to be destroyed after reload",
        async () => ((await sandboxesNamed(name)).length === 0 ? true : null),
        { timeoutMs: 180_000, secrets: credentialValues() },
      );
      await waitFor(
        "the exact generation registration to be removed after reload",
        async () => ((await managedRegistrations(sandboxId)).length === 0 ? true : null),
        { timeoutMs: 60_000, secrets: credentialValues() },
      );

      const after = await rpc<VmListResult>(vmListRpc.name, {});
      expect(after.children.find((entry) => entry.name === name)).toBeUndefined();
      expect(await sandboxesNamed(name)).toHaveLength(0);

      // Repair after deletion reports not_found and never recreates the child.
      const afterRepair = await rpc<VmReconcileResult>(vmReconcileRpc.name, { name });
      expect(afterRepair.repaired).toEqual([]);
      expect(afterRepair.errors).toEqual([{ name, error: safeError("not_found") }]);
      expect(await sandboxesNamed(name)).toHaveLength(0);

      await assertNoCanarySince(start);
    },
    CREATE_TIMEOUT_MS * 2,
  );

  it(
    "aborts an in-flight Create on Delete, recovers the recreated generation, and rejects a stale token",
    async () => {
      const start = observations.length;
      const plan = createdPlan;
      if (!plan) throw new Error("the release test did not prepare a provisioning plan");
      if (requiredCredentials.length === 0) {
        throw new Error("the release test did not prepare any credential");
      }
      await ensureStoredCredentials();

      const name = newGeneratedChildName();
      trackSandbox(name);

      await rpc<VmCreateResult>(vmCreateRpc.name, { name, plan });
      const firstHandle = await waitFor(
        "the first generation to appear",
        async () => {
          const handles = await sandboxesNamed(name);
          return handles.length === 1 ? handles[0] : null;
        },
        { timeoutMs: 180_000, secrets: credentialValues() },
      );
      const oldId = firstHandle.id;
      trackSandbox(name, oldId);

      // Delete while provisioning is the active work for this name. The lane
      // aborts Create, persists the tombstone, and destroys the exact handle.
      const deleted = await rpc<VmDeleteResult>(vmDeleteRpc.name, {
        name,
        id: oldId,
        confirmName: name,
      });
      expect(deleted).toEqual({ name, removed: true });

      await waitFor(
        "the cancelled generation to disappear",
        async () => ((await sandboxesNamed(name)).length === 0 ? true : null),
        { timeoutMs: 120_000, secrets: credentialValues() },
      );
      await waitFor(
        "the cancelled generation registration to disappear",
        async () => ((await managedRegistrations(oldId)).length === 0 ? true : null),
        { timeoutMs: 60_000, secrets: credentialValues() },
      );
      const afterDelete = await rpc<VmListResult>(vmListRpc.name, {});
      expect(afterDelete.children.find((entry) => entry.name === name)).toBeUndefined();

      // Reusing the name after its Delete left no sandbox or registration
      // creates a new generation rather than joining the old attempt.
      await rpc<VmCreateResult>(vmCreateRpc.name, { name, plan });
      const replacement = await waitFor(
        "the replacement generation to appear",
        async () => {
          const handles = await sandboxesNamed(name);
          return handles.length === 1 && handles[0].id !== oldId ? handles[0] : null;
        },
        { timeoutMs: 180_000, secrets: credentialValues() },
      );
      const newId = replacement.id;
      expect(newId).not.toBe(oldId);
      trackSandbox(name, newId);

      // Reload while the replacement is provisioning. Recovery and a queued
      // Repair must advance that same generation without a second VM or job.
      await daemon.reloadPlugin(PLUGIN_ID);
      await waitForPlugin(daemon, PLUGIN_ID);
      await rpc<VmListResult>(vmListRpc.name, {});
      const repairPromise = rpc<VmReconcileResult>(vmReconcileRpc.name, { name });

      const ready = await waitForReadySandbox(name, CREATE_TIMEOUT_MS);
      expect(ready.child.id).toBe(newId);
      const repair = await repairPromise;
      expect(repair.errors).toEqual([]);

      const survivors = await sandboxesNamed(name);
      expect(survivors).toHaveLength(1);
      expect(survivors[0].id).toBe(newId);

      const jobs = await installJobs(name);
      expect(jobs, "exactly one provision job for the replacement").toHaveLength(1);
      expect(
        jobs.every((job) => job.state === "exited" && job.exitCode === 0),
        "the recovered provision script did not complete successfully",
      ).toBe(true);

      const registrations = await managedRegistrations(newId);
      expect(registrations).toHaveLength(1);
      expect(registrations[0].status).toBe("online");
      expect(registrations[0].source?.key).toBe(newId);
      expect(await managedRegistrations(oldId)).toHaveLength(0);

      // The old generation token must never destroy a newer same-name VM.
      await expect(
        rpc<VmDeleteResult>(vmDeleteRpc.name, {
          name,
          id: oldId,
          confirmName: name,
        }),
      ).rejects.toThrow(safeError("id_mismatch").message);

      const stillThere = await rpc<VmListResult>(vmListRpc.name, {});
      const child = stillThere.children.find((entry) => entry.name === name);
      expect(child?.kind).toBe("sandbox");
      if (child?.kind === "sandbox") {
        expect(child.id).toBe(newId);
        expect(child.registration?.status).toBe("online");
      }
      expect((await sandboxesNamed(name))[0]?.id).toBe(newId);
      expect(await managedRegistrations(newId)).toHaveLength(1);

      // The current token removes exactly this generation.
      const removed = await rpc<VmDeleteResult>(vmDeleteRpc.name, {
        name,
        id: newId,
        confirmName: name,
      });
      expect(removed).toEqual({ name, removed: true });
      await waitFor(
        "the replacement to be removed",
        async () => ((await sandboxesNamed(name)).length === 0 ? true : null),
        { timeoutMs: 120_000, secrets: credentialValues() },
      );
      await waitFor(
        "the replacement registration to be removed",
        async () => ((await managedRegistrations(newId)).length === 0 ? true : null),
        { timeoutMs: 60_000, secrets: credentialValues() },
      );

      await assertNoCanarySince(start);
    },
    CREATE_TIMEOUT_MS * 2,
  );

  it(
    "completes a Delete tombstone and allocates a fresh generation",
    async () => {
      const start = observations.length;
      const plan = createdPlan;
      if (!plan) throw new Error("the release test did not prepare a provisioning plan");
      await ensureStoredCredentials();

      const name = newGeneratedChildName();
      trackSandbox(name);

      // A Delete that could not finish leaves the managed generation labelled
      // `deleting`. Its recorded shape matches, so Create completes that exact
      // cleanup and then allocates a replacement instead of reporting success
      // for cleanup alone.
      // The full suite has already let one-time plugin recovery settle, so this
      // Create is what drives the tombstone cleanup. A second tombstone is
      // covered by the unit suite instead of this release path.
      const tombstone = await createFixtureSandbox({
        name,
        managed: true,
        plan,
        phase: "deleting",
        requestedResources: { cpus: 2, memoryMib: 4096, diskMib: 10_240 },
        resourcesSpecified: true,
      });
      const oldId = tombstone.id;
      trackSandbox(name, oldId);

      const created = await rpc<VmCreateResult>(vmCreateRpc.name, {
        name,
        plan,
        resources: { memoryMib: 4096, diskMib: 10_240 },
      });
      expect(created).toEqual({ name });

      const ready = await waitForReadySandbox(name, CREATE_TIMEOUT_MS);
      expect(ready.child.id).not.toBe(oldId);
      trackSandbox(name, ready.child.id);

      const handles = await sandboxesNamed(name);
      expect(handles).toHaveLength(1);
      expect(handles[0]?.id).toBe(ready.child.id);
      expect(await managedRegistrations(oldId)).toHaveLength(0);

      await assertNoCanarySince(start);
    },
    CREATE_TIMEOUT_MS * 2,
  );

  it(
    "fails a Create safely when a foreign sandbox holds the name, without touching it",
    async () => {
      const start = observations.length;
      const plan = createdPlan;
      if (!plan) throw new Error("the release test did not prepare a provisioning plan");
      await ensureStoredCredentials();

      const name = newGeneratedChildName();
      trackSandbox(name);
      const foreign = await createFixtureSandbox({ name, managed: false });

      try {
        const foreignId = foreign.id;
        await rpc<VmCreateResult>(vmCreateRpc.name, { name, plan });

        const failed = await waitFor(
          "the pending Create to fail with name_conflict",
          async () => {
            const list = await rpc<VmListResult>(vmListRpc.name, {});
            const child = list.children.find((entry) => entry.name === name);
            return child?.kind === "pending" && child.error?.code === "name_conflict"
              ? child
              : null;
          },
          { timeoutMs: 120_000, secrets: credentialValues() },
        );
        expect(failed.phase).toBe("failed");
        expectNoStoredValue("pending name conflict", failed);

        // The foreign sandbox is not managed inventory, must not be relabelled,
        // and must still be the exact generation the fixture created.
        expect(await sandboxesNamed(name)).toHaveLength(0);
        const survivor = await msb.Sandbox.get(name);
        expect(survivor.id).toBe(foreignId);
        expect(sandboxLabels(survivor.config())[PHASE_LABEL]).toBeUndefined();
        expect(await managedRegistrations(foreignId)).toHaveLength(0);

        const detail = await rpc<VmDetailResult>(vmDetailRpc.name, { name });
        expect(detail.child?.kind).toBe("pending");
        expectNoStoredValue("pending detail", detail);
      } finally {
        await foreign.destroy({ force: true, timeoutMs: 15_000 }).catch(() => {});
        await waitFor(
          "the foreign sandbox to disappear",
          async () => {
            const current = await msb.Sandbox.get(name).catch(() => null);
            return current ? null : true;
          },
          { timeoutMs: 60_000, secrets: credentialValues() },
        );
      }

      // Dismiss clears only the volatile failed row, without touching the
      // foreign sandbox or requiring a plugin reload.
      await rpc(vmDismissRpc.name, { name });
      const cleared = await rpc<VmListResult>(vmListRpc.name, {});
      expect(cleared.children.find((entry) => entry.name === name)).toBeUndefined();

      await assertNoCanarySince(start);
    },
    10 * 60_000,
  );

  it(
    "refuses to launch a third provision job when two matching jobs are active",
    async () => {
      const start = observations.length;
      const plan = createdPlan;
      if (!plan) throw new Error("the release test did not prepare a provisioning plan");

      const name = newGeneratedChildName();
      trackSandbox(name);
      const fixture = await createFixtureSandbox({
        name,
        managed: true,
        plan,
        phase: "installing",
      });
      trackSandbox(name, fixture.id);

      try {
        const running = await waitFor(
          "the managed fixture sandbox to run",
          async () => {
            const refreshed = await fixture.refresh();
            return refreshed.status === "running" ? refreshed : null;
          },
          { timeoutMs: 180_000, secrets: credentialValues() },
        );

        const provision = buildProvisionScript(plan);
        await materializeFakeProvisionScript(running, provision);
        const jobIds = await startFakeProvisionJobs(running, provision);

        const active = await waitFor(
          "two matching provision jobs to become active",
          async () => {
            const jobs = await installJobs(name);
            const runningJobs = jobs.filter(
              (job) => job.state === "starting" || job.state === "running",
            );
            return runningJobs.length === 2 ? jobs : null;
          },
          { timeoutMs: 120_000, secrets: credentialValues() },
        );
        expect(new Set(active.map((job) => job.id))).toEqual(new Set(jobIds));

        const result = await rpc<VmReconcileResult>(vmReconcileRpc.name, { name });
        expect(result.repaired).toEqual([]);
        expect(result.errors).toEqual([
          { name, error: safeError("provision_conflict") },
        ]);

        const after = await installJobs(name);
        expect(after, "the reconciler must not launch a third job").toHaveLength(2);
        expect(new Set(after.map((job) => job.id))).toEqual(new Set(jobIds));

        const refreshed = await running.refresh();
        expect(sandboxLabels(refreshed.config())[PHASE_LABEL]).toBe("installing");
        expect(sandboxLabels(refreshed.config())[ERROR_LABEL]).toBe(
          "provision_conflict",
        );

        const detail = await rpc<VmDetailResult>(vmDetailRpc.name, { name });
        expect(detail.child?.kind).toBe("sandbox");
        if (detail.child?.kind === "sandbox") {
          expect(detail.child.labels[PHASE_LABEL]).toBe("installing");
          expect(detail.child.labels[ERROR_LABEL]).toBe("provision_conflict");
        }
        expectNoStoredValue("provision conflict detail", detail);
      } finally {
        await fixture.destroy({ force: true, timeoutMs: 15_000 }).catch(() => {});
        await waitFor(
          "the managed fixture sandbox to disappear",
          async () => {
            const current = await msb.Sandbox.get(name).catch(() => null);
            return current ? null : true;
          },
          { timeoutMs: 60_000, secrets: credentialValues() },
        );
      }

      await assertNoCanarySince(start);
    },
    15 * 60_000,
  );

  afterAll(async () => {
    const managed = new Map(managedSandboxes);
    if (createdName && createdSandboxId) managed.set(createdName, createdSandboxId);

    const names = new Set(trackedNames);
    if (createdName) names.add(createdName);

    if (daemon) {
      for (const [name, id] of managed) {
        await daemon
          .invokePluginRpc(PLUGIN_ID, vmDeleteRpc.name, {
            name,
            id,
            confirmName: name,
          })
          .catch(() => {});
      }
    }

    if (msb) {
      for (const name of names) {
        const handle = await msb.Sandbox.get(name).catch(() => null);
        if (handle) {
          await handle.destroy({ force: true, timeoutMs: 15_000 }).catch(() => {});
        }
      }
    }

    if (paseo) {
      try {
        const directory = await paseo.hosts.list();
        const managedIds = new Set(managed.values());
        const owned = directory.hosts.filter(
          (registration) =>
            registration.source?.id === REGISTRATION_PRODUCER_ID &&
            (names.has(registration.metadata.name) ||
              managedIds.has(registration.source?.key ?? "") ||
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

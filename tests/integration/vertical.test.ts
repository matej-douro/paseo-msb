import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPaseoClient, type PaseoClient } from "@getpaseo/client";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { HostSummary } from "@getpaseo/protocol/hosts";
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
  PROVISIONING_PI_VERSION,
  buildProvisionScript,
  type CanonicalPlan,
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

let daemon: DaemonClient;
let paseo: PaseoClient;
let msb: MicrosandboxModule;
let parentId = "";
let installedByTest = false;
let storedCredentialName: CredentialName | null = null;
let fakeCredentialValue = "";
let credentialWasStored = false;
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

function expectNoStoredValue(label: string, value: unknown): void {
  if (fakeCredentialValue.length === 0) return;
  const text = JSON.stringify(value) ?? "";
  expect(
    text.includes(fakeCredentialValue),
    `${label} exposed the stored credential value`,
  ).toBe(false);
}

function childPhase(child: VmChild | undefined): Phase | null {
  if (!child) return null;
  return child.kind === "sandbox" ? child.labels[PHASE_LABEL] : child.phase;
}

function planForCredential(name: CredentialName): CanonicalPlan {
  switch (name) {
    case "CLAUDE_CODE_OAUTH_TOKEN":
      return { providers: [{ provider: "claude", llms: ["anthropic-oauth"] }], integrations: [] };
    case "ANTHROPIC_API_KEY":
      return { providers: [{ provider: "pi", llms: ["anthropic-api-key"] }], integrations: [] };
    case "OPENAI_API_KEY":
      return { providers: [{ provider: "pi", llms: ["openai-api-key"] }], integrations: [] };
    case "GEMINI_API_KEY":
      return { providers: [{ provider: "pi", llms: ["gemini-api-key"] }], integrations: [] };
    case "NEURALWATT_API_KEY":
      return { providers: [{ provider: "pi", llms: ["neuralwatt"] }], integrations: [] };
    case "GH_TOKEN":
      throw new Error("the release test requires a model credential, not GH_TOKEN");
  }
}

function sandboxLabels(config: unknown): Record<string, string> {
  const labels = (config as { labels?: Record<string, string> } | null)?.labels;
  return labels ?? {};
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
    const modelCredentials: readonly CredentialName[] = [
      "ANTHROPIC_API_KEY",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "OPENAI_API_KEY",
      "GEMINI_API_KEY",
      "NEURALWATT_API_KEY",
    ];
    const candidate = secrets.secrets.find(
      (entry) => !entry.stored && modelCredentials.includes(entry.name),
    );
    if (!candidate) {
      throw new Error(
        "the release test needs at least one model credential name not already stored; use an isolated PASEO_HOME",
      );
    }

    storedCredentialName = candidate.name;
    fakeCredentialValue = `paseo-msb-release-${randomUUID()}`;

    await rpc(secretsSetRpc.name, {
      name: storedCredentialName,
      value: fakeCredentialValue,
    });
    credentialWasStored = true;

    const afterSet = await rpc<SecretsListResult>(secretsListRpc.name, {});
    expect(
      afterSet.secrets.find((entry) => entry.name === storedCredentialName),
    ).toMatchObject({ stored: true });
    expectNoStoredValue("secrets.list", afterSet);

    const list = await rpc<VmListResult>(vmListRpc.name, {});
    expect(
      list.inventory.status === "available",
      `microsandbox inventory is unavailable: ${redact(
        JSON.stringify(list.inventory),
        [fakeCredentialValue],
      )}`,
    ).toBe(true);
    expect(list.credentials).toContain(storedCredentialName);
    expect(list.storedCredentials).toContain(storedCredentialName);
    expectNoStoredValue("vm.list", list);
  }, 180_000);

  it(
    "creates, reloads, repairs, deletes, and never exposes the stored value",
    async () => {
      const credentialName = storedCredentialName;
      if (!credentialName) {
        throw new Error("the release test did not prepare a stored credential");
      }

      const requestId = randomUUID();
      const name = sandboxName(requestId);
      createdName = name;
      createdPlan = planForCredential(credentialName);

      // vm.create must return before host work. The sandbox does not exist yet.
      const createStartedAt = Date.now();
      const created = await rpc<VmCreateResult>(vmCreateRpc.name, {
        requestId,
        plan: createdPlan,
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
              [fakeCredentialValue],
            ),
          );
        }

        if (child?.kind === "pending" && phase === "failed") {
          throw new Error(
            redact(
              `pending child ${name} failed with ${
                child.error?.code ?? "create_failed"
              }: ${child.errorDetail ?? "no detail"}`,
              [fakeCredentialValue],
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
        for (const provider of createdPlan?.providers ?? []) {
          expect(
            snapshot.entries.find((entry) => entry.provider === provider.provider)?.status,
          ).toBe("ready");
        }
      } finally {
        await remote.dispose();
      }

      // Each selected provider is at its pinned version in the child.
      if (createdPlan?.providers.some((provider) => provider.provider === "pi")) {
        const piVersion = await runGuest(
          handles[0],
          `PATH=${GUEST_PATH} pi --version`,
        );
        expect(piVersion).toBe(PROVISIONING_PI_VERSION);
      }
      if (createdPlan?.providers.some((provider) => provider.provider === "claude")) {
        const claudeVersion = await runGuest(
          handles[0],
          `PATH=${GUEST_PATH} claude --version`,
        );
        expect(claudeVersion).toContain(CLAUDE_CODE_VERSION);
      }

      // The stored value reaches only the fixed microsandbox secret entry.
      const secrets = secretEntries(config);
      const secret = secrets.find(
        (entry) => entry.envVar === credentialName,
      );
      expect(secret).toBeDefined();
      if (!secret) throw new Error("the fixed secret entry is missing");

      expect(
        secret.value === fakeCredentialValue,
        "the stored value did not reach the microsandbox secret entry",
      ).toBe(true);
      expect(secret.placeholder).toBe(`$MSB_${credentialName}`);
      expect(allowedHostNames(secret)).toEqual([
        ...CREDENTIAL_ALLOWED_HOSTS[credentialName],
      ]);
      expect(secret.substitution?.headers).toBe(true);
      expect(secret.substitution?.query).toBe(false);
      expect(secret.substitution?.body).toBe(false);

      const valuePaths = findValuePaths(config, fakeCredentialValue);
      expect(valuePaths.length).toBeGreaterThan(0);
      for (const location of valuePaths) {
        expect(
          location.includes(".network.secrets"),
          `stored value leaked outside the secret entry at ${location}`,
        ).toBe(true);
        expect(
          location.endsWith(".value"),
          `stored value leaked outside a secret value at ${location}`,
        ).toBe(true);
      }

      // The guest sees only the placeholder, never the value.
      const guestValues = await readGuestEnvironment(handles[0], [
        credentialName,
      ]);
      expect(guestValues[0]).toBe(`$MSB_${credentialName}`);

      // Raw microsandbox sandbox, job, and system logs are separate sinks that
      // redaction cannot rewrite after the fact; assert the value never reached
      // them in the first place.
      const rawSandboxLogs = await handles[0].logs({
        tail: 200,
        sources: ["stdout", "stderr", "output", "system"],
      });
      for (const entry of rawSandboxLogs) {
        expect(entry.text()).not.toContain(fakeCredentialValue);
      }

      const installJob = await handles[0].getJob(jobs[0].id);
      const rawJobLogs = await installJob.logs({ tail: 200 });
      const logDecoder = new TextDecoder();
      for (const entry of rawJobLogs) {
        expect(logDecoder.decode(entry.data)).not.toContain(fakeCredentialValue);
      }

      // Replacing and then removing the store value must not disable redaction
      // for the creation-time value persisted in this VM's config.
      const replacedValue = `paseo-msb-replaced-${randomUUID()}`;
      await rpc(secretsSetRpc.name, { name: credentialName, value: replacedValue });
      const afterReplace = await rpc<VmDetailResult>(vmDetailRpc.name, { name });
      expect(JSON.stringify(afterReplace)).not.toContain(fakeCredentialValue);
      expect(JSON.stringify(afterReplace)).not.toContain(replacedValue);

      await rpc(secretsDeleteRpc.name, { name: credentialName });
      credentialWasStored = false;
      const afterCredentialRemoval = await rpc<VmDetailResult>(vmDetailRpc.name, {
        name,
      });
      expect(JSON.stringify(afterCredentialRemoval)).not.toContain(
        fakeCredentialValue,
      );

      // Repair restores a missing registration without another VM.
      const originalRegistration = registrations[0];
      await paseo.hosts.remove(originalRegistration.registrationId);
      await waitFor(
        "the registration to disappear",
        async () => {
          const remaining = await managedRegistrations(createdSandboxId);
          return remaining.length === 0 ? true : null;
        },
        { timeoutMs: 30_000, secrets: [fakeCredentialValue] },
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
        { timeoutMs: 180_000, secrets: [fakeCredentialValue] },
      );
      expect(restored.metadata.name).toBe(name);
      expect(restored.source?.key).toBe(createdSandboxId);

      const afterRepair = await sandboxesNamed(name);
      expect(afterRepair).toHaveLength(1);
      expect(afterRepair[0].id).toBe(createdSandboxId);

      // Repair removes a stale plugin-owned registration whose VM is gone.
      // The plugin must create the registration so its producer identity is
      // the real `plugin:paseo-msb`; a plain client would register as `owner`.
      // The stale child still needs the credential, so re-store it for this phase.
      await rpc(secretsSetRpc.name, { name: credentialName, value: fakeCredentialValue });
      credentialWasStored = true;
      const staleRequestId = randomUUID();
      const staleName = sandboxName(staleRequestId);
      await rpc<VmCreateResult>(vmCreateRpc.name, {
        requestId: staleRequestId,
        plan: createdPlan,
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
        { timeoutMs: CREATE_TIMEOUT_MS, secrets: [fakeCredentialValue] },
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
        { timeoutMs: 60_000, secrets: [fakeCredentialValue] },
      );

      const staleRepair = await rpc<VmReconcileResult>(vmReconcileRpc.name, {});
      expect(staleRepair.repaired).toContain(staleName);
      await waitFor(
        "the stale registration to be removed",
        async () => {
          const remaining = await managedRegistrations(staleSandboxId);
          return remaining.length === 0 ? true : null;
        },
        { timeoutMs: 30_000, secrets: [fakeCredentialValue] },
      );

      const afterStale = await sandboxesNamed(name);
      expect(afterStale).toHaveLength(1);
      expect(afterStale[0].id).toBe(createdSandboxId);

      // The second child is done; remove the temporary store value again.
      await rpc(secretsDeleteRpc.name, { name: credentialName });
      credentialWasStored = false;

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
        { timeoutMs: 60_000, secrets: [fakeCredentialValue] },
      );

      await waitFor(
        "the registration to be removed",
        async () => {
          const remaining = await managedRegistrations(createdSandboxId);
          return remaining.length === 0 ? true : null;
        },
        { timeoutMs: 30_000, secrets: [fakeCredentialValue] },
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

    if (daemon && storedCredentialName && credentialWasStored) {
      await daemon
        .invokePluginRpc(PLUGIN_ID, secretsDeleteRpc.name, {
          name: storedCredentialName,
        })
        .catch(() => {});
    }

    if (daemon && installedByTest) {
      await daemon.removePlugin(PLUGIN_ID).catch(() => {});
    }

    if (paseo) await paseo.close().catch(() => {});
    if (daemon) await daemon.close().catch(() => {});
  }, 180_000);
});

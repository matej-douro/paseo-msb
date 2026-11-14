import { describe, expect, it } from "vitest";
import {
  ERROR_LABEL,
  PHASE_LABEL,
  REGISTRATION_PRODUCER_ID,
  SANDBOX_ID_LABEL,
} from "../../shared/constants";
import { safeError } from "../../shared/errors";
import { buildProvisionScript, legacyPiPlan } from "../../shared/provisioning";
import { deleteVm } from "../../server/delete";
import { createLifecycleLanes, LifecycleAbortedError } from "../../server/lanes";
import { reconcileVm, type ReconcileVmContext } from "../../server/reconcile";
import {
  failingRuntime,
  fakeHostDirectory,
  fakeRegistration,
  fakeRuntime,
  fakeSandbox,
  FakePaseoHosts,
  FakeSandboxCreator,
  memorySecretsStore,
  PARENT_ID,
} from "./fake-runtime";

const NAME = "paseo-2f8f4c2e-8e52-4d0e-9db1-1a2b3c4d5e6f";
const INPUT = {};

function reconcileContext(
  runtime: ReconcileVmContext["runtime"],
  hosts: FakePaseoHosts,
  creator: FakeSandboxCreator = new FakeSandboxCreator(),
  overrides: Partial<ReconcileVmContext> = {},
): ReconcileVmContext {
  return {
    hosts,
    runtime,
    sandboxHost: creator,
    env: {},
    secretsStore: memorySecretsStore(),
    lanes: createLifecycleLanes(),
    timeoutMs: 100,
    pollMs: 1,
    installTimeoutMs: 100,
    ...overrides,
  };
}

function ownedRegistration(overrides: Parameters<typeof fakeRegistration>[0] = {}) {
  return fakeRegistration({
    registrationId: "reg_owned",
    label: `${PARENT_ID}/${NAME}`,
    source: { id: REGISTRATION_PRODUCER_ID, key: "sandbox_1" },
    metadata: { source: "paseo-msb", name: NAME },
    ...overrides,
  });
}

describe("reconcileVm", () => {
  it("restores a missing registration for a ready sandbox", async () => {
    const labels: Record<string, string>[] = [];
    const sandbox = fakeSandbox({
      id: "sandbox_1",
      name: NAME,
      phase: "ready",
      hostPort: 43_000,
      labelUpdates: labels,
    });
    const hosts = new FakePaseoHosts();

    const result = await reconcileVm(
      reconcileContext(fakeRuntime([sandbox]), hosts, new FakeSandboxCreator({ existing: sandbox })),
      INPUT,
    );

    expect(result).toEqual({ repaired: [NAME], errors: [] });
    expect(hosts.added).toHaveLength(1);
    expect(hosts.added[0].connection).toBe("127.0.0.1:43000");
    expect(hosts.added[0].metadata).toEqual({ source: "paseo-msb", name: NAME });
  });

  it("leaves a healthy ready sandbox alone", async () => {
    const sandbox = fakeSandbox({ id: "sandbox_1", name: NAME, phase: "ready" });
    const hosts = new FakePaseoHosts({
      directory: fakeHostDirectory([ownedRegistration()]),
    });

    const result = await reconcileVm(
      reconcileContext(fakeRuntime([sandbox]), hosts, new FakeSandboxCreator({ existing: sandbox })),
      INPUT,
    );

    expect(result).toEqual({ repaired: [], errors: [] });
    expect(hosts.added).toEqual([]);
    expect(hosts.removed).toEqual([]);
  });

  it("resumes an interrupted install from a successful provision status", async () => {
    const labels: Record<string, string>[] = [];
    const provision = buildProvisionScript(legacyPiPlan());
    const sandbox = fakeSandbox({
      id: "sandbox_1",
      name: NAME,
      phase: "installing",
      labelUpdates: labels,
      provisionStatus: {
        planHash: provision.planHash,
        ok: true,
        steps: [{ id: "pi-install", status: "ok", exitCode: 0 }],
        failedStep: null,
        error: null,
      },
    });
    const creator = new FakeSandboxCreator({ existing: sandbox });
    const hosts = new FakePaseoHosts();

    const result = await reconcileVm(
      reconcileContext(fakeRuntime([sandbox]), hosts, creator),
      INPUT,
    );

    expect(result).toEqual({ repaired: [NAME], errors: [] });
    expect(creator.createCount).toBe(0);
    expect(creator.execSpecs).toEqual([]);
    expect(hosts.added).toHaveLength(1);
    expect(sandbox.config()).toMatchObject({ labels: { [PHASE_LABEL]: "ready" } });
  });

  it("does not start a second install when job inventory is unavailable", async () => {
    const sandbox = fakeSandbox({
      id: "sandbox_1",
      name: NAME,
      phase: "installing",
      piInstalled: false,
      listJobsError: new Error("job inventory failed"),
    });
    const creator = new FakeSandboxCreator({ existing: sandbox });
    const hosts = new FakePaseoHosts();

    const result = await reconcileVm(
      reconcileContext(fakeRuntime([sandbox]), hosts, creator),
      INPUT,
    );

    expect(result.repaired).toEqual([]);
    expect(result.errors[0].error.code).toBe("job_inventory_unavailable");
    expect(creator.execSpecs).toEqual([]);
    expect(hosts.added).toEqual([]);
  });

  it("starts an install only when the complete inventory has no matching job", async () => {
    const sandbox = fakeSandbox({
      id: "sandbox_1",
      name: NAME,
      phase: "installing",
      piInstalled: false,
      jobs: [],
    });
    const creator = new FakeSandboxCreator({ existing: sandbox });
    const hosts = new FakePaseoHosts();

    await reconcileVm(reconcileContext(fakeRuntime([sandbox]), hosts, creator), INPUT);

    expect(creator.execSpecs).toHaveLength(1);
    expect(creator.execSpecs[0].command).toBe("/bin/sh");
    expect(creator.execSpecs[0].args[0]).toContain("/provision-");
  });

  it("rejects multiple active pinned installs", async () => {
    const sandbox = fakeSandbox({
      id: "sandbox_1",
      name: NAME,
      phase: "installing",
      piInstalled: false,
      jobs: [
        { id: "job_a", command: ["npm", "install", "-g", "--ignore-scripts", "--prefix", "/home/paseo/.local", "@earendil-works/pi-coding-agent@1.1.0"], state: "running" },
        { id: "job_b", command: ["npm", "install", "-g", "--ignore-scripts", "--prefix", "/home/paseo/.local", "@earendil-works/pi-coding-agent@1.1.0"], state: "starting" },
      ],
    });
    const creator = new FakeSandboxCreator({ existing: sandbox });
    const hosts = new FakePaseoHosts();

    const result = await reconcileVm(
      reconcileContext(fakeRuntime([sandbox]), hosts, creator),
      INPUT,
    );

    expect(result.errors[0].error.code).toBe("provision_conflict");
    expect(creator.execSpecs).toEqual([]);
  });

  it("reuses an existing registration instead of adding a duplicate", async () => {
    const labels: Record<string, string>[] = [];
    const sandbox = fakeSandbox({
      id: "sandbox_1",
      name: NAME,
      phase: "registering",
      labelUpdates: labels,
    });
    const hosts = new FakePaseoHosts({
      directory: fakeHostDirectory([ownedRegistration()]),
    });

    const result = await reconcileVm(
      reconcileContext(fakeRuntime([sandbox]), hosts, new FakeSandboxCreator({ existing: sandbox })),
      INPUT,
    );

    expect(result).toEqual({ repaired: [NAME], errors: [] });
    expect(hosts.added).toEqual([]);
    expect(hosts.removed).toEqual([]);
    expect(sandbox.config()).toMatchObject({ labels: { [PHASE_LABEL]: "ready" } });
  });

  it("removes a confirmed stale registration when the sandbox is absent", async () => {
    const hosts = new FakePaseoHosts({
      directory: fakeHostDirectory([
        ownedRegistration({ metadata: { source: "paseo-msb", name: NAME } }),
      ]),
    });

    const result = await reconcileVm(reconcileContext(fakeRuntime([]), hosts), INPUT);

    expect(result).toEqual({ repaired: [NAME], errors: [] });
    expect(hosts.removed).toEqual(["reg_owned"]);
  });

  it("repairs a registration pointing at a stale connection", async () => {
    const sandbox = fakeSandbox({
      id: "sandbox_1",
      name: NAME,
      phase: "ready",
      hostPort: 42_000,
    });
    const hosts = new FakePaseoHosts({
      directory: fakeHostDirectory([ownedRegistration()]),
    });

    await reconcileVm(
      reconcileContext(fakeRuntime([sandbox]), hosts, new FakeSandboxCreator({ existing: sandbox })),
      INPUT,
    );

    expect(hosts.updated[0]?.patch).toEqual({ connection: "127.0.0.1:42000" });
  });

  it("revalidates runtime absence before removing a stale registration", async () => {
    const reappeared = fakeSandbox({ id: "sandbox_1", name: NAME, phase: "ready" });
    const hosts = new FakePaseoHosts({
      directory: fakeHostDirectory([ownedRegistration()]),
    });
    const creator = new FakeSandboxCreator({
      findSequence: [null, reappeared, reappeared],
    });

    const result = await reconcileVm(reconcileContext(fakeRuntime([]), hosts, creator), INPUT);

    expect(hosts.removed).toEqual([]);
    expect(result).toEqual({ repaired: [], errors: [] });
  });

  it("preserves a user-disabled registration instead of re-enabling it", async () => {
    const sandbox = fakeSandbox({ id: "sandbox_1", name: NAME, phase: "ready" });
    const hosts = new FakePaseoHosts({
      directory: fakeHostDirectory([
        ownedRegistration({ enabled: false, status: "disabled" }),
      ]),
    });

    const result = await reconcileVm(
      reconcileContext(fakeRuntime([sandbox]), hosts, new FakeSandboxCreator({ existing: sandbox })),
      INPUT,
    );

    expect(result.errors).toEqual([
      { name: NAME, error: safeError("registration_failed") },
    ]);
    expect(hosts.updated).toEqual([]);
  });

  it("repairs label drift without treating the label as ownership", async () => {
    const sandbox = fakeSandbox({ id: "sandbox_1", name: NAME, phase: "ready" });
    const hosts = new FakePaseoHosts({
      directory: fakeHostDirectory([
        ownedRegistration({
          label: `srv_other/${NAME}`,
          metadata: { source: "paseo-msb", name: NAME },
        }),
      ]),
    });

    const result = await reconcileVm(
      reconcileContext(fakeRuntime([sandbox]), hosts, new FakeSandboxCreator({ existing: sandbox })),
      INPUT,
    );

    expect(result).toEqual({ repaired: [NAME], errors: [] });
    expect(hosts.removed).toEqual([]);
    expect(hosts.updated[0]?.patch.label).toBe(`${PARENT_ID}/${NAME}`);
  });

  it("ignores foreign registrations and still restores the owned one", async () => {
    const sandbox = fakeSandbox({ id: "sandbox_1", name: NAME, phase: "ready" });
    const foreign = fakeRegistration({
      registrationId: "reg_foreign",
      source: { id: "plugin:another-plugin", key: "sandbox_1" },
      metadata: { source: "another-plugin", name: NAME },
    });
    const hosts = new FakePaseoHosts({ directory: fakeHostDirectory([foreign]) });

    const result = await reconcileVm(
      reconcileContext(fakeRuntime([sandbox]), hosts, new FakeSandboxCreator({ existing: sandbox })),
      INPUT,
    );

    expect(result).toEqual({ repaired: [NAME], errors: [] });
    expect(hosts.added).toHaveLength(1);
    expect(hosts.removed).toEqual([]);
  });

  it("removes an older generation's registration when a live replacement exists", async () => {
    const labels: Record<string, string>[] = [];
    const sandbox = fakeSandbox({
      id: "sandbox_new",
      name: NAME,
      phase: "ready",
      labelUpdates: labels,
    });
    const hosts = new FakePaseoHosts({
      directory: fakeHostDirectory([
        ownedRegistration({
          registrationId: "reg_old",
          source: { id: REGISTRATION_PRODUCER_ID, key: "sandbox_old" },
        }),
      ]),
    });

    const result = await reconcileVm(
      reconcileContext(fakeRuntime([sandbox]), hosts, new FakeSandboxCreator({ existing: sandbox })),
      INPUT,
    );

    expect(result).toEqual({ repaired: [NAME], errors: [] });
    expect(hosts.added).toHaveLength(1);
    expect(hosts.removed).toEqual(["reg_old"]);
  });

  it("refuses duplicate owned registrations without touching them", async () => {
    const sandbox = fakeSandbox({ id: "sandbox_1", name: NAME, phase: "ready" });
    const hosts = new FakePaseoHosts({
      directory: fakeHostDirectory([
        ownedRegistration({ registrationId: "reg_a" }),
        ownedRegistration({ registrationId: "reg_b" }),
      ]),
    });

    const result = await reconcileVm(
      reconcileContext(fakeRuntime([sandbox]), hosts, new FakeSandboxCreator({ existing: sandbox })),
      INPUT,
    );

    expect(result.repaired).toEqual([]);
    expect(result.errors).toEqual([
      { name: NAME, error: safeError("registration_conflict") },
    ]);
    expect(hosts.added).toEqual([]);
    expect(hosts.removed).toEqual([]);
  });

  it("rediscovers an active job behind a legacy failed label", async () => {
    const labels: Record<string, string>[] = [];
    const sandbox = fakeSandbox({
      id: "sandbox_1",
      name: NAME,
      phase: "failed",
      error: "install_failed",
      labelUpdates: labels,
      jobState: "running",
      jobStateAfterWait: "exited",
      jobWaitCode: 0,
    });
    const hosts = new FakePaseoHosts();

    const result = await reconcileVm(
      reconcileContext(fakeRuntime([sandbox]), hosts, new FakeSandboxCreator({ existing: sandbox })),
      INPUT,
    );

    expect(result).toEqual({ repaired: [NAME], errors: [] });
    expect(labels.filter((entry) => entry[PHASE_LABEL] === "ready")).toHaveLength(1);
    expect(hosts.added).toHaveLength(1);
  });

  it("does not treat a failed legacy install job as terminal", async () => {
    const labels: Record<string, string>[] = [];
    const provision = buildProvisionScript(legacyPiPlan());
    const sandbox = fakeSandbox({
      id: "sandbox_1",
      name: NAME,
      phase: "failed",
      error: "install_failed",
      labelUpdates: labels,
      jobState: "exited",
      jobExitCode: 7,
      provisionStatus: {
        planHash: provision.planHash,
        ok: true,
        steps: [{ id: "pi-install", status: "ok", exitCode: 0 }],
        failedStep: null,
        error: null,
      },
    });
    const hosts = new FakePaseoHosts();

    const result = await reconcileVm(
      reconcileContext(fakeRuntime([sandbox]), hosts, new FakeSandboxCreator({ existing: sandbox })),
      INPUT,
    );

    expect(result).toEqual({ repaired: [NAME], errors: [] });
    expect(hosts.added).toHaveLength(1);
  });

  it("starts one install when a legacy failed label has no job history", async () => {
    const labels: Record<string, string>[] = [];
    const sandbox = fakeSandbox({
      id: "sandbox_1",
      name: NAME,
      phase: "failed",
      error: "install_failed",
      labelUpdates: labels,
    });
    const hosts = new FakePaseoHosts();
    const creator = new FakeSandboxCreator({ existing: sandbox });

    const result = await reconcileVm(reconcileContext(fakeRuntime([sandbox]), hosts, creator), INPUT);

    expect(result).toEqual({ repaired: [NAME], errors: [] });
    expect(creator.execSpecs).toHaveLength(1);
    expect(creator.createCount).toBe(0);
  });

  it("quarantines a mismatched legacy identity without writing", async () => {
    const labels: Record<string, string>[] = [];
    const sandbox = fakeSandbox({
      id: "sandbox_replacement",
      name: NAME,
      phase: "ready",
      labels: { [SANDBOX_ID_LABEL]: "sandbox_original" },
      labelUpdates: labels,
    });
    const hosts = new FakePaseoHosts();

    const result = await reconcileVm(
      reconcileContext(fakeRuntime([sandbox]), hosts, new FakeSandboxCreator({ existing: sandbox })),
      INPUT,
    );

    expect(result.errors).toEqual([{ name: NAME, error: safeError("id_mismatch") }]);
    expect(hosts.added).toEqual([]);
    expect(hosts.removed).toEqual([]);
    expect(labels).toEqual([]);
  });

  it("completes a deleting tombstone without resuming setup", async () => {
    const labels: Record<string, string>[] = [];
    const sandbox = fakeSandbox({
      id: "sandbox_1",
      name: NAME,
      phase: "deleting",
      labelUpdates: labels,
    });
    const creator = new FakeSandboxCreator({ existing: sandbox });
    const hosts = new FakePaseoHosts({
      directory: fakeHostDirectory([ownedRegistration()]),
    });

    const result = await reconcileVm(
      reconcileContext(fakeRuntime([sandbox]), hosts, creator),
      INPUT,
    );

    expect(result).toEqual({ repaired: [NAME], errors: [] });
    expect(hosts.added).toEqual([]);
    expect(hosts.removed).toEqual(["reg_owned"]);
    expect(creator.destroyed).toEqual(["sandbox_1"]);
    expect(labels.filter((entry) => entry[PHASE_LABEL] === "ready")).toEqual([]);
  });

  it("completes a deleting tombstone whose generation already vanished", async () => {
    const sandbox = fakeSandbox({
      id: "sandbox_1",
      name: NAME,
      phase: "deleting",
      refreshError: Object.assign(new Error("sandbox not found"), {
        code: "sandboxNotFound",
      }),
    });
    const creator = new FakeSandboxCreator({ existing: sandbox });
    const hosts = new FakePaseoHosts({
      directory: fakeHostDirectory([ownedRegistration()]),
    });

    const result = await reconcileVm(
      reconcileContext(fakeRuntime([sandbox]), hosts, creator),
      INPUT,
    );

    expect(result).toEqual({ repaired: [NAME], errors: [] });
    expect(hosts.added).toEqual([]);
    expect(hosts.removed).toEqual(["reg_owned"]);
    expect(creator.destroyed).toEqual([]);
  });

  it("targets one name and reports a missing child", async () => {
    const sandbox = fakeSandbox({ id: "sandbox_1", name: "paseo-other", phase: "ready" });
    const hosts = new FakePaseoHosts();

    const result = await reconcileVm(
      reconcileContext(fakeRuntime([sandbox]), hosts, new FakeSandboxCreator({ existing: sandbox })),
      { name: NAME },
    );

    expect(result.repaired).toEqual([]);
    expect(result.errors).toEqual([{ name: NAME, error: safeError("not_found") }]);
  });

  it("never creates, starts, adopts, or deletes a sandbox", async () => {
    const sandbox = fakeSandbox({ id: "sandbox_1", name: NAME, phase: "ready" });
    const creator = new FakeSandboxCreator({ existing: sandbox });
    const hosts = new FakePaseoHosts();

    await reconcileVm(reconcileContext(fakeRuntime([sandbox]), hosts, creator), INPUT);

    expect(creator.createCount).toBe(0);
    expect(creator.connectCount).toBe(0);
    expect(creator.destroyed).toEqual([]);
  });

  it("fails closed when inventory is unavailable", async () => {
    const hosts = new FakePaseoHosts({
      directory: fakeHostDirectory([ownedRegistration()]),
    });

    await expect(
      reconcileVm(reconcileContext(failingRuntime(), hosts), INPUT),
    ).rejects.toThrow(safeError("inventory_unavailable").message);

    expect(hosts.removed).toEqual([]);
    expect(hosts.added).toEqual([]);
  });

  it("fails closed when registrations are unavailable", async () => {
    const sandbox = fakeSandbox({ id: "sandbox_1", name: NAME, phase: "ready" });
    const hosts = new FakePaseoHosts({
      listError: new Error("registrations unavailable"),
    });

    await expect(
      reconcileVm(
        reconcileContext(fakeRuntime([sandbox]), hosts, new FakeSandboxCreator({ existing: sandbox })),
        INPUT,
      ),
    ).rejects.toThrow(safeError("registrations_unavailable").message);

    expect(hosts.removed).toEqual([]);
  });

  it("does not surface raw registration errors", async () => {
    const sandbox = fakeSandbox({ id: "sandbox_1", name: NAME, phase: "registering" });
    const hosts = new FakePaseoHosts({
      addError: new Error("raw upstream failure"),
    });

    const result = await reconcileVm(
      reconcileContext(fakeRuntime([sandbox]), hosts, new FakeSandboxCreator({ existing: sandbox })),
      INPUT,
    );

    expect(result.errors).toEqual([{ name: NAME, error: safeError("registration_failed") }]);
    expect(JSON.stringify(result)).not.toContain("raw upstream failure");
  });

  it("reports a repair failure without leaking raw text", async () => {
    const labels: Record<string, string>[] = [];
    const sandbox = fakeSandbox({
      id: "sandbox_1",
      name: NAME,
      phase: "registering",
      labelUpdates: labels,
    });
    const hosts = new FakePaseoHosts({
      addError: new Error("modify backend unavailable"),
    });

    const result = await reconcileVm(
      reconcileContext(fakeRuntime([sandbox]), hosts, new FakeSandboxCreator({ existing: sandbox })),
      INPUT,
    );

    expect(result.errors[0].error.code).toBe("registration_failed");
    expect(JSON.stringify(result)).not.toContain("modify backend unavailable");
  });

  it("ignores an error label when the phase is ready", async () => {
    const sandbox = fakeSandbox({
      id: "sandbox_1",
      name: NAME,
      phase: "ready",
      labels: { [ERROR_LABEL]: "install_failed" },
    });
    const hosts = new FakePaseoHosts({
      directory: fakeHostDirectory([ownedRegistration()]),
    });

    const result = await reconcileVm(
      reconcileContext(fakeRuntime([sandbox]), hosts, new FakeSandboxCreator({ existing: sandbox })),
      INPUT,
    );

    expect(result).toEqual({ repaired: [], errors: [] });
  });

  it("resumes a deletion interrupted by plugin cleanup without creating a replacement", async () => {
    const gate = deferred<void>();
    const labelUpdates: Record<string, string>[] = [];
    const sandbox = fakeSandbox({
      id: "sandbox_1",
      name: NAME,
      phase: "ready",
      labelUpdates,
    });
    const creator = new FakeSandboxCreator({
      existing: sandbox,
      destroyGate: gate.promise,
    });
    const hosts = new FakePaseoHosts({
      directory: fakeHostDirectory([ownedRegistration()]),
    });

    // First plugin instance: Delete tombstones the sandbox, then cleanup aborts
    // the destroy wait. The tombstone is durable in the managed labels.
    const lanes = createLifecycleLanes();
    const deletion = lanes.run(
      NAME,
      (token) =>
        deleteVm(
          { hosts, sandboxHost: creator, timeoutMs: 100, pollMs: 1 },
          { name: NAME, id: "sandbox_1", confirmName: NAME },
          token,
        ),
      { abortPrevious: true },
    );

    await waitFor(() =>
      labelUpdates.some((labels) => labels[PHASE_LABEL] === "deleting"),
    );
    await lanes.settle(100);
    await expect(deletion).rejects.toBeInstanceOf(LifecycleAbortedError);

    gate.resolve();
    await waitFor(() => creator.destroyed.length === 1);

    // Replacement plugin instance: recovery finishes cleanup, never setup.
    const recovery = await reconcileVm(
      reconcileContext(fakeRuntime([]), hosts, creator),
      INPUT,
    );

    expect(recovery).toEqual({ repaired: [NAME], errors: [] });
    expect(hosts.removed).toEqual(["reg_owned"]);
    expect(creator.createCount).toBe(0);
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean, deadlineMs = 1_000): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition was not observed");
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

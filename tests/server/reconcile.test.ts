import { describe, expect, it } from "vitest";
import { ERROR_LABEL, PHASE_LABEL, SANDBOX_ID_LABEL } from "../../shared/constants";
import { safeError } from "../../shared/errors";
import { reconcileVm, type ReconcileContext } from "../../server/reconcile";
import {
  failingRuntime,
  fakeHostDirectory,
  fakeRegistration,
  fakeRuntime,
  fakeSandbox,
  FakePaseoHosts,
  FakeSandboxCreator,
  PARENT_ID,
} from "./fake-runtime";

const NAME = "paseo-2f8f4c2e-8e52-4d0e-9db1-1a2b3c4d5e6f";
const INPUT = {};

function reconcileContext(
  runtime: ReconcileContext["runtime"],
  hosts: FakePaseoHosts,
  overrides: Partial<ReconcileContext> = {},
): ReconcileContext {
  return {
    hosts,
    runtime,
    sandboxHost: new FakeSandboxCreator(),
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
    source: { id: "plugin", key: "sandbox_1" },
    metadata: { source: "paseo-msb", vm: "sandbox_1", name: NAME },
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

    const result = await reconcileVm(reconcileContext(fakeRuntime([sandbox]), hosts), INPUT);

    expect(result).toEqual({ repaired: [NAME], errors: [] });
    expect(hosts.added).toHaveLength(1);
    expect(hosts.added[0].connection).toBe("127.0.0.1:43000");
  });

  it("leaves a healthy ready sandbox alone", async () => {
    const sandbox = fakeSandbox({ id: "sandbox_1", name: NAME, phase: "ready" });
    const hosts = new FakePaseoHosts({
      directory: fakeHostDirectory([ownedRegistration()]),
    });

    const result = await reconcileVm(reconcileContext(fakeRuntime([sandbox]), hosts), INPUT);

    expect(result).toEqual({ repaired: [], errors: [] });
    expect(hosts.added).toEqual([]);
    expect(hosts.removed).toEqual([]);
  });

  it("resumes an interrupted install using its persisted job", async () => {
    const labels: Record<string, string>[] = [];
    const sandbox = fakeSandbox({
      id: "sandbox_1",
      name: NAME,
      phase: "installing",
      job: "job_7",
      labelUpdates: labels,
    });
    const creator = new FakeSandboxCreator();
    const hosts = new FakePaseoHosts();

    const result = await reconcileVm(
      reconcileContext(fakeRuntime([sandbox]), hosts, { sandboxHost: creator }),
      INPUT,
    );

    expect(result).toEqual({ repaired: [NAME], errors: [] });
    expect(creator.createCount).toBe(0);
    expect(creator.execSpecs.map((spec) => spec.command)).toEqual(["sh"]);
    expect(hosts.added).toHaveLength(1);
    expect(labels).toContainEqual({ [PHASE_LABEL]: "ready" });
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

    const result = await reconcileVm(reconcileContext(fakeRuntime([sandbox]), hosts), INPUT);

    expect(result).toEqual({ repaired: [NAME], errors: [] });
    expect(hosts.added).toEqual([]);
    expect(hosts.removed).toEqual([]);
    expect(labels).toContainEqual({ [PHASE_LABEL]: "ready" });
  });

  it("removes a confirmed stale registration", async () => {
    const hosts = new FakePaseoHosts({
      directory: fakeHostDirectory([
        ownedRegistration({ metadata: { source: "paseo-msb", vm: "sandbox_gone", name: NAME } }),
      ]),
    });

    const result = await reconcileVm(reconcileContext(fakeRuntime([]), hosts), INPUT);

    expect(result).toEqual({ repaired: [NAME], errors: [] });
    expect(hosts.removed).toEqual(["reg_owned"]);
  });

  it("does not remove a registration labelled for another parent", async () => {
    const hosts = new FakePaseoHosts({
      directory: fakeHostDirectory([
        ownedRegistration({
          label: `srv_other/${NAME}`,
          metadata: { source: "paseo-msb", vm: "sandbox_gone", name: NAME },
        }),
      ]),
    });

    const result = await reconcileVm(reconcileContext(fakeRuntime([]), hosts), INPUT);

    expect(result).toEqual({ repaired: [], errors: [] });
    expect(hosts.removed).toEqual([]);
  });

  it("ignores foreign registrations and still restores the owned one", async () => {
    const sandbox = fakeSandbox({ id: "sandbox_1", name: NAME, phase: "ready" });
    const foreign = fakeRegistration({
      registrationId: "reg_foreign",
      source: { id: "another-plugin", key: "sandbox_1" },
      metadata: { source: "another-plugin", vm: "sandbox_1", name: NAME },
    });
    const hosts = new FakePaseoHosts({ directory: fakeHostDirectory([foreign]) });

    const result = await reconcileVm(reconcileContext(fakeRuntime([sandbox]), hosts), INPUT);

    expect(result).toEqual({ repaired: [NAME], errors: [] });
    expect(hosts.added).toHaveLength(1);
    expect(hosts.removed).toEqual([]);
  });

  it("refuses duplicate owned registrations without touching them", async () => {
    const sandbox = fakeSandbox({ id: "sandbox_1", name: NAME, phase: "ready" });
    const hosts = new FakePaseoHosts({
      directory: fakeHostDirectory([
        ownedRegistration({ registrationId: "reg_a" }),
        ownedRegistration({ registrationId: "reg_b" }),
      ]),
    });

    const result = await reconcileVm(reconcileContext(fakeRuntime([sandbox]), hosts), INPUT);

    expect(result.repaired).toEqual([]);
    expect(result.errors).toEqual([
      { name: NAME, error: safeError("registration_conflict") },
    ]);
    expect(hosts.added).toEqual([]);
    expect(hosts.removed).toEqual([]);
  });

  it("leaves a failed sandbox untouched and returns its safe code", async () => {
    const labels: Record<string, string>[] = [];
    const sandbox = fakeSandbox({
      id: "sandbox_1",
      name: NAME,
      phase: "failed",
      error: "install_failed",
      labelUpdates: labels,
    });
    const hosts = new FakePaseoHosts();

    const result = await reconcileVm(reconcileContext(fakeRuntime([sandbox]), hosts), INPUT);

    expect(result.repaired).toEqual([]);
    expect(result.errors).toEqual([{ name: NAME, error: safeError("install_failed") }]);
    expect(labels).toEqual([]);
    expect(hosts.added).toEqual([]);
  });

  it("refuses an identity mismatch", async () => {
    const labels: Record<string, string>[] = [];
    const sandbox = fakeSandbox({
      id: "sandbox_replacement",
      name: NAME,
      phase: "ready",
      labels: { [SANDBOX_ID_LABEL]: "sandbox_original" },
      labelUpdates: labels,
    });
    const hosts = new FakePaseoHosts();

    const result = await reconcileVm(reconcileContext(fakeRuntime([sandbox]), hosts), INPUT);

    expect(result.errors).toEqual([{ name: NAME, error: safeError("id_mismatch") }]);
    expect(hosts.added).toEqual([]);
    expect(hosts.removed).toEqual([]);
    expect(labels).toEqual([]);
  });

  it("targets one name and reports a missing child", async () => {
    const sandbox = fakeSandbox({ id: "sandbox_1", name: "paseo-other", phase: "ready" });
    const hosts = new FakePaseoHosts();

    const result = await reconcileVm(reconcileContext(fakeRuntime([sandbox]), hosts), {
      name: NAME,
    });

    expect(result.repaired).toEqual([]);
    expect(result.errors).toEqual([{ name: NAME, error: safeError("not_found") }]);
  });

  it("never creates, starts, adopts, or deletes a sandbox", async () => {
    const sandbox = fakeSandbox({ id: "sandbox_1", name: NAME, phase: "ready" });
    const creator = new FakeSandboxCreator();
    const hosts = new FakePaseoHosts();

    await reconcileVm(
      reconcileContext(fakeRuntime([sandbox]), hosts, { sandboxHost: creator }),
      INPUT,
    );

    expect(creator.createCount).toBe(0);
    expect(creator.resumeCount).toBe(0);
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
      reconcileVm(reconcileContext(fakeRuntime([sandbox]), hosts), INPUT),
    ).rejects.toThrow(safeError("registrations_unavailable").message);

    expect(hosts.removed).toEqual([]);
  });

  it("does not surface raw registration errors", async () => {
    const sandbox = fakeSandbox({ id: "sandbox_1", name: NAME, phase: "registering" });
    const hosts = new FakePaseoHosts({
      addError: new Error("raw upstream failure"),
    });

    const result = await reconcileVm(reconcileContext(fakeRuntime([sandbox]), hosts), INPUT);

    expect(result.errors).toEqual([{ name: NAME, error: safeError("registration_failed") }]);
    expect(JSON.stringify(result)).not.toContain("raw upstream failure");
  });

  it("reports a repair failure without leaking raw text when labels cannot be written", async () => {
    const labels: Record<string, string>[] = [];
    const sandbox = fakeSandbox({
      id: "sandbox_1",
      name: NAME,
      phase: "registering",
      modifyError: new Error("modify backend unavailable"),
      labelUpdates: labels,
    });
    const hosts = new FakePaseoHosts();

    const result = await reconcileVm(reconcileContext(fakeRuntime([sandbox]), hosts), INPUT);

    expect(result.errors).toEqual([{ name: NAME, error: safeError("registration_failed") }]);
    expect(JSON.stringify(result)).not.toContain("modify backend unavailable");
    expect(labels).toEqual([]);
  });

  it("ignores an error label when the phase is not failed", async () => {
    const sandbox = fakeSandbox({
      id: "sandbox_1",
      name: NAME,
      phase: "ready",
      labels: { [ERROR_LABEL]: "install_failed" },
    });
    const hosts = new FakePaseoHosts({
      directory: fakeHostDirectory([ownedRegistration()]),
    });

    const result = await reconcileVm(reconcileContext(fakeRuntime([sandbox]), hosts), INPUT);

    expect(result).toEqual({ repaired: [], errors: [] });
  });
});

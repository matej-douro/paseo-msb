import { describe, expect, it } from "vitest";
import { REGISTRATION_PRODUCER_ID } from "../../shared/constants";
import { createLifecycleLanes } from "../../server/lanes";
import { createMutationRegistry } from "../../server/mutations";
import { createRegistrationPruner } from "../../server/prune";
import {
  pruneRegistrationOnlyNames,
  type ReconcileContext,
} from "../../server/reconciler";
import {
  fakeHostDirectory,
  fakeRegistration,
  fakeRuntime,
  fakeSandbox,
  FakePaseoHosts,
  FakeSandboxCreator,
  memorySecretsStore,
} from "./fake-runtime";
import type { HostRegistrationLike } from "../../server/status";

const NAME = "paseo-2f8f4c2e-8e52-4d0e-9db1-1a2b3c4d5e6f";

function context(
  hosts: FakePaseoHosts,
  creator: FakeSandboxCreator,
): ReconcileContext {
  return {
    hosts,
    runtime: fakeRuntime([]),
    sandboxHost: creator,
    mutations: createMutationRegistry(),
    env: {},
    secretsStore: memorySecretsStore(),
    timeoutMs: 100,
    pollMs: 1,
    sdkCallTimeoutMs: 100,
  };
}

function ownedRegistration(
  overrides: Parameters<typeof fakeRegistration>[0] = {},
) {
  return fakeRegistration({
    registrationId: "reg_owned",
    label: NAME,
    source: { id: REGISTRATION_PRODUCER_ID, key: "sandbox_1" },
    metadata: { source: "paseo-msb", name: NAME },
    ...overrides,
  });
}

function hostsWith(registrations: readonly HostRegistrationLike[]) {
  return new FakePaseoHosts({ directory: fakeHostDirectory(registrations) });
}

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("condition was not met");
}

/** Directory whose reads wait for an external gate, to hold a sweep open. */
class GatedHosts extends FakePaseoHosts {
  gate: Promise<void> = Promise.resolve();
  listCount = 0;

  override async list() {
    this.listCount += 1;
    await this.gate;
    return super.list();
  }
}

describe("pruneRegistrationOnlyNames", () => {
  it("removes a registration whose generation is gone", async () => {
    const hosts = hostsWith([ownedRegistration()]);
    const creator = new FakeSandboxCreator({ existing: null });
    const lanes = createLifecycleLanes();

    const removed = await pruneRegistrationOnlyNames(
      context(hosts, creator),
      [NAME],
      lanes,
    );

    expect(removed).toEqual([NAME]);
    expect(hosts.removed).toEqual(["reg_owned"]);
    expect(creator.findCount).toBe(1);
  });

  it("keeps a registration whose exact generation is live", async () => {
    const sandbox = fakeSandbox({ id: "sandbox_1", name: NAME });
    const hosts = hostsWith([ownedRegistration()]);
    const creator = new FakeSandboxCreator({ existing: sandbox });

    const removed = await pruneRegistrationOnlyNames(
      context(hosts, creator),
      [NAME],
      createLifecycleLanes(),
    );

    expect(removed).toEqual([]);
    expect(hosts.removed).toEqual([]);
  });

  it("removes the old generation when a different one owns the name", async () => {
    const sandbox = fakeSandbox({ id: "sandbox_2", name: NAME });
    const hosts = hostsWith([ownedRegistration()]);
    const creator = new FakeSandboxCreator({ existing: sandbox });

    const removed = await pruneRegistrationOnlyNames(
      context(hosts, creator),
      [NAME],
      createLifecycleLanes(),
    );

    expect(removed).toEqual([NAME]);
    expect(hosts.removed).toEqual(["reg_owned"]);
  });

  it("keeps the row when the runtime lookup fails", async () => {
    const hosts = hostsWith([ownedRegistration()]);
    const creator = new FakeSandboxCreator({ findError: new Error("runtime down") });

    const removed = await pruneRegistrationOnlyNames(
      context(hosts, creator),
      [NAME],
      createLifecycleLanes(),
    );

    expect(removed).toEqual([]);
    expect(hosts.removed).toEqual([]);
  });

  it("does not look up a name with an unsettled native mutation", async () => {
    const hosts = hostsWith([ownedRegistration()]);
    const creator = new FakeSandboxCreator({ existing: null });
    const reconcileContext = context(hosts, creator);
    reconcileContext.mutations.track(NAME, new Promise(() => {}));

    const removed = await pruneRegistrationOnlyNames(
      reconcileContext,
      [NAME],
      createLifecycleLanes(),
    );

    expect(removed).toEqual([]);
    expect(creator.findCount).toBe(0);
    expect(hosts.removed).toEqual([]);
  });

  it("leaves duplicate owned rows for Repair", async () => {
    const hosts = hostsWith([
      ownedRegistration(),
      ownedRegistration({ registrationId: "reg_duplicate" }),
    ]);
    const creator = new FakeSandboxCreator({ existing: null });

    const removed = await pruneRegistrationOnlyNames(
      context(hosts, creator),
      [NAME],
      createLifecycleLanes(),
    );

    expect(removed).toEqual([]);
    expect(hosts.removed).toEqual([]);
  });

  it("ignores registrations this plugin does not own", async () => {
    const hosts = hostsWith([
      ownedRegistration({ source: { id: "owner", key: "sandbox_1" } }),
    ]);
    const creator = new FakeSandboxCreator({ existing: null });

    const removed = await pruneRegistrationOnlyNames(
      context(hosts, creator),
      [NAME],
      createLifecycleLanes(),
    );

    expect(removed).toEqual([]);
    expect(creator.findCount).toBe(0);
    expect(hosts.removed).toEqual([]);
  });

  it("stops when the lifecycle lanes are closed", async () => {
    const hosts = hostsWith([ownedRegistration()]);
    const creator = new FakeSandboxCreator({ existing: null });
    const lanes = createLifecycleLanes();
    lanes.close();

    const removed = await pruneRegistrationOnlyNames(
      context(hosts, creator),
      [NAME],
      lanes,
    );

    expect(removed).toEqual([]);
    expect(creator.findCount).toBe(0);
    expect(hosts.removed).toEqual([]);
  });
});

describe("createRegistrationPruner", () => {
  it("does nothing without registration-only names", async () => {
    const hosts = hostsWith([ownedRegistration()]);
    const creator = new FakeSandboxCreator({ existing: null });
    const pruner = createRegistrationPruner(createLifecycleLanes());

    pruner.schedule(context(hosts, creator), []);

    expect(pruner.running).toBe(false);
    await until(() => !pruner.running);
    expect(creator.findCount).toBe(0);
    expect(hosts.removed).toEqual([]);
  });

  it("runs one sweep at a time", async () => {
    const hosts = new GatedHosts({ directory: fakeHostDirectory([ownedRegistration()]) });
    const creator = new FakeSandboxCreator({ existing: null });
    const pruner = createRegistrationPruner(createLifecycleLanes());

    let release!: () => void;
    hosts.gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    pruner.schedule(context(hosts, creator), [NAME]);
    await until(() => hosts.listCount === 1);

    pruner.schedule(context(hosts, creator), [NAME]);
    expect(hosts.listCount).toBe(1);

    release();
    await until(() => !pruner.running);
    expect(hosts.listCount).toBe(1);
    expect(hosts.removed).toEqual(["reg_owned"]);
  });

  it("does not retry a failed name before the cooldown", async () => {
    let clock = 1_000;
    const hosts = new GatedHosts({
      directory: fakeHostDirectory([ownedRegistration()]),
      listError: new Error("parent unavailable"),
    });
    const creator = new FakeSandboxCreator({ existing: null });
    const pruner = createRegistrationPruner(createLifecycleLanes(), {
      retryAfterMs: 30_000,
      now: () => clock,
    });

    pruner.schedule(context(hosts, creator), [NAME]);
    await until(() => !pruner.running);
    expect(hosts.listCount).toBe(1);

    clock += 1_000;
    pruner.schedule(context(hosts, creator), [NAME]);
    await until(() => !pruner.running);
    expect(hosts.listCount).toBe(1);

    clock += 30_000;
    pruner.schedule(context(hosts, creator), [NAME]);
    await until(() => !pruner.running);
    expect(hosts.listCount).toBe(2);
  });

  it("drops the cooldown once a sweep removes the row", async () => {
    let clock = 1_000;
    const hosts = hostsWith([ownedRegistration()]);
    const creator = new FakeSandboxCreator({ existing: null });
    const pruner = createRegistrationPruner(createLifecycleLanes(), {
      retryAfterMs: 30_000,
      now: () => clock,
    });

    pruner.schedule(context(hosts, creator), [NAME]);
    await until(() => !pruner.running);
    expect(hosts.removed).toEqual(["reg_owned"]);

    // A later list cannot re-report this name; the cooldown must not block a
    // fresh name either.
    const other = fakeRegistration({
      registrationId: "reg_other",
      label: NAME,
      source: { id: REGISTRATION_PRODUCER_ID, key: "sandbox_9" },
      metadata: { source: "paseo-msb", name: NAME },
    });
    hosts.directory = fakeHostDirectory([other]);

    clock += 1_000;
    pruner.schedule(context(hosts, creator), [NAME]);
    await until(() => !pruner.running);
    expect(hosts.removed).toEqual(["reg_owned", "reg_other"]);
  });
});

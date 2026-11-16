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
  failingRuntime,
  fakeHostDirectory,
  fakeRegistration,
  fakeRuntime,
  fakeSandbox,
  FakePaseoHosts,
  FakeSandboxCreator,
  memorySecretsStore,
} from "./fake-runtime";
import type { HostDirectoryLike, HostRegistrationLike } from "../../server/status";

const NAME = "paseo-2f8f4c2e-8e52-4d0e-9db1-1a2b3c4d5e6f";

function context(
  hosts: FakePaseoHosts,
  creator: FakeSandboxCreator,
  runtime: ReconcileContext["runtime"] = fakeRuntime([]),
): ReconcileContext {
  return {
    hosts,
    runtime,
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

/** Directory whose reads switch to another directory after the first read. */
class SwitchingHosts extends FakePaseoHosts {
  listCount = 0;
  after: HostDirectoryLike;

  constructor(directory: HostDirectoryLike, after: HostDirectoryLike) {
    super({ directory });
    this.after = after;
  }

  override async list() {
    this.listCount += 1;
    return this.listCount > 1 ? this.after : super.list();
  }
}

/** Parent whose removals fail while `failing` is true. */
class FlakyRemoveHosts extends FakePaseoHosts {
  failing = true;

  override async remove(registrationId: string) {
    if (this.failing) throw new Error("parent unavailable");
    return super.remove(registrationId);
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
  it("derives candidates from authoritative state, not a caller list", async () => {
    const hosts = hostsWith([ownedRegistration()]);
    const creator = new FakeSandboxCreator({ existing: null });
    const pruner = createRegistrationPruner(createLifecycleLanes());

    pruner.schedule(context(hosts, creator));
    await until(() => !pruner.running);

    expect(hosts.removed).toEqual(["reg_owned"]);
  });

  it("attaches a registration whose exact generation is present", async () => {
    const sandbox = fakeSandbox({ id: "sandbox_1", name: NAME });
    const hosts = hostsWith([ownedRegistration()]);
    const creator = new FakeSandboxCreator({ existing: sandbox });
    const pruner = createRegistrationPruner(createLifecycleLanes());

    pruner.schedule(context(hosts, creator, fakeRuntime([sandbox])));
    await until(() => !pruner.running);

    expect(creator.findCount).toBe(0);
    expect(hosts.removed).toEqual([]);
  });

  it("removes an older registration hidden behind a same-name live sandbox", async () => {
    const sandbox = fakeSandbox({ id: "sandbox_2", name: NAME });
    const hosts = hostsWith([
      ownedRegistration({ registrationId: "reg_old" }),
      ownedRegistration({
        registrationId: "reg_new",
        source: { id: REGISTRATION_PRODUCER_ID, key: "sandbox_2" },
      }),
    ]);
    const creator = new FakeSandboxCreator({ existing: sandbox });
    const pruner = createRegistrationPruner(createLifecycleLanes());

    pruner.schedule(context(hosts, creator, fakeRuntime([sandbox])));
    await until(() => !pruner.running);

    expect(hosts.removed).toEqual(["reg_old"]);
    expect(hosts.directory.hosts.map((entry) => entry.registrationId)).toEqual([
      "reg_new",
    ]);
  });

  it("does not remove anything when inventory is unavailable", async () => {
    const hosts = hostsWith([ownedRegistration()]);
    const creator = new FakeSandboxCreator({ existing: null });
    const pruner = createRegistrationPruner(createLifecycleLanes());

    pruner.schedule(context(hosts, creator, failingRuntime()));
    await until(() => !pruner.running);

    expect(creator.findCount).toBe(0);
    expect(hosts.removed).toEqual([]);
  });

  it("does not remove anything when the parent directory is unavailable", async () => {
    const hosts = new FakePaseoHosts({
      directory: fakeHostDirectory([ownedRegistration()]),
      listError: new Error("parent unavailable"),
    });
    const creator = new FakeSandboxCreator({ existing: null });
    const pruner = createRegistrationPruner(createLifecycleLanes());

    pruner.schedule(context(hosts, creator));
    await until(() => !pruner.running);

    expect(creator.findCount).toBe(0);
    expect(hosts.removed).toEqual([]);
  });

  it("skips a name with an unsettled native mutation", async () => {
    const hosts = hostsWith([ownedRegistration()]);
    const creator = new FakeSandboxCreator({ existing: null });
    const pruner = createRegistrationPruner(createLifecycleLanes());
    const reconcileContext = context(hosts, creator);
    reconcileContext.mutations.track(NAME, new Promise(() => {}));

    pruner.schedule(reconcileContext);
    await until(() => !pruner.running);

    expect(creator.findCount).toBe(0);
    expect(hosts.removed).toEqual([]);
  });

  it("re-reads the parent before removing", async () => {
    const hosts = new SwitchingHosts(
      fakeHostDirectory([ownedRegistration()]),
      fakeHostDirectory([]),
    );
    const creator = new FakeSandboxCreator({ existing: null });
    const pruner = createRegistrationPruner(createLifecycleLanes());

    pruner.schedule(context(hosts, creator));
    await until(() => !pruner.running);

    expect(hosts.listCount).toBe(2);
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

    pruner.schedule(context(hosts, creator));
    await until(() => hosts.listCount === 1);

    pruner.schedule(context(hosts, creator));
    expect(hosts.listCount).toBe(1);

    release();
    await until(() => !pruner.running);
    expect(hosts.listCount).toBe(2);
    expect(hosts.removed).toEqual(["reg_owned"]);
  });

  it("does not retry a failed name before the cooldown", async () => {
    let clock = 1_000;
    const hosts = hostsWith([ownedRegistration()]);
    const creator = new FakeSandboxCreator({ findError: new Error("runtime down") });
    const pruner = createRegistrationPruner(createLifecycleLanes(), {
      retryAfterMs: 30_000,
      now: () => clock,
    });

    pruner.schedule(context(hosts, creator));
    await until(() => !pruner.running);
    expect(creator.findCount).toBe(1);

    clock += 1_000;
    pruner.schedule(context(hosts, creator));
    await until(() => !pruner.running);
    expect(creator.findCount).toBe(1);

    clock += 30_000;
    pruner.schedule(context(hosts, creator));
    await until(() => !pruner.running);
    expect(creator.findCount).toBe(2);
  });

  it("retains a failed removal and retries after the cooldown", async () => {
    let clock = 1_000;
    const hosts = new FlakyRemoveHosts({
      directory: fakeHostDirectory([ownedRegistration()]),
    });
    const creator = new FakeSandboxCreator({ existing: null });
    const pruner = createRegistrationPruner(createLifecycleLanes(), {
      retryAfterMs: 30_000,
      now: () => clock,
    });

    pruner.schedule(context(hosts, creator));
    await until(() => !pruner.running);
    expect(hosts.removed).toEqual([]);

    clock += 1_000;
    pruner.schedule(context(hosts, creator));
    await until(() => !pruner.running);
    expect(hosts.removed).toEqual([]);

    clock += 30_000;
    hosts.failing = false;
    pruner.schedule(context(hosts, creator));
    await until(() => !pruner.running);
    expect(hosts.removed).toEqual(["reg_owned"]);
  });

  it("drops the cooldown once a sweep removes the row", async () => {
    let clock = 1_000;
    const hosts = hostsWith([ownedRegistration()]);
    const creator = new FakeSandboxCreator({ existing: null });
    const pruner = createRegistrationPruner(createLifecycleLanes(), {
      retryAfterMs: 30_000,
      now: () => clock,
    });

    pruner.schedule(context(hosts, creator));
    await until(() => !pruner.running);
    expect(hosts.removed).toEqual(["reg_owned"]);

    const other = fakeRegistration({
      registrationId: "reg_other",
      label: NAME,
      source: { id: REGISTRATION_PRODUCER_ID, key: "sandbox_9" },
      metadata: { source: "paseo-msb", name: NAME },
    });
    hosts.directory = fakeHostDirectory([other]);

    clock += 1_000;
    pruner.schedule(context(hosts, creator));
    await until(() => !pruner.running);
    expect(hosts.removed).toEqual(["reg_owned", "reg_other"]);
  });

  it("starts exactly one schedule and stops it", async () => {
    const hosts = hostsWith([ownedRegistration()]);
    const creator = new FakeSandboxCreator({ existing: null });
    const tasks: (() => void)[] = [];
    let cancelled = 0;
    const pruner = createRegistrationPruner(createLifecycleLanes(), {
      scheduler: (task) => {
        tasks.push(task);
        return () => {
          cancelled += 1;
        };
      },
    });
    const reconcileContext = context(hosts, creator);

    pruner.start(reconcileContext);
    pruner.start(reconcileContext);
    expect(tasks).toHaveLength(1);

    pruner.stop();
    expect(cancelled).toBe(1);

    tasks[0]();
    await until(() => !pruner.running);
    expect(creator.findCount).toBe(0);
    expect(hosts.removed).toEqual([]);
  });

  it("rebuilds candidates after a plugin restart without durable state", async () => {
    const hosts = new FlakyRemoveHosts({
      directory: fakeHostDirectory([ownedRegistration()]),
    });
    const creator = new FakeSandboxCreator({ existing: null });

    const before = createRegistrationPruner(createLifecycleLanes());
    before.schedule(context(hosts, creator));
    await until(() => !before.running);
    expect(hosts.removed).toEqual([]);

    // Restart: a fresh pruner and lanes share no queue with the old instance.
    hosts.failing = false;
    const after = createRegistrationPruner(createLifecycleLanes());
    after.schedule(context(hosts, creator));
    await until(() => !after.running);

    expect(hosts.removed).toEqual(["reg_owned"]);
  });
});

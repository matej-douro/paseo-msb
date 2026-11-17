import { describe, expect, it } from "vitest";
import { REGISTRATION_PRODUCER_ID } from "../../shared/constants";
import { cleanupAll, cleanupName, type CleanupContext } from "../../server/cleanup";
import { createRegistrationPruner } from "../../server/prune";
import {
  fakeHostDirectory,
  fakeRegistration,
  fakeSandbox,
  FakePaseoHosts,
  FakeSandboxCreator,
} from "./fake-runtime";
import type { HostRegistrationLike } from "../../server/status";

const NAME = "paseo-2f8f4c2e-8e52-4d0e-9db1-1a2b3c4d5e6f";

function context(hosts: FakePaseoHosts, creator: FakeSandboxCreator): CleanupContext {
  return { hosts, sandboxHost: creator, timeoutMs: 100, sdkCallTimeoutMs: 100 };
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

/** Parent whose removals fail while `failing` is true. */
class FlakyRemoveHosts extends FakePaseoHosts {
  failing = true;

  override async remove(registrationId: string) {
    if (this.failing) throw new Error("parent unavailable");
    return super.remove(registrationId);
  }
}

describe("cleanupName", () => {
  it("removes a registration whose generation is gone", async () => {
    const hosts = hostsWith([ownedRegistration()]);
    const creator = new FakeSandboxCreator({ existing: null });
    const directory = await hosts.list();

    const outcome = await cleanupName(context(hosts, creator), NAME, directory.hosts);

    expect(outcome).toEqual({ found: 1, removed: 1, failed: 0 });
    expect(hosts.removed).toEqual(["reg_owned"]);
  });

  it("keeps a registration whose exact generation is live", async () => {
    const sandbox = fakeSandbox({ id: "sandbox_1", name: NAME });
    const hosts = hostsWith([ownedRegistration()]);
    const creator = new FakeSandboxCreator({ existing: sandbox });
    const directory = await hosts.list();

    const outcome = await cleanupName(context(hosts, creator), NAME, directory.hosts);

    expect(outcome).toEqual({ found: 1, removed: 0, failed: 0 });
    expect(hosts.removed).toEqual([]);
  });

  it("removes the old generation when a different one owns the name", async () => {
    const sandbox = fakeSandbox({ id: "sandbox_2", name: NAME });
    const hosts = hostsWith([ownedRegistration()]);
    const creator = new FakeSandboxCreator({ existing: sandbox });
    const directory = await hosts.list();

    const outcome = await cleanupName(context(hosts, creator), NAME, directory.hosts);

    expect(outcome.removed).toBe(1);
    expect(hosts.removed).toEqual(["reg_owned"]);
  });

  it("removes a confirmed-gone generation even while the runtime still reports it", async () => {
    const dying = fakeSandbox({ id: "sandbox_1", name: NAME });
    const hosts = hostsWith([ownedRegistration()]);
    const creator = new FakeSandboxCreator({ existing: dying });
    const directory = await hosts.list();

    const outcome = await cleanupName(context(hosts, creator), NAME, directory.hosts, {
      confirmedGoneId: "sandbox_1",
    });

    expect(outcome.removed).toBe(1);
    expect(hosts.removed).toEqual(["reg_owned"]);
  });

  it("keeps a replacement's own row while removing a confirmed-gone generation", async () => {
    const replacement = fakeSandbox({ id: "sandbox_2", name: NAME });
    const hosts = hostsWith([
      ownedRegistration(),
      ownedRegistration({
        registrationId: "reg_replacement",
        source: { id: REGISTRATION_PRODUCER_ID, key: "sandbox_2" },
      }),
    ]);
    const creator = new FakeSandboxCreator({ existing: replacement });
    const directory = await hosts.list();

    const outcome = await cleanupName(context(hosts, creator), NAME, directory.hosts, {
      confirmedGoneId: "sandbox_1",
    });

    expect(outcome.removed).toBe(1);
    expect(hosts.removed).toEqual(["reg_owned"]);
  });

  it("keeps the row when the runtime lookup fails", async () => {
    const hosts = hostsWith([ownedRegistration()]);
    const creator = new FakeSandboxCreator({ findError: new Error("runtime down") });
    const directory = await hosts.list();

    const outcome = await cleanupName(context(hosts, creator), NAME, directory.hosts);

    expect(outcome).toEqual({ found: 1, removed: 0, failed: 1 });
    expect(hosts.removed).toEqual([]);
  });

  it("removes only the confirmed generation when the lookup fails", async () => {
    const hosts = hostsWith([ownedRegistration()]);
    const creator = new FakeSandboxCreator({ findError: new Error("runtime down") });
    const directory = await hosts.list();

    const outcome = await cleanupName(context(hosts, creator), NAME, directory.hosts, {
      confirmedGoneId: "sandbox_1",
    });

    expect(outcome.removed).toBe(1);
    expect(hosts.removed).toEqual(["reg_owned"]);
  });

  it("ignores registrations this plugin does not own", async () => {
    const hosts = hostsWith([
      ownedRegistration({ source: { id: "owner", key: "sandbox_1" } }),
    ]);
    const creator = new FakeSandboxCreator({ existing: null });
    const directory = await hosts.list();

    const outcome = await cleanupName(context(hosts, creator), NAME, directory.hosts);

    expect(outcome).toEqual({ found: 0, removed: 0, failed: 0 });
    expect(creator.findCount).toBe(0);
    expect(hosts.removed).toEqual([]);
  });

  it("reports a failed removal for retry", async () => {
    const hosts = new FlakyRemoveHosts({
      directory: fakeHostDirectory([ownedRegistration()]),
    });
    const creator = new FakeSandboxCreator({ existing: null });
    const directory = await hosts.list();

    const outcome = await cleanupName(context(hosts, creator), NAME, directory.hosts);

    expect(outcome).toEqual({ found: 1, removed: 0, failed: 1 });
    expect(hosts.removed).toEqual([]);
  });
});

describe("cleanupAll", () => {
  it("does nothing when the parent directory is unavailable", async () => {
    const hosts = new FakePaseoHosts({
      directory: fakeHostDirectory([ownedRegistration()]),
      listError: new Error("parent unavailable"),
    });
    const creator = new FakeSandboxCreator({ existing: null });

    await expect(cleanupAll(context(hosts, creator))).rejects.toThrow(
      "registrations_unavailable",
    );
    expect(creator.findCount).toBe(0);
    expect(hosts.removed).toEqual([]);
  });
});

describe("createRegistrationPruner", () => {
  it("derives candidates from the parent directory", async () => {
    const hosts = hostsWith([ownedRegistration()]);
    const creator = new FakeSandboxCreator({ existing: null });
    const pruner = createRegistrationPruner();

    pruner.schedule(context(hosts, creator));
    await until(() => !pruner.running);

    expect(hosts.removed).toEqual(["reg_owned"]);
  });

  it("attaches a registration whose exact generation is present", async () => {
    const sandbox = fakeSandbox({ id: "sandbox_1", name: NAME });
    const hosts = hostsWith([ownedRegistration()]);
    const creator = new FakeSandboxCreator({ existing: sandbox });
    const pruner = createRegistrationPruner();

    pruner.schedule(context(hosts, creator));
    await until(() => !pruner.running);

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
    const pruner = createRegistrationPruner();

    pruner.schedule(context(hosts, creator));
    await until(() => !pruner.running);

    expect(hosts.removed).toEqual(["reg_old"]);
    expect(hosts.directory.hosts.map((entry) => entry.registrationId)).toEqual([
      "reg_new",
    ]);
  });

  it("runs one sweep at a time", async () => {
    const hosts = new GatedHosts({ directory: fakeHostDirectory([ownedRegistration()]) });
    const creator = new FakeSandboxCreator({ existing: null });
    const pruner = createRegistrationPruner();

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
    expect(hosts.listCount).toBe(1);
    expect(hosts.removed).toEqual(["reg_owned"]);
  });

  it("does not retry a failed name before the cooldown", async () => {
    let clock = 1_000;
    const hosts = hostsWith([ownedRegistration()]);
    const creator = new FakeSandboxCreator({ findError: new Error("runtime down") });
    const pruner = createRegistrationPruner({
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
    const pruner = createRegistrationPruner({
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
    const pruner = createRegistrationPruner({
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
    const pruner = createRegistrationPruner({
      scheduler: (task) => {
        tasks.push(task);
        return () => {
          cancelled += 1;
        };
      },
    });
    const cleanupContext = context(hosts, creator);

    pruner.start(cleanupContext);
    pruner.start(cleanupContext);
    expect(tasks).toHaveLength(1);

    pruner.stop();
    expect(cancelled).toBe(1);

    tasks[0]();
    await until(() => !pruner.running);
    expect(hosts.removed).toEqual([]);
  });

  it("rebuilds candidates after a plugin restart without durable state", async () => {
    const hosts = new FlakyRemoveHosts({
      directory: fakeHostDirectory([ownedRegistration()]),
    });
    const creator = new FakeSandboxCreator({ existing: null });

    const before = createRegistrationPruner();
    before.schedule(context(hosts, creator));
    await until(() => !before.running);
    expect(hosts.removed).toEqual([]);

    // Restart: a fresh pruner shares no queue or cooldown with the old instance.
    hosts.failing = false;
    const after = createRegistrationPruner();
    after.schedule(context(hosts, creator));
    await until(() => !after.running);

    expect(hosts.removed).toEqual(["reg_owned"]);
  });
});

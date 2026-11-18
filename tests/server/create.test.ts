import { describe, expect, it } from "vitest";
import {
  GUEST_IMAGE,
  GUEST_INIT_ARGS,
  GUEST_INIT_COMMAND,
  GUEST_PATH,
  MANAGED_LABEL,
  MAX_MEMORY_MIB,
  METRICS_SAMPLE_INTERVAL_MS,
  PARENT_LABEL,
  PHASE_LABEL,
  PLAN_ENV_VAR,
  PLUGIN_VERSION,
  RESOURCES_ENV_VAR,
  RESOURCES_SPECIFIED_ENV_VAR,
  ROOT_DISK_MIB,
} from "../../shared/constants";
import type { VmCreateInput } from "../../shared/contracts";
import type { CanonicalPlan } from "../../shared/provisioning";
import { safeError } from "../../shared/errors";
import { createVm, startCreate, type CreateContext } from "../../server/create";
import { createLifecycleLanes } from "../../server/lanes";
import { createMutationRegistry } from "../../server/mutations";
import { createPendingCreateStore } from "../../server/pending";
import { buildSandboxCreatePlan, applySandboxCreatePlan, type SandboxBuilderLike } from "../../server/sandbox";
import { resolveSelectedSecrets } from "../../server/secrets";
import { buildVmList } from "../../server/status";
import {
  fakeRuntime,
  fakeSandbox,
  FakePaseoHosts,
  FakePaseoTools,
  FakeSandboxCreator,
  memorySecretsStore,
  PARENT_ID,
  SECRET_VALUE,
  unavailableSecretsStore,
} from "./fake-runtime";

const REQUEST_ID = "2f8f4c2e-8e52-4d0e-9db1-1a2b3c4d5e6f";
const NAME = `paseo-${REQUEST_ID}`;

const INPUT: VmCreateInput = {
  name: NAME,
  plan: { providers: [{ provider: "pi", llms: ["anthropic-api-key"] }], integrations: [] },
};

const OTHER_PLAN: CanonicalPlan = {
  providers: [{ provider: "pi", llms: ["anthropic-api-key"] }],
  integrations: ["github-cli"],
};

const GEMINI_PLAN: CanonicalPlan = {
  providers: [{ provider: "pi", llms: ["gemini-api-key"] }],
  integrations: [],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitFor(predicate: () => boolean, deadlineMs = 1_000): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition was not observed");
    await tick();
  }
}

function createContext(
  creator: FakeSandboxCreator,
  overrides: Partial<CreateContext> = {},
): CreateContext {
  return {
    hosts: new FakePaseoHosts(),
    runtime: fakeRuntime([]),
    sandboxHost: creator,
    env: { ANTHROPIC_API_KEY: SECRET_VALUE, GH_TOKEN: "gh-secret-value" },
    pending: createPendingCreateStore(),
    secretsStore: memorySecretsStore(),
    lanes: createLifecycleLanes(),
    mutations: createMutationRegistry(),
    installTimeoutMs: 250,
    timeoutMs: 250,
    pollMs: 1,
    ...overrides,
  };
}

describe("createVm", () => {
  it("returns the name immediately and finishes Pi readiness in the lane", async () => {
    const gate = deferred<void>();
    const creator = new FakeSandboxCreator({ createGate: gate.promise });
    const hosts = new FakePaseoHosts();
    const context = createContext(creator, { hosts });

    const attempt = await startCreate(context, INPUT);

    expect(attempt.name).toBe(NAME);
    expect(context.pending.find(NAME)).toMatchObject({
      name: NAME,
      plan: INPUT.plan,
      resources: { cpus: 2, memoryMib: 4096, diskMib: 10240 },
      resourcesSpecified: false,
      phase: "creating",
      errorCode: null,
    });

    gate.resolve();
    await attempt.started;

    expect(context.pending.find(NAME)).toBeNull();
    expect(creator.createCount).toBe(1);
    expect(creator.requests[0]).toMatchObject({
      name: NAME,
      parentId: PARENT_ID,
      secrets: [
        {
          envVar: "ANTHROPIC_API_KEY",
          value: SECRET_VALUE,
          allowedHosts: ["api.anthropic.com"],
        },
      ],
    });

    const created = await creator.find(NAME);
    expect(created).not.toBeNull();
    expect(created!.config()).toMatchObject({
      labels: {
        [MANAGED_LABEL]: PLUGIN_VERSION,
        [PARENT_LABEL]: PARENT_ID,
        [PHASE_LABEL]: "ready",
      },
    });

    expect(hosts.added).toHaveLength(1);
    expect(hosts.added[0]).toMatchObject({
      connection: "127.0.0.1:41000",
      label: NAME,
      metadata: { source: "paseo-msb", name: NAME },
      sourceKey: "sandbox_1",
    });

    const writtenLabels = creator.labelUpdates.flatMap((labels) => Object.keys(labels));
    expect(writtenLabels).not.toContain("paseo-msb-id");
    expect(writtenLabels).not.toContain("paseo-msb-job");
    expect(JSON.stringify(creator.labelUpdates)).not.toContain(SECRET_VALUE);
  });

  it("resolves create before host work completes", async () => {
    const gate = deferred<void>();
    const creator = new FakeSandboxCreator({ createGate: gate.promise });
    const context = createContext(creator);

    const result = await createVm(context, INPUT);
    expect(result.name).toBe(NAME);
    await waitFor(() => creator.createCount === 1);

    gate.resolve();
  });

  it("starts one attempt for a repeated name", async () => {
    const gate = deferred<void>();
    const creator = new FakeSandboxCreator({ createGate: gate.promise });
    const context = createContext(creator);

    const first = await startCreate(context, INPUT);
    const second = await startCreate(context, INPUT);

    expect(second.name).toBe(first.name);
    await second.started;
    await waitFor(() => creator.createCount === 1);

    gate.resolve();
    await first.started;
    expect(creator.createCount).toBe(1);
  });

  it("explains a stale failed attempt that blocks a different shape", async () => {
    const gate = deferred<void>();
    const creator = new FakeSandboxCreator({ createGate: gate.promise });
    const context = createContext(creator);

    const first = startCreate(context, INPUT);
    context.pending.fail(NAME, "create_failed");

    expect(() => startCreate(context, { ...INPUT, plan: OTHER_PLAN })).toThrow(
      "retry or dismiss",
    );

    gate.resolve();
    await first.started;
  });

  it("returns a chosen name immediately and keeps the requested resources pending", async () => {
    const gate = deferred<void>();
    const creator = new FakeSandboxCreator({ createGate: gate.promise });
    const context = createContext(creator);

    const attempt = await startCreate(context, {
      ...INPUT,
      name: "my-vm",
      resources: { memoryMib: 8192, diskMib: 20480 },
    });

    expect(attempt.name).toBe("my-vm");
    expect(context.pending.find("my-vm")).toMatchObject({
      name: "my-vm",
      resources: { cpus: 2, memoryMib: 8192, diskMib: 20480 },
      resourcesSpecified: true,
    });

    gate.resolve();
    await attempt.started;

    expect(creator.requests[0]).toMatchObject({ name: "my-vm" });
    expect(await creator.find("my-vm")).not.toBeNull();
  });

  it("rejects a different plan, resources, or specified flag for the same name", async () => {
    const gate = deferred<void>();
    const creator = new FakeSandboxCreator({ createGate: gate.promise });
    const context = createContext(creator);

    const first = startCreate(context, INPUT);

    expect(() =>
      startCreate(context, { ...INPUT, plan: OTHER_PLAN }),
    ).toThrow(safeError("invalid_request").message);
    expect(() =>
      startCreate(context, {
        ...INPUT,
        resources: { memoryMib: 8192, diskMib: 10240 },
      }),
    ).toThrow(safeError("invalid_request").message);
    // Same values as the defaults, but supplied explicitly: a different request.
    expect(() =>
      startCreate(context, {
        ...INPUT,
        resources: { memoryMib: 4096, diskMib: 10240 },
      }),
    ).toThrow(safeError("invalid_request").message);

    gate.resolve();
    await first.started;
  });

  it("refuses to start while a native mutation is unsettled", async () => {
    const creator = new FakeSandboxCreator();
    const context = createContext(creator);
    context.mutations.track(NAME, new Promise(() => {}));

    const attempt = await startCreate(context, INPUT);
    await attempt.started;

    expect(context.pending.find(NAME)).toMatchObject({
      phase: "failed",
      errorCode: "mutation_pending",
    });
    expect(creator.createCount).toBe(0);
  });

  it("joins an existing sandbox with the same name and shape after readiness", async () => {
    const sandbox = fakeSandbox({
      id: "sandbox_existing",
      name: "my-vm",
      phase: "ready",
      plan: INPUT.plan,
      requestedResources: { cpus: 2, memoryMib: 8192, diskMib: 20480 },
      resourcesSpecified: true,
    });
    const creator = new FakeSandboxCreator({ existing: sandbox });
    const context = createContext(creator, { runtime: fakeRuntime([sandbox]) });

    const attempt = await startCreate(context, {
      ...INPUT,
      name: "my-vm",
      resources: { memoryMib: 8192, diskMib: 20480 },
    });
    await attempt.started;

    expect(creator.createCount).toBe(0);
    expect(context.pending.find("my-vm")).toBeNull();
  });

  it("rejects a create whose shape differs from the existing sandbox", async () => {
    const sandbox = fakeSandbox({
      id: "sandbox_owned",
      name: "my-vm",
      phase: "ready",
      plan: INPUT.plan,
      requestedResources: { cpus: 2, memoryMib: 4096, diskMib: 10240 },
      resourcesSpecified: true,
    });
    const creator = new FakeSandboxCreator({ existing: sandbox });
    const context = createContext(creator, { runtime: fakeRuntime([sandbox]) });

    const attempt = await startCreate(context, {
      ...INPUT,
      name: "my-vm",
    });
    await attempt.started;

    expect(context.pending.find("my-vm")).toMatchObject({
      phase: "failed",
      errorCode: "invalid_request",
    });
    expect(context.pending.find("my-vm")?.errorDetail).toContain("sandbox_owned");
    expect(creator.createCount).toBe(0);
  });

  it("rejects a create whose recorded plan or resources differ", async () => {
    const sandbox = fakeSandbox({
      id: "sandbox_owned",
      name: "my-vm",
      phase: "ready",
      plan: INPUT.plan,
      requestedResources: { cpus: 2, memoryMib: 4096, diskMib: 10240 },
      resourcesSpecified: true,
    });
    const creator = new FakeSandboxCreator({ existing: sandbox });

    const differentPlan = createContext(creator, { runtime: fakeRuntime([sandbox]) });
    const planAttempt = await startCreate(differentPlan, {
      ...INPUT,
      name: "my-vm",
      plan: OTHER_PLAN,
      resources: { memoryMib: 4096, diskMib: 10240 },
    });
    await planAttempt.started;
    expect(differentPlan.pending.find("my-vm")).toMatchObject({
      phase: "failed",
      errorCode: "invalid_request",
    });

    // A different resource selection is rejected even when the flag matches.
    const differentResources = createContext(creator, { runtime: fakeRuntime([sandbox]) });
    const resourceAttempt = await startCreate(differentResources, {
      ...INPUT,
      name: "my-vm",
      resources: { memoryMib: 8192, diskMib: 10240 },
    });
    await resourceAttempt.started;
    expect(differentResources.pending.find("my-vm")).toMatchObject({
      phase: "failed",
      errorCode: "invalid_request",
    });

    expect(creator.createCount).toBe(0);
  });

  it("joins a same-name sandbox from an earlier attempt instead of creating another", async () => {
    const sandbox = fakeSandbox({
      id: "sandbox_owned",
      name: "shared-vm",
      phase: "ready",
      plan: INPUT.plan,
      requestedResources: { cpus: 2, memoryMib: 8192, diskMib: 20480 },
      resourcesSpecified: true,
    });
    const creator = new FakeSandboxCreator({ existing: sandbox });
    const context = createContext(creator, { runtime: fakeRuntime([sandbox]) });

    const attempt = await startCreate(context, {
      ...INPUT,
      name: "shared-vm",
      resources: { memoryMib: 8192, diskMib: 20480 },
    });
    await attempt.started;

    expect(context.pending.find("shared-vm")).toBeNull();
    expect(creator.createCount).toBe(0);
    expect(await creator.find("shared-vm")).toBe(sandbox);
  });

  it("fails rather than resurrecting a tombstoned generation", async () => {
    const tombstone = fakeSandbox({
      id: "sandbox_old",
      name: NAME,
      labels: { [PHASE_LABEL]: "deleting" },
    });
    const creator = new FakeSandboxCreator({ existing: tombstone });
    const context = createContext(creator);

    const attempt = await startCreate(context, INPUT);
    await attempt.started;

    expect(creator.destroyed).toEqual([]);
    expect(creator.createCount).toBe(0);
    expect(context.pending.find(NAME)).toMatchObject({
      phase: "failed",
      errorCode: "invalid_config",
    });
  });

  it("rejects a sandbox that belongs to another parent", async () => {
    const sandbox = fakeSandbox({
      id: "sandbox_foreign",
      name: "shared-vm",
      phase: "ready",
      parentId: "srv_other",
    });
    const creator = new FakeSandboxCreator({ existing: sandbox });
    const context = createContext(creator);

    const attempt = await startCreate(context, { ...INPUT, name: "shared-vm" });
    await attempt.started;

    expect(context.pending.find("shared-vm")).toMatchObject({
      phase: "failed",
      errorCode: "name_conflict",
    });
    expect(creator.createCount).toBe(0);
  });

  it("fails a Create that meets an undecodable same-name sandbox", async () => {
    // A pre-V1.1 child has no plan or resource variables. It is never adopted,
    // joined, or destroyed by Create.
    const sandbox = fakeSandbox({
      id: "sandbox_legacy",
      name: NAME,
      phase: "ready",
      rawConfig: { env: [] },
    });
    const creator = new FakeSandboxCreator({ existing: sandbox });
    const context = createContext(creator);

    const attempt = await startCreate(context, {
      ...INPUT,
      resources: { memoryMib: 4096, diskMib: 10240 },
    });
    await attempt.started;

    expect(context.pending.find(NAME)).toMatchObject({
      phase: "failed",
      errorCode: "invalid_config",
    });
    expect(creator.createCount).toBe(0);
    expect(creator.destroyed).toEqual([]);
  });

  it("joins an owned sandbox from an earlier attempt without creating another", async () => {
    const sandbox = fakeSandbox({
      id: "sandbox_existing",
      name: NAME,
      phase: "ready",
      plan: INPUT.plan,
    });
    const creator = new FakeSandboxCreator({ existing: sandbox });
    const context = createContext(creator);

    const attempt = await startCreate(context, INPUT);
    await attempt.started;

    expect(creator.createCount).toBe(0);
    expect(context.hosts).toBeInstanceOf(FakePaseoHosts);
  });

  it("joins an existing sandbox after its create-time credentials were removed", async () => {
    const sandbox = fakeSandbox({
      id: "sandbox_existing",
      name: NAME,
      phase: "ready",
      plan: INPUT.plan,
    });
    const creator = new FakeSandboxCreator({ existing: sandbox });
    const context = createContext(creator, { env: {}, secretsStore: memorySecretsStore() });

    const attempt = await startCreate(context, INPUT);
    await attempt.started;

    expect(context.pending.find(NAME)).toBeNull();
    expect(creator.createCount).toBe(0);
  });

  it("still rejects a different persisted plan when joining without credentials", async () => {
    const sandbox = fakeSandbox({
      id: "sandbox_existing",
      name: NAME,
      phase: "ready",
      plan: GEMINI_PLAN,
    });
    const creator = new FakeSandboxCreator({ existing: sandbox });
    const context = createContext(creator, { env: {}, secretsStore: memorySecretsStore() });

    const attempt = await startCreate(context, INPUT);
    await attempt.started;

    expect(context.pending.find(NAME)).toMatchObject({
      phase: "failed",
      errorCode: "invalid_request",
    });
    expect(creator.createCount).toBe(0);
  });

  it("joins an existing sandbox when the credential store is unavailable", async () => {
    const sandbox = fakeSandbox({
      id: "sandbox_existing",
      name: NAME,
      phase: "ready",
      plan: INPUT.plan,
    });
    const creator = new FakeSandboxCreator({ existing: sandbox });
    const context = createContext(creator, {
      env: {},
      secretsStore: unavailableSecretsStore(),
    });

    const attempt = await startCreate(context, INPUT);
    await attempt.started;

    expect(context.pending.find(NAME)).toBeNull();
    expect(creator.createCount).toBe(0);
  });

  it("rejects a repeated request with different credential names", async () => {
    const gate = deferred<void>();
    const creator = new FakeSandboxCreator({ createGate: gate.promise });
    const context = createContext(creator);

    const first = startCreate(context, INPUT);

    expect(() => startCreate(context, { ...INPUT, plan: OTHER_PLAN })).toThrow(
      safeError("invalid_request").message,
    );

    gate.resolve();
    await first.started;
  });

  it("reports a pre-create failure and retries it under the same name", async () => {
    const creator = new FakeSandboxCreator({
      createFailures: [new Error("image pull failed")],
    });
    const context = createContext(creator);

    const attempt = await startCreate(context, INPUT);
    await attempt.started;

    expect(context.pending.find(NAME)).toMatchObject({
      name: NAME,
      phase: "failed",
      errorCode: "create_failed",
    });

    const retry = await startCreate(context, INPUT);
    await retry.started;

    expect(context.pending.find(NAME)).toBeNull();
    expect(creator.createCount).toBe(2);
  });

  it("marks the sandbox with a fatal provisioning error when a step exits non-zero", async () => {
    const creator = new FakeSandboxCreator({ jobExitCode: 7 });
    const context = createContext(creator);

    const attempt = await startCreate(context, INPUT);
    await attempt.started;

    const created = await creator.find(NAME);
    expect(created!.config()).toMatchObject({
      labels: {
        [PHASE_LABEL]: "installing",
        "paseo-msb-error": "provision_failed",
      },
    });
    expect(creator.labelUpdates).toContainEqual({
      [PHASE_LABEL]: "installing",
    });
  });

  it("keeps a launch failure pending instead of starting a second job", async () => {
    const creator = new FakeSandboxCreator({
      execDetachedError: new Error("job launch failed"),
    });
    const context = createContext(creator);

    const attempt = await startCreate(context, INPUT);
    await attempt.started;

    const created = await creator.find(NAME);
    expect(created!.config()).toMatchObject({
      labels: {
        [PHASE_LABEL]: "installing",
        "paseo-msb-error": "provision_pending",
      },
    });
  });

  it("settles a create whose selected credentials are absent without any sandbox work", async () => {
    const creator = new FakeSandboxCreator();
    const context = createContext(creator);

    const attempt = startCreate(context, {
      name: NAME,
      plan: GEMINI_PLAN,
    });
    await attempt.started;

    expect(context.pending.find(NAME)).toMatchObject({
      phase: "failed",
      errorCode: "missing_credentials",
    });
    expect(creator.createCount).toBe(0);
  });

  it("resolves a plugin-stored credential before the parent environment", async () => {
    const creator = new FakeSandboxCreator();
    const context = createContext(creator, {
      env: { ANTHROPIC_API_KEY: "env-value" },
      secretsStore: memorySecretsStore({ ANTHROPIC_API_KEY: "stored-value" }),
    });

    const attempt = await startCreate(context, INPUT);
    await attempt.started;

    expect(creator.requests[0].secrets).toEqual([
      {
        envVar: "ANTHROPIC_API_KEY",
        value: "stored-value",
        allowedHosts: ["api.anthropic.com"],
      },
    ]);
  });

  it("fails safely when the credential store is unavailable", async () => {
    const creator = new FakeSandboxCreator();
    const context = createContext(creator, {
      secretsStore: unavailableSecretsStore(),
    });

    const attempt = startCreate(context, INPUT);
    await attempt.started;

    expect(context.pending.find(NAME)).toMatchObject({
      phase: "failed",
      errorCode: "secrets_unavailable",
    });
    expect(creator.createCount).toBe(0);
  });

  it("retries creation on a new loopback port after a bind failure", async () => {
    const creator = new FakeSandboxCreator({
      createFailures: [new Error("address already in use")],
      hostPorts: [41_000, 42_000],
    });
    const context = createContext(creator);

    const attempt = await startCreate(context, INPUT);
    await attempt.started;

    expect(creator.createCount).toBe(2);
    expect(creator.requests[1].hostPort).toBe(42_000);
  });

  it("reports an exhausted port retry budget", async () => {
    const creator = new FakeSandboxCreator({
      createFailures: [
        new Error("address already in use"),
        new Error("address already in use"),
        new Error("address already in use"),
      ],
    });
    const context = createContext(creator);

    const attempt = await startCreate(context, INPUT);
    await attempt.started;

    expect(context.pending.find(NAME)).toMatchObject({
      phase: "failed",
      errorCode: "port_unavailable",
    });
  });

  it("reports an unavailable parent directory with a bounded detail", async () => {
    const creator = new FakeSandboxCreator();
    const context = createContext(creator, {
      hosts: new FakePaseoHosts({ listError: new Error("socket closed") }),
    });

    const attempt = await startCreate(context, INPUT);
    await attempt.started;

    const pending = context.pending.find(NAME);
    expect(pending).toMatchObject({ phase: "failed" });
    expect(pending!.errorDetail).toContain("socket closed");
    expect(pending!.errorDetail!.length).toBeLessThanOrEqual(1_000);
  });

  it("never writes credential values into pending state or labels", async () => {
    const creator = new FakeSandboxCreator({
      createFailures: [new Error("create failed with fake-anthropic-secret-value-123")],
    });
    const context = createContext(creator);

    const attempt = await startCreate(context, INPUT);
    await attempt.started;

    const persisted = JSON.stringify({
      pending: context.pending.list(),
      labels: creator.labelUpdates,
    });
    expect(persisted).not.toContain(SECRET_VALUE);
    expect(persisted).toContain("[redacted]");
  });

  it("settles a cancelled pending attempt so a later Create can work", async () => {
    const gate = deferred<void>();
    const creator = new FakeSandboxCreator({ createGate: gate.promise });
    const context = createContext(creator);

    const attempt = startCreate(context, INPUT);
    await waitFor(() => creator.createCount === 1);

    await context.lanes.settle(100);
    await attempt.started;

    expect(context.pending.find(NAME)).toBeNull();
    expect(context.lanes.closed).toBe(true);

    gate.resolve();
  });

  it("settles a pending create when the lane rejects before the task starts", async () => {
    const gate = deferred<void>();
    const lanes = createLifecycleLanes();
    const context = createContext(new FakeSandboxCreator(), { lanes });

    // Occupy the name's lane, then queue the create behind it. Closing the
    // lanes cancels the queued task before it starts.
    const blocker = lanes.run(NAME, async () => {
      await gate.promise;
    });
    const attempt = startCreate(context, INPUT);
    expect(context.pending.find(NAME)).not.toBeNull();

    lanes.close();
    gate.resolve();
    await blocker.catch(() => undefined);
    await attempt.started;

    expect(context.pending.find(NAME)).toBeNull();
  });

  it("keeps a pending create visible through the list projection", async () => {
    const gate = deferred<void>();
    const creator = new FakeSandboxCreator({ createGate: gate.promise });
    const context = createContext(creator);

    const attempt = await startCreate(context, INPUT);

    const list = buildVmList({
      parentId: PARENT_ID,
      inventory: { status: "available", sandboxes: [], failures: [] },
      registrations: { status: "available", hosts: [] },
      pending: context.pending.list(),
      env: context.env,
    });

    expect(list.children[0]).toMatchObject({
      kind: "pending",
      name: NAME,
      phase: "creating",
    });

    gate.resolve();
    await attempt.started;
  });

  it("configures Paseo tools and orchestration skills for the selected integration", async () => {
    const creator = new FakeSandboxCreator();
    const paseoTools = new FakePaseoTools();
    const context = createContext(creator, {
      paseoTools: (connection, options) => paseoTools.connect(connection, options),
    });
    const plan: CanonicalPlan = {
      providers: [{ provider: "pi", llms: ["anthropic-api-key"] }],
      integrations: ["paseo-tools"],
    };

    const attempt = await startCreate(context, { name: NAME, plan });
    await attempt.started;

    expect(paseoTools.connections).toEqual(["127.0.0.1:41000"]);
    expect(paseoTools.enabledProviders).toEqual([["pi"]]);
    expect(paseoTools.installCalls).toBe(1);
    expect(paseoTools.closes).toBe(1);
    expect(context.pending.find(NAME)).toBeNull();

    const created = await creator.find(NAME);
    expect(created).not.toBeNull();
    expect(created!.config()).toMatchObject({ labels: { [PHASE_LABEL]: "ready" } });
  });

  it("reports a Paseo tools failure in the registering phase and keeps the sandbox", async () => {
    const creator = new FakeSandboxCreator();
    const paseoTools = new FakePaseoTools({ skillsError: new Error("skills failed") });
    const context = createContext(creator, {
      paseoTools: (connection, options) => paseoTools.connect(connection, options),
    });
    const plan: CanonicalPlan = {
      providers: [{ provider: "pi", llms: ["anthropic-api-key"] }],
      integrations: ["paseo-tools"],
    };

    const attempt = await startCreate(context, { name: NAME, plan });
    await attempt.started;

    expect(paseoTools.closes).toBe(1);
    expect(context.pending.find(NAME)).toMatchObject({
      phase: "failed",
      errorCode: "paseo_tools_failed",
    });
    const created = await creator.find(NAME);
    expect(created).not.toBeNull();
    expect(created!.config()).toMatchObject({ labels: { [PHASE_LABEL]: "registering" } });
  });

  it("fails the Paseo tools step when the child-daemon connector is unavailable", async () => {
    const creator = new FakeSandboxCreator();
    const context = createContext(creator);
    const plan: CanonicalPlan = {
      providers: [{ provider: "pi", llms: ["anthropic-api-key"] }],
      integrations: ["paseo-tools"],
    };

    const attempt = await startCreate(context, { name: NAME, plan });
    await attempt.started;

    expect(context.pending.find(NAME)).toMatchObject({
      phase: "failed",
      errorCode: "paseo_tools_failed",
    });
  });

  it("does not apply Paseo tools before the selected providers are ready", async () => {
    const creator = new FakeSandboxCreator();
    const hosts = new FakePaseoHosts({ providerStatus: "starting" });
    const paseoTools = new FakePaseoTools();
    const context = createContext(creator, {
      hosts,
      timeoutMs: 30,
      pollMs: 1,
      paseoTools: (connection, options) => paseoTools.connect(connection, options),
    });
    const plan: CanonicalPlan = {
      providers: [{ provider: "pi", llms: ["anthropic-api-key"] }],
      integrations: ["paseo-tools"],
    };

    const attempt = await startCreate(context, { name: NAME, plan });
    await attempt.started;

    expect(context.pending.find(NAME)).toMatchObject({
      phase: "failed",
      errorCode: "provider_unavailable",
    });
    expect(paseoTools.connections).toEqual([]);
  });

  it("maps a connector failure without leaking a client", async () => {
    const creator = new FakeSandboxCreator();
    const paseoTools = new FakePaseoTools({ connectError: new Error("connect failed") });
    const context = createContext(creator, {
      paseoTools: (connection, options) => paseoTools.connect(connection, options),
    });
    const plan: CanonicalPlan = {
      providers: [{ provider: "pi", llms: ["anthropic-api-key"] }],
      integrations: ["paseo-tools"],
    };

    const attempt = await startCreate(context, { name: NAME, plan });
    await attempt.started;

    expect(context.pending.find(NAME)).toMatchObject({
      phase: "failed",
      errorCode: "paseo_tools_failed",
    });
    expect(paseoTools.closes).toBe(0);
    expect(paseoTools.installCalls).toBe(0);
  });

  it("closes the client when enabling tools fails", async () => {
    const creator = new FakeSandboxCreator();
    const paseoTools = new FakePaseoTools({ enableError: new Error("policy failed") });
    const context = createContext(creator, {
      paseoTools: (connection, options) => paseoTools.connect(connection, options),
    });
    const plan: CanonicalPlan = {
      providers: [{ provider: "pi", llms: ["anthropic-api-key"] }],
      integrations: ["paseo-tools"],
    };

    const attempt = await startCreate(context, { name: NAME, plan });
    await attempt.started;

    expect(context.pending.find(NAME)).toMatchObject({
      phase: "failed",
      errorCode: "paseo_tools_failed",
    });
    expect(paseoTools.closes).toBe(1);
    expect(paseoTools.installCalls).toBe(0);
  });

  it("bounds a hanging skills install and still closes the client", async () => {
    const gate = deferred<void>();
    const creator = new FakeSandboxCreator();
    const paseoTools = new FakePaseoTools({ skillsGate: gate.promise });
    const context = createContext(creator, {
      sdkCallTimeoutMs: 25,
      paseoTools: (connection, options) => paseoTools.connect(connection, options),
    });
    const plan: CanonicalPlan = {
      providers: [{ provider: "pi", llms: ["anthropic-api-key"] }],
      integrations: ["paseo-tools"],
    };

    const attempt = await startCreate(context, { name: NAME, plan });
    await attempt.started;

    expect(context.pending.find(NAME)).toMatchObject({
      phase: "failed",
      errorCode: "paseo_tools_failed",
    });
    expect(paseoTools.installCalls).toBe(1);
    expect(paseoTools.closes).toBe(1);
  });

  it("closes the client when the lane aborts during skills setup", async () => {
    const gate = deferred<void>();
    const creator = new FakeSandboxCreator();
    const paseoTools = new FakePaseoTools({ skillsGate: gate.promise });
    const context = createContext(creator, {
      sdkCallTimeoutMs: 5_000,
      paseoTools: (connection, options) => paseoTools.connect(connection, options),
    });
    const plan: CanonicalPlan = {
      providers: [{ provider: "pi", llms: ["anthropic-api-key"] }],
      integrations: ["paseo-tools"],
    };

    const attempt = await startCreate(context, { name: NAME, plan });
    await waitFor(() => paseoTools.installCalls === 1);
    context.lanes.close();
    await attempt.started;

    expect(paseoTools.closes).toBe(1);
    expect(context.pending.find(NAME)).toBeNull();
  });

  it("closes a client that connects after the setup deadline", async () => {
    const gate = deferred<void>();
    const creator = new FakeSandboxCreator();
    const paseoTools = new FakePaseoTools({ connectGate: gate.promise });
    const context = createContext(creator, {
      sdkCallTimeoutMs: 25,
      paseoTools: (connection, options) => paseoTools.connect(connection, options),
    });
    const plan: CanonicalPlan = {
      providers: [{ provider: "pi", llms: ["anthropic-api-key"] }],
      integrations: ["paseo-tools"],
    };

    const attempt = await startCreate(context, { name: NAME, plan });
    await attempt.started;

    expect(context.pending.find(NAME)).toMatchObject({
      phase: "failed",
      errorCode: "paseo_tools_failed",
    });
    expect(paseoTools.closes).toBe(0);

    gate.resolve();
    await tick();
    expect(paseoTools.closes).toBe(1);
  });
});

describe("sandbox create plan", () => {
  it("pins the image, resources, init, loopback port, PATH, labels, and header-only secrets", () => {
    const resolution = resolveSelectedSecrets(
      ["ANTHROPIC_API_KEY", "GH_TOKEN"],
      {
        ANTHROPIC_API_KEY: "anthropic-secret",
        GH_TOKEN: "gh-secret",
      },
    );
    if (resolution.status !== "ok") throw new Error("expected resolved secrets");

    const resources = { cpus: 4, memoryMib: 8192, diskMib: 20480 };
    const createdPlan = buildSandboxCreatePlan({
      name: NAME,
      parentId: PARENT_ID,
      hostPort: 43_000,
      plan: INPUT.plan,
      secrets: resolution.secrets,
      resources,
      resourcesSpecified: true,
    });

    expect(createdPlan.name).toBe(NAME);
    expect(createdPlan.image).toBe(GUEST_IMAGE);
    expect(createdPlan.cpus).toBe(4);
    expect(createdPlan.memoryMib).toBe(8192);
    expect(createdPlan.maxMemoryMib).toBe(MAX_MEMORY_MIB);
    expect(createdPlan.rootDiskMib).toBe(20480);
    expect(createdPlan.metricsSampleIntervalMs).toBe(METRICS_SAMPLE_INTERVAL_MS);
    expect(createdPlan.detached).toBe(true);
    expect(createdPlan.init).toEqual({ command: GUEST_INIT_COMMAND, args: GUEST_INIT_ARGS });
    expect(createdPlan.hostPort).toBe(43_000);
    expect(createdPlan.guestPort).toBe(6767);
    expect(createdPlan.env).toEqual({
      PATH: GUEST_PATH,
      [PLAN_ENV_VAR]: JSON.stringify(INPUT.plan),
      [RESOURCES_ENV_VAR]: JSON.stringify(resources),
      [RESOURCES_SPECIFIED_ENV_VAR]: "1",
    });
    expect(createdPlan.labels).toEqual({
      [MANAGED_LABEL]: PLUGIN_VERSION,
      [PARENT_LABEL]: PARENT_ID,
      [PHASE_LABEL]: "creating",
    });

    for (const secret of createdPlan.secrets) {
      expect(secret.substitution).toEqual({ headers: true, query: false, body: false });
    }

    const projected = JSON.stringify({ labels: createdPlan.labels, env: createdPlan.env });
    expect(projected).not.toContain("anthropic-secret");
    expect(projected).not.toContain("gh-secret");
  });

  it("uses the default resources and reports an omitted selection", () => {
    const createdPlan = buildSandboxCreatePlan({
      name: NAME,
      parentId: PARENT_ID,
      hostPort: 43_000,
      plan: INPUT.plan,
      secrets: [],
    });

    expect(createdPlan.cpus).toBe(2);
    expect(createdPlan.memoryMib).toBe(4096);
    expect(createdPlan.rootDiskMib).toBe(ROOT_DISK_MIB);
    expect(createdPlan.maxMemoryMib).toBe(MAX_MEMORY_MIB);
    expect(createdPlan.env[RESOURCES_ENV_VAR]).toBe(
      JSON.stringify({ cpus: 2, memoryMib: 4096, diskMib: ROOT_DISK_MIB }),
    );
    expect(createdPlan.env[RESOURCES_SPECIFIED_ENV_VAR]).toBe("0");
  });

  it("applies the create plan in the pinned SDK order", () => {
    const createdPlan = buildSandboxCreatePlan({
      name: NAME,
      parentId: PARENT_ID,
      hostPort: 43_000,
      plan: INPUT.plan,
      secrets: [],
      resources: { cpus: 4, memoryMib: 8192, diskMib: 20480 },
      resourcesSpecified: true,
    });
    const builder = new RecordingBuilder();

    applySandboxCreatePlan(builder, createdPlan);

    expect(builder.calls).toEqual([
      ["image", GUEST_IMAGE],
      ["rootDisk", 20480],
      ["cpus", 4],
      ["memory", 8192],
      ["maxMemory", MAX_MEMORY_MIB],
      ["metricsSampleIntervalMs", METRICS_SAMPLE_INTERVAL_MS],
      ["detached", true],
      ["init", GUEST_INIT_COMMAND, [...GUEST_INIT_ARGS]],
      ["port", 43_000, 6767],
      ["labels", createdPlan.labels],
      ["env", "PATH", GUEST_PATH],
      ["env", PLAN_ENV_VAR, JSON.stringify(INPUT.plan)],
      ["env", RESOURCES_ENV_VAR, createdPlan.env[RESOURCES_ENV_VAR]],
      ["env", RESOURCES_SPECIFIED_ENV_VAR, "1"],
    ]);
  });

  it("reports only names with non-empty values and ignores duplicates", () => {
    const resolution = resolveSelectedSecrets(
      ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENAI_API_KEY"],
      { ANTHROPIC_API_KEY: "anthropic-secret", OPENAI_API_KEY: "  " },
    );

    expect(resolution.status).toBe("missing");
    if (resolution.status === "missing") expect(resolution.missing).toEqual(["OPENAI_API_KEY"]);
  });
});

/** Records the builder calls so the create-plan order stays pinned. */
class RecordingBuilder implements SandboxBuilderLike {
  readonly calls: (readonly [string, ...unknown[]])[] = [];

  image(image: string): this {
    return this.record("image", image);
  }

  rootDisk(sizeMiB: number): this {
    return this.record("rootDisk", sizeMiB);
  }

  cpus(count: number): this {
    return this.record("cpus", count);
  }

  memory(mib: number): this {
    return this.record("memory", mib);
  }

  maxMemory(mib: number): this {
    return this.record("maxMemory", mib);
  }

  metricsSampleIntervalMs(ms: number): this {
    return this.record("metricsSampleIntervalMs", ms);
  }

  detached(enabled: boolean): this {
    return this.record("detached", enabled);
  }

  init(command: string, args?: string[]): this {
    return this.record("init", command, args);
  }

  port(hostPort: number, guestPort: number): this {
    return this.record("port", hostPort, guestPort);
  }

  labels(labels: Readonly<Record<string, string>>): this {
    return this.record("labels", labels);
  }

  env(key: string, value: string): this {
    return this.record("env", key, value);
  }

  private record(name: string, ...args: unknown[]): this {
    this.calls.push([name, ...args]);
    return this;
  }
}

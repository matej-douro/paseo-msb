import { describe, expect, it } from "vitest";
import {
  GUEST_IMAGE,
  GUEST_INIT_ARGS,
  GUEST_INIT_COMMAND,
  GUEST_PATH,
  MANAGED_LABEL,
  PARENT_LABEL,
  PHASE_LABEL,
  PLUGIN_VERSION,
} from "../../shared/constants";
import type { VmCreateInput } from "../../shared/contracts";
import { safeError } from "../../shared/errors";
import { createVm, startCreate, type CreateContext } from "../../server/create";
import { createLifecycleLanes } from "../../server/lanes";
import { createPendingCreateStore } from "../../server/pending";
import { buildSandboxCreatePlan } from "../../server/sandbox";
import { resolveSelectedSecrets } from "../../server/secrets";
import { buildVmList } from "../../server/status";
import {
  fakeRuntime,
  fakeSandbox,
  FakePaseoHosts,
  FakeSandboxCreator,
  memorySecretsStore,
  PARENT_ID,
  SECRET_VALUE,
  unavailableSecretsStore,
} from "./fake-runtime";

const REQUEST_ID = "2f8f4c2e-8e52-4d0e-9db1-1a2b3c4d5e6f";
const NAME = `paseo-${REQUEST_ID}`;

const INPUT: VmCreateInput = {
  requestId: REQUEST_ID,
  secretEnvVars: ["ANTHROPIC_API_KEY"],
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
    expect(context.pending.find(REQUEST_ID)).toMatchObject({
      name: NAME,
      credentialNames: ["ANTHROPIC_API_KEY"],
      phase: "creating",
      errorCode: null,
    });

    gate.resolve();
    await attempt.started;

    expect(context.pending.find(REQUEST_ID)).toBeNull();
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
      label: `${PARENT_ID}/${NAME}`,
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

  it("starts one attempt for a repeated request ID", async () => {
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

  it("joins an owned sandbox from an earlier attempt without creating another", async () => {
    const sandbox = fakeSandbox({ id: "sandbox_existing", name: NAME, phase: "ready" });
    const creator = new FakeSandboxCreator({ existing: sandbox });
    const context = createContext(creator);

    const attempt = await startCreate(context, INPUT);
    await attempt.started;

    expect(creator.createCount).toBe(0);
    expect(context.hosts).toBeInstanceOf(FakePaseoHosts);
  });

  it("rejects a repeated request with different credential names", async () => {
    const gate = deferred<void>();
    const creator = new FakeSandboxCreator({ createGate: gate.promise });
    const context = createContext(creator);

    const first = await startCreate(context, INPUT);

    await expect(
      startCreate(context, { ...INPUT, secretEnvVars: ["GH_TOKEN"] }),
    ).rejects.toThrow(safeError("invalid_request").message);

    gate.resolve();
    await first.started;
  });

  it("rejects different credential names for an existing sandbox", async () => {
    const sandbox = fakeSandbox({
      id: "sandbox_existing",
      name: NAME,
      phase: "ready",
      configExtras: {
        env: [{ name: "ANTHROPIC_API_KEY", value: SECRET_VALUE }],
      },
    });
    const creator = new FakeSandboxCreator({ existing: sandbox });
    const context = createContext(creator);

    await expect(
      startCreate(context, { ...INPUT, secretEnvVars: ["GH_TOKEN"] }),
    ).rejects.toThrow(safeError("invalid_request").message);
  });

  it("reports a pre-create failure and retries it under the same request ID", async () => {
    const creator = new FakeSandboxCreator({
      createFailures: [new Error("image pull failed")],
    });
    const context = createContext(creator);

    const attempt = await startCreate(context, INPUT);
    await attempt.started;

    expect(context.pending.find(REQUEST_ID)).toMatchObject({
      name: NAME,
      phase: "failed",
      errorCode: "create_failed",
    });

    const retry = await startCreate(context, INPUT);
    await retry.started;

    expect(context.pending.find(REQUEST_ID)).toBeNull();
    expect(creator.createCount).toBe(2);
  });

  it("marks the sandbox with a retryable error when the Pi install exits non-zero", async () => {
    const creator = new FakeSandboxCreator({ jobExitCode: 7 });
    const context = createContext(creator);

    const attempt = await startCreate(context, INPUT);
    await attempt.started;

    const created = await creator.find(NAME);
    expect(created!.config()).toMatchObject({
      labels: {
        [PHASE_LABEL]: "installing",
        "paseo-msb-error": "install_failed",
      },
    });
    expect(creator.labelUpdates).toContainEqual({
      [PHASE_LABEL]: "installing",
    });
  });

  it("keeps a launch failure retryable instead of starting a second job", async () => {
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
        "paseo-msb-error": "install_pending",
      },
    });
  });

  it("marks the sandbox path_unverified when Pi is not on the daemon PATH", async () => {
    const creator = new FakeSandboxCreator({ execOutput: "not-pi\n0.0.1\n" });
    const context = createContext(creator);

    const attempt = await startCreate(context, INPUT);
    await attempt.started;

    const created = await creator.find(NAME);
    expect(created!.config()).toMatchObject({
      labels: {
        [PHASE_LABEL]: "installing",
        "paseo-msb-error": "path_unverified",
      },
    });
  });

  it("rejects a create whose selected credentials are absent", async () => {
    const creator = new FakeSandboxCreator();
    const context = createContext(creator);

    await expect(
      createVm(context, {
        requestId: REQUEST_ID,
        secretEnvVars: ["GEMINI_API_KEY"],
      }),
    ).rejects.toThrow(safeError("missing_credentials").message);

    expect(creator.createCount).toBe(0);
    expect(context.pending.find(REQUEST_ID)).toBeNull();
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

    await expect(createVm(context, INPUT)).rejects.toThrow(
      safeError("secrets_unavailable").message,
    );
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

    expect(context.pending.find(REQUEST_ID)).toMatchObject({
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

    const pending = context.pending.find(REQUEST_ID);
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

    const plan = buildSandboxCreatePlan({
      name: NAME,
      parentId: PARENT_ID,
      hostPort: 43_000,
      secrets: resolution.secrets,
    });

    expect(plan.name).toBe(NAME);
    expect(plan.image).toBe(GUEST_IMAGE);
    expect(plan.cpus).toBe(2);
    expect(plan.memoryMib).toBe(2048);
    expect(plan.detached).toBe(true);
    expect(plan.init).toEqual({ command: GUEST_INIT_COMMAND, args: GUEST_INIT_ARGS });
    expect(plan.hostPort).toBe(43_000);
    expect(plan.guestPort).toBe(6767);
    expect(plan.env).toEqual({ PATH: GUEST_PATH });
    expect(plan.labels).toEqual({
      [MANAGED_LABEL]: PLUGIN_VERSION,
      [PARENT_LABEL]: PARENT_ID,
      [PHASE_LABEL]: "creating",
    });

    for (const secret of plan.secrets) {
      expect(secret.substitution).toEqual({ headers: true, query: false, body: false });
    }
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

import { describe, expect, it } from "vitest";
import {
  GUEST_IMAGE,
  GUEST_INIT_ARGS,
  GUEST_INIT_COMMAND,
  GUEST_PATH,
  JOB_LABEL,
  MANAGED_LABEL,
  PARENT_LABEL,
  PHASE_LABEL,
  SANDBOX_ID_LABEL,
} from "../../shared/constants";
import type { VmCreateInput } from "../../shared/contracts";
import { safeError } from "../../shared/errors";
import { createVm, startCreate, type CreateContext } from "../../server/create";
import { createPendingCreateStore } from "../../server/pending";
import { piInstallSpec, piPathCheckSpec } from "../../server/pi-install";
import { buildSandboxCreatePlan } from "../../server/sandbox";
import { resolveSelectedSecrets } from "../../server/secrets";
import { buildVmList } from "../../server/status";
import {
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

async function waitFor(predicate: () => boolean, deadlineMs = 1000): Promise<void> {
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
    creator,
    env: { ANTHROPIC_API_KEY: SECRET_VALUE, GH_TOKEN: "gh-secret-value" },
    pending: createPendingCreateStore(),
    secretsStore: memorySecretsStore(),
    installTimeoutMs: 250,
    timeoutMs: 250,
    pollMs: 1,
    ...overrides,
  };
}

describe("createVm", () => {
  it("returns the generated name immediately and finishes Pi readiness in the background", async () => {
    const gate = deferred<void>();
    const creator = new FakeSandboxCreator({ createGate: gate.promise });
    const hosts = new FakePaseoHosts();
    const context = createContext(creator, { hosts });

    const attempt = startCreate(context, INPUT);

    expect(attempt.name).toBe(NAME);
    expect(context.pending.find(REQUEST_ID)).toMatchObject({
      name: NAME,
      phase: "creating",
      errorCode: null,
    });

    await tick();
    expect(creator.createCount).toBe(1);
    expect(context.pending.find(REQUEST_ID)?.phase).toBe("creating");

    gate.resolve();
    await attempt.started;

    expect(context.pending.list()).toEqual([]);
    expect(creator.requests).toEqual([
      {
        name: NAME,
        parentId: PARENT_ID,
        hostPort: 41_000,
        secrets: [
          {
            envVar: "ANTHROPIC_API_KEY",
            value: SECRET_VALUE,
            allowedHosts: ["api.anthropic.com"],
          },
        ],
      },
    ]);
    expect(creator.labelUpdates).toEqual([
      { [SANDBOX_ID_LABEL]: "sandbox_1", [PHASE_LABEL]: "installing" },
      { [JOB_LABEL]: "job_1" },
      { [PHASE_LABEL]: "registering" },
      { [PHASE_LABEL]: "ready" },
    ]);
    expect(creator.execSpecs).toEqual([piInstallSpec(), piPathCheckSpec()]);
    expect(hosts.added).toEqual([
      {
        connection: "127.0.0.1:41000",
        label: `${PARENT_ID}/${NAME}`,
        metadata: { source: "paseo-msb", vm: "sandbox_1", name: NAME },
        sourceKey: "sandbox_1",
      },
    ]);
    expect(hosts.clients).toEqual(["srv_child"]);
    expect(hosts.disposed).toBe(1);
  });

  it("resolves the RPC before host work completes", async () => {
    const gate = deferred<void>();
    const creator = new FakeSandboxCreator({ createGate: gate.promise });
    const context = createContext(creator);

    const result = await createVm(context, INPUT);

    expect(result).toEqual({ name: NAME });
    expect(context.pending.list()).toHaveLength(1);

    gate.resolve();
    await waitFor(() => context.pending.list().length === 0);
  });

  it("starts one attempt for a repeated request ID", async () => {
    const gate = deferred<void>();
    const creator = new FakeSandboxCreator({ createGate: gate.promise });
    const context = createContext(creator);

    const first = startCreate(context, INPUT);
    const second = startCreate(context, INPUT);
    await second.started;
    await waitFor(() => creator.createCount === 1);

    expect(second.name).toBe(NAME);
    expect(creator.createCount).toBe(1);

    gate.resolve();
    await first.started;
    expect(creator.createCount).toBe(1);
    expect(context.pending.list()).toEqual([]);
  });

  it("accepts an owned sandbox from an earlier attempt without creating another", async () => {
    const creator = new FakeSandboxCreator({
      existing: fakeSandbox({ id: "sandbox_owned", name: NAME, phase: "registering" }),
    });
    const context = createContext(creator);

    const attempt = startCreate(context, INPUT);
    await attempt.started;

    expect(creator.createCount).toBe(0);
    expect(context.pending.list()).toEqual([]);
  });

  it("refuses a same-name replacement instead of adopting it", async () => {
    const creator = new FakeSandboxCreator({
      existing: fakeSandbox({
        id: "sandbox_replacement",
        name: NAME,
        labels: { [SANDBOX_ID_LABEL]: "sandbox_original" },
      }),
    });
    const context = createContext(creator);

    await startCreate(context, INPUT).started;

    expect(creator.createCount).toBe(0);
    expect(context.pending.find(REQUEST_ID)).toMatchObject({
      phase: "failed",
      errorCode: "name_conflict",
    });
  });

  it("refuses an unmanaged sandbox that already has the generated name", async () => {
    const creator = new FakeSandboxCreator({
      existing: fakeSandbox({
        id: "sandbox_foreign",
        name: NAME,
        labels: { [MANAGED_LABEL]: "v2" },
      }),
    });
    const context = createContext(creator);

    await startCreate(context, INPUT).started;

    expect(creator.createCount).toBe(0);
    expect(context.pending.find(REQUEST_ID)?.errorCode).toBe("name_conflict");
  });

  it("reports a pre-create failure and retries it under the same request ID", async () => {
    const creator = new FakeSandboxCreator({
      createFailures: [new Error("image pull failed")],
    });
    const context = createContext(creator);

    await startCreate(context, INPUT).started;

    expect(context.pending.find(REQUEST_ID)).toMatchObject({
      name: NAME,
      phase: "failed",
      errorCode: "create_failed",
    });

    const retry = startCreate(context, INPUT);

    expect(retry.name).toBe(NAME);
    await retry.started;

    expect(creator.createCount).toBe(2);
    expect(context.pending.list()).toEqual([]);
  });

  it("marks the sandbox failed when the Pi install exits non-zero", async () => {
    const creator = new FakeSandboxCreator({ jobExitCode: 1 });
    const context = createContext(creator);

    await startCreate(context, INPUT).started;

    expect(creator.labelUpdates).toEqual([
      { [SANDBOX_ID_LABEL]: "sandbox_1", [PHASE_LABEL]: "installing" },
      { [JOB_LABEL]: "job_1" },
      { [PHASE_LABEL]: "failed", "paseo-msb-error": "install_failed" },
    ]);
  });

  it("marks the sandbox failed when the detached job cannot start", async () => {
    const creator = new FakeSandboxCreator({
      execDetachedError: new Error("job backend unavailable"),
    });
    const context = createContext(creator);

    await startCreate(context, INPUT).started;

    expect(creator.labelUpdates.at(-1)).toEqual({
      [PHASE_LABEL]: "failed",
      "paseo-msb-error": "install_failed",
    });
  });

  it("marks the sandbox failed when Pi is not on the daemon PATH", async () => {
    const creator = new FakeSandboxCreator({ execOutput: "/usr/bin/pi\n1.1.0\n" });
    const context = createContext(creator);

    await startCreate(context, INPUT).started;

    expect(creator.labelUpdates.at(-1)).toEqual({
      [PHASE_LABEL]: "failed",
      "paseo-msb-error": "path_unverified",
    });
  });

  it("rejects a create whose selected credentials are absent", async () => {
    const creator = new FakeSandboxCreator();
    const context = createContext(creator);
    const input: VmCreateInput = { requestId: REQUEST_ID, secretEnvVars: ["OPENAI_API_KEY"] };

    expect(() => startCreate(context, input)).toThrow(
      safeError("missing_credentials").message,
    );
    await expect(createVm(context, input)).rejects.toThrow(
      safeError("missing_credentials").message,
    );

    expect(context.pending.list()).toEqual([]);
    expect(creator.createCount).toBe(0);
  });

  it("resolves a plugin-stored credential before the parent environment", async () => {
    const creator = new FakeSandboxCreator();
    const context = createContext(creator, {
      env: { ANTHROPIC_API_KEY: "env-value" },
      secretsStore: memorySecretsStore({ ANTHROPIC_API_KEY: "stored-value" }),
    });

    const attempt = startCreate(
      context,
      INPUT,
      new Map([["ANTHROPIC_API_KEY", "stored-value"]]),
    );
    await attempt.started;

    expect(creator.requests[0].secrets).toEqual([
      {
        envVar: "ANTHROPIC_API_KEY",
        value: "stored-value",
        allowedHosts: ["api.anthropic.com"],
      },
    ]);
  });

  it("reads the plugin store when vm.create resolves credentials", async () => {
    const creator = new FakeSandboxCreator();
    const context = createContext(creator, {
      env: {},
      secretsStore: memorySecretsStore({ GH_TOKEN: "stored-gh-token" }),
    });
    const input: VmCreateInput = { requestId: REQUEST_ID, secretEnvVars: ["GH_TOKEN"] };

    await expect(createVm(context, input)).resolves.toEqual({ name: NAME });
    await waitFor(() => creator.requests.length === 1);

    expect(creator.requests[0].secrets[0]).toMatchObject({
      envVar: "GH_TOKEN",
      value: "stored-gh-token",
    });
    await waitFor(() => context.pending.list().length === 0);
  });

  it("fails safely when the credential store is unavailable", async () => {
    const creator = new FakeSandboxCreator();
    const context = createContext(creator, { secretsStore: unavailableSecretsStore() });

    await expect(createVm(context, INPUT)).rejects.toThrow(
      safeError("secrets_unavailable").message,
    );

    expect(context.pending.list()).toEqual([]);
    expect(creator.createCount).toBe(0);
  });

  it("retries creation on a new loopback port after a bind failure", async () => {
    const creator = new FakeSandboxCreator({
      createFailures: [new Error("bind: address already in use")],
      hostPorts: [41_001, 41_002],
    });
    const context = createContext(creator);

    await startCreate(context, INPUT).started;

    expect(creator.probeCount).toBe(2);
    expect(creator.requests.map((request) => request.hostPort)).toEqual([41_001, 41_002]);
    expect(creator.labelUpdates.at(-1)).toEqual({ [PHASE_LABEL]: "ready" });
    expect(context.pending.list()).toEqual([]);
  });

  it("reports an exhausted port retry budget", async () => {
    const creator = new FakeSandboxCreator({
      createFailures: [
        new Error("bind: address already in use"),
        new Error("bind: address already in use"),
        new Error("bind: address already in use"),
      ],
    });
    const context = createContext(creator);

    await startCreate(context, INPUT).started;

    expect(creator.createCount).toBe(3);
    expect(context.pending.find(REQUEST_ID)?.errorCode).toBe("port_unavailable");
  });

  it("reports an unavailable port probe", async () => {
    const creator = new FakeSandboxCreator({ probeError: new Error("no loopback") });
    const context = createContext(creator);

    await startCreate(context, INPUT).started;

    expect(creator.createCount).toBe(0);
    expect(context.pending.find(REQUEST_ID)?.errorCode).toBe("port_unavailable");
  });

  it("reports an unavailable parent directory without touching the runtime", async () => {
    const creator = new FakeSandboxCreator();
    const context = createContext(creator, {
      hosts: new FakePaseoHosts({ listError: new Error("parent directory unavailable: leaked detail") }),
    });

    await startCreate(context, INPUT).started;

    expect(creator.createCount).toBe(0);
    expect(context.pending.find(REQUEST_ID)?.errorCode).toBe("runtime_unavailable");
    expect(JSON.stringify(context.pending.list())).not.toContain("leaked detail");
  });

  it("never writes credential values into pending state or labels", async () => {
    const creator = new FakeSandboxCreator({
      createFailures: [new Error(`pull failed with ${SECRET_VALUE}`)],
    });
    const context = createContext(creator);

    await startCreate(context, INPUT).started;

    const persisted = JSON.stringify({
      pending: context.pending.list(),
      labels: creator.labelUpdates,
    });
    expect(persisted).not.toContain(SECRET_VALUE);
    expect(persisted).not.toContain("pull failed");

    const retryCreator = new FakeSandboxCreator();
    const retryContext = createContext(retryCreator);
    await startCreate(retryContext, INPUT).started;

    expect(
      JSON.stringify({ pending: retryContext.pending.list(), labels: retryCreator.labelUpdates }),
    ).not.toContain(SECRET_VALUE);
  });

  it("keeps a pending create visible through the list projection", async () => {
    const gate = deferred<void>();
    const creator = new FakeSandboxCreator({ createGate: gate.promise });
    const context = createContext(creator);

    startCreate(context, INPUT);
    await tick();

    const list = buildVmList({
      parentId: PARENT_ID,
      inventory: { status: "available", sandboxes: [], failures: [] },
      registrations: { status: "available", hosts: [] },
      pending: context.pending.list(),
      env: context.env,
    });

    expect(list.children[0]).toEqual({
      kind: "pending",
      name: NAME,
      phase: "creating",
      error: null,
    });

    gate.resolve();
    await waitFor(() => context.pending.list().length === 0);
  });
});

describe("sandbox create plan", () => {
  it("pins the image, resources, init, loopback port, PATH, labels, and header-only secrets", () => {
    const resolution = resolveSelectedSecrets(
      ["ANTHROPIC_API_KEY", "GH_TOKEN"],
      { ANTHROPIC_API_KEY: SECRET_VALUE, GH_TOKEN: "gh-secret-value" },
    );
    expect(resolution.status).toBe("ok");
    if (resolution.status !== "ok") return;

    const plan = buildSandboxCreatePlan({
      name: NAME,
      parentId: PARENT_ID,
      hostPort: 42_000,
      secrets: resolution.secrets,
    });

    expect(plan).toMatchObject({
      name: NAME,
      image: GUEST_IMAGE,
      cpus: 2,
      memoryMib: 2048,
      detached: true,
      init: { command: GUEST_INIT_COMMAND, args: [...GUEST_INIT_ARGS] },
      hostPort: 42_000,
      guestPort: 6767,
      env: { PATH: GUEST_PATH },
      labels: {
        [MANAGED_LABEL]: "v1",
        [PARENT_LABEL]: PARENT_ID,
        [PHASE_LABEL]: "creating",
      },
    });

    expect(plan.secrets.map((secret) => secret.envVar)).toEqual([
      "ANTHROPIC_API_KEY",
      "GH_TOKEN",
    ]);
    expect(plan.secrets[0].substitution).toEqual({ headers: true, query: false, body: false });
    expect(plan.secrets[0].allowedHosts).toEqual(["api.anthropic.com"]);
    expect(plan.secrets[1].allowedHosts).toEqual([
      "api.github.com",
      "github.com",
      "uploads.github.com",
    ]);
  });

  it("reports only names with non-empty values and ignores duplicates", () => {
    const resolution = resolveSelectedSecrets(
      ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"],
      { ANTHROPIC_API_KEY: SECRET_VALUE, OPENAI_API_KEY: "  " },
    );

    expect(resolution).toEqual({
      status: "missing",
      missing: ["OPENAI_API_KEY"],
    });
  });
});

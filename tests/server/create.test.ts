import test from "node:test";
import assert from "node:assert/strict";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import {
  CHILD,
  FIXED_RESOURCES,
  GUEST_PATH,
  INIT,
  LABELS,
  PI,
} from "../../shared/constants";
import {
  VmCreateInputSchema,
  type ManagedLabels,
} from "../../shared/contracts";
import { createCreateHandler, safeCodeForCreateError } from "../../server/create";
import { buildSandboxBuilder } from "../../server/sandbox";
import { resolveSecretMaterial } from "../../server/secrets";
import {
  FAKE_CREDENTIAL_VALUES,
  FakeSandboxRuntime,
  deferred,
} from "./fake-runtime";

const parentServerId = "srv_test_parent";
const requestId = "11111111-1111-4111-8111-111111111111";
const sandboxName = `paseo-${requestId}`;

const parentDirectory = {
  self: { serverId: parentServerId, label: "Test Parent" },
  hosts: [],
};

function context(): PluginHandlerContext {
  return {
    paseo: {
      hosts: {
        list: async () => parentDirectory,
      },
    },
  } as unknown as PluginHandlerContext;
}

function input(secretEnvVars = ["ANTHROPIC_API_KEY", "GH_TOKEN"]) {
  return VmCreateInputSchema.parse({ requestId, secretEnvVars });
}

function env(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...FAKE_CREDENTIAL_VALUES, ...overrides };
}

function namedError(name: string, message = "fake runtime failure"): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

function labelsOf(sandbox: { labels: Record<string, string> }): ManagedLabels {
  return sandbox.labels as unknown as ManagedLabels;
}

test("vm.create returns the request-derived name and completes setup in the background", async () => {
  const pending = new Map();
  const runtime = new FakeSandboxRuntime();
  const handler = createCreateHandler({
    pending,
    runtime,
    env: env(),
    sleep: async () => {},
  });

  const output = await handler.create(input(), context());
  assert.deepEqual(output, { name: sandboxName });

  await handler.idle();

  assert.equal(runtime.createCalls.length, 1);
  const call = runtime.createCalls[0];
  assert.equal(call.options.name, sandboxName);
  assert.equal(call.options.parentServerId, parentServerId);
  assert.equal(call.options.hostPort, 0);
  assert.deepEqual(call.options.labels, {
    [LABELS.managed]: LABELS.version,
    [LABELS.parent]: parentServerId,
    [LABELS.phase]: "creating",
  });
  assert.deepEqual(
    call.options.secrets.map((secret) => secret.env),
    ["ANTHROPIC_API_KEY", "GH_TOKEN"],
  );
  assert.deepEqual(
    call.options.secrets.map((secret) => secret.hosts),
    [["api.anthropic.com"], ["api.github.com", "github.com", "uploads.github.com"]],
  );

  const sandbox = runtime.sandboxes[0];
  const labels = labelsOf(sandbox);
  assert.equal(labels[LABELS.managed], LABELS.version);
  assert.equal(labels[LABELS.parent], parentServerId);
  assert.equal(labels[LABELS.id], sandbox.id);
  assert.equal(labels[LABELS.phase], "registering");
  assert.equal(labels[LABELS.job], `fake-job-${sandbox.id}`);
  assert.equal(pending.size, 0);
  assert.deepEqual(
    sandbox.modifyCalls
      .map((entry) => entry[LABELS.phase])
      .filter((phase) => phase !== undefined),
    ["installing", "registering"],
  );

  const install = sandbox.detachedCalls[0];
  assert.equal(install.command, "npm");
  assert.deepEqual(install.options?.args, [
    "install",
    "-g",
    "--prefix",
    PI.installPrefix,
    `${PI.package}@${PI.version}`,
  ]);
  assert.equal(install.options?.user, CHILD.user);
  assert.equal(install.options?.env?.HOME, CHILD.home);
  assert.equal(install.options?.env?.PATH, GUEST_PATH);
  assert.equal(install.options?.env?.NPM_CONFIG_PREFIX, PI.installPrefix);
  assert.equal(
    sandbox.execCalls.some((entry) => entry.command === "pi"),
    true,
  );
  assert.equal(
    sandbox.execCalls.some((entry) => entry.command === "printenv"),
    true,
  );
});

test("a repeated request ID never starts a second create", async () => {
  const pending = new Map();
  const gate = deferred<void>();
  const runtime = new FakeSandboxRuntime({ createGate: gate });
  const handler = createCreateHandler({
    pending,
    runtime,
    env: env(),
    sleep: async () => {},
  });

  const [first, second] = await Promise.all([
    handler.create(input(), context()),
    handler.create(input(), context()),
  ]);

  assert.deepEqual(first, { name: sandboxName });
  assert.deepEqual(second, { name: sandboxName });
  assert.equal(pending.size, 1);
  assert.equal(runtime.createCalls.length, 1);

  gate.resolve();
  await handler.idle();

  assert.equal(runtime.createCalls.length, 1);
  assert.equal(runtime.sandboxes.length, 1);
  assert.equal(pending.size, 0);
});

test("missing credentials fail the pending create without starting a sandbox", async () => {
  const pending = new Map();
  const runtime = new FakeSandboxRuntime();
  const handler = createCreateHandler({
    pending,
    runtime,
    env: {},
    sleep: async () => {},
  });

  await handler.create(input(["ANTHROPIC_API_KEY"]), context());
  await handler.idle();

  const failed = pending.get(requestId);
  assert.equal(failed?.phase, "failed");
  assert.equal(failed?.error?.code, "credentials_missing");
  assert.equal(runtime.createCalls.length, 0);
  assert.equal(JSON.stringify(failed).includes("fake-anthropic-value"), false);
});

test("image pull, boot, and name-conflict failures use safe codes", async () => {
  const cases = [
    { name: "ImageError", code: "image_pull_failed" },
    { name: "BootError", code: "sandbox_boot_failed" },
    { name: "SandboxAlreadyExistsError", code: "create_name_conflict" },
  ] as const;

  for (const entry of cases) {
    const pending = new Map();
    const runtime = new FakeSandboxRuntime({
      createError: () => namedError(entry.name, "fake failure detail"),
    });
    const handler = createCreateHandler({
      pending,
      runtime,
      env: env(),
      sleep: async () => {},
    });

    await handler.create(input(), context());
    await handler.idle();

    const failed = pending.get(requestId);
    assert.equal(failed?.phase, "failed");
    assert.equal(failed?.error?.code, entry.code);
    assert.equal(runtime.createCalls.length, 1);
    assert.equal(runtime.sandboxes.length, 0);
    assert.equal(runtime.sandboxes.some((sandbox) => sandbox.destroyed), false);
  }
});

test("Pi install failure leaves a failed sandbox with its IDs persisted", async () => {
  const pending = new Map();
  const runtime = new FakeSandboxRuntime({
    jobStates: [{ state: "exited", exitCode: 1 }],
  });
  const handler = createCreateHandler({
    pending,
    runtime,
    env: env(),
    sleep: async () => {},
  });

  await handler.create(input(), context());
  await handler.idle();

  assert.equal(pending.size, 0);
  const sandbox = runtime.sandboxes[0];
  const labels = labelsOf(sandbox);
  assert.equal(labels[LABELS.id], sandbox.id);
  assert.equal(labels[LABELS.job], `fake-job-${sandbox.id}`);
  assert.equal(labels[LABELS.phase], "failed");
  assert.equal(labels[LABELS.error], "pi_install_failed");
  assert.equal(sandbox.destroyed, false);
});

test("Pi PATH verification failure is a safe failed phase", async () => {
  const pending = new Map();
  const runtime = new FakeSandboxRuntime({
    execHandler: (command, options) => {
      if (command === "pi" && options?.args?.[0] === "--version") {
        return { success: false, code: 1, stdout: "", stderr: "" };
      }
      if (command === "which" && options?.args?.[0] === "pi") {
        return { success: true, code: 0, stdout: `${PI.pathEntry}/pi`, stderr: "" };
      }
      if (command === "printenv" && options?.args?.[0] === "PATH") {
        return { success: true, code: 0, stdout: GUEST_PATH, stderr: "" };
      }
      return { success: true, code: 0, stdout: "", stderr: "" };
    },
  });
  const handler = createCreateHandler({
    pending,
    runtime,
    env: env(),
    sleep: async () => {},
  });

  await handler.create(input(), context());
  await handler.idle();

  const sandbox = runtime.sandboxes[0];
  const labels = labelsOf(sandbox);
  assert.equal(labels[LABELS.phase], "failed");
  assert.equal(labels[LABELS.error], "pi_path_unverified");
});

test("loopback host port zero falls back to a probed port and retries creation", async () => {
  const pending = new Map();
  const runtime = new FakeSandboxRuntime({
    assignedPorts: [null, 45678],
    probePorts: [45678],
  });
  const handler = createCreateHandler({
    pending,
    runtime,
    env: env(),
    sleep: async () => {},
  });

  await handler.create(input(), context());
  await handler.idle();

  assert.equal(runtime.createCalls.length, 2);
  assert.equal(runtime.createCalls[0].options.hostPort, 0);
  assert.equal(runtime.createCalls[1].options.hostPort, 45678);
  assert.deepEqual(runtime.probeCalls, [45678]);
  assert.equal(runtime.sandboxes[0].destroyed, true);
  assert.equal(runtime.sandboxes[1].destroyed, false);
  assert.equal(labelsOf(runtime.sandboxes[1])[LABELS.phase], "registering");
  assert.equal(pending.size, 0);
});

test("a create-time port error retries with a probed loopback port", async () => {
  const pending = new Map();
  const runtime = new FakeSandboxRuntime({
    createError: (attempt) =>
      attempt === 0 ? namedError("PortBindError", "address already in use") : null,
    probePorts: [45679],
  });
  const handler = createCreateHandler({
    pending,
    runtime,
    env: env(),
    sleep: async () => {},
  });

  await handler.create(input(), context());
  await handler.idle();

  assert.equal(runtime.createCalls.length, 2);
  assert.equal(runtime.createCalls[0].options.hostPort, 0);
  assert.equal(runtime.createCalls[1].options.hostPort, 45679);
  assert.deepEqual(runtime.probeCalls, [45679]);
  assert.equal(labelsOf(runtime.sandboxes[0])[LABELS.phase], "registering");
});

test("background failure text is not stored with pending state", async () => {
  const pending = new Map();
  const fakeSecret = FAKE_CREDENTIAL_VALUES.ANTHROPIC_API_KEY;
  const runtime = new FakeSandboxRuntime({
    createError: () => namedError("BootError", `failed with ${fakeSecret}`),
  });
  const handler = createCreateHandler({
    pending,
    runtime,
    env: env(),
    sleep: async () => {},
  });

  await handler.create(input(), context());
  await handler.idle();

  const failed = pending.get(requestId);
  const serialized = JSON.stringify(failed);
  assert.equal(serialized.includes(fakeSecret), false);
  assert.equal(serialized.includes("[redacted]"), false);
  assert.equal(failed?.error?.code, "sandbox_boot_failed");
});

test("creation-time secret material is private, redacts, and is disposable", () => {
  const resolved = resolveSecretMaterial(
    ["ANTHROPIC_API_KEY", "GH_TOKEN"],
    env(),
  );
  assert.equal(resolved.status, "ok");
  if (resolved.status !== "ok") return;

  const fakeSecret = FAKE_CREDENTIAL_VALUES.ANTHROPIC_API_KEY;
  assert.equal(
    resolved.material.redact(`token ${fakeSecret} done`),
    "token [redacted] done",
  );
  assert.equal(JSON.stringify(resolved.material).includes(fakeSecret), false);

  resolved.material.dispose();
  assert.equal(resolved.material.bindings().length, 0);
  assert.equal(resolved.material.redact(fakeSecret), fakeSecret);
});

test("static sandbox config uses fixed resources, loopback publishing, and header-only secrets", async () => {
  const resolved = resolveSecretMaterial(
    [
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "GEMINI_API_KEY",
      "NEURALWATT_API_KEY",
      "GH_TOKEN",
    ],
    env(),
  );
  assert.equal(resolved.status, "ok");
  if (resolved.status !== "ok") return;

  const config = (await buildSandboxBuilder({
    name: sandboxName,
    parentServerId,
    hostPort: 0,
    labels: {
      [LABELS.managed]: LABELS.version,
      [LABELS.parent]: parentServerId,
      [LABELS.phase]: "creating",
    },
    secrets: resolved.material.bindings(),
  }).build()) as {
    resources?: { cpus?: number; memoryMib?: number };
    init?: { cmd?: string; args?: string[] };
    env?: Array<{ key?: string; value?: string }>;
    labels?: Record<string, string>;
    network?: {
      ports?: Array<{ hostPort?: number; guestPort?: number; hostBind?: string }>;
      secrets?: {
        secrets?: Array<{
          envVar?: string;
          value?: string;
          placeholder?: string;
          allowedHosts?: Array<{ exact?: string }>;
          substitution?: { headers?: boolean; query?: boolean; body?: boolean };
          requireTlsIdentity?: boolean;
        }>;
      };
    };
  };

  const expectedHosts = {
    ANTHROPIC_API_KEY: ["api.anthropic.com"],
    OPENAI_API_KEY: ["api.openai.com"],
    GEMINI_API_KEY: ["generativelanguage.googleapis.com"],
    NEURALWATT_API_KEY: ["api.neuralwatt.com"],
    GH_TOKEN: ["api.github.com", "github.com", "uploads.github.com"],
  } as const;

  assert.equal(config.resources?.cpus, FIXED_RESOURCES.cpus);
  assert.equal(config.resources?.memoryMib, FIXED_RESOURCES.memoryMiB);
  assert.equal(config.init?.cmd, INIT.fallback.cmd);
  assert.deepEqual(config.init?.args, [...INIT.fallback.args]);
  assert.equal(
    config.env?.find((entry) => entry.key === "PASEO_PASSWORD"),
    undefined,
  );
  assert.equal(
    config.env?.find((entry) => entry.key === "PATH")?.value,
    GUEST_PATH,
  );
  assert.equal(
    config.env?.find((entry) => entry.key === "PASEO_LISTEN")?.value,
    CHILD.listen,
  );
  assert.deepEqual(config.labels, {
    [LABELS.managed]: LABELS.version,
    [LABELS.parent]: parentServerId,
    [LABELS.phase]: "creating",
  });

  const port = config.network?.ports?.[0];
  assert.equal(port?.guestPort, FIXED_RESOURCES.guestPort);
  assert.equal(port?.hostPort, 0);
  assert.equal(port?.hostBind, "127.0.0.1");

  const secrets = config.network?.secrets?.secrets ?? [];
  assert.equal(secrets.length, 5);
  for (const secret of secrets) {
    assert.equal(secret.substitution?.headers, true);
    assert.equal(secret.substitution?.query, false);
    assert.equal(secret.substitution?.body, false);
    assert.equal(secret.requireTlsIdentity, true);
    assert.ok(secret.placeholder);
    assert.equal(secret.placeholder?.includes(secret.value ?? ""), false);
    const expected = expectedHosts[secret.envVar as keyof typeof expectedHosts];
    assert.deepEqual(
      (secret.allowedHosts ?? []).map((entry) => entry.exact).sort(),
      [...expected].sort(),
    );
  }

  resolved.material.dispose();
});

test("create error classification is bounded to safe codes", () => {
  assert.equal(safeCodeForCreateError(namedError("ImageError")), "image_pull_failed");
  assert.equal(safeCodeForCreateError(namedError("BootError")), "sandbox_boot_failed");
  assert.equal(
    safeCodeForCreateError(namedError("SandboxAlreadyExistsError")),
    "create_name_conflict",
  );
  assert.equal(safeCodeForCreateError(namedError("PortBindError")), "port_unavailable");
  assert.equal(safeCodeForCreateError(new Error("unexpected")), "sandbox_boot_failed");
});

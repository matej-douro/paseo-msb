import test from "node:test";
import assert from "node:assert/strict";
import {
  CHILD,
  CREDENTIALS,
  FIXED_RESOURCES,
  IMAGE,
  LABELS,
  LOG_ENTRY_LIMIT,
  PARENT_DAEMON_VERSION,
  PI,
} from "../../shared/constants";
import {
  VmCreateInputSchema,
  VmDeleteInputSchema,
  VmDetailInputSchema,
  VmReconcileInputSchema,
  VmListOutputSchema,
  VM_RPCS,
  vmList,
} from "../../shared/contracts";
import { decodeManagedLabels, decodeSandboxHandle } from "../../server/sandbox";
import type { SandboxHandleView } from "../../server/sandbox";
import { availableCredentialNames } from "../../server/status";

const parentServerId = "srv_test_parent";
const sandboxId = "sandbox_test_1";

function managedConfig(overrides: Record<string, string> = {}) {
  return {
    labels: {
      [LABELS.managed]: LABELS.version,
      [LABELS.parent]: parentServerId,
      [LABELS.id]: sandboxId,
      [LABELS.phase]: "ready",
      ...overrides,
    },
    env: ["ANTHROPIC_API_KEY=fake-config-value"],
  };
}

test("pins match the statically verified vertical slice", () => {
  assert.equal(PARENT_DAEMON_VERSION, "0.15.0");
  assert.equal(IMAGE.tag, PARENT_DAEMON_VERSION);
  assert.equal(IMAGE.ref, `${IMAGE.repository}@${IMAGE.indexDigest}`);
  assert.equal(IMAGE.nodeVersion, "22.23.4");
  assert.equal(IMAGE.npmVersion, "10.9.9");
  assert.equal(PI.package, "@earendil-works/pi-coding-agent");
  assert.equal(PI.version, "1.5.0");
  assert.equal(PI.enginesNode, ">=22.19.0");
  assert.deepEqual(FIXED_RESOURCES, { cpus: 2, memoryMiB: 2048, guestPort: 6767 });
  assert.equal(CHILD.listen, "0.0.0.0:6767");
  assert.equal(CHILD.healthPath, "/api/health");
});

test("labels and fixed resources decode from persisted configuration only", () => {
  const labels = decodeManagedLabels(managedConfig(), sandboxId, parentServerId);
  assert.deepEqual(labels, {
    [LABELS.managed]: LABELS.version,
    [LABELS.parent]: parentServerId,
    [LABELS.id]: sandboxId,
    [LABELS.phase]: "ready",
  });
  assert.equal("env" in (labels ?? {}), false);
  assert.equal(JSON.stringify(labels).includes("fake-config-value"), false);

  assert.equal(
    decodeManagedLabels(managedConfig(), "sandbox_test_other", parentServerId),
    null,
  );
  assert.equal(decodeManagedLabels(managedConfig(), sandboxId, "srv_other_parent"), null);
  assert.equal(decodeManagedLabels({ env: [] }, sandboxId, parentServerId), null);
});

test("label-matched handles with invalid config stay visible as degraded", () => {
  const invalidIdLabels: SandboxHandleView = {
    id: sandboxId,
    name: "paseo-invalid-labels",
    status: "running",
    config: () => ({
      labels: {
        [LABELS.managed]: LABELS.version,
        [LABELS.parent]: parentServerId,
        [LABELS.id]: "sandbox_test_other",
        [LABELS.phase]: "unknown-phase",
      },
    }),
  };
  const invalidId = decodeSandboxHandle(invalidIdLabels, parentServerId);
  assert.equal(invalidId.status, "degraded");
  if (invalidId.status === "degraded") {
    assert.equal(invalidId.sandbox.id, sandboxId);
    assert.equal(invalidId.sandbox.labels, null);
  }

  const unreadableConfig: SandboxHandleView = {
    id: sandboxId,
    name: "paseo-unreadable-config",
    status: "crashed",
    config: () => {
      throw new Error("config unavailable");
    },
  };
  const degraded = decodeSandboxHandle(unreadableConfig, parentServerId);
  assert.equal(degraded.status, "degraded");
  if (degraded.status === "degraded") {
    assert.equal(degraded.sandbox.runtimeStatus, "crashed");
    assert.equal(degraded.sandbox.labels, null);
  }

  const foreign: SandboxHandleView = {
    id: sandboxId,
    name: "paseo-foreign",
    status: "running",
    config: () => ({
      labels: {
        [LABELS.managed]: LABELS.version,
        [LABELS.parent]: "srv_other_parent",
      },
    }),
  };
  assert.equal(decodeSandboxHandle(foreign, parentServerId).status, "foreign");

  const emptyLabels: SandboxHandleView = {
    id: sandboxId,
    name: "paseo-empty-labels",
    status: "running",
    config: () => ({ labels: {} }),
  };
  assert.equal(decodeSandboxHandle(emptyLabels, parentServerId).status, "foreign");
  assert.equal(
    decodeSandboxHandle(emptyLabels, parentServerId, { assumeManaged: true }).status,
    "degraded",
  );
});

test("the five credential mappings stay fixed and header-host scoped", () => {
  assert.deepEqual(
    CREDENTIALS.map((entry) => entry.env),
    [
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "GEMINI_API_KEY",
      "NEURALWATT_API_KEY",
      "GH_TOKEN",
    ],
  );
  assert.deepEqual(
    CREDENTIALS.map((entry) => entry.hosts),
    [
      ["api.anthropic.com"],
      ["api.openai.com"],
      ["generativelanguage.googleapis.com"],
      ["api.neuralwatt.com"],
      ["api.github.com", "github.com", "uploads.github.com"],
    ],
  );
});

test("available credentials expose names only", () => {
  const anthropic = "fake-anthropic-value";
  const github = "fake-github-value";
  const names = availableCredentialNames({
    ANTHROPIC_API_KEY: anthropic,
    OPENAI_API_KEY: "",
    GH_TOKEN: github,
  });

  assert.deepEqual(names, ["ANTHROPIC_API_KEY", "GH_TOKEN"]);
  assert.equal(JSON.stringify(names).includes(anthropic), false);
  assert.equal(JSON.stringify(names).includes(github), false);
});

test("contracts are exactly the five v1 RPCs", () => {
  assert.deepEqual(
    VM_RPCS.map((contract) => contract.name),
    ["vm.list", "vm.detail", "vm.create", "vm.delete", "vm.reconcile"],
  );
  vmList.output.parse({
    parent: null,
    pending: [],
    children: [],
    credentials: [],
    inventory: { status: "available", error: null },
    registrations: { status: "available", error: null },
  });
});

test("mutation contracts reject values that could carry secrets", () => {
  const requestId = "00000000-0000-4000-8000-000000000000";

  assert.equal(
    VmCreateInputSchema.safeParse({
      requestId,
      secretEnvVars: ["ANTHROPIC_API_KEY", "GH_TOKEN"],
    }).success,
    true,
  );
  assert.equal(VmCreateInputSchema.safeParse({ requestId, secretEnvVars: [] }).success, false);
  assert.equal(
    VmCreateInputSchema.safeParse({
      requestId,
      secretEnvVars: ["ANTHROPIC_API_KEY=fake-value"],
    }).success,
    false,
  );
  assert.equal(
    VmCreateInputSchema.safeParse({
      requestId,
      secretEnvVars: ["ANTHROPIC_API_KEY"],
      ANTHROPIC_API_KEY: "fake-value",
    }).success,
    false,
  );

  assert.equal(
    VmDetailInputSchema.safeParse({ name: "paseo-test", id: sandboxId }).success,
    true,
  );
  assert.equal(
    VmDeleteInputSchema.safeParse({
      name: "paseo-test",
      id: sandboxId,
      confirmName: "paseo-test",
    }).success,
    true,
  );
  assert.equal(
    VmDeleteInputSchema.safeParse({ name: "paseo-test", id: sandboxId }).success,
    false,
  );
  assert.equal(
    VmReconcileInputSchema.safeParse({ name: "paseo-test", id: sandboxId }).success,
    true,
  );
});

test("list output rejects unknown or secret-bearing fields", () => {
  const output = {
    parent: null,
    pending: [],
    children: [],
    credentials: [],
    inventory: { status: "available" as const, error: null },
    registrations: { status: "available" as const, error: null },
  };

  assert.equal(VmListOutputSchema.safeParse(output).success, true);
  assert.equal(
    VmListOutputSchema.safeParse({
      ...output,
      config: { env: ["ANTHROPIC_API_KEY=fake-value"] },
    }).success,
    false,
  );
  assert.equal(LOG_ENTRY_LIMIT, 40);
});

import test from "node:test";
import assert from "node:assert/strict";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import {
  LABELS,
  LOG_ENTRY_LIMIT,
  LOG_TEXT_LIMIT,
  LOG_TOTAL_LIMIT,
} from "../../shared/constants";
import {
  type ManagedLabels,
  type PendingChild,
  vmDetail,
  vmList,
} from "../../shared/contracts";
import { createReadHandlers } from "../../server/rpc";
import {
  lookupManagedSandbox,
  type ManagedSandbox,
  type RawLogs,
  type SandboxHandleView,
  type SandboxInventory,
} from "../../server/sandbox";

const parentServerId = "srv_test_parent";
const sandboxId = "sandbox_test_1";
const sandboxName = "paseo-00000000-0000-4000-8000-000000000000";
const fakeAnthropic = "fake-anthropic-value";
const fakeGitHub = "fake-github-value";

const parentDirectory = {
  self: { serverId: parentServerId, label: "Test Parent" },
  hosts: [
    {
      registrationId: "reg_test_1",
      serverId: "srv_test_child",
      label: `Test Parent/${sandboxName}`,
      source: { id: "plugin", key: sandboxId },
      metadata: {
        source: "paseo-msb",
        vm: sandboxId,
        name: sandboxName,
      },
      status: "online",
    },
  ],
};

function labels(overrides: Partial<ManagedLabels> = {}): ManagedLabels {
  return {
    [LABELS.managed]: LABELS.version,
    [LABELS.parent]: parentServerId,
    [LABELS.id]: sandboxId,
    [LABELS.phase]: "ready",
    ...overrides,
  } as ManagedLabels;
}

function sandbox(overrides: Partial<ManagedSandbox> = {}): ManagedSandbox {
  return {
    id: sandboxId,
    name: sandboxName,
    runtimeStatus: "running",
    labels: labels(),
    ...overrides,
  };
}

function context(list: () => Promise<unknown>): PluginHandlerContext {
  return {
    paseo: { hosts: { list } },
  } as unknown as PluginHandlerContext;
}

function fakeInventory(options: {
  listed?: readonly ManagedSandbox[];
  degraded?: number;
  lookup?:
    | { status: "found"; sandbox: ManagedSandbox }
    | { status: "not_found" };
  logs?: RawLogs;
  listError?: boolean;
  lookupError?: boolean;
}): SandboxInventory {
  return {
    async listManaged() {
      if (options.listError) throw new Error("inventory unavailable");
      return {
        sandboxes: options.listed ?? [],
        degraded: options.degraded ?? 0,
      };
    },
    async getManaged() {
      if (options.lookupError) throw new Error("inventory unavailable");
      return options.lookup ?? { status: "not_found" };
    },
    async readLogs() {
      return (
        options.logs ?? {
          sandbox: [],
          job: [],
          jobUnavailable: false,
        }
      );
    },
  };
}

test("vm.list joins managed sandboxes with parent registrations", async () => {
  const inventory = fakeInventory({ listed: [sandbox()] });
  const handlers = createReadHandlers({
    inventory,
    pendingCreates: new Map(),
    env: {
      ANTHROPIC_API_KEY: fakeAnthropic,
      GH_TOKEN: fakeGitHub,
    },
  });

  const output = await handlers.list({}, context(async () => parentDirectory));
  vmList.output.parse(output);

  assert.deepEqual(output.parent, {
    serverId: parentServerId,
    label: "Test Parent",
  });
  assert.equal(output.pending.length, 0);
  assert.equal(output.children.length, 1);
  assert.equal(output.children[0].id, sandboxId);
  assert.equal(output.children[0].name, sandboxName);
  assert.equal(output.children[0].runtimeStatus, "running");
  assert.equal(output.children[0].registration?.registrationId, "reg_test_1");
  assert.equal(output.children[0].registration?.status, "online");
  assert.deepEqual(output.credentials, ["ANTHROPIC_API_KEY", "GH_TOKEN"]);
  assert.equal(output.inventory.status, "available");
  assert.equal(output.registrations.status, "available");

  const serialized = JSON.stringify(output);
  assert.equal(serialized.includes(fakeAnthropic), false);
  assert.equal(serialized.includes(fakeGitHub), false);
  assert.equal(serialized.includes("fake-config-value"), false);
});

test("vm.list keeps degraded label-matched sandboxes visible with partial inventory", async () => {
  const degradedId = "sandbox_test_degraded";
  const degradedName = "paseo-11111111-1111-4111-8111-111111111111";
  const inventory = fakeInventory({
    listed: [
      sandbox(),
      sandbox({ id: degradedId, name: degradedName, labels: null }),
    ],
    degraded: 1,
  });
  const handlers = createReadHandlers({
    inventory,
    pendingCreates: new Map(),
    env: {},
  });

  const output = await handlers.list({}, context(async () => parentDirectory));
  vmList.output.parse(output);

  assert.equal(output.children.length, 2);
  const degraded = output.children.find((child) => child.id === degradedId);
  assert.equal(degraded?.name, degradedName);
  assert.equal(degraded?.labels, null);
  assert.equal(degraded?.error?.code, "config_invalid");
  assert.equal(output.inventory.status, "partial");
  assert.equal(output.inventory.error?.code, "inventory_partial");
});

test("vm.list keeps pending creates visible", async () => {
  const requestId = "00000000-0000-4000-8000-000000000000";
  const pending: PendingChild = {
    requestId,
    name: `paseo-${requestId}`,
    phase: "creating",
    error: null,
  };
  const handlers = createReadHandlers({
    inventory: fakeInventory({ listed: [] }),
    pendingCreates: new Map([[requestId, pending]]),
    env: {},
  });

  const output = await handlers.list({}, context(async () => parentDirectory));
  assert.deepEqual(output.pending, [pending]);
});

test("vm.list reports unavailable inventory instead of an empty inventory", async () => {
  const handlers = createReadHandlers({
    inventory: fakeInventory({ listError: true }),
    pendingCreates: new Map(),
    env: {},
  });

  const output = await handlers.list({}, context(async () => parentDirectory));
  vmList.output.parse(output);

  assert.equal(output.children.length, 0);
  assert.equal(output.inventory.status, "unavailable");
  assert.equal(output.inventory.error?.code, "inventory_unavailable");
  assert.equal(output.registrations.status, "available");
});

test("vm.list reports unavailable parent identity without guessing a parent", async () => {
  const requestId = "00000000-0000-4000-8000-000000000000";
  const pending: PendingChild = {
    requestId,
    name: `paseo-${requestId}`,
    phase: "creating",
    error: null,
  };
  const handlers = createReadHandlers({
    inventory: fakeInventory({ listed: [sandbox()] }),
    pendingCreates: new Map([[requestId, pending]]),
    env: {},
  });

  const output = await handlers.list(
    {},
    context(async () => {
      throw new Error("parent unavailable");
    }),
  );
  vmList.output.parse(output);

  assert.equal(output.parent, null);
  assert.deepEqual(output.pending, [pending]);
  assert.equal(output.children.length, 0);
  assert.equal(output.inventory.error?.code, "parent_unavailable");
  assert.equal(output.registrations.error?.code, "parent_unavailable");
});

test("vm.detail redacts and bounds sandbox and job logs", async () => {
  const rawLogs: RawLogs = {
    sandbox: [
      {
        origin: "sandbox",
        stream: "stdout",
        timestamp: "2026-01-01T00:00:00.000Z",
        text: `token=${fakeAnthropic}`,
      },
      {
        origin: "sandbox",
        stream: "stderr",
        timestamp: "2026-01-01T00:00:01.000Z",
        text: "Authorization: Bearer fake-bearer-value",
      },
      {
        origin: "sandbox",
        stream: "output",
        timestamp: "2026-01-01T00:00:02.000Z",
        text: "placeholder $MSB_ANTHROPIC_API_KEY",
      },
    ],
    job: [
      {
        origin: "job",
        stream: "stderr",
        timestamp: "2026-01-01T00:00:03.000Z",
        text: `GH_TOKEN=${fakeGitHub}`,
      },
    ],
    jobUnavailable: false,
  };
  const handlers = createReadHandlers({
    inventory: fakeInventory({
      lookup: { status: "found", sandbox: sandbox({ labels: labels({ [LABELS.job]: "job_test_1" }) }) },
      logs: rawLogs,
    }),
    pendingCreates: new Map(),
    env: { ANTHROPIC_API_KEY: fakeAnthropic, GH_TOKEN: fakeGitHub },
  });

  const output = await handlers.detail(
    { name: sandboxName, id: sandboxId },
    context(async () => parentDirectory),
  );
  vmDetail.output.parse(output);

  assert.equal(output.child?.id, sandboxId);
  assert.equal(output.logs.status, "available");
  assert.equal(output.logs.entries.length, 4);
  assert.equal(output.logs.entries.some((entry) => entry.source === "job"), true);

  const serialized = JSON.stringify(output);
  assert.equal(serialized.includes(fakeAnthropic), false);
  assert.equal(serialized.includes(fakeGitHub), false);
  assert.equal(serialized.includes("fake-bearer-value"), false);
  assert.equal(serialized.includes("$MSB_"), false);
  assert.equal(serialized.includes("[redacted]"), true);
});

test("vm.detail bounds log entries and text", async () => {
  const longLine = "x".repeat(LOG_TEXT_LIMIT * 2);
  const sandboxLogs = Array.from({ length: 100 }, (_, index) => ({
    origin: "sandbox" as const,
    stream: "stdout",
    timestamp: `2026-01-01T00:00:${String(index % 60).padStart(2, "0")}.000Z`,
    text: `${longLine}-${index}`,
  }));
  const handlers = createReadHandlers({
    inventory: fakeInventory({
      lookup: { status: "found", sandbox: sandbox() },
      logs: { sandbox: sandboxLogs, job: [], jobUnavailable: false },
    }),
    pendingCreates: new Map(),
    env: {},
  });

  const output = await handlers.detail(
    { name: sandboxName },
    context(async () => parentDirectory),
  );
  vmDetail.output.parse(output);

  assert.equal(output.logs.entries.length <= LOG_ENTRY_LIMIT, true);
  assert.equal(
    output.logs.entries.reduce((total, entry) => total + entry.text.length, 0) <=
      LOG_TOTAL_LIMIT,
    true,
  );
  assert.equal(
    output.logs.entries.every((entry) => entry.text.length <= LOG_TEXT_LIMIT),
    true,
  );
});

test("vm.detail distinguishes missing, unproven, and replaced sandboxes", async () => {
  const missing = createReadHandlers({
    inventory: fakeInventory({ lookup: { status: "not_found" } }),
    pendingCreates: new Map(),
    env: {},
  });
  const missingOutput = await missing.detail(
    { name: sandboxName },
    context(async () => parentDirectory),
  );
  vmDetail.output.parse(missingOutput);
  assert.equal(missingOutput.error?.code, "sandbox_not_found");
  assert.equal(missingOutput.inventory.status, "available");
  assert.equal(missingOutput.logs.status, "available");

  const unproven = createReadHandlers({
    inventory: fakeInventory({
      lookup: { status: "found", sandbox: sandbox({ labels: null }) },
    }),
    pendingCreates: new Map(),
    env: {},
  });
  const unprovenOutput = await unproven.detail(
    { name: sandboxName },
    context(async () => parentDirectory),
  );
  vmDetail.output.parse(unprovenOutput);
  assert.equal(unprovenOutput.error?.code, "sandbox_not_found");
  assert.equal(unprovenOutput.child, null);
  assert.equal(unprovenOutput.inventory.status, "available");

  const replaced = createReadHandlers({
    inventory: fakeInventory({
      lookup: { status: "found", sandbox: sandbox({ id: "sandbox_test_2" }) },
    }),
    pendingCreates: new Map(),
    env: {},
  });
  const replacedOutput = await replaced.detail(
    { name: sandboxName, id: sandboxId },
    context(async () => parentDirectory),
  );
  vmDetail.output.parse(replacedOutput);
  assert.equal(replacedOutput.error?.code, "sandbox_replaced");
  assert.equal(replacedOutput.child, null);
});

test("vm.detail direct lookup rejects unreadable and missing managed labels", async () => {
  const handles: SandboxHandleView[] = [
    {
      id: sandboxId,
      name: "paseo-unreadable-config",
      status: "running",
      config: () => {
        throw new Error("config unavailable");
      },
    },
    {
      id: sandboxId,
      name: "paseo-missing-managed-labels",
      status: "running",
      config: () => ({ labels: {} }),
    },
    {
      id: sandboxId,
      name: "paseo-foreign-parent",
      status: "running",
      config: () => ({
        labels: {
          [LABELS.managed]: LABELS.version,
          [LABELS.parent]: "srv_other_parent",
          [LABELS.id]: sandboxId,
          [LABELS.phase]: "ready",
        },
      }),
    },
  ];

  for (const handle of handles) {
    const lookup = lookupManagedSandbox(handle, parentServerId);
    assert.equal(lookup.status, "not_found");

    const handlers = createReadHandlers({
      inventory: fakeInventory({ lookup }),
      pendingCreates: new Map(),
      env: {},
    });
    const output = await handlers.detail(
      { name: handle.name },
      context(async () => parentDirectory),
    );
    vmDetail.output.parse(output);
    assert.equal(output.error?.code, "sandbox_not_found");
    assert.equal(output.child, null);
    assert.equal(output.logs.status, "available");
  }
});

test("vm.detail reports unavailable parent and inventory", async () => {
  const parentUnavailable = createReadHandlers({
    inventory: fakeInventory({ lookup: { status: "found", sandbox: sandbox() } }),
    pendingCreates: new Map(),
    env: {},
  });
  const parentOutput = await parentUnavailable.detail(
    { name: sandboxName },
    context(async () => {
      throw new Error("parent unavailable");
    }),
  );
  vmDetail.output.parse(parentOutput);
  assert.equal(parentOutput.error?.code, "parent_unavailable");
  assert.equal(parentOutput.inventory.status, "unavailable");
  assert.equal(parentOutput.registrations.status, "unavailable");
  assert.equal(parentOutput.logs.status, "unavailable");

  const inventoryUnavailable = createReadHandlers({
    inventory: fakeInventory({ lookupError: true }),
    pendingCreates: new Map(),
    env: {},
  });
  const inventoryOutput = await inventoryUnavailable.detail(
    { name: sandboxName },
    context(async () => parentDirectory),
  );
  vmDetail.output.parse(inventoryOutput);
  assert.equal(inventoryOutput.error?.code, "inventory_unavailable");
  assert.equal(inventoryOutput.inventory.status, "unavailable");
  assert.equal(inventoryOutput.logs.status, "unavailable");
});

test("vm.detail reports partial job logs", async () => {
  const handlers = createReadHandlers({
    inventory: fakeInventory({
      lookup: { status: "found", sandbox: sandbox({ labels: labels({ [LABELS.job]: "job_test_1" }) }) },
      logs: {
        sandbox: [
          {
            origin: "sandbox",
            stream: "stdout",
            timestamp: "2026-01-01T00:00:00.000Z",
            text: "sandbox output",
          },
        ],
        job: [],
        jobUnavailable: true,
      },
    }),
    pendingCreates: new Map(),
    env: {},
  });

  const output = await handlers.detail(
    { name: sandboxName },
    context(async () => parentDirectory),
  );
  vmDetail.output.parse(output);

  assert.equal(output.child?.id, sandboxId);
  assert.equal(output.logs.status, "partial");
  assert.equal(output.logs.error?.code, "job_unavailable");
  assert.equal(output.logs.entries.length, 1);
});

test("vm.detail keeps a sandbox visible when logs are unavailable", async () => {
  const handlers = createReadHandlers({
    inventory: {
      async listManaged() {
        return { sandboxes: [], degraded: 0 };
      },
      async getManaged() {
        return { status: "found", sandbox: sandbox() };
      },
      async readLogs() {
        throw new Error("logs unavailable");
      },
    },
    pendingCreates: new Map(),
    env: {},
  });

  const output = await handlers.detail(
    { name: sandboxName },
    context(async () => parentDirectory),
  );
  vmDetail.output.parse(output);

  assert.equal(output.child?.id, sandboxId);
  assert.equal(output.logs.status, "unavailable");
  assert.equal(output.logs.error?.code, "logs_unavailable");
});

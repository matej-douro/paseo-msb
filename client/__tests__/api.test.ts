import test from "node:test";
import assert from "node:assert/strict";
import { createVmApi, type RpcInvoke } from "../api";

const sandboxId = "sandbox_test_1";
const childName = "paseo-00000000-0000-4000-8000-000000000000";
const requestId = "11111111-1111-4111-8111-111111111111";

const listOutput = {
  parent: { serverId: "srv_parent", label: "Parent" },
  pending: [],
  children: [
    {
      id: sandboxId,
      name: childName,
      labels: {
        "paseo-msb": "v1",
        "paseo-msb-parent": "srv_parent",
        "paseo-msb-id": sandboxId,
        "paseo-msb-phase": "ready",
      },
      runtimeStatus: "running",
      registration: {
        registrationId: "reg_1",
        serverId: "srv_child",
        label: `Parent/${childName}`,
        status: "online",
        sourceKey: sandboxId,
      },
      error: null,
    },
  ],
  credentials: ["ANTHROPIC_API_KEY"],
  inventory: { status: "available", error: null },
  registrations: { status: "available", error: null },
} as const;

const detailOutput = {
  pending: null,
  child: listOutput.children[0],
  logs: { status: "available", entries: [], error: null },
  inventory: { status: "available", error: null },
  registrations: { status: "available", error: null },
  error: null,
} as const;

function fakeInvoke() {
  const calls: Array<{ method: string; input: unknown }> = [];
  const invoke: RpcInvoke = async (method, input) => {
    calls.push({ method, input });
    if (method === "vm.list") return listOutput;
    if (method === "vm.detail") return detailOutput;
    if (method === "vm.create") return { name: childName };
    if (method === "vm.delete") return { name: childName, id: sandboxId };
    if (method === "vm.reconcile") {
      return { name: childName, id: sandboxId, phase: "ready" };
    }
    throw new Error(`unexpected method ${method}`);
  };
  return { calls, invoke };
}

test("client transport invokes exactly the five RPC contracts", async () => {
  const fake = fakeInvoke();
  const api = createVmApi(fake.invoke);

  const list = await api.list();
  assert.equal(list.children.length, 1);

  await api.detail({ name: childName, id: sandboxId });
  await api.create({ requestId, secretEnvVars: ["ANTHROPIC_API_KEY"] });
  await api.delete({ name: childName, id: sandboxId, confirmName: childName });
  await api.reconcile({ name: childName, id: sandboxId });

  assert.deepEqual(
    fake.calls.map((call) => call.method),
    ["vm.list", "vm.detail", "vm.create", "vm.delete", "vm.reconcile"],
  );
  assert.deepEqual(fake.calls[1].input, { name: childName, id: sandboxId });
  assert.deepEqual(fake.calls[2].input, {
    requestId,
    secretEnvVars: ["ANTHROPIC_API_KEY"],
  });
  assert.deepEqual(fake.calls[3].input, {
    name: childName,
    id: sandboxId,
    confirmName: childName,
  });
});

test("client transport validates inputs before calling the host", async () => {
  const fake = fakeInvoke();
  const api = createVmApi(fake.invoke);

  await assert.rejects(
    api.create({ requestId, secretEnvVars: [] }),
    /at least 1|>=1|expected array/i,
  );
  assert.equal(fake.calls.length, 0);
});

test("client transport rejects outputs carrying unknown fields", async () => {
  const api = createVmApi(async (method) => {
    if (method === "vm.list") {
      return { ...listOutput, config: { env: ["ANTHROPIC_API_KEY=value"] } };
    }
    throw new Error("unexpected method");
  });

  await assert.rejects(api.list());
});

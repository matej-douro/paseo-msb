import test from "node:test";
import assert from "node:assert/strict";
import type { Child } from "../../shared/contracts";
import { createChild, deleteChild, repairChild } from "../actions";
import type { VmApi } from "../api";

const child: Child = {
  id: "sandbox_test_1",
  name: "paseo-00000000-0000-4000-8000-000000000000",
  labels: {
    "paseo-msb": "v1",
    "paseo-msb-parent": "srv_parent",
    "paseo-msb-id": "sandbox_test_1",
    "paseo-msb-phase": "failed",
  },
  runtimeStatus: "stopped",
  registration: null,
  error: { code: "sandbox_failed", message: "Sandbox setup failed." },
};

function fakeApi(overrides: Partial<VmApi> = {}): VmApi {
  return {
    list: async () => {
      throw new Error("not used");
    },
    detail: async () => {
      throw new Error("not used");
    },
    create: async () => ({ name: child.name }),
    delete: async () => ({ name: child.name, id: child.id }),
    reconcile: async () => ({
      name: child.name,
      id: child.id,
      phase: "registering",
    }),
    ...overrides,
  };
}

test("create sends one request ID and selected credential names", async () => {
  const calls: unknown[] = [];
  const api = fakeApi({
    create: async (input) => {
      calls.push(input);
      return { name: child.name };
    },
  });

  const output = await createChild(api, {
    requestId: "11111111-1111-4111-8111-111111111111",
    secretEnvVars: ["ANTHROPIC_API_KEY", "GH_TOKEN"],
  });

  assert.deepEqual(output, { name: child.name });
  assert.deepEqual(calls, [
    {
      requestId: "11111111-1111-4111-8111-111111111111",
      secretEnvVars: ["ANTHROPIC_API_KEY", "GH_TOKEN"],
    },
  ]);
});

test("create refuses an empty credential selection without calling the host", async () => {
  let called = false;
  const api = fakeApi({
    create: async () => {
      called = true;
      return { name: child.name };
    },
  });

  assert.throws(() => {
    void createChild(api, {
      requestId: "11111111-1111-4111-8111-111111111111",
      secretEnvVars: [],
    });
  });
  assert.equal(called, false);
});

test("repair uses the stable sandbox ID as well as the name", async () => {
  const calls: unknown[] = [];
  const api = fakeApi({
    reconcile: async (input) => {
      calls.push(input);
      return { name: child.name, id: child.id, phase: "ready" };
    },
  });

  const output = await repairChild(api, child);
  assert.equal(output.phase, "ready");
  assert.deepEqual(calls, [{ name: child.name, id: child.id }]);
});

test("delete requires the exact confirmation name", async () => {
  const calls: unknown[] = [];
  const api = fakeApi({
    delete: async (input) => {
      calls.push(input);
      return { name: child.name, id: child.id };
    },
  });

  assert.throws(() => {
    void deleteChild(api, child, "paseo-wrong");
  });
  assert.equal(calls.length, 0);

  const output = await deleteChild(api, child, child.name);
  assert.deepEqual(output, { name: child.name, id: child.id });
  assert.deepEqual(calls, [
    { name: child.name, id: child.id, confirmName: child.name },
  ]);
});

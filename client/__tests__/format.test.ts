import test from "node:test";
import assert from "node:assert/strict";
import type { Child, PendingChild } from "../../shared/contracts";
import {
  childStatus,
  childTone,
  inventoryNotices,
  pendingTone,
  safeErrorText,
} from "../format";

const baseChild: Child = {
  id: "sandbox_test_1",
  name: "paseo-00000000-0000-4000-8000-000000000000",
  labels: {
    "paseo-msb": "v1",
    "paseo-msb-parent": "srv_parent",
    "paseo-msb-id": "sandbox_test_1",
    "paseo-msb-phase": "ready",
  },
  runtimeStatus: "running",
  registration: {
    registrationId: "reg_1",
    serverId: "srv_child",
    label: "Parent/paseo-test",
    status: "online",
    sourceKey: "sandbox_test_1",
  },
  error: null,
};

test("child rows show phase, runtime, and registration state", () => {
  assert.equal(
    childStatus(baseChild),
    "Ready · Running · Registration Online",
  );
  assert.equal(childTone(baseChild), "success");
  assert.equal(
    childTone({
      ...baseChild,
      labels: null,
    }),
    "danger",
  );
  assert.equal(
    childTone({
      ...baseChild,
      labels: { ...baseChild.labels!, "paseo-msb-phase": "failed" },
    }),
    "danger",
  );
  assert.equal(
    childTone({
      ...baseChild,
      registration: null,
    }),
    "warning",
  );
});

test("safe errors show a message and code without raw details", () => {
  assert.equal(
    safeErrorText({ code: "inventory_unavailable", message: "Sandbox inventory is unavailable." }),
    "Sandbox inventory is unavailable. (inventory_unavailable)",
  );
  assert.equal(safeErrorText(null), null);
});

test("pending creates show a phase and warn unless failed", () => {
  const pending: PendingChild = {
    requestId: "11111111-1111-4111-8111-111111111111",
    name: "paseo-11111111-1111-4111-8111-111111111111",
    phase: "creating",
    error: null,
  };
  assert.equal(pendingTone(pending), "warning");
  assert.equal(pendingTone({ ...pending, phase: "failed" }), "danger");
});

test("inventory notices distinguish partial, unavailable, and parent failure", () => {
  const available = { status: "available" as const, error: null };
  assert.deepEqual(
    inventoryNotices({
      parent: { serverId: "srv_parent", label: "Parent" },
      inventory: available,
      registrations: available,
    }),
    [],
  );

  const partial = inventoryNotices({
    parent: { serverId: "srv_parent", label: "Parent" },
    inventory: {
      status: "partial",
      error: { code: "inventory_partial", message: "Some configs are unreadable." },
    },
    registrations: available,
  });
  assert.equal(partial.length, 1);
  assert.equal(partial[0].tone, "warning");

  const unavailable = inventoryNotices({
    parent: null,
    inventory: {
      status: "unavailable",
      error: { code: "parent_unavailable", message: "Parent is unavailable." },
    },
    registrations: {
      status: "unavailable",
      error: { code: "parent_unavailable", message: "Parent is unavailable." },
    },
  });
  assert.equal(unavailable.length, 2);
  assert.equal(unavailable[0].tone, "danger");
  assert.match(unavailable[1].text, /inventory is unavailable/i);
});

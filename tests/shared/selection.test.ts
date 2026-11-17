import { describe, expect, it } from "vitest";
import { MANAGED_LABEL, PARENT_LABEL, PHASE_LABEL, PLUGIN_VERSION } from "../../shared/constants";
import type { VmChild } from "../../shared/contracts";
import { selectVmChild } from "../../shared/selection";

const PLAN = { providers: [], integrations: [] };

const pending: VmChild = {
  kind: "pending",
  name: "shared",
  plan: PLAN,
  phase: "creating",
  error: null,
  resources: { cpus: 2, memoryMib: 4096, diskMib: 10240 },
  resourcesSpecified: false,
};

const sandbox: VmChild = {
  kind: "sandbox",
  name: "shared",
  id: "sandbox_1",
  labels: {
    [MANAGED_LABEL]: PLUGIN_VERSION,
    [PARENT_LABEL]: "srv_parent",
    [PHASE_LABEL]: "ready",
  },
  runtimeStatus: "running",
  plan: PLAN,
  registration: null,
  resources: { cpus: 2, memoryMib: 4096, diskMib: 10240 },
  requestedResources: null,
};

const staleRegistration: VmChild = {
  kind: "registration",
  name: "shared",
  id: "sandbox_old",
  phase: "registering",
  registration: { registrationId: "reg_1", status: "offline", serverId: null },
  error: null,
};

describe("selectVmChild", () => {
  const children = [pending, sandbox, staleRegistration];

  it("selects the pending attempt when no id is given", () => {
    expect(selectVmChild(children, { name: "shared" })).toBe(pending);
    expect(selectVmChild([sandbox], { name: "shared" })).toBe(sandbox);
  });

  it("selects the exact non-pending generation by id", () => {
    expect(selectVmChild(children, { name: "shared", id: sandbox.id })).toBe(sandbox);
    expect(selectVmChild(children, { name: "shared", id: staleRegistration.id })).toBe(
      staleRegistration,
    );
    expect(selectVmChild(children, { name: "shared", id: "missing" })).toBeNull();
    expect(selectVmChild([pending], { name: "shared", id: sandbox.id })).toBeNull();
  });

  it("returns null when the name is absent", () => {
    expect(selectVmChild(children, { name: "other" })).toBeNull();
  });
});

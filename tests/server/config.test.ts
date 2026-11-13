import { describe, expect, it } from "vitest";
import {
  ERROR_LABEL,
  MANAGED_LABEL,
  PARENT_LABEL,
  PHASE_LABEL,
  PLUGIN_VERSION,
  SANDBOX_ID_LABEL,
} from "../../shared/constants";
import {
  decodeManagedSandbox,
  loadManagedSandboxes,
  SandboxDecodeError,
} from "../../server/sandbox";
import {
  fakeRuntime,
  fakeSandbox,
  PARENT_ID,
  SECRET_VALUE,
} from "./fake-runtime";

describe("decodeManagedSandbox", () => {
  it("returns only stable id, name, labels, and runtime status", () => {
    const handle = fakeSandbox({ id: "sbx_1", name: "paseo-1" });
    const decoded = decodeManagedSandbox(handle, PARENT_ID);

    expect(decoded).not.toBeNull();
    expect(Object.keys(decoded!).sort()).toEqual([
      "errorDetail",
      "id",
      "labels",
      "legacyId",
      "legacyJobId",
      "name",
      "plan",
      "runtimeStatus",
    ]);
    expect(decoded!.errorDetail).toBeNull();
    expect(decoded!.id).toBe("sbx_1");
    expect(decoded!.name).toBe("paseo-1");
    expect(decoded!.runtimeStatus).toBe("running");
    expect(decoded!.legacyId).toBeNull();
    expect(decoded!.legacyJobId).toBeNull();
    expect(decoded!.labels).toEqual({
      [MANAGED_LABEL]: PLUGIN_VERSION,
      [PARENT_LABEL]: PARENT_ID,
      [PHASE_LABEL]: "ready",
    });
    expect(JSON.stringify(decoded)).not.toContain(SECRET_VALUE);
  });

  it("drops raw config, environment, and secret values", () => {
    const handle = fakeSandbox({ id: "sbx_1", name: "paseo-1" });
    const decoded = decodeManagedSandbox(handle, PARENT_ID);
    const serialized = JSON.stringify(decoded!.labels);

    expect(serialized).not.toContain(SECRET_VALUE);
    expect(serialized).not.toContain("api.anthropic.com");
    expect(serialized).not.toContain("network");
    expect(serialized).not.toContain("env");
    expect(serialized).not.toContain("substitution");
  });

  it("ignores unmanaged sandboxes and other parents", () => {
    const unmanaged = fakeSandbox({
      id: "sbx_2",
      name: "paseo-2",
      labels: { [MANAGED_LABEL]: "v2" },
    });
    const otherParent = fakeSandbox({ id: "sbx_3", name: "paseo-3", parentId: "srv_other" });

    expect(decodeManagedSandbox(unmanaged, PARENT_ID)).toBeNull();
    expect(decodeManagedSandbox(otherParent, PARENT_ID)).toBeNull();
  });

  it("ignores unknown sandbox labels", () => {
    const handle = fakeSandbox({
      id: "sbx_1",
      name: "paseo-1",
      extraLabels: { "user-label": "not-managed-by-paseo" },
    });
    const decoded = decodeManagedSandbox(handle, PARENT_ID);

    expect(decoded!.labels).not.toHaveProperty("user-label");
  });

  it("marks an invalid phase as failed with a safe code", () => {
    const handle = fakeSandbox({
      id: "sbx_1",
      name: "paseo-1",
      labels: { [PHASE_LABEL]: "exploded" },
    });
    const decoded = decodeManagedSandbox(handle, PARENT_ID);

    expect(decoded!.labels[PHASE_LABEL]).toBe("failed");
    expect(decoded!.labels[ERROR_LABEL]).toBe("invalid_config");
  });

  it("quarantines a mismatched legacy stable-id label", () => {
    const handle = fakeSandbox({
      id: "sbx_replacement",
      name: "paseo-1",
      labels: { [SANDBOX_ID_LABEL]: "sbx_original" },
    });

    expect(() => decodeManagedSandbox(handle, PARENT_ID)).toThrow(SandboxDecodeError);
  });

  it("accepts a matching legacy stable-id label and reads legacy job ids only as hints", () => {
    const handle = fakeSandbox({
      id: "sbx_1",
      name: "paseo-1",
      extraLabels: { [SANDBOX_ID_LABEL]: "sbx_1", "paseo-msb-job": "job_7" },
    });
    const decoded = decodeManagedSandbox(handle, PARENT_ID);

    expect(decoded!.labels).not.toHaveProperty(SANDBOX_ID_LABEL);
    expect(decoded!.legacyId).toBe("sbx_1");
    expect(decoded!.legacyJobId).toBe("job_7");
  });

  it("does not project an arbitrary error label", () => {
    const handle = fakeSandbox({
      id: "sbx_1",
      name: "paseo-1",
      phase: "failed",
      labels: { [ERROR_LABEL]: SECRET_VALUE },
    });
    const decoded = decodeManagedSandbox(handle, PARENT_ID);

    expect(decoded!.labels[ERROR_LABEL]).toBe("invalid_config");
    expect(JSON.stringify(decoded!.labels)).not.toContain(SECRET_VALUE);
  });
});

describe("loadManagedSandboxes", () => {
  it("reports unavailable inventory instead of an empty list", async () => {
    const inventory = await loadManagedSandboxes(
      { list: async () => Promise.reject(new Error("socket closed")) },
      PARENT_ID,
    );

    expect(inventory.status).toBe("unavailable");
    if (inventory.status === "unavailable") {
      expect(inventory.error.code).toBe("inventory_unavailable");
      expect(inventory.error.message).not.toContain("socket closed");
    }
  });

  it("keeps malformed managed sandboxes visible as failed", async () => {
    const handle = fakeSandbox({ id: "sbx_1", name: "paseo-1", rawConfig: null });
    const inventory = await loadManagedSandboxes(fakeRuntime([handle]), PARENT_ID);

    expect(inventory.status).toBe("available");
    if (inventory.status === "available") {
      expect(inventory.sandboxes).toHaveLength(0);
      expect(inventory.failures).toEqual([
        { id: "sbx_1", name: "paseo-1", runtimeStatus: "running", code: "invalid_config" },
      ]);
    }
  });
});

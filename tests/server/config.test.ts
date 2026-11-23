import { describe, expect, it } from "vitest";
import {
  ERROR_LABEL,
  MANAGED_LABEL,
  PARENT_LABEL,
  PHASE_LABEL,
  PLAN_ENV_VAR,
  PLUGIN_VERSION,
  RESOURCES_ENV_VAR,
  RESOURCES_SPECIFIED_ENV_VAR,
} from "../../shared/constants";
import {
  decodeManagedSandbox,
  loadManagedSandboxes,
  readSandboxMaxMemoryMib,
  SandboxDecodeError,
} from "../../server/sandbox";
import {
  DEFAULT_PLAN,
  fakeRuntime,
  fakeSandbox,
  managedEnv,
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
      "name",
      "plan",
      "requestedResources",
      "resources",
      "resourcesSpecified",
      "runtimeStatus",
    ]);
    expect(decoded!.errorDetail).toBeNull();
    expect(decoded!.id).toBe("sbx_1");
    expect(decoded!.name).toBe("paseo-1");
    expect(decoded!.runtimeStatus).toBe("running");
    expect(decoded!.labels).toEqual({
      [MANAGED_LABEL]: PLUGIN_VERSION,
      [PARENT_LABEL]: PARENT_ID,
      [PHASE_LABEL]: "ready",
    });
    expect(JSON.stringify(decoded)).not.toContain(SECRET_VALUE);
  });

  it("decodes the persisted plan from SDK-shaped env entries", () => {
    const plan = {
      providers: [{ provider: "pi" as const, llms: ["neuralwatt" as const] }],
      integrations: [],
    };
    const handle = fakeSandbox({
      id: "sbx_1",
      name: "paseo-1",
      rawConfig: {
        env: managedEnv([{ key: PLAN_ENV_VAR, value: JSON.stringify(plan) }]),
      },
    });

    const decoded = decodeManagedSandbox(handle, PARENT_ID);
    expect(decoded!.plan).toEqual(plan);
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

  it("reads the desired resources and specified flag internally", () => {
    const handle = fakeSandbox({
      id: "sbx_1",
      name: "paseo-1",
      rawConfig: {
        env: managedEnv([
          {
            name: RESOURCES_ENV_VAR,
            value: JSON.stringify({ cpus: 4, memoryMib: 8192, diskMib: 20480 }),
          },
          { name: RESOURCES_SPECIFIED_ENV_VAR, value: "1" },
        ]),
      },
    });

    const decoded = decodeManagedSandbox(handle, PARENT_ID);

    expect(decoded!.plan).toEqual(DEFAULT_PLAN);
    expect(decoded!.requestedResources).toEqual({
      cpus: 4,
      memoryMib: 8192,
      diskMib: 20480,
    });
    expect(decoded!.resourcesSpecified).toBe(true);
    // No observed resources were reported, so none are invented.
    expect(decoded!.resources).toEqual({ cpus: 2, memoryMib: null, diskMib: null });
  });

  it("reports observed resources from the sandbox config", () => {
    const handle = fakeSandbox({ id: "sbx_1", name: "paseo-1" });
    const decoded = decodeManagedSandbox(handle, PARENT_ID);

    expect(decoded!.resources).toEqual({ cpus: 2, memoryMib: 4096, diskMib: 10240 });
    expect(decoded!.requestedResources).toEqual({
      cpus: 2,
      memoryMib: 4096,
      diskMib: 10240,
    });
    expect(decoded!.resourcesSpecified).toBe(false);
  });

  it("decodes a record-shaped CLI env and ignores non-string values", () => {
    const handle = fakeSandbox({
      id: "sbx_1",
      name: "paseo-1",
      rawConfig: {
        env: {
          [PLAN_ENV_VAR]: JSON.stringify(DEFAULT_PLAN),
          [RESOURCES_ENV_VAR]: JSON.stringify({ cpus: 4, memoryMib: 8192, diskMib: 20480 }),
          [RESOURCES_SPECIFIED_ENV_VAR]: "1",
          IGNORED: 7,
        },
      },
    });

    const decoded = decodeManagedSandbox(handle, PARENT_ID);

    expect(decoded!.plan).toEqual(DEFAULT_PLAN);
    expect(decoded!.requestedResources.cpus).toBe(4);
    expect(decoded!.resourcesSpecified).toBe(true);
  });

  it("keeps an out-of-range memory or disk report unreported rather than failing the VM", () => {
    const withMemory = fakeSandbox({
      id: "sbx_1",
      name: "paseo-1",
      rawConfig: { env: managedEnv(), resources: { cpus: 2, memoryMib: 512 } },
    });
    expect(decodeManagedSandbox(withMemory, PARENT_ID)!.resources).toEqual({
      cpus: 2,
      memoryMib: null,
      diskMib: null,
    });

    const withDisk = fakeSandbox({
      id: "sbx_1",
      name: "paseo-1",
      rawConfig: { env: managedEnv(), image: { Oci: { rootDisk: { sizeMib: 1 } } } },
    });
    expect(decodeManagedSandbox(withDisk, PARENT_ID)!.resources.diskMib).toBeNull();
  });

  it("reads the reported boot-time memory cap and ignores invalid values", () => {
    const capped = fakeSandbox({
      id: "sbx_1",
      name: "paseo-1",
      rawConfig: { env: managedEnv(), resources: { cpus: 2, maxMemoryMib: 8_192 } },
    });
    expect(readSandboxMaxMemoryMib(capped)).toBe(8_192);

    for (const maxMemoryMib of [0, 2.5, 40_000]) {
      const invalid = fakeSandbox({
        id: "sbx_1",
        name: "paseo-1",
        rawConfig: { env: managedEnv(), resources: { cpus: 2, maxMemoryMib } },
      });
      expect(readSandboxMaxMemoryMib(invalid)).toBeNull();
    }
  });

  it("decodes object-shaped env bags the record branch accepts", () => {
    const fields = {
      [PLAN_ENV_VAR]: JSON.stringify(DEFAULT_PLAN),
      [RESOURCES_ENV_VAR]: JSON.stringify({ cpus: 4, memoryMib: 8192, diskMib: 20480 }),
      [RESOURCES_SPECIFIED_ENV_VAR]: "1",
    };
    // A class instance is what separates `z.looseObject` from `z.record`; the
    // null-prototype bag covers the other non-plain object shape.
    class EnvBag {}

    for (const env of [
      Object.assign(new EnvBag(), fields),
      Object.assign(Object.create(null), fields),
    ]) {
      const handle = fakeSandbox({ id: "sbx_1", name: "paseo-1", rawConfig: { env } });

      const decoded = decodeManagedSandbox(handle, PARENT_ID);

      expect(decoded!.plan).toEqual(DEFAULT_PLAN);
      expect(decoded!.requestedResources.cpus).toBe(4);
      expect(decoded!.resourcesSpecified).toBe(true);
    }
  });

  it("requires the plan and both resource variables", () => {
    for (const env of [
      [],
      [{ name: RESOURCES_ENV_VAR, value: "{}" }],
      [{ name: RESOURCES_SPECIFIED_ENV_VAR, value: "0" }],
    ]) {
      const handle = fakeSandbox({ id: "sbx_1", name: "paseo-1", rawConfig: { env } });
      expect(() => decodeManagedSandbox(handle, PARENT_ID)).toThrow(SandboxDecodeError);
    }
  });

  it("accepts snake_case resource keys", () => {
    const handle = fakeSandbox({
      id: "sbx_1",
      name: "paseo-1",
      rawConfig: {
        env: managedEnv(),
        resources: { cpus: 2, memory_mib: 6144 },
        image: { oci: { root_disk: { size_mib: 12288 } } },
      },
    });

    const decoded = decodeManagedSandbox(handle, PARENT_ID);
    expect(decoded!.resources).toEqual({ cpus: 2, memoryMib: 6144, diskMib: 12288 });
  });

  it("leaves an unreported memory and root disk null", () => {
    const handle = fakeSandbox({
      id: "sbx_1",
      name: "paseo-1",
      rawConfig: { env: managedEnv(), resources: { cpus: 2 } },
    });

    const decoded = decodeManagedSandbox(handle, PARENT_ID);
    expect(decoded!.resources).toEqual({ cpus: 2, memoryMib: null, diskMib: null });
  });

  it("reports the observed CPU count when it is not the default", () => {
    const handle = fakeSandbox({
      id: "sbx_1",
      name: "paseo-1",
      rawConfig: { env: managedEnv(), resources: { cpus: 4 } },
    });

    const decoded = decodeManagedSandbox(handle, PARENT_ID);
    expect(decoded!.resources).toEqual({ cpus: 4, memoryMib: null, diskMib: null });
  });

  it("rejects a config that reports an out-of-range CPU count", () => {
    for (const cpus of [0, 17, 2.5]) {
      const handle = fakeSandbox({
        id: "sbx_1",
        name: "paseo-1",
        rawConfig: { env: managedEnv(), resources: { cpus } },
      });

      expect(() => decodeManagedSandbox(handle, PARENT_ID)).toThrow(SandboxDecodeError);
    }
  });

  it("rejects malformed resources and specified-flag values", () => {
    const resources = JSON.stringify({ cpus: 2, memoryMib: 4096, diskMib: 10240 });
    const plan = [{ name: PLAN_ENV_VAR, value: JSON.stringify(DEFAULT_PLAN) }];
    const handleWith = (env: { name: string; value: string }[]) =>
      fakeSandbox({
        id: "sbx_1",
        name: "paseo-1",
        rawConfig: { env: [...plan, ...env] },
      });

    // The two variables are written together; either alone is a partial write.
    expect(() =>
      decodeManagedSandbox(handleWith([{ name: RESOURCES_ENV_VAR, value: resources }]), PARENT_ID),
    ).toThrow(SandboxDecodeError);
    expect(() =>
      decodeManagedSandbox(
        handleWith([{ name: RESOURCES_SPECIFIED_ENV_VAR, value: "0" }]),
        PARENT_ID,
      ),
    ).toThrow(SandboxDecodeError);

    // A single-cause failure: the payload is complete but memory is below the bound.
    for (const badResources of [
      "{not json",
      JSON.stringify({ cpus: 2, memoryMib: 1000, diskMib: 10240 }),
    ]) {
      expect(() =>
        decodeManagedSandbox(
          handleWith([
            { name: RESOURCES_ENV_VAR, value: badResources },
            { name: RESOURCES_SPECIFIED_ENV_VAR, value: "0" },
          ]),
          PARENT_ID,
        ),
      ).toThrow(SandboxDecodeError);
    }

    expect(() =>
      decodeManagedSandbox(
        handleWith([
          { name: RESOURCES_ENV_VAR, value: resources },
          { name: RESOURCES_SPECIFIED_ENV_VAR, value: "yes" },
        ]),
        PARENT_ID,
      ),
    ).toThrow(SandboxDecodeError);
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

  it("projects a persisted failed phase as an undecodable config", () => {
    const handle = fakeSandbox({
      id: "sbx_1",
      name: "paseo-1",
      phase: "failed",
      error: "provision_failed",
    });
    const decoded = decodeManagedSandbox(handle, PARENT_ID);

    expect(decoded!.labels[PHASE_LABEL]).toBe("failed");
    expect(decoded!.labels[ERROR_LABEL]).toBe("invalid_config");
  });

  it("does not project legacy or unknown sandbox labels", () => {
    const handle = fakeSandbox({
      id: "sbx_1",
      name: "paseo-1",
      extraLabels: { "paseo-msb-id": "sbx_1", "paseo-msb-job": "job_7" },
    });
    const decoded = decodeManagedSandbox(handle, PARENT_ID);

    expect(decoded!.labels).not.toHaveProperty("paseo-msb-id");
    expect(decoded!.labels).not.toHaveProperty("paseo-msb-job");
    expect(decoded).not.toHaveProperty("legacyId");
    expect(decoded).not.toHaveProperty("legacyJobId");
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

  it("keeps a partial resource environment visible as invalid_config", async () => {
    const handle = fakeSandbox({
      id: "sbx_2",
      name: "paseo-2",
      rawConfig: { env: [{ name: RESOURCES_SPECIFIED_ENV_VAR, value: "1" }] },
    });
    const inventory = await loadManagedSandboxes(fakeRuntime([handle]), PARENT_ID);

    expect(inventory.status).toBe("available");
    if (inventory.status === "available") {
      expect(inventory.failures).toEqual([
        { id: "sbx_2", name: "paseo-2", runtimeStatus: "running", code: "invalid_config" },
      ]);
    }
  });
});

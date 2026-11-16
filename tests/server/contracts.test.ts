import { describe, expect, it } from "vitest";
import {
  CPUS_MAX,
  METRICS_SAMPLE_INTERVAL_MS,
  METRICS_POLL_INTERVAL_MS,
  MAX_SAMPLE_FUTURE_SKEW_MS,
  STALE_SAMPLE_MS,
} from "../../shared/constants";
import {
  METRICS_UNAVAILABLE_REASONS,
  MetricsSampleSchema,
  ResourceRequestSchema,
  VmChildSchema,
  VmCreateInputSchema,
  VmDeleteInputSchema,
  VmDetailInputSchema,
  VmListOutputSchema,
  VmMetricsOutputSchema,
  VmNameSchema,
  VmResizeInputSchema,
  VmResizeOutputSchema,
  SecretsSetInputSchema,
  secretsDeleteRpc,
  secretsListRpc,
  secretsSetRpc,
  vmCreateRpc,
  vmDeleteRpc,
  vmDetailRpc,
  vmDismissRpc,
  vmListRpc,
  vmMetricsRpc,
  vmReconcileRpc,
  vmResizeRpc,
  type VmChild,
} from "../../shared/contracts";
import { SAFE_ERROR_CODES, SAFE_ERROR_MESSAGES } from "../../shared/errors";

const requestId = "2f8f4c2e-8e52-4d0e-9db1-1a2b3c4d5e6f";

const plan = {
  providers: [{ provider: "pi" as const, llms: ["neuralwatt" as const] }],
  integrations: [],
};

const sample = {
  timestamp: "2026-11-15T00:00:00.000Z",
  cpuPercent: 12.5,
  memoryBytes: 1024,
  memoryLimitBytes: 4096,
  memoryAvailableBytes: null,
  diskReadBytes: 0,
  diskWriteBytes: 0,
  netRxBytes: 0,
  netTxBytes: 0,
  upperUsedBytes: null,
  upperFreeBytes: null,
  uptimeMs: 1000,
};

const sandboxChild: VmChild = {
  kind: "sandbox",
  name: "paseo-1",
  id: "sandbox_1",
  labels: {
    "paseo-msb": "v1",
    "paseo-msb-parent": "srv_parent",
    "paseo-msb-phase": "ready",
  },
  runtimeStatus: "running",
  plan: null,
  registration: null,
  resources: { cpus: 2, memoryMib: 4096, diskMib: 10240 },
  requestedResources: null,
};

describe("RPC contracts", () => {
  it("registers the six lifecycle contracts, resize, metrics, and the credential store", () => {
    expect(
      [
        vmListRpc,
        vmDetailRpc,
        vmCreateRpc,
        vmDismissRpc,
        vmDeleteRpc,
        vmReconcileRpc,
        vmResizeRpc,
        vmMetricsRpc,
      ].map((contract) => contract.name),
    ).toEqual([
      "vm.list",
      "vm.detail",
      "vm.create",
      "vm.dismiss",
      "vm.delete",
      "vm.reconcile",
      "vm.resize",
      "vm.metrics",
    ]);
    expect([secretsListRpc, secretsSetRpc, secretsDeleteRpc].map((contract) => contract.name)).toEqual(
      ["secrets.list", "secrets.set", "secrets.delete"],
    );
  });

  it("accepts a strict create request with a provider plan", () => {
    const parsed = VmCreateInputSchema.safeParse({
      requestId,
      plan: {
        providers: [
          { provider: "claude", llms: ["anthropic-api-key"] },
          { provider: "pi", llms: ["neuralwatt"] },
        ],
        integrations: ["github-cli"],
      },
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects empty, unknown, duplicate, and extra create fields", () => {
    expect(
      VmCreateInputSchema.safeParse({
        requestId,
        plan: { providers: [], integrations: [] },
      }).success,
    ).toBe(false);
    expect(
      VmCreateInputSchema.safeParse({
        requestId,
        plan: {
          providers: [{ provider: "unknown", llms: ["neuralwatt"] }],
          integrations: [],
        },
      }).success,
    ).toBe(false);
    expect(
      VmCreateInputSchema.safeParse({
        requestId,
        plan: {
          providers: [{ provider: "pi", llms: ["neuralwatt", "neuralwatt"] }],
          integrations: [],
        },
      }).success,
    ).toBe(false);
    expect(
      VmCreateInputSchema.safeParse({
        requestId,
        plan: {
          providers: [{ provider: "pi", llms: ["neuralwatt"] }],
          integrations: [],
        },
        value: "must-not-be-accepted",
      }).success,
    ).toBe(false);
  });

  it("requires delete confirmation to match the sandbox name", () => {
    expect(
      VmDeleteInputSchema.safeParse({
        name: "paseo-1",
        id: "sandbox_1",
        confirmName: "paseo-1",
      }).success,
    ).toBe(true);
    expect(
      VmDeleteInputSchema.safeParse({
        name: "paseo-1",
        id: "sandbox_1",
        confirmName: "paseo-2",
      }).success,
    ).toBe(false);
  });

  it("rejects unknown detail fields", () => {
    expect(VmDetailInputSchema.safeParse({ name: "paseo-1" }).success).toBe(true);
    expect(VmDetailInputSchema.safeParse({ name: "paseo-1", includeEnv: true }).success).toBe(
      false,
    );
  });

  it("selects one same-name pending attempt by requestId and never by both tokens", () => {
    expect(VmDetailInputSchema.safeParse({ name: "paseo-1", requestId }).success).toBe(true);
    expect(VmDetailInputSchema.safeParse({ name: "paseo-1", id: "sandbox_1" }).success).toBe(true);
    expect(
      VmDetailInputSchema.safeParse({ name: "paseo-1", id: "sandbox_1", requestId }).success,
    ).toBe(false);
    expect(VmDetailInputSchema.safeParse({ name: "paseo-1", requestId: "not-a-uuid" }).success).toBe(
      false,
    );
    expect(VmDetailInputSchema.safeParse({ name: "paseo-1", metrics: true }).success).toBe(false);
  });

  it("requires a fixed credential name and a non-blank stored value", () => {
    expect(
      SecretsSetInputSchema.safeParse({ name: "OPENAI_API_KEY", value: "sk-test" }).success,
    ).toBe(true);
    expect(
      SecretsSetInputSchema.safeParse({ name: "CUSTOM_TOKEN", value: "sk-test" }).success,
    ).toBe(false);
    expect(
      SecretsSetInputSchema.safeParse({ name: "OPENAI_API_KEY", value: "   " }).success,
    ).toBe(false);
    expect(
      SecretsSetInputSchema.safeParse({
        name: "OPENAI_API_KEY",
        value: "sk-test",
        stored: true,
      }).success,
    ).toBe(false);
  });

  it("does not allow raw config fields in the list DTO", () => {
    const result = {
      inventory: { status: "available" },
      registrations: { status: "available" },
      credentials: ["ANTHROPIC_API_KEY"],
      storedCredentials: [],
      children: [
        {
          ...sandboxChild,
          env: { ANTHROPIC_API_KEY: "must-not-cross" },
        },
      ],
    };

    expect(VmListOutputSchema.safeParse(result).success).toBe(false);
  });
});

describe("sandbox names", () => {
  it("accepts generated names and lowercase slugs", () => {
    for (const name of ["paseo-2f8f4c2e-8e52-4d0e-9db1-1a2b3c4d5e6f", "my-vm", "a", "a1", "a".repeat(63)]) {
      expect(VmNameSchema.safeParse(name).success).toBe(true);
    }
  });

  it("rejects uppercase, separators, whitespace, edge hyphens, and overlong names", () => {
    for (const name of [
      "",
      "Mixed-Case",
      "has/slash",
      "has space",
      "has_underscore",
      "has.dot",
      "-leading",
      "trailing-",
      "a".repeat(64),
      "é",
    ]) {
      expect(VmNameSchema.safeParse(name).success).toBe(false);
    }
  });
});

describe("create resources", () => {
  it("accepts an omitted name and resources or an explicit selection", () => {
    expect(VmCreateInputSchema.safeParse({ requestId, plan }).success).toBe(true);
    expect(VmCreateInputSchema.safeParse({ requestId, plan, name: "my-vm" }).success).toBe(true);
    expect(
      VmCreateInputSchema.safeParse({
        requestId,
        plan,
        name: "my-vm",
        resources: { memoryMib: 8192, diskMib: 20480 },
      }).success,
    ).toBe(true);
  });

  it("accepts the resource bounds and steps", () => {
    for (const memoryMib of [1024, 1280, 4096, 32768]) {
      expect(ResourceRequestSchema.safeParse({ memoryMib, diskMib: 10240 }).success).toBe(true);
    }
    for (const diskMib of [1024, 10240, 20480, 262144]) {
      expect(ResourceRequestSchema.safeParse({ memoryMib: 4096, diskMib }).success).toBe(true);
    }
  });

  it("requires both resource values and rejects out-of-range or off-step values", () => {
    expect(ResourceRequestSchema.safeParse({ memoryMib: 4096 }).success).toBe(false);
    expect(ResourceRequestSchema.safeParse({ diskMib: 10240 }).success).toBe(false);
    expect(ResourceRequestSchema.safeParse({ memoryMib: 1000, diskMib: 10240 }).success).toBe(false);
    expect(ResourceRequestSchema.safeParse({ memoryMib: 33024, diskMib: 10240 }).success).toBe(false);
    expect(ResourceRequestSchema.safeParse({ memoryMib: 4097, diskMib: 10240 }).success).toBe(false);
    expect(ResourceRequestSchema.safeParse({ memoryMib: 4096, diskMib: 12000 }).success).toBe(false);
    expect(ResourceRequestSchema.safeParse({ memoryMib: 4096, diskMib: 1024.5 }).success).toBe(
      false,
    );
  });

  it("accepts a bounded CPU selection and rejects unknown resource fields", () => {
    expect(
      VmCreateInputSchema.safeParse({
        requestId,
        plan,
        resources: { cpus: 4, memoryMib: 4096, diskMib: 10240 },
      }).success,
    ).toBe(true);
    for (const cpus of [1, 2, 16]) {
      expect(
        ResourceRequestSchema.safeParse({ cpus, memoryMib: 4096, diskMib: 10240 }).success,
      ).toBe(true);
    }
    for (const cpus of [0, 17, 2.5]) {
      expect(
        ResourceRequestSchema.safeParse({ cpus, memoryMib: 4096, diskMib: 10240 }).success,
      ).toBe(false);
    }
    expect(
      ResourceRequestSchema.safeParse({ memoryMib: 4096, diskMib: 10240, extra: true }).success,
    ).toBe(false);
  });

  it("rejects an invalid create name", () => {
    expect(VmCreateInputSchema.safeParse({ requestId, plan, name: "Mixed" }).success).toBe(false);
  });
});

describe("resize request", () => {
  it("requires the generation id and at least one target", () => {
    expect(
      VmResizeInputSchema.safeParse({ name: "paseo-1", id: "sandbox_1" }).success,
    ).toBe(false);
    expect(
      VmResizeInputSchema.safeParse({ name: "paseo-1", id: "sandbox_1", memoryMib: 8192 })
        .success,
    ).toBe(true);
    expect(
      VmResizeInputSchema.safeParse({ name: "paseo-1", id: "sandbox_1", diskMib: 20480 }).success,
    ).toBe(true);
    expect(
      VmResizeInputSchema.safeParse({
        name: "paseo-1",
        id: "sandbox_1",
        memoryMib: 8192,
        diskMib: 20480,
        restart: true,
      }).success,
    ).toBe(true);
  });

  it("rejects CPU changes, invalid names, and malformed targets", () => {
    expect(
      VmResizeInputSchema.safeParse({ name: "paseo-1", id: "sandbox_1", cpus: 4 }).success,
    ).toBe(false);
    expect(
      VmResizeInputSchema.safeParse({ name: "Bad Name", id: "sandbox_1", memoryMib: 8192 })
        .success,
    ).toBe(false);
    expect(
      VmResizeInputSchema.safeParse({ name: "paseo-1", id: "", memoryMib: 8192 }).success,
    ).toBe(false);
    expect(
      VmResizeInputSchema.safeParse({ name: "paseo-1", id: "sandbox_1", memoryMib: 1000 }).success,
    ).toBe(false);
    expect(
      VmResizeInputSchema.safeParse({ name: "paseo-1", id: "sandbox_1", diskMib: 12000 }).success,
    ).toBe(false);
    expect(
      VmResizeInputSchema.safeParse({
        name: "paseo-1",
        id: "sandbox_1",
        memoryMib: 8192,
        retire: true,
      }).success,
    ).toBe(false);
  });

  it("reports the aggregate outcome with observed and requested resources", () => {
    const parsed = VmResizeOutputSchema.safeParse({
      name: "paseo-1",
      id: "sandbox_1",
      result: "restart_required",
      resources: { cpus: 2, memoryMib: 4096, diskMib: 10240 },
      requestedResources: { cpus: 2, memoryMib: 8192, diskMib: 10240 },
    });
    expect(parsed.success).toBe(true);

    expect(
      VmResizeOutputSchema.safeParse({
        name: "paseo-1",
        id: "sandbox_1",
        result: "unknown",
        resources: { cpus: 2, memoryMib: null, diskMib: null },
        requestedResources: null,
      }).success,
    ).toBe(false);
  });
});

describe("child resource placement", () => {
  it("lets a pending row carry requested resources and the specified flag", () => {
    expect(
      VmChildSchema.safeParse({
        kind: "pending",
        name: "paseo-1",
        requestId,
        plan,
        phase: "creating",
        error: null,
        resources: { cpus: 2, memoryMib: 4096, diskMib: 10240 },
        resourcesSpecified: false,
      }).success,
    ).toBe(true);
  });

  it("lets a sandbox row carry observed and requested resources", () => {
    expect(
      VmChildSchema.safeParse({
        ...sandboxChild,
        resources: { cpus: 2, memoryMib: 4096, diskMib: null },
        requestedResources: null,
      }).success,
    ).toBe(true);
  });

  it("rejects the resources-specified flag outside a pending row", () => {
    expect(VmChildSchema.safeParse({ ...sandboxChild, resourcesSpecified: true }).success).toBe(
      false,
    );
  });

  it("rejects fabricated resources on a registration-only row", () => {
    const registrationChild = {
      kind: "registration",
      name: "paseo-1",
      id: "sandbox_1",
      phase: "registering",
      registration: { registrationId: "hst_1", status: "online", serverId: "srv_child" },
      error: null,
    };

    expect(
      VmChildSchema.safeParse({
        ...registrationChild,
        resources: { cpus: 2, memoryMib: 4096, diskMib: 10240 },
      }).success,
    ).toBe(false);
    expect(
      VmChildSchema.safeParse({ ...registrationChild, resourcesSpecified: true }).success,
    ).toBe(false);
    expect(VmChildSchema.safeParse(registrationChild).success).toBe(true);
  });
});

describe("metrics availability", () => {
  it("exposes a numeric sample when available", () => {
    expect(MetricsSampleSchema.safeParse(sample).success).toBe(true);
    expect(VmMetricsOutputSchema.safeParse({ status: "available", sample }).success).toBe(true);
  });

  it("uses the fixed unavailable reasons", () => {
    for (const reason of METRICS_UNAVAILABLE_REASONS) {
      expect(VmMetricsOutputSchema.safeParse({ status: "unavailable", reason }).success).toBe(true);
    }
    expect(METRICS_UNAVAILABLE_REASONS).toEqual([
      "no_sandbox",
      "not_running",
      "disabled",
      "unavailable",
    ]);
  });

  it("rejects raw errors, unknown reasons, and malformed samples", () => {
    expect(
      VmMetricsOutputSchema.safeParse({
        status: "unavailable",
        reason: "sandboxNotRunning",
      }).success,
    ).toBe(false);
    expect(
      VmMetricsOutputSchema.safeParse({
        status: "unavailable",
        reason: "unavailable",
        error: "raw sdk text",
      }).success,
    ).toBe(false);
    expect(
      MetricsSampleSchema.safeParse({ ...sample, timestamp: "yesterday" }).success,
    ).toBe(false);
    expect(
      MetricsSampleSchema.safeParse({ ...sample, cpuPercent: 100 * CPUS_MAX + 1 }).success,
    ).toBe(false);
    expect(MetricsSampleSchema.safeParse({ ...sample, memoryBytes: -1 }).success).toBe(false);
    expect(MetricsSampleSchema.safeParse({ ...sample, exitCode: 1 }).success).toBe(false);
  });
});

describe("V1.1 fixed values", () => {
  it("pins the metrics cadence and freshness bounds", () => {
    expect(METRICS_SAMPLE_INTERVAL_MS).toBe(2000);
    expect(METRICS_POLL_INTERVAL_MS).toBe(3000);
    expect(STALE_SAMPLE_MS).toBe(10_000);
    expect(MAX_SAMPLE_FUTURE_SKEW_MS).toBe(5_000);
  });

  it("adds only the two new safe error codes", () => {
    expect(SAFE_ERROR_CODES).toContain("mutation_pending");
    expect(SAFE_ERROR_CODES).toContain("resize_failed");
    expect(SAFE_ERROR_MESSAGES.mutation_pending.length).toBeGreaterThan(0);
    expect(SAFE_ERROR_MESSAGES.resize_failed.length).toBeGreaterThan(0);
  });
});

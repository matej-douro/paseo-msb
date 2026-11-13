import { describe, expect, it } from "vitest";
import {
  vmCreateRpc,
  vmDeleteRpc,
  vmDetailRpc,
  vmListRpc,
  vmReconcileRpc,
  VmCreateInputSchema,
  VmDeleteInputSchema,
  VmDetailInputSchema,
  VmListOutputSchema,
} from "../../shared/contracts";

const requestId = "2f8f4c2e-8e52-4d0e-9db1-1a2b3c4d5e6f";

describe("RPC contracts", () => {
  it("registers exactly the five v1 contracts", () => {
    expect(
      [vmListRpc, vmDetailRpc, vmCreateRpc, vmDeleteRpc, vmReconcileRpc].map(
        (contract) => contract.name,
      ),
    ).toEqual(["vm.list", "vm.detail", "vm.create", "vm.delete", "vm.reconcile"]);
  });

  it("accepts a strict create request with fixed credential names only", () => {
    const parsed = VmCreateInputSchema.safeParse({
      requestId,
      secretEnvVars: ["ANTHROPIC_API_KEY", "GH_TOKEN"],
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects empty, unknown, duplicate, and extra create fields", () => {
    expect(VmCreateInputSchema.safeParse({ requestId, secretEnvVars: [] }).success).toBe(false);
    expect(
      VmCreateInputSchema.safeParse({ requestId, secretEnvVars: ["CUSTOM_TOKEN"] }).success,
    ).toBe(false);
    expect(
      VmCreateInputSchema.safeParse({
        requestId,
        secretEnvVars: ["ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY"],
      }).success,
    ).toBe(false);
    expect(
      VmCreateInputSchema.safeParse({
        requestId,
        secretEnvVars: ["ANTHROPIC_API_KEY"],
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

  it("does not allow raw config fields in the list DTO", () => {
    const result = {
      inventory: { status: "available" },
      registrations: { status: "available" },
      credentials: ["ANTHROPIC_API_KEY"],
      children: [
        {
          kind: "sandbox",
          name: "paseo-1",
          id: "sandbox_1",
          labels: {
            "paseo-msb": "v1",
            "paseo-msb-parent": "srv_parent",
            "paseo-msb-id": "sandbox_1",
            "paseo-msb-phase": "ready",
          },
          runtimeStatus: "running",
          registration: null,
          env: { ANTHROPIC_API_KEY: "must-not-cross" },
        },
      ],
    };

    expect(VmListOutputSchema.safeParse(result).success).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import {
  secretsDeleteRpc,
  secretsListRpc,
  secretsSetRpc,
  vmCreateRpc,
  vmDeleteRpc,
  vmDetailRpc,
  vmListRpc,
  vmReconcileRpc,
  SecretsSetInputSchema,
  VmCreateInputSchema,
  VmDeleteInputSchema,
  VmDetailInputSchema,
  VmListOutputSchema,
} from "../../shared/contracts";

const requestId = "2f8f4c2e-8e52-4d0e-9db1-1a2b3c4d5e6f";

describe("RPC contracts", () => {
  it("registers the five lifecycle contracts and the credential store", () => {
    expect(
      [vmListRpc, vmDetailRpc, vmCreateRpc, vmDeleteRpc, vmReconcileRpc].map(
        (contract) => contract.name,
      ),
    ).toEqual(["vm.list", "vm.detail", "vm.create", "vm.delete", "vm.reconcile"]);
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
          kind: "sandbox",
          name: "paseo-1",
          id: "sandbox_1",
          labels: {
            "paseo-msb": "v1",
            "paseo-msb-parent": "srv_parent",
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

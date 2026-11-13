import { describe, expect, it } from "vitest";
import { VmListOutputSchema } from "../../shared/contracts";
import { loadManagedSandboxes } from "../../server/sandbox";
import { buildVmList } from "../../server/status";
import {
  fakeHostDirectory,
  fakeRegistration,
  fakeRuntime,
  fakeSandbox,
  PARENT_ID,
  SECRET_VALUE,
} from "./fake-runtime";

const PENDING = {
  requestId: "2f8f4c2e-8e52-4d0e-9db1-1a2b3c4d5e6f",
  name: "paseo-2f8f4c2e-8e52-4d0e-9db1-1a2b3c4d5e6f",
  phase: "creating" as const,
  createdAt: 1,
  errorCode: null,
  errorDetail: null,
};

describe("buildVmList", () => {
  it("joins a managed sandbox with its parent registration", async () => {
    const inventory = await loadManagedSandboxes(
      fakeRuntime([fakeSandbox({ id: "sandbox_1", name: "paseo-1", job: "job_1" })]),
      PARENT_ID,
    );

    const result = buildVmList({
      parentId: PARENT_ID,
      inventory,
      registrations: { status: "available", hosts: [fakeRegistration()] },
      pending: [],
      env: { ANTHROPIC_API_KEY: SECRET_VALUE, OPENAI_API_KEY: "   " },
    });

    expect(result.inventory.status).toBe("available");
    expect(result.registrations.status).toBe("available");
    expect(result.credentials).toEqual(["ANTHROPIC_API_KEY"]);
    expect(result.children).toHaveLength(1);
    expect(result.children[0]).toMatchObject({
      kind: "sandbox",
      name: "paseo-1",
      id: "sandbox_1",
      runtimeStatus: "running",
      registration: {
        registrationId: "reg_1",
        status: "online",
        serverId: "srv_child",
      },
    });
    expect(JSON.stringify(result)).not.toContain(SECRET_VALUE);
    expect(VmListOutputSchema.parse(result)).toEqual(result);
  });

  it("does not join a registration owned by another source", async () => {
    const inventory = await loadManagedSandboxes(
      fakeRuntime([fakeSandbox({ id: "sandbox_1", name: "paseo-1" })]),
      PARENT_ID,
    );

    const result = buildVmList({
      parentId: PARENT_ID,
      inventory,
      registrations: {
        status: "available",
        hosts: [
          fakeRegistration({
            metadata: { source: "another-plugin", vm: "sandbox_1", name: "paseo-1" },
          }),
        ],
      },
      pending: [],
      env: {},
    });

    expect(result.children[0]).toMatchObject({ kind: "sandbox", registration: null });
  });

  it("does not attach an older registration to a same-name replacement", async () => {
    const inventory = await loadManagedSandboxes(
      fakeRuntime([fakeSandbox({ id: "sandbox_new", name: "paseo-1" })]),
      PARENT_ID,
    );

    const result = buildVmList({
      parentId: PARENT_ID,
      inventory,
      registrations: {
        status: "available",
        hosts: [
          fakeRegistration({
            source: { id: "plugin", key: "sandbox_old" },
            metadata: { source: "paseo-msb", vm: "sandbox_old", name: "paseo-1" },
          }),
        ],
      },
      pending: [],
      env: {},
    });

    expect(result.children[0]).toMatchObject({ kind: "sandbox", registration: null });
  });

  it("includes pending creates before sandboxes", async () => {
    const inventory = await loadManagedSandboxes(
      fakeRuntime([fakeSandbox({ id: "sandbox_1", name: "paseo-z" })]),
      PARENT_ID,
    );

    const result = buildVmList({
      parentId: PARENT_ID,
      inventory,
      registrations: { status: "available", hosts: [] },
      pending: [PENDING],
      env: {},
    });

    expect(result.children.map((child) => [child.kind, child.name])).toEqual([
      ["pending", PENDING.name],
      ["sandbox", "paseo-z"],
    ]);
    expect(result.children[0]).toEqual({
      kind: "pending",
      name: PENDING.name,
      phase: "creating",
      error: null,
      errorDetail: null,
    });
    expect(VmListOutputSchema.parse(result)).toEqual(result);
  });

  it("keeps pending creates and reports unavailable inventory explicitly", async () => {
    const result = buildVmList({
      parentId: PARENT_ID,
      inventory: {
        status: "unavailable",
        error: { code: "inventory_unavailable", message: "Microsandbox inventory is unavailable." },
      },
      registrations: { status: "available", hosts: [] },
      pending: [PENDING],
      env: {},
    });

    expect(result.inventory.status).toBe("unavailable");
    expect(result.children).toHaveLength(1);
    expect(result.children[0].kind).toBe("pending");
    expect(VmListOutputSchema.parse(result)).toEqual(result);
  });

  it("reports unavailable registrations without hiding inventory", async () => {
    const inventory = await loadManagedSandboxes(
      fakeRuntime([fakeSandbox({ id: "sandbox_1", name: "paseo-1" })]),
      PARENT_ID,
    );

    const result = buildVmList({
      parentId: PARENT_ID,
      inventory,
      registrations: {
        status: "unavailable",
        error: { code: "registrations_unavailable", message: "Parent host registrations are unavailable." },
      },
      pending: [],
      env: {},
    });

    expect(result.inventory.status).toBe("available");
    expect(result.registrations.status).toBe("unavailable");
    expect(result.children[0]).toMatchObject({ kind: "sandbox", registration: null });
  });

  it("projects malformed managed sandboxes as failed", async () => {
    const inventory = await loadManagedSandboxes(
      fakeRuntime([fakeSandbox({ id: "sandbox_1", name: "paseo-1", rawConfig: null })]),
      PARENT_ID,
    );

    const result = buildVmList({
      parentId: PARENT_ID,
      inventory,
      registrations: { status: "available", hosts: [] },
      pending: [],
      env: {},
    });

    expect(result.children[0]).toMatchObject({
      kind: "sandbox",
      name: "paseo-1",
      id: "sandbox_1",
      labels: { "paseo-msb-phase": "failed", "paseo-msb-error": "invalid_config" },
      registration: null,
    });
  });

  it("reports plugin-stored credentials by name only", () => {
    const result = buildVmList({
      parentId: PARENT_ID,
      inventory: { status: "available", sandboxes: [], failures: [] },
      registrations: { status: "available", hosts: [] },
      pending: [],
      env: {},
      storedCredentials: ["OPENAI_API_KEY"],
    });

    expect(result.credentials).toEqual(["OPENAI_API_KEY"]);
    expect(result.storedCredentials).toEqual(["OPENAI_API_KEY"]);
    expect(VmListOutputSchema.parse(result)).toEqual(result);
  });

  it("exposes no raw directory fields in the projection", async () => {
    const inventory = await loadManagedSandboxes(
      fakeRuntime([fakeSandbox({ id: "sandbox_1", name: "paseo-1" })]),
      PARENT_ID,
    );
    const directory = fakeHostDirectory([
      fakeRegistration({
        metadata: {
          source: "paseo-msb",
          vm: "sandbox_1",
          name: "paseo-1",
          secret: SECRET_VALUE,
        },
      }),
    ]);

    const result = buildVmList({
      parentId: directory.self.serverId,
      inventory,
      registrations: { status: "available", hosts: directory.hosts },
      pending: [],
      env: { ANTHROPIC_API_KEY: SECRET_VALUE },
    });

    expect(JSON.stringify(result)).not.toContain(SECRET_VALUE);
  });
});

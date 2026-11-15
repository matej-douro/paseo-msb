import { describe, expect, it } from "vitest";
import { VmListOutputSchema } from "../../shared/contracts";
import type { CanonicalPlan } from "../../shared/provisioning";
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

const PENDING_PLAN: CanonicalPlan = {
  providers: [{ provider: "pi", llms: ["anthropic-api-key"] }],
  integrations: [],
};

const PENDING = {
  requestId: "2f8f4c2e-8e52-4d0e-9db1-1a2b3c4d5e6f",
  name: "paseo-2f8f4c2e-8e52-4d0e-9db1-1a2b3c4d5e6f",
  plan: PENDING_PLAN,
  resources: { cpus: 2 as const, memoryMib: 4096, diskMib: 10240 },
  resourcesSpecified: false,
  phase: "creating" as const,
  createdAt: 1,
  errorCode: null,
  errorDetail: null,
};

const OTHER_REQUEST_ID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

describe("buildVmList", () => {
  it("joins a managed sandbox with its parent registration", async () => {
    const inventory = await loadManagedSandboxes(
      fakeRuntime([fakeSandbox({ id: "sandbox_1", name: "paseo-1" })]),
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

  it("redacts persisted values from a legacy error detail label", async () => {
    const sandbox = fakeSandbox({
      id: "sandbox_1",
      name: "paseo-1",
      phase: "failed",
      error: "install_failed",
      extraLabels: { "paseo-msb-error-detail": `leaked ${SECRET_VALUE}` },
    });

    const inventory = await loadManagedSandboxes(
      fakeRuntime([sandbox]),
      PARENT_ID,
    );

    const result = buildVmList({
      parentId: PARENT_ID,
      inventory,
      registrations: { status: "available", hosts: [] },
      pending: [],
      env: {},
    });

    expect(JSON.stringify(result)).not.toContain(SECRET_VALUE);
    expect(result.children[0]).toMatchObject({ errorDetail: "leaked [redacted]" });
  });

  it("keeps a registration-only child visible beside a failed pending attempt", () => {
    const failedPending = {
      ...PENDING,
      phase: "failed" as const,
      errorCode: "registration_failed" as const,
    };
    const registration = fakeRegistration({
      metadata: { source: "paseo-msb", name: PENDING.name },
    });

    const result = buildVmList({
      parentId: PARENT_ID,
      inventory: { status: "available", sandboxes: [], failures: [] },
      registrations: { status: "available", hosts: [registration] },
      pending: [failedPending],
      env: {},
    });

    expect(result.children.map((child) => child.kind).sort()).toEqual([
      "pending",
      "registration",
    ]);
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
            source: { id: "plugin:another-plugin", key: "sandbox_1" },
            metadata: { source: "another-plugin", name: "paseo-1" },
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
            source: { id: "plugin:paseo-msb", key: "sandbox_old" },
            metadata: { source: "paseo-msb", name: "paseo-1" },
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
      requestId: PENDING.requestId,
      plan: PENDING.plan,
      phase: "creating",
      error: null,
      errorDetail: null,
      resources: PENDING.resources,
      resourcesSpecified: false,
    });
    expect(VmListOutputSchema.parse(result)).toEqual(result);
  });

  it("keeps same-name pending attempts distinct by request ID", () => {
    const other = {
      ...PENDING,
      requestId: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
      name: "shared-vm",
    };

    const result = buildVmList({
      parentId: PARENT_ID,
      inventory: { status: "available", sandboxes: [], failures: [] },
      registrations: { status: "available", hosts: [] },
      pending: [{ ...PENDING, name: "shared-vm" }, other],
      env: {},
    });

    expect(result.children.map((child) => [child.kind, child.name])).toEqual([
      ["pending", "shared-vm"],
      ["pending", "shared-vm"],
    ]);
    expect(
      result.children.map((child) => (child.kind === "pending" ? child.requestId : null)),
    ).toEqual([PENDING.requestId, other.requestId]);
    expect(VmListOutputSchema.parse(result)).toEqual(result);
  });

  it("reports observed resources and a pending restart", async () => {
    const handle = fakeSandbox({
      id: "sandbox_1",
      name: "paseo-1",
      requestId: PENDING.requestId,
      requestedResources: { cpus: 2, memoryMib: 8192, diskMib: 20480 },
      resourcesSpecified: true,
    });
    const inventory = await loadManagedSandboxes(fakeRuntime([handle]), PARENT_ID);

    const result = buildVmList({
      parentId: PARENT_ID,
      inventory,
      registrations: { status: "available", hosts: [] },
      pending: [],
      env: { ANTHROPIC_API_KEY: SECRET_VALUE },
    });

    expect(result.children[0]).toMatchObject({
      kind: "sandbox",
      resources: { cpus: 2, memoryMib: 4096, diskMib: 10240 },
      requestedResources: { cpus: 2, memoryMib: 8192, diskMib: 20480 },
    });
    expect(VmListOutputSchema.parse(result)).toEqual(result);

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(PENDING.requestId);
    expect(serialized).not.toContain(SECRET_VALUE);
  });

  it("hides requested resources once the observation matches", async () => {
    const handle = fakeSandbox({
      id: "sandbox_1",
      name: "paseo-1",
      requestId: PENDING.requestId,
      requestedResources: { cpus: 2, memoryMib: 4096, diskMib: 10240 },
      resourcesSpecified: true,
    });
    const inventory = await loadManagedSandboxes(fakeRuntime([handle]), PARENT_ID);

    const result = buildVmList({
      parentId: PARENT_ID,
      inventory,
      registrations: { status: "available", hosts: [] },
      pending: [],
      env: {},
    });

    expect(result.children[0]).toMatchObject({
      kind: "sandbox",
      requestedResources: null,
    });
  });

  it("supersedes only the pending attempt its request marker owns", async () => {
    const handle = fakeSandbox({
      id: "sandbox_1",
      name: "shared-vm",
      requestId: PENDING.requestId,
      requestedResources: PENDING.resources,
      resourcesSpecified: false,
    });
    const inventory = await loadManagedSandboxes(fakeRuntime([handle]), PARENT_ID);

    const result = buildVmList({
      parentId: PARENT_ID,
      inventory,
      registrations: { status: "available", hosts: [] },
      pending: [
        { ...PENDING, name: "shared-vm" },
        { ...PENDING, requestId: OTHER_REQUEST_ID, name: "shared-vm", createdAt: 2 },
      ],
      env: {},
    });

    expect(
      result.children.map((child) => [
        child.kind,
        child.name,
        child.kind === "pending" ? child.requestId : null,
      ]),
    ).toEqual([
      ["pending", "shared-vm", OTHER_REQUEST_ID],
      ["sandbox", "shared-vm", null],
    ]);
  });

  it("supersedes a generated-name pending attempt for a markerless sandbox", async () => {
    const inventory = await loadManagedSandboxes(
      fakeRuntime([fakeSandbox({ id: "sandbox_1", name: PENDING.name })]),
      PARENT_ID,
    );

    const result = buildVmList({
      parentId: PARENT_ID,
      inventory,
      registrations: { status: "available", hosts: [] },
      pending: [PENDING],
      env: {},
    });

    expect(result.children.map((child) => child.kind)).toEqual(["sandbox"]);
  });

  it("keeps a custom-named pending attempt beside a markerless sandbox", async () => {
    const inventory = await loadManagedSandboxes(
      fakeRuntime([fakeSandbox({ id: "sandbox_1", name: "my-vm" })]),
      PARENT_ID,
    );

    const result = buildVmList({
      parentId: PARENT_ID,
      inventory,
      registrations: { status: "available", hosts: [] },
      pending: [{ ...PENDING, name: "my-vm" }],
      env: {},
    });

    expect(result.children.map((child) => child.kind)).toEqual(["pending", "sandbox"]);
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

  it("replaces a pending row when a sandbox with the same name exists", async () => {
    const sandbox = fakeSandbox({ id: "sandbox_1", name: PENDING.name, phase: "installing" });
    const inventory = await loadManagedSandboxes(fakeRuntime([sandbox]), PARENT_ID);

    const result = buildVmList({
      parentId: PARENT_ID,
      inventory,
      registrations: { status: "available", hosts: [] },
      pending: [PENDING],
      env: {},
    });

    expect(result.children).toHaveLength(1);
    expect(result.children[0]).toMatchObject({
      kind: "sandbox",
      name: PENDING.name,
      id: "sandbox_1",
    });
    expect(VmListOutputSchema.parse(result)).toEqual(result);
  });

  it("includes a registration-only child when no sandbox has that name", () => {
    const result = buildVmList({
      parentId: PARENT_ID,
      inventory: { status: "available", sandboxes: [], failures: [] },
      registrations: {
        status: "available",
        hosts: [
          fakeRegistration({
            registrationId: "reg_only",
            source: { id: "plugin:paseo-msb", key: "sandbox_gone" },
            metadata: { source: "paseo-msb", name: "paseo-gone" },
            label: `${PARENT_ID}/paseo-gone`,
            status: "offline",
            serverId: null,
          }),
        ],
      },
      pending: [],
      env: {},
    });

    expect(result.children).toHaveLength(1);
    expect(result.children[0]).toMatchObject({
      kind: "registration",
      name: "paseo-gone",
      id: "sandbox_gone",
      phase: "registering",
      registration: { registrationId: "reg_only", status: "offline" },
    });
    expect(VmListOutputSchema.parse(result)).toEqual(result);
  });

  it("lists a plugin-owned registration without the managed name prefix", () => {
    const result = buildVmList({
      parentId: PARENT_ID,
      inventory: { status: "available", sandboxes: [], failures: [] },
      registrations: {
        status: "available",
        hosts: [
          fakeRegistration({
            registrationId: "reg_legacy",
            source: { id: "plugin:paseo-msb", key: "sandbox_gone" },
            metadata: { source: "paseo-msb", name: "legacy-child" },
            label: `${PARENT_ID}/legacy-child`,
            status: "offline",
            serverId: null,
          }),
        ],
      },
      pending: [],
      env: {},
    });

    expect(result.children).toEqual([
      expect.objectContaining({ kind: "registration", name: "legacy-child" }),
    ]);
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

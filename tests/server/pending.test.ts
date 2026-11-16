import { describe, expect, it } from "vitest";
import { CPUS, MEMORY_MIB, ROOT_DISK_MIB } from "../../shared/constants";
import type { VmCreateInput } from "../../shared/contracts";
import { canonicalizePlan, type CanonicalPlan } from "../../shared/provisioning";
import {
  createPendingCreateStore,
  createRequestFor,
  dismissPendingCreate,
  type PendingCreateRequest,
} from "../../server/pending";

const REQUEST_ID = "2f8f4c2e-8e52-4d0e-9db1-1a2b3c4d5e6f";
const OTHER_REQUEST_ID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const NAME = `paseo-${REQUEST_ID}`;

const PLAN: CanonicalPlan = {
  providers: [{ provider: "pi", llms: ["neuralwatt"] }],
  integrations: [],
};

const INPUT: VmCreateInput = { requestId: REQUEST_ID, plan: PLAN };

function request(patch: Partial<PendingCreateRequest> = {}): PendingCreateRequest {
  return {
    requestId: REQUEST_ID,
    name: NAME,
    plan: canonicalizePlan(PLAN),
    resources: { cpus: CPUS, memoryMib: MEMORY_MIB, diskMib: ROOT_DISK_MIB },
    resourcesSpecified: false,
    ...patch,
  };
}

describe("createRequestFor", () => {
  it("derives the generated name and default resources", () => {
    expect(createRequestFor(INPUT, PLAN)).toEqual(request());
  });

  it("keeps an explicit name, resources, and the specified flag", () => {
    expect(
      createRequestFor(
        {
          ...INPUT,
          name: "my-vm",
          resources: { memoryMib: 8192, diskMib: 20480 },
        },
        PLAN,
      ),
    ).toEqual(
      request({
        name: "my-vm",
        resources: { cpus: CPUS, memoryMib: 8192, diskMib: 20480 },
        resourcesSpecified: true,
      }),
    );
  });

  it("keeps an explicit CPU count", () => {
    expect(
      createRequestFor(
        {
          ...INPUT,
          resources: { cpus: 4, memoryMib: 8192, diskMib: 20480 },
        },
        PLAN,
      ),
    ).toEqual(
      request({
        resources: { cpus: 4, memoryMib: 8192, diskMib: 20480 },
        resourcesSpecified: true,
      }),
    );
  });

  it("canonicalizes the plan order", () => {
    const ordered = createRequestFor(
      {
        ...INPUT,
        plan: {
          providers: [
            { provider: "pi", llms: ["gemini-api-key", "anthropic-api-key"] },
            { provider: "claude", llms: ["anthropic-api-key"] },
          ],
          integrations: ["github-cli"],
        },
      },
      {
        providers: [
          { provider: "pi", llms: ["gemini-api-key", "anthropic-api-key"] },
          { provider: "claude", llms: ["anthropic-api-key"] },
        ],
        integrations: ["github-cli"],
      },
    );

    expect(ordered.plan).toEqual({
      providers: [
        { provider: "claude", llms: ["anthropic-api-key"] },
        { provider: "pi", llms: ["anthropic-api-key", "gemini-api-key"] },
      ],
      integrations: ["github-cli"],
    });
  });
});

describe("pending create store", () => {
  it("reserves the canonical request and reports it", () => {
    const store = createPendingCreateStore();
    const reservation = store.reserve(request());
    if (reservation.status !== "reserved") throw new Error("expected a reservation");

    expect(reservation.entry).toMatchObject({
      requestId: REQUEST_ID,
      name: NAME,
      plan: canonicalizePlan(PLAN),
      resources: { cpus: CPUS, memoryMib: MEMORY_MIB, diskMib: ROOT_DISK_MIB },
      resourcesSpecified: false,
      phase: "creating",
      errorCode: null,
    });
    expect(store.find(REQUEST_ID)).toBe(reservation.entry);
  });

  it("joins an identical running attempt", () => {
    const store = createPendingCreateStore();
    const first = store.reserve(request());
    const second = store.reserve(request());
    if (first.status !== "reserved") throw new Error("expected a reservation");
    if (second.status !== "joined") throw new Error("expected a join");

    expect(second.entry).toBe(first.entry);
    expect(store.list()).toHaveLength(1);
  });

  it("rejects a different request after a failure instead of restarting it", () => {
    const store = createPendingCreateStore();
    const first = store.reserve(request());
    if (first.status !== "reserved") throw new Error("expected a reservation");

    store.fail(REQUEST_ID, "create_failed", "image pulled slowly", first.entry);
    expect(store.find(REQUEST_ID)).toMatchObject({ phase: "failed", errorCode: "create_failed" });

    const retry = store.reserve(
      request({
        name: "my-vm",
        resources: { cpus: CPUS, memoryMib: 8192, diskMib: 20480 },
        resourcesSpecified: true,
      }),
    );

    expect(retry.status).toBe("conflict");
    expect(store.find(REQUEST_ID)).toMatchObject({ phase: "failed" });
  });

  it("restarts a failed attempt when the request still matches", () => {
    const store = createPendingCreateStore();
    const first = store.reserve(request());
    if (first.status !== "reserved") throw new Error("expected a reservation");

    store.fail(REQUEST_ID, "create_failed", "image pulled slowly", first.entry);
    const retry = store.reserve(request());

    expect(retry.status).toBe("reserved");
    if (retry.status !== "reserved") throw new Error("expected a reservation");
    expect(retry.entry).toMatchObject({
      phase: "creating",
      errorCode: null,
      errorDetail: null,
      name: NAME,
      resourcesSpecified: false,
    });
    expect(store.find(REQUEST_ID)).toBe(retry.entry);
  });

  it("rejects a different name, plan, resources, or specified flag for the same request", () => {
    const store = createPendingCreateStore();
    store.reserve(request());

    expect(store.reserve(request({ name: "other-vm" })).status).toBe("conflict");
    expect(
      store.reserve(
        request({
          plan: { providers: [{ provider: "pi", llms: ["anthropic-api-key"] }], integrations: [] },
        }),
      ).status,
    ).toBe("conflict");
    expect(
      store.reserve(
        request({ resources: { cpus: CPUS, memoryMib: 8192, diskMib: ROOT_DISK_MIB } }),
      ).status,
    ).toBe("conflict");
    expect(
      store.reserve(
        request({ resources: { cpus: CPUS, memoryMib: MEMORY_MIB, diskMib: 20480 } }),
      ).status,
    ).toBe("conflict");
    // The same values become a different request once they are explicit.
    expect(store.reserve(request({ resourcesSpecified: true })).status).toBe("conflict");

    expect(store.list()).toHaveLength(1);
  });

  it("keeps same-name attempts from different requests distinct", () => {
    const store = createPendingCreateStore();
    const first = store.reserve(request({ name: "shared-vm" }));
    const second = store.reserve(request({ requestId: OTHER_REQUEST_ID, name: "shared-vm" }));

    expect(first.status).toBe("reserved");
    expect(second.status).toBe("reserved");
    expect(
      store.list().map((entry) => ({ requestId: entry.requestId, name: entry.name })),
    ).toEqual([
      { requestId: REQUEST_ID, name: "shared-vm" },
      { requestId: OTHER_REQUEST_ID, name: "shared-vm" },
    ]);
    expect(store.find(REQUEST_ID)?.name).toBe("shared-vm");
    expect(store.find(OTHER_REQUEST_ID)?.name).toBe("shared-vm");
  });

  it("settles only the attempt it was given", () => {
    const store = createPendingCreateStore();
    const first = store.reserve(request());
    if (first.status !== "reserved") throw new Error("expected a reservation");
    store.fail(REQUEST_ID, "create_failed", null, first.entry);
    const second = store.reserve(request());
    if (second.status !== "reserved") throw new Error("expected a reservation");

    store.settle(REQUEST_ID, first.entry);
    expect(store.find(REQUEST_ID)).toBe(second.entry);

    store.settle(REQUEST_ID, second.entry);
    expect(store.find(REQUEST_ID)).toBeNull();
  });
});

describe("dismissPendingCreate", () => {
  it("dismisses only a failed pending attempt", () => {
    const store = createPendingCreateStore();
    const reservation = store.reserve(request());
    if (reservation.status !== "reserved") throw new Error("expected a reservation");

    expect(() => dismissPendingCreate(store, REQUEST_ID)).toThrow("The request is invalid.");

    store.fail(REQUEST_ID, "missing_credentials", null, reservation.entry);
    expect(dismissPendingCreate(store, REQUEST_ID)).toEqual({
      name: NAME,
      dismissed: true,
    });
    expect(store.find(REQUEST_ID)).toBeNull();
  });

  it("dismisses one same-name attempt without touching the other", () => {
    const store = createPendingCreateStore();
    const first = store.reserve(request({ name: "shared-vm" }));
    store.reserve(request({ requestId: OTHER_REQUEST_ID, name: "shared-vm" }));
    if (first.status !== "reserved") throw new Error("expected a reservation");

    store.fail(REQUEST_ID, "name_conflict", null, first.entry);
    expect(dismissPendingCreate(store, REQUEST_ID)).toEqual({
      name: "shared-vm",
      dismissed: true,
    });
    expect(store.find(OTHER_REQUEST_ID)?.name).toBe("shared-vm");
  });

  it("does not dismiss an unknown or already-settled attempt", () => {
    const store = createPendingCreateStore();
    expect(() => dismissPendingCreate(store, REQUEST_ID)).toThrow("The child was not found.");
  });
});

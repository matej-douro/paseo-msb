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

const NAME = "builder-1";

const PLAN: CanonicalPlan = {
  providers: [{ provider: "pi", llms: ["neuralwatt"] }],
  integrations: [],
};

const INPUT: VmCreateInput = { name: NAME, plan: PLAN };

function request(patch: Partial<PendingCreateRequest> = {}): PendingCreateRequest {
  return {
    name: NAME,
    plan: canonicalizePlan(PLAN),
    resources: { cpus: CPUS, memoryMib: MEMORY_MIB, diskMib: ROOT_DISK_MIB },
    resourcesSpecified: false,
    ...patch,
  };
}

describe("createRequestFor", () => {
  it("keeps the name and default resources", () => {
    expect(createRequestFor(INPUT, PLAN)).toEqual(request());
  });

  it("keeps explicit resources and the specified flag", () => {
    expect(
      createRequestFor(
        {
          ...INPUT,
          resources: { memoryMib: 8192, diskMib: 20480 },
        },
        PLAN,
      ),
    ).toEqual(
      request({
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
      name: NAME,
      plan: canonicalizePlan(PLAN),
      resources: { cpus: CPUS, memoryMib: MEMORY_MIB, diskMib: ROOT_DISK_MIB },
      resourcesSpecified: false,
      phase: "creating",
      errorCode: null,
    });
    expect(store.find(NAME)).toBe(reservation.entry);
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

  it("rejects a different shape for the same name", () => {
    const store = createPendingCreateStore();
    store.reserve(request());

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

  it("restarts a failed attempt when the request still matches", () => {
    const store = createPendingCreateStore();
    const first = store.reserve(request());
    if (first.status !== "reserved") throw new Error("expected a reservation");

    store.fail(NAME, "create_failed", "image pulled slowly", first.entry);
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
    expect(store.find(NAME)).toBe(retry.entry);
  });

  it("rejects a different shape after a failure instead of restarting it", () => {
    const store = createPendingCreateStore();
    const first = store.reserve(request());
    if (first.status !== "reserved") throw new Error("expected a reservation");

    store.fail(NAME, "create_failed", "image pulled slowly", first.entry);
    expect(store.find(NAME)).toMatchObject({ phase: "failed", errorCode: "create_failed" });

    const retry = store.reserve(
      request({ resources: { cpus: CPUS, memoryMib: 8192, diskMib: 20480 }, resourcesSpecified: true }),
    );

    expect(retry.status).toBe("conflict");
    expect(store.find(NAME)).toMatchObject({ phase: "failed" });
  });

  it("settles only the attempt it was given", () => {
    const store = createPendingCreateStore();
    const first = store.reserve(request());
    if (first.status !== "reserved") throw new Error("expected a reservation");
    store.fail(NAME, "create_failed", null, first.entry);
    const second = store.reserve(request());
    if (second.status !== "reserved") throw new Error("expected a reservation");

    store.settle(NAME, first.entry);
    expect(store.find(NAME)).toBe(second.entry);

    store.settle(NAME, second.entry);
    expect(store.find(NAME)).toBeNull();
  });
});

describe("dismissPendingCreate", () => {
  it("dismisses only a failed pending attempt", () => {
    const store = createPendingCreateStore();
    const reservation = store.reserve(request());
    if (reservation.status !== "reserved") throw new Error("expected a reservation");

    expect(() => dismissPendingCreate(store, NAME)).toThrow("The request is invalid.");

    store.fail(NAME, "missing_credentials", null, reservation.entry);
    expect(dismissPendingCreate(store, NAME)).toEqual({
      name: NAME,
      dismissed: true,
    });
    expect(store.find(NAME)).toBeNull();
  });

  it("does not dismiss an unknown or already-settled attempt", () => {
    const store = createPendingCreateStore();
    expect(() => dismissPendingCreate(store, NAME)).toThrow("The child was not found.");
  });
});

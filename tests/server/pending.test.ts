import { describe, expect, it } from "vitest";
import type { CanonicalPlan } from "../../shared/provisioning";
import { createPendingCreateStore, dismissPendingCreate } from "../../server/pending";

const REQUEST_ID = "2f8f4c2e-8e52-4d0e-9db1-1a2b3c4d5e6f";
const PLAN: CanonicalPlan = {
  providers: [{ provider: "pi", llms: ["neuralwatt"] }],
  integrations: [],
};

describe("dismissPendingCreate", () => {
  it("dismisses only a failed pending attempt", () => {
    const store = createPendingCreateStore();
    const reservation = store.reserve(REQUEST_ID, PLAN);
    if (reservation.status !== "reserved") throw new Error("expected a reservation");

    expect(() => dismissPendingCreate(store, REQUEST_ID)).toThrow("The request is invalid.");

    store.fail(REQUEST_ID, "missing_credentials", null, reservation.entry);
    expect(dismissPendingCreate(store, REQUEST_ID)).toEqual({
      name: `paseo-${REQUEST_ID}`,
      dismissed: true,
    });
    expect(store.find(REQUEST_ID)).toBeNull();
  });

  it("does not dismiss an unknown or already-settled attempt", () => {
    const store = createPendingCreateStore();
    expect(() => dismissPendingCreate(store, REQUEST_ID)).toThrow("The child was not found.");
  });
});

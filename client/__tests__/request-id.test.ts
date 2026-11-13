import { describe, expect, it } from "vitest";
import { newRequestId } from "../request-id";

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("newRequestId", () => {
  it("produces a UUID v4 accepted by the create contract", () => {
    for (let index = 0; index < 20; index += 1) {
      expect(newRequestId()).toMatch(UUID_V4);
    }
  });

  it("does not repeat within a session", () => {
    const ids = new Set(Array.from({ length: 50 }, () => newRequestId()));
    expect(ids.size).toBe(50);
  });
});

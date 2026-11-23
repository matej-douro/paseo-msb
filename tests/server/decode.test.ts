import { describe, expect, it } from "vitest";
import { EnvEntrySchema } from "../../server/decode";

describe("EnvEntrySchema", () => {
  it("falls back to the other name field when one is malformed", () => {
    expect(EnvEntrySchema.parse({ name: 5, key: "A", value: "v" }).key).toBe("A");
    expect(EnvEntrySchema.parse({ name: null, key: "A", value: "v" }).name).toBeUndefined();
    expect(EnvEntrySchema.parse({ name: "A", key: 5, value: "v" }).key).toBeUndefined();
    expect(EnvEntrySchema.parse({ name: "A", key: 5, value: "v" }).name).toBe("A");
  });

  it("still requires a string value", () => {
    expect(EnvEntrySchema.safeParse({ name: "A", value: 5 }).success).toBe(false);
    expect(EnvEntrySchema.safeParse({ name: "A" }).success).toBe(false);
  });
});

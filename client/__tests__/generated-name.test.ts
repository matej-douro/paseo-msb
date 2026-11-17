import { describe, expect, it } from "vitest";
import { VmNameSchema } from "../../shared/contracts";
import { newGeneratedChildName } from "../generated-name";

const NAME = /^paseo-[a-z0-9]{10}$/;

describe("newGeneratedChildName", () => {
  it("produces names accepted by the create contract", () => {
    for (let index = 0; index < 20; index += 1) {
      const name = newGeneratedChildName();
      expect(name).toMatch(NAME);
      expect(VmNameSchema.safeParse(name).success).toBe(true);
    }
  });

  it("does not repeat within a session", () => {
    const names = new Set(Array.from({ length: 50 }, () => newGeneratedChildName()));
    expect(names.size).toBe(50);
  });
});

import { describe, expect, it } from "vitest";
import { newGeneratedChildName } from "../generated-name";

const NAME =
  /^paseo-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("newGeneratedChildName", () => {
  it("produces names accepted by the create contract", () => {
    for (let index = 0; index < 20; index += 1) {
      expect(newGeneratedChildName()).toMatch(NAME);
    }
  });

  it("does not repeat within a session", () => {
    const names = new Set(Array.from({ length: 50 }, () => newGeneratedChildName()));
    expect(names.size).toBe(50);
  });
});

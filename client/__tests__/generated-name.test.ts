import { afterEach, describe, expect, it, vi } from "vitest";
import { VmNameSchema } from "../../shared/contracts";
import { newGeneratedChildName } from "../generated-name";

const NAME = /^paseo-[a-z0-9]{10}$/;

afterEach(() => {
  vi.unstubAllGlobals();
});

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

  it("falls back when crypto is unavailable or unusable", () => {
    vi.stubGlobal("crypto", undefined);
    expect(newGeneratedChildName()).toMatch(NAME);

    vi.stubGlobal("crypto", {
      getRandomValues: () => {
        throw new Error("crypto unavailable");
      },
    });
    expect(newGeneratedChildName()).toMatch(NAME);
  });
});

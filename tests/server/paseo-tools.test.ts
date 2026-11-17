import { describe, expect, it } from "vitest";
import { paseoToolsPatch } from "../../server/paseo-tools";

describe("Paseo tools patch", () => {
  it("injects Paseo tools and enables the provider policy", () => {
    expect(paseoToolsPatch(["claude", "pi"])).toEqual({
      mcp: { injectIntoAgents: true },
      providers: {
        claude: { paseoTools: { enabled: true } },
        pi: { paseoTools: { enabled: true } },
      },
    });
  });

  it("refuses to build a patch without a selected provider", () => {
    expect(() => paseoToolsPatch([])).toThrow(/No Paseo provider/);
  });
});

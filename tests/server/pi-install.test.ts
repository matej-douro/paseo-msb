import { describe, expect, it } from "vitest";
import { PI_VERSION, PI_PREFIX } from "../../shared/constants";
import { inspectPiInstall, piPathCheckSpec } from "../../server/pi-install";

describe("Pi path check", () => {
  it("does not run pi when command -v finds nothing", () => {
    const spec = piPathCheckSpec();
    const script = spec.args.at(-1) ?? "";

    expect(script).toContain("command -v pi &&");
    expect(script).not.toContain("command -v pi;");
  });

  it("accepts only the pinned path and version", () => {
    expect(inspectPiInstall(`${PI_PREFIX}/bin/pi\n${PI_VERSION}\n`)).toEqual({
      path: `${PI_PREFIX}/bin/pi`,
      version: PI_VERSION,
    });
    expect(inspectPiInstall("")).toBeNull();
    expect(inspectPiInstall(`/usr/local/bin/pi\n${PI_VERSION}\n`)).toBeNull();
    expect(inspectPiInstall(`${PI_PREFIX}/bin/pi\n0.0.1\n`)).toBeNull();
  });
});

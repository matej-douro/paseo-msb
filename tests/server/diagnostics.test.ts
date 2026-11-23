import { describe, expect, it } from "vitest";
import { MAX_ERROR_DETAIL_CHARS } from "../../shared/constants";
import {
  failureDetail,
  persistedCredentialValues,
} from "../../server/diagnostics";

describe("failureDetail", () => {
  it("redacts every known credential value", () => {
    const detail = failureDetail(
      new Error("pull failed with super-secret and another-secret"),
      ["super-secret", "another-secret"],
    );

    expect(detail).toBe("Error: pull failed with [redacted] and [redacted]");
  });

  it("prefers explicit detail on a setup failure and strips control characters", () => {
    const detail = failureDetail({ code: "provision_failed", detail: "npm\nfailed\there" });
    expect(detail).toBe("npm failed here");
  });

  it("includes nested causes in the redacted detail", () => {
    const root = new Error("Cannot find module './microsandbox.darwin-arm64.node'");
    const middle = new Error(
      "dlopen failed: mapping process and mapped file have different Team IDs",
      { cause: root },
    );
    const top = new Error("Cannot find native binding", { cause: middle });

    const detail = failureDetail(top);

    expect(detail).toContain("Cannot find native binding");
    expect(detail).toContain("different Team IDs");
    expect(detail).toContain("Cannot find module");
  });

  it("bounds long text", () => {
    const detail = failureDetail(new Error("x".repeat(MAX_ERROR_DETAIL_CHARS + 500)));
    expect(detail).not.toBeNull();
    expect(detail!.length).toBe(MAX_ERROR_DETAIL_CHARS);
    expect(detail!.endsWith("…")).toBe(true);
  });

  it("returns null for empty failures", () => {
    expect(failureDetail(null)).toBeNull();
    expect(failureDetail(new Error(""))).toBe("Error");
  });

  it("reads creation-time credential values from persisted sandbox config", () => {
    const values = persistedCredentialValues({
      env: [{ name: "ANTHROPIC_API_KEY", value: "anthropic-old" }],
      network: {
        secrets: {
          secrets: [
            { envVar: "GH_TOKEN", value: "gh-old" },
            { envVar: "CUSTOM", value: "not-fixed" },
          ],
        },
      },
    });

    expect(values.sort()).toEqual(["anthropic-old", "gh-old"]);
  });

  it("reads network secret values from a flat secret array", () => {
    // The SDK type declares `network.secrets` as a flat array; the nested shape
    // above is what the native config also emits. Redaction must cover both.
    const values = persistedCredentialValues({
      network: {
        secrets: [{ envVar: "GH_TOKEN", value: "gh-flat" }, { envVar: "CUSTOM", value: "skip" }],
      },
    });

    expect(values).toEqual(["gh-flat"]);
  });

  it("reads a CLI-shaped env entry that names its field `key`", () => {
    // The persisted native config carries entries as either `name` or `key`;
    // both must reach the redaction set.
    const values = persistedCredentialValues({
      env: [{ key: "GH_TOKEN", value: "gh-keyed" }],
    });
    expect(values).toEqual(["gh-keyed"]);
  });

  it("ignores malformed persisted config without throwing", () => {
    expect(persistedCredentialValues(null)).toEqual([]);
    expect(persistedCredentialValues({ network: "broken", env: 7 })).toEqual([]);
    expect(persistedCredentialValues({ env: [{ name: "GH_TOKEN", value: "" }] })).toEqual([]);
    expect(
      persistedCredentialValues({
        env: { GH_TOKEN: "gh-record", ANTHROPIC_API_KEY: 42 },
      }),
    ).toEqual(["gh-record"]);
  });
});

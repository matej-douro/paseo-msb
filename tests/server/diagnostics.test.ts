import { describe, expect, it } from "vitest";
import { MAX_ERROR_DETAIL_CHARS } from "../../shared/constants";
import { failureDetail } from "../../server/diagnostics";

describe("failureDetail", () => {
  it("redacts every known credential value", () => {
    const detail = failureDetail(
      new Error("pull failed with super-secret and another-secret"),
      ["super-secret", "another-secret"],
    );

    expect(detail).toBe("Error: pull failed with [redacted] and [redacted]");
  });

  it("prefers explicit detail on a setup failure and strips control characters", () => {
    const detail = failureDetail({ code: "install_failed", detail: "npm\nfailed\there" });
    expect(detail).toBe("npm failed here");
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
});

import { describe, expect, it } from "vitest";
import { MAX_JOB_PAGES } from "../../shared/constants";
import { collectSandboxPages } from "../../server/runtime";
import type { SandboxHandleLike } from "../../server/sandbox";
import { fakeSandbox } from "./fake-runtime";

function sandbox(id: string): SandboxHandleLike {
  return fakeSandbox({ id, name: `paseo-${id}` });
}

describe("collectSandboxPages", () => {
  it("collects every page until the cursor ends", async () => {
    const first = sandbox("one");
    const second = sandbox("two");
    const pages = [
      { sandboxes: [first], nextCursor: "page_2" },
      { sandboxes: [second], nextCursor: null },
    ];
    const cursors: (string | undefined)[] = [];

    const result = await collectSandboxPages(async (cursor) => {
      cursors.push(cursor);
      return pages[cursors.length - 1];
    });

    expect(result).toEqual([first, second]);
    expect(cursors).toEqual([undefined, "page_2"]);
  });

  it("rejects a repeated cursor instead of looping", async () => {
    await expect(
      collectSandboxPages(async () => ({ sandboxes: [], nextCursor: "same" })),
    ).rejects.toThrow("sandbox inventory repeated a cursor");
  });

  it("rejects an inventory that exceeds the page budget", async () => {
    let calls = 0;

    await expect(
      collectSandboxPages(async () => ({
        sandboxes: [],
        nextCursor: `page_${calls++}`,
      })),
    ).rejects.toThrow("sandbox inventory exceeded the page budget");

    expect(calls).toBe(MAX_JOB_PAGES);
  });
});

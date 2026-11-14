import { describe, expect, it } from "vitest";
import { readVmList, type ReadContext } from "../../server/rpc";
import type { HostDirectoryLike } from "../../server/status";
import { fakeRuntime } from "./fake-runtime";

function readContext(hosts: ReadContext["hosts"]): ReadContext {
  return {
    hosts,
    runtime: fakeRuntime([]),
    pending: [],
    env: {},
    storedCredentials: [],
    storedSecrets: new Map(),
    hostCallTimeoutMs: 10,
  };
}

describe("readVmList", () => {
  it("bounds the parent directory read instead of waiting forever", async () => {
    const never = new Promise<HostDirectoryLike>(() => {});
    const result = await readVmList(readContext({ list: () => never }));

    expect(result.registrations).toMatchObject({
      status: "unavailable",
      error: { code: "registrations_unavailable" },
    });
    expect(result.inventory).toMatchObject({ status: "unavailable" });
    expect(result.children).toEqual([]);
  });
});

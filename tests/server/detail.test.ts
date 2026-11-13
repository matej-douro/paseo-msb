import { describe, expect, it } from "vitest";
import {
  REGISTRATION_PRODUCER_ID,
  MAX_LOG_ENTRIES,
  MAX_LOG_LINE_BYTES,
} from "../../shared/constants";
import { VmDetailOutputSchema } from "../../shared/contracts";
import type { CanonicalPlan } from "../../shared/provisioning";
import { boundLogLines } from "../../server/logs";
import { readVmDetail } from "../../server/rpc";
import type { ReadContext } from "../../server/rpc";
import {
  fakeHostDirectory,
  fakeRegistration,
  fakeRuntime,
  fakeSandbox,
  failingRuntime,
  PARENT_ID,
  SECRET_VALUE,
} from "./fake-runtime";

function logEntry(text: string, index = 0, source = "stdout") {
  return { timestamp: new Date(1_700_000_000_000 + index), source, text: () => text };
}

function jobLogEntry(text: string, index = 0, source = "stdout") {
  return {
    timestamp: 1_700_000_000_000 + index,
    source,
    data: new TextEncoder().encode(text),
  };
}

function context(runtime: ReadContext["runtime"], pending: ReadContext["pending"] = []): ReadContext {
  return {
    hosts: { list: async () => fakeHostDirectory([]) },
    runtime,
    pending,
    env: { ANTHROPIC_API_KEY: SECRET_VALUE },
    storedCredentials: [],
    storedSecrets: new Map(),
  };
}

describe("readVmDetail", () => {
  it("keeps only the newest bounded log entries", () => {
    const lines = Array.from({ length: MAX_LOG_ENTRIES + 50 }, (_, index) => ({
      timestamp: new Date(1_700_000_000_000 + index).toISOString(),
      stream: "stdout" as const,
      text: `line ${index}`,
    }));

    const bundle = boundLogLines(lines, []);

    expect(bundle.entries).toHaveLength(MAX_LOG_ENTRIES);
    expect(bundle.truncated).toBe(true);
    expect(bundle.entries[0].text).toBe("line 50");
    expect(bundle.entries[MAX_LOG_ENTRIES - 1].text).toBe(`line ${MAX_LOG_ENTRIES + 49}`);
  });

  it("returns bounded, redacted sandbox and job logs", async () => {
    const logs = [
      logEntry("before secret", 0),
      logEntry(`token ${SECRET_VALUE} after`, 1),
      logEntry("x".repeat(MAX_LOG_LINE_BYTES * 2), 2),
    ];
    const handle = fakeSandbox({
      id: "sandbox_1",
      name: "paseo-1",
      jobs: [
        {
          id: "job_1",
          command: [
            "npm",
            "install",
            "-g",
            "--ignore-scripts",
            "--prefix",
            "/home/paseo/.local",
            "@earendil-works/pi-coding-agent@1.1.0",
          ],
          state: "exited",
          exitCode: 0,
        },
      ],
      logs,
      jobLogs: [jobLogEntry(`npm token=${SECRET_VALUE}`, 0)],
    });

    const detail = await readVmDetail(context(fakeRuntime([handle])), { name: "paseo-1" });

    expect(detail.child).toMatchObject({ kind: "sandbox", name: "paseo-1", id: "sandbox_1" });
    expect(detail.logs.sandbox.available).toBe(true);
    expect(detail.logs.sandbox.entries.length).toBeLessThanOrEqual(MAX_LOG_ENTRIES);
    expect(detail.logs.sandbox.truncated).toBe(true);

    for (const entry of detail.logs.sandbox.entries) {
      expect(entry.text).not.toContain(SECRET_VALUE);
      expect(new TextEncoder().encode(entry.text).byteLength).toBeLessThanOrEqual(
        MAX_LOG_LINE_BYTES,
      );
    }

    expect(detail.logs.job.available).toBe(true);
    expect(detail.logs.job.entries[0].text).not.toContain(SECRET_VALUE);
    expect(JSON.stringify(detail)).not.toContain(SECRET_VALUE);
    expect(VmDetailOutputSchema.parse(detail)).toEqual(detail);
  });

  it("distinguishes unavailable inventory from empty inventory", async () => {
    const unavailable = await readVmDetail(context(failingRuntime()), { name: "paseo-1" });
    const empty = await readVmDetail(
      {
        ...context(fakeRuntime([])),
        hosts: { list: async () => fakeHostDirectory([]) },
      },
      { name: "paseo-1" },
    );

    expect(unavailable.inventory.status).toBe("unavailable");
    expect(unavailable.child).toBeNull();
    expect(unavailable.logs.sandbox.available).toBe(false);

    expect(empty.inventory.status).toBe("available");
    expect(empty.child).toBeNull();
    expect(empty.logs.sandbox.available).toBe(false);
  });

  it("returns a pending create without attempting logs", async () => {
    const plan: CanonicalPlan = {
      providers: [{ provider: "pi", llms: ["anthropic-api-key"] }],
      integrations: [],
    };
    const pending = {
      requestId: "2f8f4c2e-8e52-4d0e-9db1-1a2b3c4d5e6f",
      name: "paseo-2f8f4c2e-8e52-4d0e-9db1-1a2b3c4d5e6f",
      plan,
      phase: "creating" as const,
      createdAt: 1,
      errorCode: null,
      errorDetail: null,
    };

    const detail = await readVmDetail(context(failingRuntime(), [pending]), {
      name: pending.name,
    });

    expect(detail.child).toEqual({
      kind: "pending",
      name: pending.name,
      requestId: pending.requestId,
      plan,
      phase: "creating",
      error: null,
      errorDetail: null,
    });
    expect(detail.logs.sandbox.available).toBe(false);
    expect(detail.logs.job.available).toBe(false);
    expect(VmDetailOutputSchema.parse(detail)).toEqual(detail);
  });

  it("reports unavailable logs without failing the detail", async () => {
    const handle = fakeSandbox({
      id: "sandbox_1",
      name: "paseo-1",
      listJobsError: new Error("job backend unavailable"),
    });
    handle.logs = async () => {
      throw new Error("log backend unavailable");
    };

    const detail = await readVmDetail(context(fakeRuntime([handle])), { name: "paseo-1" });

    expect(detail.child).toMatchObject({ kind: "sandbox", name: "paseo-1" });
    expect(detail.logs.sandbox).toEqual({ available: false, truncated: false, entries: [] });
    expect(detail.logs.job).toEqual({ available: false, truncated: false, entries: [] });
    expect(JSON.stringify(detail)).not.toContain("log backend unavailable");
  });

  it("includes the registration identity and status in the detail", async () => {
    const handle = fakeSandbox({ id: "sandbox_1", name: "paseo-1" });
    const detail = await readVmDetail(
      {
        ...context(fakeRuntime([handle])),
        hosts: { list: async () => fakeHostDirectory([fakeRegistration()]) },
      },
      { name: "paseo-1" },
    );

    expect(detail.registrations.status).toBe("available");
    expect(detail.child).toMatchObject({
      kind: "sandbox",
      registration: { registrationId: "reg_1", status: "online", serverId: "srv_child" },
    });
  });

  it("redacts values from the plugin credential store too", async () => {
    const storedValue = "stored-secret-value-456";
    const handle = fakeSandbox({
      id: "sandbox_1",
      name: "paseo-1",
      logs: [logEntry(`token ${storedValue}`, 0)],
    });
    const detail = await readVmDetail(
      {
        ...context(fakeRuntime([handle])),
        storedCredentials: ["OPENAI_API_KEY"],
        storedSecrets: new Map([["OPENAI_API_KEY", storedValue]]),
      },
      { name: "paseo-1" },
    );

    expect(detail.logs.sandbox.entries[0].text).toBe("token [redacted]");
    expect(JSON.stringify(detail)).not.toContain(storedValue);
  });

  it("selects an exact generation when a name has two rows", async () => {
    const name = "paseo-2f8f4c2e-8e52-4d0e-9db1-1a2b3c4d5e6f";
    const registration = fakeRegistration({
      registrationId: "reg_1",
      label: `${PARENT_ID}/${name}`,
      source: { id: REGISTRATION_PRODUCER_ID, key: "sandbox_1" },
      metadata: { source: "paseo-msb", name },
    });
    const failedPending = {
      requestId: "2f8f4c2e-8e52-4d0e-9db1-1a2b3c4d5e6f",
      name,
      plan: {
        providers: [{ provider: "pi" as const, llms: ["anthropic-api-key" as const] }],
        integrations: [],
      },
      phase: "failed" as const,
      createdAt: 1,
      errorCode: "registration_failed" as const,
      errorDetail: null,
    };
    const ctx: ReadContext = {
      hosts: { list: async () => fakeHostDirectory([registration]) },
      runtime: fakeRuntime([]),
      pending: [failedPending],
      env: {},
      storedCredentials: [],
      storedSecrets: new Map(),
    };

    const byName = await readVmDetail(ctx, { name });
    expect(byName.child?.kind).toBe("pending");

    const byId = await readVmDetail(ctx, { name, id: "sandbox_1" });
    expect(byId.child).toMatchObject({ kind: "registration", id: "sandbox_1" });
  });
});

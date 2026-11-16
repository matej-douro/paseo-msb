import { describe, expect, it } from "vitest";
import {
  ERROR_LABEL,
  MANAGED_LABEL,
  MAX_LOG_ENTRIES,
  PARENT_LABEL,
  PHASE_LABEL,
} from "../../shared/constants";
import type { VmChild, VmListResult } from "../../shared/contracts";
import { safeError } from "../../shared/errors";
import type { CanonicalPlan } from "../../shared/provisioning";
import {
  childErrorText,
  childPhase,
  childPlan,
  createBlockedMessage,
  CPU_FIELD_BOUNDS,
  createFormIssue,
  createNameIssue,
  createRequestInput,
  credentialSourceLabel,
  deleteConfirmationText,
  DISK_FIELD_BOUNDS,
  inventoryNotice,
  isChildSelected,
  isEmptyInventory,
  logBundleSummary,
  logLineCountLabel,
  logTimestamp,
  MEMORY_FIELD_BOUNDS,
  mergeLogBundles,
  phaseText,
  planSummary,
  reconcileFailureMessage,
  reconcileSuccessMessage,
  registrationText,
  registrationsNotice,
  resourceFieldIssue,
  resourceSliderOffset,
  resourceSliderValue,
  retryCreateInput,
  runtimeText,
  selectChildFor,
  selectionFor,
  setupPill,
  snapResourceValue,
  vmPill,
} from "../state";

const PLAN: CanonicalPlan = {
  providers: [{ provider: "pi", llms: ["neuralwatt"] }],
  integrations: [],
};

const PENDING: Extract<VmChild, { kind: "pending" }> = {
  kind: "pending",
  name: "paseo-pending",
  plan: PLAN,
  phase: "creating",
  error: null,
  resources: { cpus: 2, memoryMib: 4096, diskMib: 10240 },
  resourcesSpecified: false,
};

type SandboxChild = Extract<VmChild, { kind: "sandbox" }>;

const SANDBOX: SandboxChild = {
  kind: "sandbox",
  name: "paseo-ready",
  id: "sandbox_1",
  labels: {
    [MANAGED_LABEL]: "v1",
    [PARENT_LABEL]: "srv_parent",
    [PHASE_LABEL]: "ready",
  },
  runtimeStatus: "running",
  plan: PLAN,
  registration: { registrationId: "reg_1", status: "online", serverId: "srv_child" },
  resources: { cpus: 2, memoryMib: 4096, diskMib: 10240 },
  requestedResources: null,
};

const sandbox = (patch: Partial<SandboxChild>): SandboxChild => ({ ...SANDBOX, ...patch });

const REGISTRATION: Extract<VmChild, { kind: "registration" }> = {
  kind: "registration",
  name: "paseo-gone",
  id: "sandbox_gone",
  phase: "registering",
  registration: { registrationId: "reg", status: "offline", serverId: null },
  error: null,
};

describe("plan presentation", () => {
  it("summarizes providers, LLM options, and integrations", () => {
    expect(planSummary(PLAN)).toBe("Pi (NeuralWatt)");
    expect(planSummary(null)).toBe("Legacy Pi-only");
    expect(
      planSummary({
        providers: [{ provider: "claude", llms: ["anthropic-oauth"] }],
        integrations: ["github-cli"],
      }),
    ).toBe("Claude (Claude subscription) · GitHub CLI");
  });

  it("returns the persisted plan for pending and sandbox children", () => {
    expect(childPlan(PENDING)).toEqual(PLAN);
    expect(childPlan(SANDBOX)).toEqual(PLAN);
    expect(childPlan(REGISTRATION)).toBeNull();
  });

  it("rebuilds the original create input for a retry", () => {
    expect(retryCreateInput(PENDING)).toEqual({
      name: PENDING.name,
      plan: PLAN,
    });

    expect(
      retryCreateInput({
        ...PENDING,
        name: "my-vm",
        resources: { cpus: 4, memoryMib: 8192, diskMib: 20480 },
        resourcesSpecified: true,
      }),
    ).toEqual({
      name: "my-vm",
      plan: PLAN,
      resources: { cpus: 4, memoryMib: 8192, diskMib: 20480 },
    });
  });

  it("labels where a credential value comes from", () => {
    expect(credentialSourceLabel("GH_TOKEN", [])).toBe("Environment");
    expect(credentialSourceLabel("GH_TOKEN", ["GH_TOKEN"])).toBe("Stored");
  });
});

describe("create form", () => {
  it("accepts generated names and slugs but rejects unsafe input", () => {
    expect(createNameIssue("")).toBeNull();
    expect(createNameIssue("   ")).toBeNull();
    expect(createNameIssue("paseo-2f8f4c2e-8e52-4d0e-9db1-1a2b3c4d5e6f")).toBeNull();
    expect(createNameIssue("my-vm-2")).toBeNull();
    expect(createNameIssue("a")).toBeNull();
    expect(createNameIssue("a".repeat(63))).toBeNull();

    expect(createNameIssue("My-VM")).not.toBeNull();
    expect(createNameIssue("my/vm")).not.toBeNull();
    expect(createNameIssue("my vm")).not.toBeNull();
    expect(createNameIssue("-my-vm")).not.toBeNull();
    expect(createNameIssue("my-vm-")).not.toBeNull();
    expect(createNameIssue("a".repeat(64))).not.toBeNull();
  });

  it("checks CPU, RAM, and disk against the shared bounds and steps", () => {
    expect(resourceFieldIssue("2", CPU_FIELD_BOUNDS)).toBeNull();
    expect(resourceFieldIssue("1", CPU_FIELD_BOUNDS)).toBeNull();
    expect(resourceFieldIssue("16", CPU_FIELD_BOUNDS)).toBeNull();
    expect(resourceFieldIssue("0", CPU_FIELD_BOUNDS)).not.toBeNull();
    expect(resourceFieldIssue("17", CPU_FIELD_BOUNDS)).not.toBeNull();
    expect(resourceFieldIssue("2.5", CPU_FIELD_BOUNDS)).not.toBeNull();

    expect(resourceFieldIssue("4096", MEMORY_FIELD_BOUNDS)).toBeNull();
    expect(resourceFieldIssue("1024", MEMORY_FIELD_BOUNDS)).toBeNull();
    expect(resourceFieldIssue("32768", MEMORY_FIELD_BOUNDS)).toBeNull();
    expect(resourceFieldIssue("1280", MEMORY_FIELD_BOUNDS)).toBeNull();

    expect(resourceFieldIssue("", MEMORY_FIELD_BOUNDS)).toBe("Enter a value in MiB.");
    expect(resourceFieldIssue("4.5", MEMORY_FIELD_BOUNDS)).not.toBeNull();
    expect(resourceFieldIssue("1023", MEMORY_FIELD_BOUNDS)).not.toBeNull();
    expect(resourceFieldIssue("33024", MEMORY_FIELD_BOUNDS)).not.toBeNull();
    expect(resourceFieldIssue("1100", MEMORY_FIELD_BOUNDS)).not.toBeNull();

    expect(resourceFieldIssue("10240", DISK_FIELD_BOUNDS)).toBeNull();
    expect(resourceFieldIssue("1024", DISK_FIELD_BOUNDS)).toBeNull();
    expect(resourceFieldIssue("262144", DISK_FIELD_BOUNDS)).toBeNull();
    expect(resourceFieldIssue("1500", DISK_FIELD_BOUNDS)).not.toBeNull();
  });

  it("reports the first local problem blocking submit", () => {
    expect(createFormIssue("", { memoryMib: "4096", diskMib: "10240" })).toBeNull();
    expect(createFormIssue("", { cpus: "2", memoryMib: "4096", diskMib: "10240" })).toBeNull();
    expect(
      createFormIssue("", { cpus: "17", memoryMib: "4096", diskMib: "10240" }),
    ).not.toBeNull();
    expect(createFormIssue("MY-VM", { memoryMib: "4096", diskMib: "10240" })).not.toBeNull();
    expect(createFormIssue("", { memoryMib: "1000", diskMib: "10240" })).not.toBeNull();
    expect(createFormIssue("", { memoryMib: "4096", diskMib: "1000" })).not.toBeNull();
  });

  it("sends the generated name for an empty field and the typed name otherwise", () => {
    expect(createRequestInput("paseo-generated", "", PLAN, {
      cpus: 2,
      memoryMib: 4096,
      diskMib: 10240,
    })).toEqual({
      name: "paseo-generated",
      plan: PLAN,
      resources: { cpus: 2, memoryMib: 4096, diskMib: 10240 },
    });

    expect(createRequestInput("paseo-generated", "  my-vm ", PLAN, {
      cpus: 4,
      memoryMib: 8192,
      diskMib: 20480,
    })).toEqual({
      name: "my-vm",
      plan: PLAN,
      resources: { cpus: 4, memoryMib: 8192, diskMib: 20480 },
    });
  });

  it("snaps slider values onto the shared grid", () => {
    expect(snapResourceValue(4000, MEMORY_FIELD_BOUNDS)).toBe(4096);
    expect(snapResourceValue(1023, MEMORY_FIELD_BOUNDS)).toBe(1024);
    expect(snapResourceValue(99_999, MEMORY_FIELD_BOUNDS)).toBe(32_768);
    expect(snapResourceValue(4000, DISK_FIELD_BOUNDS)).toBe(4096);
    expect(snapResourceValue(1600, DISK_FIELD_BOUNDS)).toBe(2048);
  });

  it("round-trips a slider offset and value", () => {
    expect(resourceSliderOffset(4096, MEMORY_FIELD_BOUNDS)).toBeCloseTo(
      (4096 - 1024) / (32768 - 1024),
    );
    expect(resourceSliderValue(0, DISK_FIELD_BOUNDS)).toBe(1024);
    expect(resourceSliderValue(1, DISK_FIELD_BOUNDS)).toBe(262_144);
    expect(resourceSliderValue(-1, MEMORY_FIELD_BOUNDS)).toBe(1024);
    expect(resourceSliderValue(2, MEMORY_FIELD_BOUNDS)).toBe(32_768);

    const value = 8192;
    expect(
      resourceSliderValue(resourceSliderOffset(value, MEMORY_FIELD_BOUNDS), MEMORY_FIELD_BOUNDS),
    ).toBe(value);
  });
});

describe("selection", () => {
  const pending = { ...PENDING, name: "shared" };
  const settled = { ...SANDBOX, name: "shared" };
  const staleRegistration = { ...REGISTRATION, name: "shared", id: "sandbox_old" };
  const children = [pending, settled, staleRegistration];

  it("selects a pending attempt by name and another row by generation", () => {
    expect(selectionFor(PENDING)).toEqual({ name: PENDING.name, pending: true });
    expect(selectionFor(SANDBOX)).toEqual({ name: SANDBOX.name, id: SANDBOX.id });

    expect(selectChildFor(children, { name: "shared", pending: true })).toBe(pending);
    expect(selectChildFor([settled], { name: "shared", pending: true })).toBe(settled);
    expect(selectChildFor(children, { name: "shared" })).toBe(pending);
    expect(selectChildFor(children, { name: "shared", id: settled.id })).toBe(settled);
    expect(selectChildFor(children, { name: "shared", id: staleRegistration.id })).toBe(
      staleRegistration,
    );
    expect(selectChildFor(children, { name: "missing" })).toBeNull();
  });

  it("follows a settled attempt to its same-name sandbox", () => {
    expect(selectChildFor([settled], { name: "shared" })).toBe(settled);
    expect(isChildSelected(pending, "shared", null, true)).toBe(true);
    expect(isChildSelected(settled, "shared", null, true)).toBe(false);
    expect(isChildSelected(settled, "shared", settled.id)).toBe(true);
    expect(isChildSelected(staleRegistration, "shared", settled.id)).toBe(false);
    expect(isChildSelected(pending, "shared", settled.id)).toBe(false);
    expect(isChildSelected(pending, "shared", null)).toBe(false);
  });
});

describe("child presentation", () => {
  it("labels phases, runtime, and registration", () => {
    expect(phaseText("installing")).toBe("Provisioning");
    expect(phaseText("deleting")).toBe("Deleting");
    expect(phaseText("ready")).toBe("Ready");
    expect(runtimeText("running")).toBe("Running");
    expect(
      registrationText(
        SANDBOX.kind === "sandbox" ? SANDBOX.registration : null,
        { status: "available" },
      ),
    ).toBe("Online");
    expect(registrationText(null, { status: "available" })).toBe("Not registered");
    expect(
      registrationText(null, {
        status: "unavailable",
        error: safeError("registrations_unavailable"),
      }),
    ).toBe("Unknown");
  });

  it("separates setup health from VM status", () => {
    expect(childPhase(PENDING)).toBe("creating");
    expect(setupPill(PENDING)).toEqual({ label: "Creating", tone: "accent" });
    expect(setupPill(SANDBOX)).toEqual({ label: "Ready", tone: "success" });
    expect(
      setupPill(sandbox({ labels: { ...SANDBOX.labels, [PHASE_LABEL]: "installing" } })),
    ).toEqual({ label: "Provisioning", tone: "accent" });
    expect(
      setupPill(
        sandbox({
          labels: {
            ...SANDBOX.labels,
            [PHASE_LABEL]: "installing",
            [ERROR_LABEL]: "install_pending",
          },
        }),
      ),
    ).toEqual({ label: "Install pending", tone: "warning" });
    expect(
      setupPill(
        sandbox({
          labels: {
            ...SANDBOX.labels,
            [PHASE_LABEL]: "installing",
            [ERROR_LABEL]: "install_failed",
          },
        }),
      ),
    ).toEqual({ label: "Install failed", tone: "danger" });
    expect(setupPill({ ...PENDING, phase: "failed", error: safeError("create_failed") })).toEqual({
      label: "Create failed",
      tone: "danger",
    });
    expect(setupPill(REGISTRATION)).toEqual({ label: "Incomplete", tone: "warning" });
  });

  it("folds runtime and reachability into the VM pill", () => {
    const available = { status: "available" } as const;

    expect(vmPill(PENDING, available)).toEqual({ label: "No VM yet", tone: "muted" });
    expect(vmPill(REGISTRATION, available)).toEqual({ label: "Missing", tone: "danger" });
    expect(vmPill(SANDBOX, available)).toEqual({ label: "Online", tone: "success" });
    expect(vmPill(sandbox({ registration: null }), available)).toEqual({
      label: "Not registered",
      tone: "warning",
    });
    expect(
      vmPill(
        sandbox({ registration: { registrationId: "reg", status: "offline", serverId: null } }),
        available,
      ),
    ).toEqual({ label: "Offline", tone: "warning" });
    expect(vmPill(sandbox({ runtimeStatus: "crashed" }), available)).toEqual({
      label: "Crashed",
      tone: "danger",
    });
    expect(vmPill(sandbox({ runtimeStatus: "stopped" }), available)).toEqual({
      label: "Stopped",
      tone: "muted",
    });
    expect(
      vmPill(SANDBOX, { status: "unavailable", error: safeError("registrations_unavailable") }),
    ).toEqual({ label: "Running", tone: "success" });
  });

  it("uses only safe error text plus bounded detail", () => {
    expect(childErrorText(PENDING)).toBeNull();
    expect(
      childErrorText({ ...PENDING, phase: "failed", error: safeError("create_failed") }),
    ).toBe(safeError("create_failed").message);
    expect(
      childErrorText({
        ...PENDING,
        phase: "failed",
        error: safeError("create_failed"),
        errorDetail: "image pull failed",
      }),
    ).toBe(`${safeError("create_failed").message} image pull failed`);
    expect(
      childErrorText({
        ...SANDBOX,
        labels: { ...SANDBOX.labels, [PHASE_LABEL]: "failed", [ERROR_LABEL]: "install_failed" },
        errorDetail: "npm exited 1",
      }),
    ).toBe(`${safeError("install_failed").message} npm exited 1`);
    expect(childErrorText(REGISTRATION)).toBeNull();
    expect(
      childErrorText({ ...REGISTRATION, error: safeError("registration_failed") }),
    ).toBe(safeError("registration_failed").message);
  });

  it("keeps a selected row through pending to sandbox", () => {
    expect(isChildSelected(PENDING, PENDING.name, null, true)).toBe(true);
    expect(isChildSelected(SANDBOX, PENDING.name, SANDBOX.id, true)).toBe(false);
    expect(isChildSelected(SANDBOX, SANDBOX.name, SANDBOX.id)).toBe(true);
    expect(isChildSelected(SANDBOX, SANDBOX.name, "sandbox_other")).toBe(false);
    expect(isChildSelected(PENDING, PENDING.name, SANDBOX.id)).toBe(false);
    expect(isChildSelected(SANDBOX, SANDBOX.name, null)).toBe(false);
    expect(isChildSelected(REGISTRATION, REGISTRATION.name, null)).toBe(false);
    expect(isChildSelected(REGISTRATION, REGISTRATION.name, REGISTRATION.id)).toBe(true);
    expect(isChildSelected(SANDBOX, "paseo-pending", null)).toBe(false);
    expect(isChildSelected(SANDBOX, null, null)).toBe(false);
  });
});

describe("list states", () => {
  it("blocks create without a fresh list", () => {
    const data: VmListResult = {
      inventory: { status: "available" },
      registrations: { status: "available" },
      credentials: [],
      storedCredentials: [],
      children: [],
    };

    expect(createBlockedMessage(null, null)).toContain("still loading");
    expect(createBlockedMessage(null, "The request failed.")).toBe("The request failed.");
    expect(createBlockedMessage(data, "The request failed.")).toBe("The request failed.");
    expect(createBlockedMessage(data, null)).toBeNull();
  });

  it("explains partial availability and includes detail", () => {
    expect(inventoryNotice({ status: "available" })).toBeNull();
    expect(
      inventoryNotice({
        status: "unavailable",
        error: safeError("inventory_unavailable", "native binding failed"),
      }),
    ).toContain("native binding failed");
    expect(registrationsNotice({ status: "available" })).toBeNull();
    expect(
      registrationsNotice({
        status: "unavailable",
        error: safeError("registrations_unavailable"),
      }),
    ).toContain("registrations are unavailable");
  });

  it("recognizes an empty list", () => {
    expect(
      isEmptyInventory({
        inventory: { status: "available" },
        registrations: { status: "available" },
        credentials: [],
        storedCredentials: [],
        children: [],
      }),
    ).toBe(true);
    expect(
      isEmptyInventory({
        inventory: { status: "available" },
        registrations: { status: "available" },
        credentials: ["GH_TOKEN"],
        storedCredentials: [],
        children: [PENDING],
      }),
    ).toBe(false);
    expect(
      isEmptyInventory({
        inventory: {
          status: "unavailable",
          error: safeError("inventory_unavailable"),
        },
        registrations: { status: "available" },
        credentials: [],
        storedCredentials: [],
        children: [],
      }),
    ).toBe(false);
  });
});

describe("repair and delete text", () => {
  it("summarizes repair results", () => {
    expect(
      reconcileFailureMessage({ repaired: [], errors: [] }),
    ).toBeNull();
    expect(
      reconcileFailureMessage({
        repaired: [],
        errors: [{ name: "paseo-a", error: safeError("registration_conflict") }],
      }),
    ).toBe(`paseo-a: ${safeError("registration_conflict").message}`);
    expect(
      reconcileFailureMessage({
        repaired: [],
        errors: [{ name: "paseo-a", error: safeError("install_failed", "npm exited 1") }],
      }),
    ).toBe(`paseo-a: ${safeError("install_failed").message} npm exited 1`);
    expect(
      reconcileFailureMessage({
        repaired: [],
        errors: [
          { name: "paseo-a", error: safeError("registration_conflict") },
          { name: "paseo-b", error: safeError("install_failed") },
        ],
      }),
    ).toContain("(1 more)");
    expect(reconcileSuccessMessage({ repaired: ["paseo-a"], errors: [] })).toBe(
      "Repair completed.",
    );
  });

  it("names the child and both removed resources", () => {
    const text = deleteConfirmationText("paseo-abc");
    expect(text).toContain("paseo-abc");
    expect(text).toContain("sandbox");
    expect(text).toContain("registration");
  });
});

describe("log summaries", () => {
  it("merges logs chronologically and removes exact duplicates", () => {
    const first = { timestamp: "2026-01-01T00:00:00.000Z", stream: "stdout", text: "first" } as const;
    const shared = { timestamp: "2026-01-01T00:00:01.000Z", stream: "stderr", text: "shared" } as const;
    const last = { timestamp: "2026-01-01T00:00:02.000Z", stream: "stdout", text: "last" } as const;

    const merged = mergeLogBundles(
      { available: true, truncated: false, entries: [shared, first] },
      { available: true, truncated: true, entries: [last, shared] },
    );

    expect(merged).toEqual({ available: true, truncated: true, entries: [first, shared, last] });
  });

  it("keeps available output when another log source is unavailable", () => {
    const line = { timestamp: "2026-01-01T00:00:00.000Z", stream: "stdout", text: "line" } as const;
    const unavailable = { available: false, truncated: false, entries: [] };

    expect(mergeLogBundles(unavailable, unavailable).available).toBe(false);
    expect(mergeLogBundles(unavailable, { available: true, truncated: false, entries: [line] })).toEqual({
      available: true,
      truncated: false,
      entries: [line],
    });
  });

  it("keeps only the newest bounded entries after merging", () => {
    const entries = Array.from({ length: MAX_LOG_ENTRIES + 5 }, (_, index) => ({
      timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
      stream: "stdout" as const,
      text: `line ${index}`,
    }));

    const merged = mergeLogBundles({ available: true, truncated: false, entries });

    expect(merged.truncated).toBe(true);
    expect(merged.entries).toHaveLength(MAX_LOG_ENTRIES);
    expect(merged.entries[0]?.text).toBe("line 5");
    expect(merged.entries.at(-1)?.text).toBe(`line ${MAX_LOG_ENTRIES + 4}`);
  });

  it("describes unavailable, empty, full, and truncated bundles", () => {
    expect(logBundleSummary({ available: false, truncated: false, entries: [] })).toContain(
      "unavailable",
    );
    expect(logBundleSummary({ available: true, truncated: false, entries: [] })).toBe(
      "No log output yet.",
    );
    expect(
      logBundleSummary({
        available: true,
        truncated: true,
        entries: [{ timestamp: "2026-01-01T00:00:00.000Z", stream: "stdout", text: "x" }],
      }),
    ).toBe("Showing the newest 1 entries.");
  });

  it("labels a collapsible header with the line count", () => {
    const line = { timestamp: "2026-01-01T00:00:00.000Z", stream: "stdout", text: "x" } as const;

    expect(logLineCountLabel({ available: false, truncated: false, entries: [] })).toBe(
      "Unavailable",
    );
    expect(logLineCountLabel({ available: true, truncated: false, entries: [] })).toBe("0 lines");
    expect(logLineCountLabel({ available: true, truncated: false, entries: [line] })).toBe(
      "1 line",
    );
    expect(logLineCountLabel({ available: true, truncated: true, entries: [line, line] })).toBe(
      "2 lines · truncated",
    );
  });

  it("keeps the clock time column and tolerates odd timestamps", () => {
    expect(logTimestamp("2026-01-01T12:34:56.789Z")).toBe("12:34:56");
    expect(logTimestamp("no-time")).toBe("no-time");
  });
});

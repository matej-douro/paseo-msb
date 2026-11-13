import { describe, expect, it } from "vitest";
import { ERROR_LABEL, MANAGED_LABEL, PARENT_LABEL, PHASE_LABEL } from "../../shared/constants";
import type { VmChild } from "../../shared/contracts";
import { safeError } from "../../shared/errors";
import {
  canCreate,
  childErrorText,
  childPhase,
  credentialSourceLabel,
  deleteConfirmationText,
  findChild,
  inventoryNotice,
  isEmptyInventory,
  logBundleSummary,
  logLineCountLabel,
  logTimestamp,
  phaseText,
  reconcileFailureMessage,
  reconcileSuccessMessage,
  registrationText,
  registrationTone,
  registrationsNotice,
  runtimeText,
  secretSource,
  setupPill,
  toggleCredential,
  vmPill,
} from "../state";

const PENDING: VmChild = {
  kind: "pending",
  name: "paseo-pending",
  requestId: "2f8f4c2e-8e52-4d0e-9db1-1a2b3c4d5e6f",
  credentialNames: ["ANTHROPIC_API_KEY"],
  phase: "creating",
  error: null,
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
  registration: { registrationId: "reg_1", status: "online", serverId: "srv_child" },
};

const sandbox = (patch: Partial<SandboxChild>): SandboxChild => ({ ...SANDBOX, ...patch });

const REGISTRATION: VmChild = {
  kind: "registration",
  name: "paseo-gone",
  id: "sandbox_gone",
  phase: "registering",
  registration: { registrationId: "reg", status: "offline", serverId: null },
  error: null,
};

describe("create selection", () => {
  it("toggles credential names without duplicates", () => {
    const once = toggleCredential([], "ANTHROPIC_API_KEY");
    expect(once).toEqual(["ANTHROPIC_API_KEY"]);
    expect(toggleCredential(once, "GH_TOKEN")).toEqual(["ANTHROPIC_API_KEY", "GH_TOKEN"]);
    expect(toggleCredential(once, "ANTHROPIC_API_KEY")).toEqual([]);
  });

  it("requires at least one credential", () => {
    expect(canCreate([])).toBe(false);
    expect(canCreate(["GH_TOKEN"])).toBe(true);
  });

  it("labels where a credential value comes from", () => {
    expect(credentialSourceLabel("GH_TOKEN", [])).toBe("Environment");
    expect(credentialSourceLabel("GH_TOKEN", ["GH_TOKEN"])).toBe("Stored");
    expect(secretSource({ name: "GH_TOKEN", stored: true, environment: true })).toEqual({
      label: "Stored",
      tone: "accent",
    });
    expect(secretSource({ name: "GH_TOKEN", stored: false, environment: true })).toEqual({
      label: "Environment",
      tone: "muted",
    });
    expect(secretSource({ name: "GH_TOKEN", stored: false, environment: false })).toEqual({
      label: "Not set",
      tone: "warning",
    });
  });
});

describe("child presentation", () => {
  it("labels phases, runtime, and registration", () => {
    expect(phaseText("installing")).toBe("Installing Pi");
    expect(phaseText("deleting")).toBe("Deleting");
    expect(phaseText("ready")).toBe("Ready");
    expect(runtimeText("running")).toBe("Running");
    expect(
      registrationText(
        SANDBOX.kind === "sandbox" ? SANDBOX.registration : null,
        { status: "available" },
      ),
    ).toBe("Registration online");
    expect(registrationText(null, { status: "available" })).toBe("Not registered");
    expect(
      registrationText(null, {
        status: "unavailable",
        error: safeError("registrations_unavailable"),
      }),
    ).toBe("Registration unknown");
  });

  it("separates setup health from VM status", () => {
    expect(childPhase(PENDING)).toBe("creating");
    expect(setupPill(PENDING)).toEqual({ label: "Creating", tone: "accent" });
    expect(setupPill(SANDBOX)).toEqual({ label: "Ready", tone: "success" });
    expect(
      setupPill(sandbox({ labels: { ...SANDBOX.labels, [PHASE_LABEL]: "installing" } })),
    ).toEqual({ label: "Installing Pi", tone: "accent" });
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
    expect(registrationTone({ registrationId: "reg", status: "error", serverId: null })).toBe(
      "danger",
    );
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
  });

  it("finds a child by name", () => {
    expect(findChild([PENDING, SANDBOX], "paseo-ready")).toBe(SANDBOX);
    expect(findChild([PENDING], "paseo-missing")).toBeNull();
    expect(findChild([PENDING], null)).toBeNull();
  });
});

describe("list states", () => {
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

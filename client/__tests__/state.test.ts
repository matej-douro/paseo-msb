import { describe, expect, it } from "vitest";
import {
  ERROR_LABEL,
  MANAGED_LABEL,
  PARENT_LABEL,
  PHASE_LABEL,
  SANDBOX_ID_LABEL,
} from "../../shared/constants";
import type { VmChild } from "../../shared/contracts";
import { safeError } from "../../shared/errors";
import {
  canCreate,
  childErrorText,
  childPhase,
  childTone,
  credentialSourceLabel,
  deleteConfirmationText,
  findChild,
  inventoryNotice,
  isEmptyInventory,
  logBundleSummary,
  phaseText,
  reconcileFailureMessage,
  reconcileSuccessMessage,
  registrationText,
  registrationTone,
  registrationsNotice,
  runtimeText,
  secretSource,
  toggleCredential,
} from "../state";

const PENDING: VmChild = {
  kind: "pending",
  name: "paseo-pending",
  phase: "creating",
  error: null,
};

const SANDBOX: VmChild = {
  kind: "sandbox",
  name: "paseo-ready",
  id: "sandbox_1",
  labels: {
    [MANAGED_LABEL]: "v1",
    [PARENT_LABEL]: "srv_parent",
    [SANDBOX_ID_LABEL]: "sandbox_1",
    [PHASE_LABEL]: "ready",
  },
  runtimeStatus: "running",
  registration: { registrationId: "reg_1", status: "online", serverId: "srv_child" },
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
    expect(phaseText("ready")).toBe("Ready");
    expect(runtimeText("running")).toBe("Running");
    expect(registrationText(SANDBOX.kind === "sandbox" ? SANDBOX.registration : null)).toBe(
      "Registration online",
    );
    expect(registrationText(null)).toBe("Not registered");
  });

  it("maps tones for phases and registrations", () => {
    expect(childPhase(PENDING)).toBe("creating");
    expect(childTone(PENDING)).toBe("accent");
    expect(childTone(SANDBOX)).toBe("success");
    expect(registrationTone({ registrationId: "reg", status: "error", serverId: null })).toBe(
      "danger",
    );
  });

  it("uses only safe error text", () => {
    expect(childErrorText(PENDING)).toBeNull();
    expect(
      childErrorText({ ...PENDING, phase: "failed", error: safeError("create_failed") }),
    ).toBe(safeError("create_failed").message);
    expect(
      childErrorText({
        ...SANDBOX,
        labels: { ...SANDBOX.labels, [PHASE_LABEL]: "failed", [ERROR_LABEL]: "install_failed" },
      }),
    ).toBe(safeError("install_failed").message);
  });

  it("finds a child by name", () => {
    expect(findChild([PENDING, SANDBOX], "paseo-ready")).toBe(SANDBOX);
    expect(findChild([PENDING], "paseo-missing")).toBeNull();
    expect(findChild([PENDING], null)).toBeNull();
  });
});

describe("list states", () => {
  it("explains partial availability", () => {
    expect(inventoryNotice({ status: "available" })).toBeNull();
    expect(
      inventoryNotice({
        status: "unavailable",
        error: safeError("inventory_unavailable"),
      }),
    ).toContain("inventory is unavailable");
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
});

import { describe, expect, it } from "vitest";
import { MANAGED_LABEL, PARENT_LABEL, PHASE_LABEL } from "../../shared/constants";
import type {
  VmChild,
  VmObservedResources,
  VmResources,
  VmResizeResult,
} from "../../shared/contracts";
import type { CanonicalPlan } from "../../shared/provisioning";
import {
  canResize,
  childResourcesText,
  resizeChangeLines,
  resizeDiskBounds,
  resizeFeedback,
  resizeRequestInput,
  resizeRestartIssue,
  resizeTargetFor,
  resizeTargetIssue,
  resourceDetailLines,
  restartConfirmationText,
} from "../state";

const PLAN: CanonicalPlan = {
  providers: [{ provider: "pi", llms: ["neuralwatt"] }],
  integrations: [],
};

const observed = (patch: Partial<VmObservedResources> = {}): VmObservedResources => ({
  cpus: 2,
  memoryMib: 4096,
  diskMib: 10_240,
  ...patch,
});

const requested = (patch: Partial<VmResources> = {}): VmResources => ({
  cpus: 2,
  memoryMib: 4096,
  diskMib: 10_240,
  ...patch,
});

const resizeResult = (result: VmResizeResult["result"]): VmResizeResult => ({
  name: "paseo-a",
  id: "sandbox_1",
  result,
  resources: observed(),
  requestedResources: null,
});

const PENDING: Extract<VmChild, { kind: "pending" }> = {
  kind: "pending",
  name: "paseo-pending",
  plan: PLAN,
  phase: "creating",
  error: null,
  resources: requested({ memoryMib: 8192, diskMib: 20_480 }),
  resourcesSpecified: true,
};

const SANDBOX: Extract<VmChild, { kind: "sandbox" }> = {
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
  registration: null,
  resources: observed(),
  requestedResources: null,
};

const REGISTRATION: Extract<VmChild, { kind: "registration" }> = {
  kind: "registration",
  name: "paseo-gone",
  id: "sandbox_gone",
  phase: "registering",
  registration: { registrationId: "reg", status: "offline", serverId: null },
  error: null,
};

describe("resize targets", () => {
  it("defaults to the current or requested values", () => {
    expect(resizeTargetFor(observed(), null)).toEqual({ memoryMib: 4096, diskMib: 10_240 });
    expect(
      resizeTargetFor(observed(), requested({ memoryMib: 8192, diskMib: 20_480 })),
    ).toEqual({ memoryMib: 8192, diskMib: 20_480 });
  });

  it("disables a field the runtime does not report", () => {
    expect(resizeTargetFor(observed({ memoryMib: null }), null).memoryMib).toBeNull();
    expect(resizeTargetFor(observed({ diskMib: null }), null).diskMib).toBeNull();
  });

  it("never defaults the disk below the observed size", () => {
    expect(resizeTargetFor(observed(), requested({ diskMib: 2048 })).diskMib).toBe(10_240);
  });

  it("anchors disk bounds at the observed size", () => {
    expect(resizeDiskBounds(observed()).min).toBe(10_240);
    expect(resizeDiskBounds(observed({ diskMib: 20_480 })).min).toBe(20_480);
    expect(resizeDiskBounds(observed({ diskMib: null })).min).toBe(1024);
  });

  it("knows when no resource has a baseline", () => {
    expect(canResize(observed())).toBe(true);
    expect(canResize(observed({ memoryMib: 4096, diskMib: null }))).toBe(true);
    expect(canResize(observed({ memoryMib: null, diskMib: null }))).toBe(false);
  });
});

describe("resize validation", () => {
  it("rejects a target with nothing to resize", () => {
    expect(
      resizeTargetIssue({ memoryMib: null, diskMib: null }, observed({ memoryMib: null, diskMib: null })),
    ).toContain("nothing to resize");
  });

  it("rejects RAM without an observed baseline", () => {
    expect(resizeTargetIssue({ memoryMib: 8192, diskMib: null }, observed({ memoryMib: null }))).toContain(
      "Repair",
    );
  });

  it("rejects disk without an observed baseline", () => {
    expect(resizeTargetIssue({ memoryMib: null, diskMib: 20_480 }, observed({ diskMib: null }))).toContain(
      "unreported",
    );
  });

  it("rejects disk shrink", () => {
    expect(resizeTargetIssue({ memoryMib: null, diskMib: 8192 }, observed())).toBe(
      "The root disk can only grow.",
    );
  });

  it("enforces the shared bounds and steps", () => {
    expect(resizeTargetIssue({ memoryMib: 512, diskMib: null }, observed())).toContain(
      "1024-32768",
    );
    expect(resizeTargetIssue({ memoryMib: 4000, diskMib: null }, observed())).toContain(
      "steps of 256",
    );
    expect(resizeTargetIssue({ memoryMib: null, diskMib: 11_000 }, observed())).toContain(
      "steps of 1024",
    );
  });

  it("accepts a valid target, including an unchanged one", () => {
    expect(resizeTargetIssue({ memoryMib: 8192, diskMib: 20_480 }, observed())).toBeNull();
    expect(resizeTargetIssue({ memoryMib: 4096, diskMib: 10_240 }, observed())).toBeNull();
  });
});

describe("resize outcomes", () => {
  it("gives every outcome distinct feedback", () => {
    const outcomes = ["applied", "unchanged", "converging", "restart_required", "resize_failed"] as const;
    const feedback = outcomes.map((outcome) => resizeFeedback(resizeResult(outcome)));

    expect(new Set(feedback.map((entry) => entry.text)).size).toBe(outcomes.length);
    expect(feedback.map((entry) => entry.offersRestart)).toEqual([
      false,
      false,
      false,
      true,
      false,
    ]);
    expect(feedback.map((entry) => entry.tone)).toEqual([
      "success",
      "muted",
      "warning",
      "warning",
      "danger",
    ]);
  });

  it("offers restart only for a running VM", () => {
    expect(resizeRestartIssue("running")).toBeNull();

    for (const status of ["created", "starting", "paused", "stopped", "crashed"] as const) {
      const issue = resizeRestartIssue(status);
      expect(issue).toContain(status);
      expect(issue).toContain("running");
      expect(issue).toContain("never starts it");
    }
  });
});

describe("restart confirmation", () => {
  it("names the child and warns about disconnecting sessions", () => {
    const text = restartConfirmationText("paseo-a");
    expect(text).toContain("paseo-a");
    expect(text).toContain("disconnects active sessions");
  });

  it("shows changed, unchanged, and unknown values", () => {
    const lines = resizeChangeLines(
      observed({ memoryMib: null }),
      { memoryMib: 8192, diskMib: 10_240 },
    );
    expect(lines).toEqual([
      { label: "RAM", value: "Unknown" },
      { label: "Root disk", value: "10240 MiB (unchanged; grow only)" },
    ]);

    expect(
      resizeChangeLines(observed(), { memoryMib: 8192, diskMib: 20_480 }),
    ).toEqual([
      { label: "RAM", value: "4096 MiB → 8192 MiB" },
      { label: "Root disk", value: "10240 MiB → 20480 MiB" },
    ]);
  });

  it("omits disabled fields from the request", () => {
    expect(resizeRequestInput("paseo-a", "sandbox_1", { memoryMib: 8192, diskMib: null }, false)).toEqual({
      name: "paseo-a",
      id: "sandbox_1",
      memoryMib: 8192,
    });
    expect(
      resizeRequestInput("paseo-a", "sandbox_1", { memoryMib: 8192, diskMib: 20_480 }, true),
    ).toEqual({
      name: "paseo-a",
      id: "sandbox_1",
      memoryMib: 8192,
      diskMib: 20_480,
      restart: true,
    });
  });
});

describe("resource presentation", () => {
  it("summarizes pending, observed, and registration-only rows", () => {
    expect(childResourcesText(PENDING)).toBe("2 CPUs · 8192 MiB RAM · 20480 MiB root disk");
    expect(childResourcesText(SANDBOX)).toBe("2 CPUs · 4096 MiB RAM · 10240 MiB root disk");
    expect(childResourcesText({ ...SANDBOX, resources: observed({ memoryMib: null }) })).toBe(
      "2 CPUs · 10240 MiB root disk",
    );
    expect(childResourcesText({ ...SANDBOX, resources: observed({ memoryMib: null, diskMib: null }) })).toBe(
      "2 CPUs",
    );
    expect(childResourcesText(REGISTRATION)).toBeNull();
  });

  it("shows a requested target until it is confirmed", () => {
    expect(resourceDetailLines(observed(), null)).toEqual([
      { label: "CPUs", value: "2" },
      { label: "RAM", value: "4096 MiB" },
      { label: "Root disk", value: "10240 MiB" },
    ]);
    expect(
      resourceDetailLines(observed({ memoryMib: null }), requested({ memoryMib: 8192 })),
    ).toEqual([
      { label: "CPUs", value: "2" },
      { label: "RAM", value: "Unknown" },
      { label: "Root disk", value: "10240 MiB" },
    ]);
    expect(resourceDetailLines(observed(), requested({ memoryMib: 8192 }))[1]).toEqual({
      label: "RAM",
      value: "4096 MiB → 8192 MiB",
    });
  });
});

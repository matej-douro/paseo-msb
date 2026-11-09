import { LABELS } from "../shared/constants";
import type {
  Child,
  InventoryState,
  ManagedPhase,
  Parent,
  PendingChild,
  Registration,
  SafeError,
} from "../shared/contracts";

export type Tone = "success" | "warning" | "danger" | "muted";

const PHASE_LABELS: Record<ManagedPhase, string> = {
  creating: "Creating",
  installing: "Installing Pi",
  registering: "Registering",
  ready: "Ready",
  failed: "Failed",
};

const RUNTIME_LABELS: Record<Child["runtimeStatus"], string> = {
  created: "Created",
  starting: "Starting",
  running: "Running",
  draining: "Draining",
  paused: "Paused",
  stopped: "Stopped",
  crashed: "Crashed",
};

const REGISTRATION_LABELS: Record<Registration["status"], string> = {
  online: "Online",
  offline: "Offline",
  connecting: "Connecting",
  error: "Error",
  disabled: "Disabled",
};

const ERROR_FALLBACKS: Record<string, string> = {
  parent_unavailable: "Parent host registration is unavailable.",
  inventory_unavailable: "Sandbox inventory is unavailable.",
  inventory_partial: "Some sandbox configurations are not readable.",
  sandbox_not_found: "Sandbox not found.",
  sandbox_replaced: "Sandbox identity changed.",
  config_invalid: "Sandbox configuration is not readable.",
  logs_unavailable: "Logs are unavailable.",
  job_unavailable: "Job logs are unavailable.",
  sandbox_failed: "Sandbox setup failed.",
  not_implemented: "This operation is not implemented yet.",
};

export function phaseLabel(phase: ManagedPhase | null | undefined): string {
  return phase ? PHASE_LABELS[phase] : "Phase unknown";
}

export function childPhase(child: Child): ManagedPhase | null {
  return child.labels?.[LABELS.phase] ?? null;
}

export function runtimeLabel(status: Child["runtimeStatus"]): string {
  return RUNTIME_LABELS[status];
}

export function registrationLabel(registration: Registration | null): string {
  return registration
    ? `Registration ${REGISTRATION_LABELS[registration.status]}`
    : "Not registered";
}

export function safeErrorText(error: SafeError | null | undefined): string | null {
  if (!error) return null;
  const message = error.message || ERROR_FALLBACKS[error.code] || "Unknown error.";
  return `${message} (${error.code})`;
}

export function childStatus(child: Child): string {
  const parts = [phaseLabel(childPhase(child)), runtimeLabel(child.runtimeStatus)];
  parts.push(registrationLabel(child.registration));
  return parts.join(" · ");
}

export function pendingStatus(pending: PendingChild): string {
  return phaseLabel(pending.phase);
}

export function childTone(child: Child): Tone {
  if (!child.labels || child.error) return "danger";
  const phase = childPhase(child);
  if (phase === "failed") return "danger";
  if (child.registration?.status === "error") return "danger";
  if (
    phase === "ready" &&
    child.runtimeStatus === "running" &&
    child.registration?.status === "online"
  ) {
    return "success";
  }
  if (phase === "ready") return "warning";
  return "warning";
}

export function pendingTone(pending: PendingChild): Tone {
  return pending.phase === "failed" ? "danger" : "warning";
}

export interface Notice {
  readonly tone: "warning" | "danger";
  readonly text: string;
}

export function inventoryNotices(input: {
  parent: Parent | null;
  inventory: InventoryState;
  registrations: InventoryState;
}): Notice[] {
  const notices: Notice[] = [];
  if (!input.parent) {
    notices.push({
      tone: "danger",
      text: "Parent host identity is unavailable. Managed children may be missing.",
    });
  }

  if (input.inventory.status === "unavailable") {
    const text =
      input.inventory.error?.code === "parent_unavailable" && !input.parent
        ? "Sandbox inventory is unavailable until the parent host is reachable."
        : (safeErrorText(input.inventory.error) ?? "Sandbox inventory is unavailable.");
    notices.push({ tone: "danger", text });
  } else if (input.inventory.status === "partial") {
    notices.push({
      tone: "warning",
      text:
        safeErrorText(input.inventory.error) ??
        "Some sandbox configurations are not readable.",
    });
  }

  if (
    input.registrations.status === "unavailable" &&
    input.registrations.error?.code !== "parent_unavailable"
  ) {
    notices.push({
      tone: "warning",
      text:
        safeErrorText(input.registrations.error) ??
        "Host registrations are unavailable.",
    });
  }

  return notices;
}

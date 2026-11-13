import {
  ERROR_LABEL,
  PHASE_LABEL,
  type CredentialName,
  type Phase,
  type RuntimeStatus,
} from "../shared/constants";
import type {
  Availability,
  LogBundle,
  Registration,
  SecretEntry,
  VmChild,
  VmListResult,
  VmReconcileResult,
} from "../shared/contracts";
import { SAFE_ERROR_MESSAGES, isSafeErrorCode, type SafeErrorCode } from "../shared/errors";

export type Tone = "success" | "warning" | "danger" | "muted" | "accent";

export function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0
    ? error.message
    : "The request failed.";
}

export function toggleCredential(
  selected: readonly CredentialName[],
  name: CredentialName,
): CredentialName[] {
  return selected.includes(name)
    ? selected.filter((candidate) => candidate !== name)
    : [...selected, name];
}

/** The create confirmation requires at least one credential name. */
export function canCreate(selected: readonly CredentialName[]): boolean {
  return selected.length > 0;
}

/** Where a credential value used for create will come from. */
export function credentialSourceLabel(
  name: CredentialName,
  stored: readonly CredentialName[],
): string {
  return stored.includes(name) ? "Stored" : "Environment";
}

/** Management row source, including names that are not configured anywhere. */
export function secretSource(entry: SecretEntry): { label: string; tone: Tone } {
  if (entry.stored) return { label: "Stored", tone: "accent" };
  if (entry.environment) return { label: "Environment", tone: "muted" };
  return { label: "Not set", tone: "warning" };
}

export function phaseText(phase: Phase): string {
  switch (phase) {
    case "creating":
      return "Creating";
    case "installing":
      return "Installing Pi";
    case "registering":
      return "Registering";
    case "ready":
      return "Ready";
    case "deleting":
      return "Deleting";
    case "failed":
      return "Failed";
  }
}

export function runtimeText(status: RuntimeStatus): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

export function registrationText(
  registration: Registration | null,
  availability: Availability,
): string {
  if (registration) return `Registration ${registration.status}`;
  // Unavailable registrations are unknown, not confidently absent.
  return availability.status === "available" ? "Not registered" : "Registration unknown";
}

export function registrationTone(
  registration: Registration | null,
  availability: Availability = { status: "available" },
): Tone {
  if (!registration) return availability.status === "available" ? "muted" : "warning";
  switch (registration.status) {
    case "online":
      return "success";
    case "error":
    case "disabled":
      return "danger";
    case "offline":
    case "connecting":
      return "warning";
    default:
      return "muted";
  }
}

export function childPhase(child: VmChild): Phase {
  if (child.kind === "sandbox") return child.labels[PHASE_LABEL];
  return child.phase;
}

export interface Pill {
  readonly label: string;
  readonly tone: Tone;
}

/**
 * Setup health labels. A phase is only a hint and terminal failures keep the
 * actionable phase plus a code, so a stored error code wins over the phase. The
 * label names the stage whose evidence is missing; Repair (sandbox) or Retry
 * create (pending) is what actually retries it.
 */
const SETUP_ERROR_PILLS: Partial<Record<SafeErrorCode, Pill>> = {
  invalid_config: { label: "Quarantined", tone: "danger" },
  id_mismatch: { label: "Quarantined", tone: "danger" },
  not_found: { label: "Missing", tone: "danger" },
  name_conflict: { label: "Name conflict", tone: "danger" },
  create_failed: { label: "Create failed", tone: "danger" },
  port_unavailable: { label: "No loopback port", tone: "danger" },
  install_failed: { label: "Install failed", tone: "danger" },
  install_pending: { label: "Install pending", tone: "warning" },
  install_conflict: { label: "Install conflict", tone: "warning" },
  job_inventory_unavailable: { label: "Install unconfirmed", tone: "warning" },
  path_unverified: { label: "Pi missing on PATH", tone: "danger" },
  provider_unavailable: { label: "Pi not ready", tone: "warning" },
  registration_failed: { label: "Registration failed", tone: "warning" },
  registration_timeout: { label: "Registration pending", tone: "warning" },
  registration_conflict: { label: "Registration conflict", tone: "danger" },
  runtime_unavailable: { label: "Runtime unavailable", tone: "warning" },
  missing_credentials: { label: "Credentials missing", tone: "warning" },
  delete_failed: { label: "Delete failed", tone: "danger" },
  registrations_unavailable: { label: "Registration unknown", tone: "warning" },
  secrets_unavailable: { label: "Secrets unavailable", tone: "warning" },
  invalid_request: { label: "Invalid request", tone: "danger" },
  not_implemented: { label: "Unsupported", tone: "danger" },
};

/** A stored error code this build does not know about is still a problem. */
const SETUP_UNKNOWN_ERROR: Pill = { label: "Setup issue", tone: "danger" };

/** The stored safe error code for a child, if any. */
function storedErrorCode(child: VmChild): SafeErrorCode | null {
  if (child.kind !== "sandbox") return child.error?.code ?? null;
  const code = child.labels[ERROR_LABEL];
  return code !== undefined && isSafeErrorCode(code) ? code : null;
}

/** Where the plugin's setup pipeline stands, and whether it needs the user. */
export function setupPill(child: VmChild): Pill {
  const code = storedErrorCode(child);
  if (code) return SETUP_ERROR_PILLS[code] ?? SETUP_UNKNOWN_ERROR;

  if (child.kind === "registration") return { label: "Incomplete", tone: "warning" };

  const phase = childPhase(child);
  switch (phase) {
    case "ready":
      return { label: "Ready", tone: "success" };
    case "deleting":
      return { label: "Deleting", tone: "warning" };
    case "failed":
      return { label: "Failed", tone: "danger" };
    default:
      return { label: phaseText(phase), tone: "accent" };
  }
}

/**
 * VM status: the live runtime, folded with reachability while a sandbox is
 * running. A stopped or crashed VM reports itself first, because that is the
 * more informative fact and a deliberate stop should not read as "offline".
 * Unavailable registrations never become an online or offline claim.
 */
export function vmPill(child: VmChild, registrations: Availability): Pill {
  if (child.kind === "pending") return { label: "No VM yet", tone: "muted" };
  if (child.kind === "registration") return { label: "Missing", tone: "danger" };

  switch (child.runtimeStatus) {
    case "crashed":
      return { label: "Crashed", tone: "danger" };
    case "stopped":
      return { label: "Stopped", tone: "muted" };
    case "paused":
      return { label: "Paused", tone: "warning" };
    case "draining":
      return { label: "Draining", tone: "warning" };
    case "created":
    case "starting":
      return { label: "Starting", tone: "accent" };
    case "unknown":
      return { label: "Unknown", tone: "muted" };
    case "running":
      break;
  }

  if (registrations.status !== "available") return { label: "Running", tone: "success" };

  const registration = child.registration;
  if (!registration) return { label: "Not registered", tone: "warning" };

  switch (registration.status) {
    case "online":
      return { label: "Online", tone: "success" };
    case "connecting":
      return { label: "Connecting", tone: "accent" };
    case "offline":
      return { label: "Offline", tone: "warning" };
    case "error":
      return { label: "Unreachable", tone: "danger" };
    case "disabled":
      return { label: "Disabled", tone: "muted" };
    case "unknown":
      return { label: "Reachability unknown", tone: "muted" };
  }
}

/** Safe text plus bounded, redacted detail when the server has one. */
export function childErrorText(child: VmChild): string | null {
  if (child.kind === "pending") {
    if (!child.error) return child.errorDetail ?? null;
    return withDetail(child.error.message, child.error.detail ?? child.errorDetail);
  }

  if (child.kind === "registration") {
    if (!child.error) return child.errorDetail ?? null;
    return withDetail(child.error.message, child.error.detail ?? child.errorDetail);
  }

  const code = child.labels[ERROR_LABEL];
  const message = code ? SAFE_ERROR_MESSAGES[code] : null;
  if (message) return withDetail(message, child.errorDetail);
  return child.errorDetail ?? null;
}

function withDetail(message: string, detail: string | null | undefined): string {
  return detail ? `${message} ${detail}` : message;
}

export function inventoryNotice(availability: Availability): string | null {
  if (availability.status === "available") return null;
  return withDetail(
    "Microsandbox inventory is unavailable. Pending creates are still shown.",
    availability.error.detail,
  );
}

export function registrationsNotice(availability: Availability): string | null {
  if (availability.status === "available") return null;
  return withDetail(
    "Parent registrations are unavailable. Registration state may be stale.",
    availability.error.detail,
  );
}

export function isEmptyInventory(data: VmListResult): boolean {
  // Only a complete, available directory can prove that nothing exists.
  return (
    data.inventory.status === "available" &&
    data.registrations.status === "available" &&
    data.children.length === 0
  );
}

export function reconcileFailureMessage(result: VmReconcileResult): string | null {
  const first = result.errors[0];
  if (!first) return null;

  const reason = first.error.detail
    ? `${first.error.message} ${first.error.detail}`
    : first.error.message;
  const remaining = result.errors.length - 1;
  return remaining > 0
    ? `${first.name}: ${reason} (${remaining} more)`
    : `${first.name}: ${reason}`;
}

export function reconcileSuccessMessage(result: VmReconcileResult): string {
  return result.repaired.length > 0
    ? "Repair completed."
    : "Nothing needed repair.";
}

/** Names the child and states that both the sandbox and registration go away. */
export function deleteConfirmationText(name: string): string {
  return `Delete ${name}? Its sandbox and parent registration are removed. This cannot be undone.`;
}

export function logBundleSummary(bundle: LogBundle): string {
  if (!bundle.available) return "Logs are unavailable for this child.";
  if (bundle.entries.length === 0) return "No log output yet.";
  if (bundle.truncated) return `Showing the newest ${bundle.entries.length} entries.`;
  return `${bundle.entries.length} entries.`;
}

/** Header line count for a collapsible log block, with truncation and availability marked. */
export function logLineCountLabel(bundle: LogBundle): string {
  if (!bundle.available) return "Unavailable";
  const count = bundle.entries.length;
  const lines = count === 1 ? "1 line" : `${count} lines`;
  return bundle.truncated ? `${lines} · truncated` : lines;
}

/** Clock time shown left of a log line; odd timestamps render unchanged. */
export function logTimestamp(timestamp: string): string {
  return timestamp.length >= 19 ? timestamp.slice(11, 19) : timestamp;
}

export function findChild(
  children: readonly VmChild[],
  name: string | null,
): VmChild | null {
  if (!name) return null;
  return children.find((child) => child.name === name) ?? null;
}

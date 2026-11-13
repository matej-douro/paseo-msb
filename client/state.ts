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
import { SAFE_ERROR_MESSAGES } from "../shared/errors";

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
    case "failed":
      return "Failed";
  }
}

export function runtimeText(status: RuntimeStatus): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

export function registrationText(registration: Registration | null): string {
  return registration ? `Registration ${registration.status}` : "Not registered";
}

export function registrationTone(registration: Registration | null): Tone {
  if (!registration) return "muted";
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
  return child.kind === "pending" ? child.phase : child.labels[PHASE_LABEL];
}

export function childTone(child: VmChild): Tone {
  const phase = childPhase(child);
  if (phase === "failed") return "danger";
  if (phase === "ready") return "success";
  return "accent";
}

/** Safe text plus bounded, redacted detail when the server has one. */
export function childErrorText(child: VmChild): string | null {
  if (child.kind === "pending") {
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
  return data.children.length === 0;
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

export function findChild(
  children: readonly VmChild[],
  name: string | null,
): VmChild | null {
  if (!name) return null;
  return children.find((child) => child.name === name) ?? null;
}

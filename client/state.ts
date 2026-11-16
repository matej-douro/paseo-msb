import {
  CPUS_MAX,
  CPUS_MIN,
  CPUS_STEP,
  ERROR_LABEL,
  MAX_LOG_ENTRIES,
  MEMORY_MIB_MAX,
  MEMORY_MIB_MIN,
  MEMORY_MIB_STEP,
  PHASE_LABEL,
  ROOT_DISK_MIB_MAX,
  ROOT_DISK_MIB_MIN,
  ROOT_DISK_MIB_STEP,
  sandboxName,
  type CredentialName,
  type Phase,
  type RuntimeStatus,
} from "../shared/constants";
import {
  VmNameSchema,
  type Availability,
  type LogBundle,
  type Registration,
  type VmChild,
  type VmCreateInput,
  type VmListResult,
  type VmReconcileResult,
} from "../shared/contracts";
import { SAFE_ERROR_MESSAGES, isSafeErrorCode, type SafeErrorCode } from "../shared/errors";
import {
  INTEGRATION_CATALOG,
  PROVIDER_CATALOG,
  type CanonicalPlan,
} from "../shared/provisioning";

export type Tone = "success" | "warning" | "danger" | "muted" | "accent";

export function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0
    ? error.message
    : "The request failed.";
}

/** Where a credential value used for create will come from. */
export function credentialSourceLabel(
  name: CredentialName,
  stored: readonly CredentialName[],
): string {
  return stored.includes(name) ? "Stored" : "Environment";
}

/** The placeholder shown when the user does not pick an explicit name. */
export function createNamePlaceholder(requestId: string): string {
  return sandboxName(requestId);
}

/**
 * Local name validation mirrors the shared `vm.create` schema so a bad name is
 * rejected before submit. An empty field is valid: it keeps the generated name.
 */
export function createNameIssue(raw: string): string | null {
  const name = raw.trim();
  if (name.length === 0) return null;
  if (VmNameSchema.safeParse(name).success) return null;
  return "Use 1-63 lowercase letters, digits, or internal hyphens, starting and ending with a letter or digit.";
}

/** Resource field bounds, shared with the RPC schemas, so the client adds no rules. */
export interface ResourceFieldBounds {
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly unit: string;
}

export const MEMORY_FIELD_BOUNDS: ResourceFieldBounds = {
  min: MEMORY_MIB_MIN,
  max: MEMORY_MIB_MAX,
  step: MEMORY_MIB_STEP,
  unit: "MiB",
};

export const CPU_FIELD_BOUNDS: ResourceFieldBounds = {
  min: CPUS_MIN,
  max: CPUS_MAX,
  step: CPUS_STEP,
  unit: "CPUs",
};

export const DISK_FIELD_BOUNDS: ResourceFieldBounds = {
  min: ROOT_DISK_MIB_MIN,
  max: ROOT_DISK_MIB_MAX,
  step: ROOT_DISK_MIB_STEP,
  unit: "MiB",
};

/**
 * Validates one whole-number field against the shared bounds. A value outside
 * the range or off the step gets a message that names the actual rule.
 */
export function resourceFieldIssue(raw: string, bounds: ResourceFieldBounds): string | null {
  const text = raw.trim();
  if (text.length === 0) return `Enter a value in ${bounds.unit}.`;
  if (!/^\d+$/.test(text)) return `Enter a whole number of ${bounds.unit}.`;

  const value = Number(text);
  if (
    value < bounds.min ||
    value > bounds.max ||
    (value - bounds.min) % bounds.step !== 0
  ) {
    return `Use ${bounds.min}-${bounds.max} ${bounds.unit}, in steps of ${bounds.step}.`;
  }
  return null;
}

/** Raw create form fields, kept as text so partial input never becomes a value. */
export interface CreateResourceInputs {
  readonly cpus?: string;
  readonly memoryMib: string;
  readonly diskMib: string;
}

/** Validated resource values from the create form. */
export interface CreateResourceValues {
  readonly cpus: number;
  readonly memoryMib: number;
  readonly diskMib: number;
}

/**
 * Snaps an arbitrary MiB value onto the shared bounds and step grid. The sliders
 * and any future numeric entry share this, so the client cannot produce a
 * value the RPC schemas reject.
 */
export function snapResourceValue(value: number, bounds: ResourceFieldBounds): number {
  const clamped = Math.min(bounds.max, Math.max(bounds.min, value));
  const steps = Math.round((clamped - bounds.min) / bounds.step);
  return Math.min(bounds.max, bounds.min + steps * bounds.step);
}

/** Slider position as a 0-1 fraction of the snapped value. */
export function resourceSliderOffset(value: number, bounds: ResourceFieldBounds): number {
  return (snapResourceValue(value, bounds) - bounds.min) / (bounds.max - bounds.min);
}

/** Snapped value at a 0-1 slider position. */
export function resourceSliderValue(offset: number, bounds: ResourceFieldBounds): number {
  const clamped = Math.min(1, Math.max(0, offset));
  return snapResourceValue(bounds.min + clamped * (bounds.max - bounds.min), bounds);
}

/** The first local problem blocking create, or null when the form is valid. */
export function createFormIssue(
  name: string,
  resources: CreateResourceInputs,
): string | null {
  return (
    createNameIssue(name) ??
    (resources.cpus === undefined
      ? null
      : resourceFieldIssue(resources.cpus, CPU_FIELD_BOUNDS)) ??
    resourceFieldIssue(resources.memoryMib, MEMORY_FIELD_BOUNDS) ??
    resourceFieldIssue(resources.diskMib, DISK_FIELD_BOUNDS)
  );
}

/**
 * Builds the `vm.create` input from validated form fields. An empty name is
 * omitted so the server keeps the generated `paseo-<requestId>` identity;
 * resources are always sent explicitly from the editable defaults.
 */
export function createRequestInput(
  requestId: string,
  name: string,
  plan: CanonicalPlan,
  resources: CreateResourceValues,
): VmCreateInput {
  const chosen = name.trim();
  return {
    requestId,
    ...(chosen.length > 0 ? { name: chosen } : {}),
    plan,
    resources: {
      cpus: resources.cpus,
      memoryMib: resources.memoryMib,
      diskMib: resources.diskMib,
    },
  };
}

/** A selected row: named, generation-exact by id, or request-exact while pending. */
export interface ChildSelection {
  readonly name: string;
  readonly id?: string;
  readonly requestId?: string;
}

/** Rows that share a name stay distinct by request ID (pending) or id. */
export function selectionFor(child: VmChild): ChildSelection {
  return child.kind === "pending"
    ? { name: child.name, requestId: child.requestId }
    : { name: child.name, id: child.id };
}

/**
 * Resolves a selection against the current list. A pending attempt wins while
 * it exists; after it settles the same name resolves to its sandbox, so the
 * detail pane follows the attempt instead of going blank.
 */
export function selectChildFor(
  children: readonly VmChild[],
  selection: ChildSelection,
): VmChild | null {
  const named = children.filter((child) => child.name === selection.name);
  if (named.length === 0) return null;

  if (selection.requestId) {
    const pending = named.find(
      (child) => child.kind === "pending" && child.requestId === selection.requestId,
    );
    if (pending) return pending;
  }

  if (selection.id) {
    return named.find((child) => child.kind !== "pending" && child.id === selection.id) ?? null;
  }

  return named.find((child) => child.kind !== "pending") ?? named[0] ?? null;
}

export function phaseText(phase: Phase): string {
  switch (phase) {
    case "creating":
      return "Creating";
    case "installing":
      return "Provisioning";
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
  if (registration) {
    return registration.status.charAt(0).toUpperCase() + registration.status.slice(1);
  }
  // Unavailable registrations are unknown, not confidently absent.
  return availability.status === "available" ? "Not registered" : "Unknown";
}

export function childPhase(child: VmChild): Phase {
  if (child.kind === "sandbox") return child.labels[PHASE_LABEL];
  return child.phase;
}

/** The persisted plan for a pending or sandbox child; null for registration rows. */
export function childPlan(child: VmChild): CanonicalPlan | null {
  if (child.kind === "registration") return null;
  return child.plan;
}

/**
 * Rebuilds the original Create input for a failed pending attempt. The name,
 * plan, and request ID are always preserved; resources are re-sent only when
 * the original request supplied them, so an omitted selection retries as the
 * default shape instead of becoming an explicit one.
 */
export function retryCreateInput(child: Extract<VmChild, { kind: "pending" }>): VmCreateInput {
  return {
    requestId: child.requestId,
    name: child.name,
    plan: child.plan,
    ...(child.resourcesSpecified
      ? {
          resources: {
            cpus: child.resources.cpus,
            memoryMib: child.resources.memoryMib,
            diskMib: child.resources.diskMib,
          },
        }
      : {}),
  };
}

/** Human-readable provider, LLM, and integration labels. */
export function planSummary(plan: CanonicalPlan | null): string {
  if (!plan) return "Legacy Pi-only";

  const parts: string[] = [];
  for (const selection of plan.providers) {
    const entry = PROVIDER_CATALOG.find((candidate) => candidate.id === selection.provider);
    if (!entry) continue;
    const llms = selection.llms.map(
      (llm) => entry.llms.find((candidate) => candidate.id === llm)?.label ?? llm,
    );
    parts.push(llms.length > 0 ? `${entry.label} (${llms.join(", ")})` : entry.label);
  }

  for (const integration of plan.integrations) {
    const entry = INTEGRATION_CATALOG.find((candidate) => candidate.id === integration);
    if (entry) parts.push(entry.label);
  }

  return parts.length > 0 ? parts.join(" · ") : "Nothing selected";
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
  provision_failed: { label: "Provisioning failed", tone: "danger" },
  provision_pending: { label: "Provisioning pending", tone: "warning" },
  provision_conflict: { label: "Provisioning conflict", tone: "warning" },
  job_inventory_unavailable: { label: "Install unconfirmed", tone: "warning" },
  path_unverified: { label: "Pi missing on PATH", tone: "danger" },
  provider_unavailable: { label: "Provider not ready", tone: "warning" },
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
  if (child.kind === "pending" || child.kind === "registration") {
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

/**
 * Create reads credential availability only from a loaded list. A stale list
 * whose refresh failed is not a trustworthy source, so Create is blocked
 * instead of claiming credentials are missing.
 */
export function createBlockedMessage(
  data: VmListResult | null,
  error: string | null,
): string | null {
  if (error) return error;
  if (!data) return "Credentials are still loading. Try again in a moment.";
  return null;
}

/**
 * A row is selected by exact generation when the id is known. A name-only
 * selection follows a pending attempt into its sandbox, so the transition does
 * not drop the selection or require re-selecting the row.
 */
export function isChildSelected(
  child: VmChild,
  selectedName: string | null,
  selectedId: string | null,
  selectedRequestId: string | null = null,
): boolean {
  if (selectedName === null || child.name !== selectedName) return false;
  if (selectedId !== null) return child.kind !== "pending" && child.id === selectedId;
  if (selectedRequestId !== null) {
    if (child.kind === "pending") return child.requestId === selectedRequestId;
    // The selected attempt settled into this row, so follow it by name.
    return true;
  }
  // Pending rows have no id; prefer an attempt over a leftover registration
  // when several rows share the selected name.
  return child.kind !== "registration";
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

export function mergeLogBundles(...bundles: readonly LogBundle[]): LogBundle {
  const available = bundles.filter((bundle) => bundle.available);
  if (available.length === 0) {
    return { available: false, truncated: false, entries: [] };
  }

  const seen = new Set<string>();
  const entries = available
    .flatMap((bundle) => bundle.entries)
    .map((entry, index) => ({ entry, index }))
    .sort(
      (left, right) =>
        left.entry.timestamp.localeCompare(right.entry.timestamp) || left.index - right.index,
    )
    .filter(({ entry }) => {
      const key = `${entry.timestamp}\0${entry.stream}\0${entry.text}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map(({ entry }) => entry);

  return {
    available: true,
    truncated:
      available.some((bundle) => bundle.truncated) || entries.length > MAX_LOG_ENTRIES,
    entries: entries.slice(-MAX_LOG_ENTRIES),
  };
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

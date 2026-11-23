import { z } from "zod";
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
  type VmDetailResult,
  type VmListResult,
  type VmObservedResources,
  type VmReconcileResult,
  type VmResizeInput,
  type VmResizeResult,
  type VmResources,
} from "../shared/contracts";
import type { ChildSelection } from "../shared/selection";
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

/**
 * Local name validation mirrors the shared `vm.create` schema so a bad name is
 * rejected before submit. The generated name is sent when the field is blank.
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

/** Digit-only text: a resource field accepts a whole number and nothing else. */
const WHOLE_NUMBER = z.string().regex(/^\d+$/, "not a whole number");

/** The shared bounds and step rule for one resource field. */
function resourceValueSchema(bounds: ResourceFieldBounds) {
  return z
    .number()
    .int()
    .min(bounds.min)
    .max(bounds.max)
    .refine((value) => (value - bounds.min) % bounds.step === 0);
}

/**
 * Validates one whole-number field against the shared bounds. A value outside
 * the range or off the step gets a message that names the actual rule.
 */
export function resourceFieldIssue(raw: string, bounds: ResourceFieldBounds): string | null {
  const text = raw.trim();
  if (text.length === 0) return `Enter a value in ${bounds.unit}.`;

  const whole = WHOLE_NUMBER.safeParse(text);
  if (!whole.success) return `Enter a whole number of ${bounds.unit}.`;

  const value = resourceValueSchema(bounds).safeParse(Number(whole.data));
  if (value.success) return null;
  return `Use ${bounds.min}-${bounds.max} ${bounds.unit}, in steps of ${bounds.step}.`;
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

/** A labelled resource value for detail and confirmation rows. */
export interface ResourceLine {
  readonly label: string;
  readonly value: string;
}

export function cpuText(cpus: number): string {
  return cpus === 1 ? "1 CPU" : `${cpus} CPUs`;
}

function desiredResourceParts(resources: VmResources): string[] {
  return [
    cpuText(resources.cpus),
    `${resources.memoryMib} MiB RAM`,
    `${resources.diskMib} MiB root disk`,
  ];
}

function observedResourceParts(resources: VmObservedResources): string[] {
  const parts = [cpuText(resources.cpus)];
  if (resources.memoryMib !== null) parts.push(`${resources.memoryMib} MiB RAM`);
  if (resources.diskMib !== null) parts.push(`${resources.diskMib} MiB root disk`);
  return parts;
}

/**
 * One-line resource summary for a list row. Pending attempts show their desired
 * shape, sandboxes show only reported fields, and registration-only rows none.
 */
export function childResourcesText(child: VmChild): string | null {
  if (child.kind === "registration") return null;
  if (child.kind === "pending") return desiredResourceParts(child.resources).join(" · ");
  return observedResourceParts(child.resources).join(" · ");
}

/**
 * Detail rows for observed resources. A requested target is shown after an
 * arrow until the runtime confirms it.
 */
export function resourceDetailLines(
  observed: VmObservedResources,
  requested: VmResources | null,
): ResourceLine[] {
  return [
    { label: "CPUs", value: String(observed.cpus) },
    { label: "RAM", value: resourceValueLine(observed.memoryMib, requested?.memoryMib ?? null) },
    {
      label: "Root disk",
      value: resourceValueLine(observed.diskMib, requested?.diskMib ?? null),
    },
  ];
}

function resourceValueLine(observed: number | null, requested: number | null): string {
  if (observed === null) return "Unknown";
  if (requested !== null && requested !== observed) return `${observed} MiB → ${requested} MiB`;
  return `${observed} MiB`;
}

/**
 * Builds the `vm.create` input from validated form fields. An empty name falls
 * back to the generated name; resources are always sent explicitly from the
 * editable defaults.
 */
export function createRequestInput(
  generatedName: string,
  name: string,
  plan: CanonicalPlan,
  resources: CreateResourceValues,
): VmCreateInput {
  const chosen = name.trim();
  return {
    name: chosen.length > 0 ? chosen : generatedName,
    plan,
    resources: {
      cpus: resources.cpus,
      memoryMib: resources.memoryMib,
      diskMib: resources.diskMib,
    },
  };
}

/** A selected row: named, or name plus the exact generation id. */
export function selectionFor(child: VmChild): ChildSelection {
  return child.kind === "pending" ? { name: child.name } : { name: child.name, id: child.id };
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
 * plan, and resources shape are always preserved; resources are re-sent only
 * when the original request supplied them, so an omitted selection retries as
 * the default shape instead of becoming an explicit one.
 */
export function retryCreateInput(child: Extract<VmChild, { kind: "pending" }>): VmCreateInput {
  return {
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

/** A resize target; null disables a field the runtime does not report. */
export interface ResizeTarget {
  readonly memoryMib: number | null;
  readonly diskMib: number | null;
}

/** Defaults from current/requested values; unreported fields stay disabled. */
export function resizeTargetFor(
  observed: VmObservedResources,
  requested: VmResources | null,
): ResizeTarget {
  const memory = requested?.memoryMib ?? observed.memoryMib;
  const disk = requested?.diskMib ?? observed.diskMib;
  return {
    memoryMib: observed.memoryMib === null ? null : memory,
    diskMib: observed.diskMib === null || disk === null ? null : Math.max(observed.diskMib, disk),
  };
}

/** Grow-only root-disk bounds anchored at the observed size. */
export function resizeDiskBounds(observed: VmObservedResources): ResourceFieldBounds {
  if (observed.diskMib === null) return DISK_FIELD_BOUNDS;
  return { ...DISK_FIELD_BOUNDS, min: Math.max(DISK_FIELD_BOUNDS.min, observed.diskMib) };
}

/** True when at least one resource has a reported baseline to resize. */
export function canResize(observed: VmObservedResources): boolean {
  return observed.memoryMib !== null || observed.diskMib !== null;
}

/**
 * Validates a resize target against the shared bounds and the observed
 * baseline. Sliders already snap to the bounds; this is the single rule set
 * used by both the dialog and its tests.
 */
export function resizeTargetIssue(
  target: ResizeTarget,
  observed: VmObservedResources,
): string | null {
  if (target.memoryMib === null && target.diskMib === null) {
    return "This VM reports neither RAM nor root disk, so there is nothing to resize. Repair may restore a value.";
  }
  if (target.memoryMib !== null) {
    if (observed.memoryMib === null) {
      return "RAM cannot be changed until Repair reports its effective value.";
    }
    const issue = resourceFieldIssue(String(target.memoryMib), MEMORY_FIELD_BOUNDS);
    if (issue) return issue;
  }
  if (target.diskMib !== null) {
    if (observed.diskMib === null) {
      return "The root disk size is unreported, so it cannot be changed.";
    }
    if (target.diskMib < observed.diskMib) return "The root disk can only grow.";
    const issue = resourceFieldIssue(String(target.diskMib), resizeDiskBounds(observed));
    if (issue) return issue;
  }
  return null;
}

/** Distinct user feedback for each resize outcome. */
export interface ResizeFeedback {
  readonly text: string;
  readonly tone: Tone;
  /** Whether the result is a no-restart refusal the user can restart through. */
  readonly offersRestart: boolean;
}

export function resizeFeedback(result: VmResizeResult): ResizeFeedback {
  switch (result.result) {
    case "applied":
      return { text: "Resources updated.", tone: "success", offersRestart: false };
    case "unchanged":
      return { text: "The VM already has these resources.", tone: "muted", offersRestart: false };
    case "converging":
      return {
        text: "The runtime accepted the change and is converging; the detail updates when it confirms.",
        tone: "warning",
        offersRestart: false,
      };
    case "restart_required":
      return {
        text: "The runtime cannot apply this change live.",
        tone: "warning",
        offersRestart: true,
      };
    case "resize_failed":
      return {
        text: "The resource change was not applied. The previous values remain.",
        tone: "danger",
        offersRestart: false,
      };
  }
}

/** Why a restart-and-apply action is unavailable, or null for a running VM. */
export function resizeRestartIssue(runtimeStatus: RuntimeStatus): string | null {
  if (runtimeStatus === "running") return null;
  return `Restart is only offered for a running VM. This VM is ${runtimeText(runtimeStatus).toLowerCase()}, and resize never starts it.`;
}

/** Change rows for a restart confirmation; unchanged values are named. */
export function resizeChangeLines(
  observed: VmObservedResources,
  target: ResizeTarget,
): ResourceLine[] {
  return [
    { label: "RAM", value: changeLine(observed.memoryMib, target.memoryMib, "unchanged") },
    {
      label: "Root disk",
      value: changeLine(observed.diskMib, target.diskMib, "unchanged; grow only"),
    },
  ];
}

function changeLine(observed: number | null, target: number | null, unchanged: string): string {
  if (observed === null || target === null) return "Unknown";
  return target === observed ? `${observed} MiB (${unchanged})` : `${observed} MiB → ${target} MiB`;
}

/** The disruptive warning shown by the restart confirmation. */
export function restartConfirmationText(name: string): string {
  return `The runtime cannot apply this RAM change live. Restarting ${name} disconnects active sessions.`;
}

/** Builds the resize RPC input, omitting fields with no editable baseline. */
export function resizeRequestInput(
  name: string,
  id: string,
  target: ResizeTarget,
  restart: boolean,
): VmResizeInput {
  return {
    name,
    id,
    ...(target.memoryMib === null ? {} : { memoryMib: target.memoryMib }),
    ...(target.diskMib === null ? {} : { diskMib: target.diskMib }),
    ...(restart ? { restart: true } : {}),
  };
}

/** Human-readable provider, LLM, and integration labels. */
export function planSummary(plan: CanonicalPlan | null): string {
  if (!plan) return "Unknown";

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
  id_mismatch: { label: "Generation mismatch", tone: "danger" },
  not_found: { label: "Missing", tone: "danger" },
  name_conflict: { label: "Name conflict", tone: "danger" },
  create_failed: { label: "Create failed", tone: "danger" },
  port_unavailable: { label: "No loopback port", tone: "danger" },
  provision_failed: { label: "Provisioning failed", tone: "danger" },
  provision_pending: { label: "Provisioning pending", tone: "warning" },
  provision_conflict: { label: "Provisioning conflict", tone: "warning" },
  job_inventory_unavailable: { label: "Install unconfirmed", tone: "warning" },
  provider_unavailable: { label: "Provider not ready", tone: "warning" },
  paseo_tools_failed: { label: "Paseo tools failed", tone: "danger" },
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
  // A registration-only row means the join found no sandbox, not that the VM is
  // gone: inventory may be unavailable. Only exact cleanup proof removes a row.
  if (child.kind === "registration") return { label: "VM state unknown", tone: "muted" };

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

/** Explains why a registration-only row exists and what its actions do. */
export function registrationOnlyDetailText(): string {
  return "This child exists only as a parent registration, so its VM state is unknown. A missing sandbox row is not proof of deletion. Repair revalidates this child against the runtime. Delete re-reads it and removes only an exactly matching registration, plus its sandbox generation only if that generation still exists.";
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
 * Explains an absent detail child. Only a complete read of both sources can
 * suggest deletion; a partial read says the state is unknown.
 */
export function missingChildText(
  data: Pick<VmDetailResult, "inventory" | "registrations">,
): string {
  if (data.inventory.status === "unavailable") {
    return "Inventory is unavailable, so this child's state cannot be confirmed. It is not known to be deleted.";
  }
  if (data.registrations.status === "unavailable") {
    return "Parent registrations are unavailable, so this child's state cannot be confirmed. It is not known to be deleted.";
  }
  return "This child is no longer in the managed inventory. It may have been deleted or reloaded.";
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

/** Names the child and states exactly what the matching Delete call removes. */
export function deleteConfirmationText(
  name: string,
  kind: "sandbox" | "registration",
): string {
  if (kind === "registration") {
    return `Delete ${name}? Only what exactly matches this child is removed: its sandbox generation, if still present, and its matching parent registration. This cannot be undone.`;
  }
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

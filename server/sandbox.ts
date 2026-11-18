import { z } from "zod";
import {
  CPUS,
  CPUS_MAX,
  CPUS_MIN,
  ERROR_DETAIL_LABEL,
  ERROR_LABEL,
  GUEST_IMAGE,
  GUEST_INIT_ARGS,
  GUEST_INIT_COMMAND,
  GUEST_PATH,
  GUEST_PORT,
  MANAGED_LABEL,
  MAX_MEMORY_MIB,
  MEMORY_MIB_MAX,
  MEMORY_MIB_MIN,
  METRICS_SAMPLE_INTERVAL_MS,
  PARENT_LABEL,
  PHASE_LABEL,
  PHASES,
  PLAN_ENV_VAR,
  PLUGIN_VERSION,
  RESOURCES_ENV_VAR,
  RESOURCES_SPECIFIED_ENV_VAR,
  ROOT_DISK_MIB_MAX,
  ROOT_DISK_MIB_MIN,
  RUNTIME_STATUSES,
  type CredentialName,
  type Phase,
  type RuntimeStatus,
} from "../shared/constants";
import {
  defaultResources,
  VmResourcesSchema,
  type ManagedLabels,
  type VmObservedResources,
  type VmResources,
} from "../shared/contracts";
import { isSafeErrorCode, safeError, type SafeErrorCode } from "../shared/errors";
import { parseProvisionPlan, type CanonicalPlan } from "../shared/provisioning";
import { failureDetail, persistedCredentialValues } from "./diagnostics";
import { bounded } from "./lanes";
import type { MutationRegistry } from "./mutations";
import type { ResolvedSecret } from "./secrets";

/**
 * Structural handles keep the decoder testable with fake sandboxes. The real
 * microsandbox adapter below satisfies the same interface. Every mutation goes
 * through `guardedModify`, because the pinned SDK's `modify()` does not reject a
 * same-name replacement (verified by the integration identity contract).
 */
export interface SandboxLogEntryLike {
  readonly timestamp: Date | number;
  readonly source: string;
  text(): string;
}

export interface SandboxJobLogEntryLike {
  readonly timestamp: number;
  readonly source: string;
  readonly data: Uint8Array;
}

export interface SandboxJobInfoLike {
  readonly id: string;
  readonly command: readonly string[];
  readonly state: string;
  readonly exitCode: number | null;
  readonly timedOut?: boolean;
  readonly createdAt?: number;
  readonly failure?: { readonly kind: string; readonly message: string } | null;
}

export interface SandboxJobPageLike {
  readonly items: readonly SandboxJobInfoLike[];
  readonly nextCursor: string | null;
}

export interface SandboxJobListBuilderLike {
  all(value?: boolean): SandboxJobListBuilderLike;
  limit(value: number): SandboxJobListBuilderLike;
  cursor(value: string): SandboxJobListBuilderLike;
}

export interface SandboxJobLike {
  inspect(): Promise<SandboxJobInfoLike>;
  wait(): Promise<{ readonly code: number }>;
  logs(options: { tail?: number }): Promise<readonly SandboxJobLogEntryLike[]>;
}

export interface SandboxConnectResultLike {
  readonly code: number;
  readonly stdout: string;
}

export interface SandboxConnectHandleLike {
  exec(spec: ExecSpec): Promise<SandboxConnectResultLike>;
}

/** The subset of `modify()` options the server uses. MiB values throughout. */
export interface SandboxModifyOptionsLike {
  readonly memory?: number;
  readonly maxMemory?: number;
  readonly rootDiskSize?: number;
  readonly env?: Readonly<Record<string, string>>;
  readonly labels?: Readonly<Record<string, string>>;
  readonly policy?: "no_restart" | "next_start" | "restart";
  readonly dryRun?: boolean;
}

/** The subset of a `modify()` plan the resize outcome depends on. */
export interface SandboxModificationPlanLike {
  readonly applied: boolean;
  readonly conflicts: readonly { readonly field: string; readonly message: string }[];
  readonly changes: readonly {
    readonly field: string;
    readonly disposition: "live" | "next start" | "requires restart" | "unsupported";
  }[];
  readonly resizeStatus: readonly { readonly resource: string; readonly state: string }[];
}

/** The subset of a metrics sample the server projects. */
export interface SandboxMetricsLike {
  readonly cpuPercent: number;
  readonly memoryBytes: number;
  readonly memoryLimitBytes: number;
  readonly memoryAvailableBytes: number | null;
  readonly diskReadBytes: number;
  readonly diskWriteBytes: number;
  readonly netRxBytes: number;
  readonly netTxBytes: number;
  readonly upperUsedBytes: number | null;
  readonly upperFreeBytes: number | null;
  readonly uptimeMs: number;
  readonly timestamp: Date;
}

export interface SandboxHandleLike {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  config(): unknown;
  /** The raw native promise. Callers register it before awaiting settlement. */
  modify(options: SandboxModifyOptionsLike): Promise<unknown>;
  metrics(): Promise<SandboxMetricsLike>;
  refresh(): Promise<SandboxHandleLike>;
  connect(): Promise<SandboxConnectHandleLike>;
  listJobsWith(
    configure: (builder: SandboxJobListBuilderLike) => SandboxJobListBuilderLike,
  ): Promise<SandboxJobPageLike>;
  logs(options: {
    tail?: number;
    sources?: readonly string[];
  }): Promise<readonly SandboxLogEntryLike[]>;
  getJob(id: string): Promise<SandboxJobLike>;
}

export interface SandboxRuntime {
  list(parentId: string): Promise<readonly SandboxHandleLike[]>;
}

/** One guest command the reconciler runs with an explicit user. */
export interface ExecSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly user: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly stdinNull?: boolean;
}

/** A detached guest job, reduced to what the reconciler observes. */
export interface SandboxJobHandleLike {
  readonly id: string;
  wait(): Promise<{ readonly code: number }>;
  inspect(): Promise<SandboxJobInfoLike>;
}

/** The identity returned by a strict create. */
export interface SandboxCreateHandleLike {
  readonly id: string;
  readonly name: string;
}

export interface SandboxCreateRequest {
  readonly name: string;
  readonly parentId: string;
  readonly hostPort: number;
  readonly plan: CanonicalPlan;
  readonly secrets: readonly ResolvedSecret[];
  /** Requested resources; omitted means the default child shape. */
  readonly resources?: VmResources;
  /** Whether the original Create supplied an explicit resource selection. */
  readonly resourcesSpecified?: boolean;
}

/**
 * The fixed sandbox shape and secret policy handed to the SDK adapter. Keeping
 * it pure lets fake-runtime tests verify the pinned image, resources, init,
 * loopback port, PATH, labels, and header-only substitution.
 */
export interface SandboxCreatePlan {
  readonly name: string;
  readonly image: string;
  readonly cpus: number;
  readonly memoryMib: number;
  readonly maxMemoryMib: number;
  readonly rootDiskMib: number;
  readonly metricsSampleIntervalMs: number;
  readonly detached: true;
  readonly init: { readonly command: string; readonly args: readonly string[] };
  readonly hostPort: number;
  readonly guestPort: number;
  readonly env: Readonly<Record<string, string>>;
  readonly labels: Readonly<Record<string, string>>;
  readonly secrets: readonly SandboxSecretPlan[];
}

export interface SandboxSecretPlan {
  readonly envVar: CredentialName;
  readonly value: string;
  readonly allowedHosts: readonly string[];
  readonly substitution: {
    readonly headers: true;
    readonly query: false;
    readonly body: false;
  };
}

export interface SandboxCreator {
  /** Strict lookup by name; null only when no sandbox has that name. */
  find(name: string): Promise<SandboxHandleLike | null>;
  /** Probes a free loopback port; the runtime does not allocate host port 0. */
  probePort(): Promise<number>;
  create(request: SandboxCreateRequest): Promise<SandboxCreateHandleLike>;
}

/**
 * Host-side sandbox operations. `connect` and `destroy` use the exact captured
 * handle; `startInstall` launches the single pinned detached Pi install.
 */
export interface SandboxHost extends SandboxCreator {
  connect(handle: SandboxHandleLike): Promise<SandboxConnectHandleLike>;
  startInstall(
    handle: SandboxHandleLike,
    spec: ExecSpec,
  ): Promise<SandboxJobHandleLike>;
  destroy(handle: SandboxHandleLike): Promise<void>;
}

export function buildSandboxCreatePlan(request: SandboxCreateRequest): SandboxCreatePlan {
  const resources: VmResources = request.resources ?? defaultResources();

  return {
    name: request.name,
    image: GUEST_IMAGE,
    cpus: resources.cpus,
    memoryMib: resources.memoryMib,
    maxMemoryMib: MAX_MEMORY_MIB,
    rootDiskMib: resources.diskMib,
    metricsSampleIntervalMs: METRICS_SAMPLE_INTERVAL_MS,
    detached: true,
    init: { command: GUEST_INIT_COMMAND, args: GUEST_INIT_ARGS },
    hostPort: request.hostPort,
    guestPort: GUEST_PORT,
    env: {
      PATH: GUEST_PATH,
      [PLAN_ENV_VAR]: JSON.stringify(request.plan),
      [RESOURCES_ENV_VAR]: JSON.stringify(resources),
      [RESOURCES_SPECIFIED_ENV_VAR]: request.resourcesSpecified ? "1" : "0",
    },
    labels: {
      [MANAGED_LABEL]: PLUGIN_VERSION,
      [PARENT_LABEL]: request.parentId,
      [PHASE_LABEL]: "creating",
    },
    secrets: request.secrets.map((secret) => ({
      envVar: secret.envVar,
      value: secret.value,
      allowedHosts: secret.allowedHosts,
      substitution: { headers: true, query: false, body: false },
    })),
  };
}

/**
 * The subset of the SDK builder the create plan applies. Setters mutate in
 * place and return `this`; keeping the interface structural lets tests record
 * the exact order the runtime uses.
 */
export interface SandboxBuilderLike {
  image(image: string): this;
  rootDisk(sizeMiB: number): this;
  cpus(count: number): this;
  memory(mib: number): this;
  maxMemory(mib: number): this;
  metricsSampleIntervalMs(ms: number): this;
  detached(enabled: boolean): this;
  init(command: string, args?: string[]): this;
  port(hostPort: number, guestPort: number): this;
  labels(labels: Readonly<Record<string, string>>): this;
  env(key: string, value: string): this;
}

/** Applies the pinned create chain in the order the SDK expects. */
export function applySandboxCreatePlan(
  builder: SandboxBuilderLike,
  plan: SandboxCreatePlan,
): void {
  // The pinned image's entrypoint is tini, not a distro init, so
  // `.init("auto")` fails; the verified fallback is explicit tini.
  builder
    .image(plan.image)
    .rootDisk(plan.rootDiskMib)
    .cpus(plan.cpus)
    .memory(plan.memoryMib)
    .maxMemory(plan.maxMemoryMib)
    .metricsSampleIntervalMs(plan.metricsSampleIntervalMs)
    .detached(plan.detached)
    .init(plan.init.command, [...plan.init.args])
    .port(plan.hostPort, plan.guestPort)
    .labels({ ...plan.labels });

  for (const [key, value] of Object.entries(plan.env)) {
    builder.env(key, value);
  }
}

export interface DecodedSandbox {
  readonly id: string;
  readonly name: string;
  readonly runtimeStatus: RuntimeStatus;
  readonly labels: ManagedLabels;
  /** Persisted plan. */
  readonly plan: CanonicalPlan;
  /** Bounded, redacted diagnostic for a failed or retrying sandbox. */
  readonly errorDetail: string | null;
  /** Observed from the sandbox config; unreported fields are null. */
  readonly resources: VmObservedResources;
  /** Desired resources from the managed environment. */
  readonly requestedResources: VmResources;
  /** Internal resources-specified flag. Never projected into a public DTO. */
  readonly resourcesSpecified: boolean;
}

export interface LoadedSandbox {
  readonly sandbox: DecodedSandbox;
  readonly handle: SandboxHandleLike;
}

export interface SandboxDecodeFailure {
  readonly id: string;
  readonly name: string;
  readonly runtimeStatus: RuntimeStatus;
  readonly code: "invalid_config";
}

export type SandboxInventory =
  | {
      readonly status: "available";
      readonly sandboxes: readonly LoadedSandbox[];
      readonly failures: readonly SandboxDecodeFailure[];
    }
  | {
      readonly status: "unavailable";
      readonly error: ReturnType<typeof safeError>;
    };

export class SandboxDecodeError extends Error {
  constructor(readonly code: "invalid_config") {
    super(code);
    this.name = "SandboxDecodeError";
  }
}

/** A guarded label write failed because the generation changed or is unknown. */
export class SandboxGenerationError extends Error {
  constructor(readonly code: Extract<SafeErrorCode, "id_mismatch" | "runtime_unavailable">) {
    super(code);
    this.name = "SandboxGenerationError";
  }
}

/** The exact generation disappeared between lookup and refresh. */
export class SandboxMissingError extends Error {
  constructor() {
    super("sandbox generation is gone");
    this.name = "SandboxMissingError";
  }
}

/**
 * The runtime config is a wide SDK object. Only labels and the fixed credential
 * names are read here, and no part of it is returned to callers.
 */
const RawConfigSchema = z.looseObject({
  labels: z.record(z.string(), z.string()).optional(),
  env: z.unknown().optional(),
  network: z.unknown().optional(),
});

const PhaseSchema = z.enum(PHASES);
const RuntimeStatusSchema = z.enum(RUNTIME_STATUSES);

/** Bound for one complete sandbox inventory read. */
const SANDBOX_LIST_TIMEOUT_MS = 60_000;

function normalizeRuntimeStatus(value: string): RuntimeStatus {
  const parsed = RuntimeStatusSchema.safeParse(value);
  return parsed.success ? parsed.data : "unknown";
}

type LabelProjection = Omit<
  DecodedSandbox,
  "plan" | "resources" | "requestedResources" | "resourcesSpecified"
>;

function decodeLabels(
  labels: Readonly<Record<string, string>>,
  handle: SandboxHandleLike,
  redaction: readonly string[] = [],
): LabelProjection {
  const phaseParsed = PhaseSchema.safeParse(labels[PHASE_LABEL]);
  const phase: Phase = phaseParsed.success ? phaseParsed.data : "failed";

  const rawError = labels[ERROR_LABEL];
  let error: SafeErrorCode | undefined =
    rawError && isSafeErrorCode(rawError) ? rawError : undefined;

  if (!phaseParsed.success) error = "invalid_config";
  // A persisted `failed` phase is never written by current code. It is projected
  // as an undecodable config instead of a resumable failure.
  if (phase === "failed") error = "invalid_config";

  // Persisted detail goes through the same redaction boundary as live errors
  // before it can appear in a DTO.
  const detail = error ? failureDetail(labels[ERROR_DETAIL_LABEL], redaction) : null;

  const projected: ManagedLabels = {
    [MANAGED_LABEL]: PLUGIN_VERSION,
    [PARENT_LABEL]: labels[PARENT_LABEL] ?? "",
    [PHASE_LABEL]: phase,
    ...(error ? { [ERROR_LABEL]: error } : {}),
  };

  return {
    id: handle.id,
    name: handle.name,
    runtimeStatus: normalizeRuntimeStatus(handle.status),
    labels: projected,
    errorDetail: detail,
  };
}

/**
 * Returns null for a sandbox that is not managed by this plugin and parent.
 */
export function decodeManagedSandbox(
  handle: SandboxHandleLike,
  parentId: string,
  redaction: readonly string[] = [],
): DecodedSandbox | null {
  let rawConfig: unknown;
  try {
    rawConfig = handle.config();
  } catch {
    throw new SandboxDecodeError("invalid_config");
  }

  const parsedConfig = RawConfigSchema.safeParse(rawConfig);
  if (!parsedConfig.success) throw new SandboxDecodeError("invalid_config");

  const labels = parsedConfig.data.labels ?? {};
  if (labels[MANAGED_LABEL] !== PLUGIN_VERSION) return null;
  if (labels[PARENT_LABEL] !== parentId) return null;

  return {
    ...decodeLabels(labels, handle, redaction),
    plan: readPlanFromEnv(parsedConfig.data.env),
    resources: decodeObservedResources(asRecord(parsedConfig.data)),
    ...readResourcesEnv(parsedConfig.data.env),
  };
}

export async function loadManagedSandboxes(
  runtime: SandboxRuntime,
  parentId: string,
  redaction: readonly string[] = [],
): Promise<SandboxInventory> {
  let handles: readonly SandboxHandleLike[];
  try {
    handles = await bounded(runtime.list(parentId), {
      timeoutMs: SANDBOX_LIST_TIMEOUT_MS,
    });
  } catch (error) {
    return {
      status: "unavailable",
      error: safeError("inventory_unavailable", failureDetail(error, redaction)),
    };
  }

  const sandboxes: LoadedSandbox[] = [];
  const failures: SandboxDecodeFailure[] = [];

  // Inventory-wide decoding uses every managed VM's persisted credential values
  // in addition to the current environment/store values, so malformed config
  // cannot echo a creation-time secret.
  const mergedRedaction = mergePersistedRedaction(redaction, handles);

  for (const handle of handles) {
    try {
      const decoded = decodeManagedSandbox(handle, parentId, mergedRedaction);
      if (decoded) sandboxes.push({ sandbox: decoded, handle });
    } catch {
      failures.push({
        id: handle.id,
        name: handle.name,
        runtimeStatus: normalizeRuntimeStatus(handle.status),
        code: "invalid_config",
      });
    }
  }

  return { status: "available", sandboxes, failures };
}


function mergePersistedRedaction(
  base: readonly string[],
  handles: readonly SandboxHandleLike[],
): string[] {
  const values = new Set(base);
  for (const handle of handles) {
    try {
      for (const value of persistedCredentialValues(handle.config())) values.add(value);
    } catch {
      // A config read failure contributes no values and is not fatal here.
    }
  }
  return [...values].sort((left, right) => right.length - left.length);
}

function rawLabels(handle: SandboxHandleLike): Record<string, string> | null {
  try {
    const parsed = RawConfigSchema.safeParse(handle.config());
    return parsed.success ? (parsed.data.labels ?? {}) : null;
  } catch {
    return null;
  }
}

export type SandboxOwnership = "owned" | "foreign" | "unknown";

/**
 * Ownership requires the managed and parent labels; the name owns the current
 * generation. An unreadable config reports `unknown` and is never adopted.
 */
export function ownershipOf(handle: SandboxHandleLike, parentId: string): SandboxOwnership {
  const labels = rawLabels(handle);
  if (labels === null) return "unknown";
  if (labels[MANAGED_LABEL] !== PLUGIN_VERSION) return "foreign";
  if (labels[PARENT_LABEL] !== parentId) return "foreign";
  return "owned";
}


/**
 * Normalizes the SDK's array-shaped env and the CLI's record-shaped env.
 * Values are only used for the non-secret plan variable and credential names.
 */
function readEnvRecord(env: unknown): Readonly<Record<string, string>> {
  if (Array.isArray(env)) {
    const record: Record<string, string> = {};
    for (const entry of env) {
      const item = asRecord(entry);
      const name =
        typeof item?.name === "string"
          ? item.name
          : typeof item?.key === "string"
            ? item.key
            : undefined;
      const value = item?.value;
      if (typeof name === "string" && typeof value === "string") record[name] = value;
    }
    return record;
  }

  const record = asRecord(env);
  if (!record) return {};
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(record)) {
    if (typeof value === "string") result[name] = value;
  }
  return result;
}

function readPlanFromEnv(env: unknown): CanonicalPlan {
  const value = readEnvRecord(env)[PLAN_ENV_VAR];
  if (value === undefined) throw new SandboxDecodeError("invalid_config");

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new SandboxDecodeError("invalid_config");
  }

  const plan = parseProvisionPlan(parsed);
  if (!plan.ok) throw new SandboxDecodeError("invalid_config");
  return plan.plan;
}


/** First defined value under any of the SDK's camelCase or snake_case keys. */
function firstValue(
  record: Readonly<Record<string, unknown>> | null,
  keys: readonly string[],
): unknown {
  if (!record) return undefined;
  for (const key of keys) {
    if (record[key] !== undefined) return record[key];
  }
  return undefined;
}

function readBoundedInteger(value: unknown, min: number, max: number): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
    ? value
    : null;
}

/**
 * Observed resources come from the sandbox config only. An unreported field is
 * null and is never filled from the requested resources or a default.
 */
function decodeObservedResources(
  config: Readonly<Record<string, unknown>> | null,
): VmObservedResources {
  const resources = asRecord(firstValue(config, ["resources"]));
  const rawCpus = firstValue(resources, ["cpus"]);
  const reportedCpus = readBoundedInteger(rawCpus, CPUS_MIN, CPUS_MAX);
  // A present but out-of-range CPU count is malformed, not unreported. An
  // absent value keeps the fixed default shape.
  if (rawCpus !== undefined && reportedCpus === null) {
    throw new SandboxDecodeError("invalid_config");
  }

  const image = asRecord(firstValue(config, ["image"]));
  const oci = asRecord(firstValue(image, ["Oci", "oci"]));
  const rootDisk = asRecord(firstValue(oci, ["rootDisk", "root_disk"]));

  return {
    cpus: reportedCpus ?? CPUS,
    memoryMib: readBoundedInteger(
      firstValue(resources, ["memoryMib", "memory_mib"]),
      MEMORY_MIB_MIN,
      MEMORY_MIB_MAX,
    ),
    diskMib: readBoundedInteger(
      firstValue(rootDisk, ["sizeMib", "size_mib"]),
      ROOT_DISK_MIB_MIN,
      ROOT_DISK_MIB_MAX,
    ),
  };
}

/** Desired resources and the internal resources-specified flag from the environment. */
function readResourcesEnv(env: unknown): {
  readonly requestedResources: VmResources;
  readonly resourcesSpecified: boolean;
} {
  const record = readEnvRecord(env);
  const rawResources = record[RESOURCES_ENV_VAR];
  const rawSpecified = record[RESOURCES_SPECIFIED_ENV_VAR];

  if (rawResources === undefined || rawSpecified === undefined) {
    throw new SandboxDecodeError("invalid_config");
  }
  if (rawSpecified !== "0" && rawSpecified !== "1") {
    throw new SandboxDecodeError("invalid_config");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawResources);
  } catch {
    throw new SandboxDecodeError("invalid_config");
  }
  const resources = VmResourcesSchema.safeParse(parsed);
  if (!resources.success) throw new SandboxDecodeError("invalid_config");

  return {
    requestedResources: resources.data,
    resourcesSpecified: rawSpecified === "1",
  };
}

/**
 * Writes modify options only after re-reading the exact generation. The pinned
 * SDK's `modify()` applies to a same-name replacement, so this guard is
 * mandatory. The residual window remains: an external replacement created
 * between this refresh and the write can still inherit it.
 */
export interface MutationTracking {
  readonly mutations: MutationRegistry;
  readonly name: string;
}

export async function guardedModify(
  handle: SandboxHandleLike,
  options: SandboxModifyOptionsLike,
  tracking?: MutationTracking,
): Promise<unknown> {
  let current: SandboxHandleLike;
  try {
    current = await handle.refresh();
  } catch (error) {
    // Preserve absence as a distinct outcome: Delete treats it as an already
    // satisfied request, while a replaced generation remains a mismatch.
    if (isSandboxNotFoundError(error)) throw new SandboxMissingError();
    if (isIncompleteSandboxError(error)) throw error;
    throw new SandboxGenerationError(
      isSandboxReplacedError(error) ? "id_mismatch" : "runtime_unavailable",
    );
  }

  if (current.id !== handle.id) throw new SandboxGenerationError("id_mismatch");

  const operation = current.modify(options);
  // Register the raw native promise before awaiting it: a wrapper timeout must
  // not hide that the call is still in flight.
  tracking?.mutations.track(tracking.name, operation);

  try {
    return await operation;
  } catch (error) {
    if (isSandboxNotFoundError(error)) throw new SandboxMissingError();
    if (isSandboxReplacedError(error)) throw new SandboxGenerationError("id_mismatch");
    throw error;
  }
}

/** Reads the observed boot-time memory cap, or null when unreported. */
export function readSandboxMaxMemoryMib(handle: SandboxHandleLike): number | null {
  let raw: unknown;
  try {
    raw = handle.config();
  } catch {
    return null;
  }

  const resources = asRecord(firstValue(asRecord(raw), ["resources"]));
  return readBoundedInteger(
    firstValue(resources, ["maxMemoryMib", "max_memory_mib"]),
    MEMORY_MIB_MIN,
    MEMORY_MIB_MAX,
  );
}

export function isSandboxReplacedError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    ((error as { code?: unknown }).code === "sandboxReplaced" ||
      (error as { code?: unknown }).code === "sandbox_replaced")
  );
}

/** An interrupted create cannot be refreshed or labelled, but its handle can be destroyed. */
export function isIncompleteSandboxError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; message?: unknown };
  return (
    candidate.code === "invalidConfig" &&
    typeof candidate.message === "string" &&
    candidate.message.includes("incomplete creation or cleanup")
  );
}

/** The SDK could not find the exact generation that was just looked up. */
export function isSandboxNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    ((error as { code?: unknown }).code === "sandboxNotFound" ||
      (error as { code?: unknown }).code === "sandbox_not_found")
  );
}

/** Advances the progress hint and optionally records a safe error. */
export async function markSandboxPhase(
  handle: SandboxHandleLike,
  phase: Phase,
  options: {
    readonly code?: SafeErrorCode;
    readonly detail?: string | null;
    readonly tracking?: MutationTracking;
  } = {},
): Promise<void> {
  const labels: Record<string, string> = { [PHASE_LABEL]: phase };

  if (options.code) {
    labels[ERROR_LABEL] = options.code;
    labels[ERROR_DETAIL_LABEL] = options.detail ?? "";
  } else if (phase === "ready" || phase === "registering") {
    // Clear an earlier retryable error without writing `failed`.
    labels[ERROR_LABEL] = "";
    labels[ERROR_DETAIL_LABEL] = "";
  }

  await guardedModify(handle, { labels }, options.tracking);
}

/**
 * Persists a retryable or terminal setup error while keeping the actionable
 * phase.
 */
export async function markSandboxError(
  handle: SandboxHandleLike,
  phase: Phase,
  code: SafeErrorCode,
  detail: string | null = null,
  tracking?: MutationTracking,
): Promise<void> {
  await markSandboxPhase(handle, phase, {
    code,
    detail,
    tracking,
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function readPortNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

function isLoopbackBind(bind: string | null): boolean {
  return bind === null || bind === "127.0.0.1" || bind === "localhost" || bind === "::1";
}

/**
 * Reads the published loopback host port for guest 6767 from the persisted
 * config. The SDK uses camelCase; older/CLI shapes use snake_case.
 */
export function readSandboxHostPort(handle: SandboxHandleLike): number | null {
  let raw: unknown;
  try {
    raw = handle.config();
  } catch {
    return null;
  }

  const ports = asRecord(asRecord(raw)?.network)?.ports;
  if (!Array.isArray(ports)) return null;

  for (const entry of ports) {
    const port = asRecord(entry);
    if (!port) continue;

    const guestPort = readPortNumber(port.guestPort, port.guest_port);
    const hostPort = readPortNumber(port.hostPort, port.host_port);
    const protocol = typeof port.protocol === "string" ? port.protocol : "tcp";
    const bind =
      typeof port.hostBind === "string"
        ? port.hostBind
        : typeof port.host_bind === "string"
          ? port.host_bind
          : null;

    if (
      guestPort === GUEST_PORT &&
      hostPort !== null &&
      hostPort > 0 &&
      protocol === "tcp" &&
      isLoopbackBind(bind)
    ) {
      return hostPort;
    }
  }

  return null;
}

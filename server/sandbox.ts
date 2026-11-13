import { z } from "zod";
import {
  CPUS,
  CREDENTIAL_NAMES,
  ERROR_DETAIL_LABEL,
  ERROR_LABEL,
  GUEST_IMAGE,
  GUEST_INIT_ARGS,
  GUEST_INIT_COMMAND,
  GUEST_PATH,
  GUEST_PORT,
  JOB_LABEL,
  MANAGED_LABEL,
  MANAGED_NAME_PREFIX,
  MEMORY_MIB,
  PARENT_LABEL,
  PHASE_LABEL,
  PHASES,
  PLUGIN_VERSION,
  RUNTIME_STATUSES,
  SANDBOX_ID_LABEL,
  type CredentialName,
  type Phase,
  type RuntimeStatus,
} from "../shared/constants";
import type { ManagedLabels } from "../shared/contracts";
import { isSafeErrorCode, safeError, type SafeErrorCode } from "../shared/errors";
import { failureDetail } from "./diagnostics";
import type { ResolvedSecret } from "./secrets";

/**
 * Structural handles keep the decoder testable with fake sandboxes. The real
 * microsandbox adapter below satisfies the same interface. Every mutation goes
 * through `guardedModify`, because the pinned SDK's `modify()` does not reject a
 * same-name replacement (verified by the task 7 spike).
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

export interface SandboxHandleLike {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  config(): unknown;
  modify(options: { readonly labels: Readonly<Record<string, string>> }): Promise<unknown>;
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
  readonly secrets: readonly ResolvedSecret[];
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
  return {
    name: request.name,
    image: GUEST_IMAGE,
    cpus: CPUS,
    memoryMib: MEMORY_MIB,
    detached: true,
    init: { command: GUEST_INIT_COMMAND, args: GUEST_INIT_ARGS },
    hostPort: request.hostPort,
    guestPort: GUEST_PORT,
    env: { PATH: GUEST_PATH },
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

export interface DecodedSandbox {
  readonly id: string;
  readonly name: string;
  readonly runtimeStatus: RuntimeStatus;
  readonly labels: ManagedLabels;
  /** Bounded, redacted diagnostic for a failed or retrying sandbox. */
  readonly errorDetail: string | null;
  /** Legacy stable-ID label, read only for migration. */
  readonly legacyId: string | null;
  /** Legacy job label, read only for migration. */
  readonly legacyJobId: string | null;
}

export interface LoadedSandbox {
  readonly sandbox: DecodedSandbox;
  readonly handle: SandboxHandleLike;
}

export interface SandboxDecodeFailure {
  readonly id: string;
  readonly name: string;
  readonly runtimeStatus: RuntimeStatus;
  readonly code: Extract<SafeErrorCode, "invalid_config" | "id_mismatch">;
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
  constructor(readonly code: "invalid_config" | "id_mismatch") {
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
const CREDENTIAL_SET: ReadonlySet<string> = new Set(CREDENTIAL_NAMES);

function normalizeRuntimeStatus(value: string): RuntimeStatus {
  const parsed = RuntimeStatusSchema.safeParse(value);
  return parsed.success ? parsed.data : "unknown";
}

function decodeLabels(labels: Readonly<Record<string, string>>, handle: SandboxHandleLike): DecodedSandbox {
  const phaseParsed = PhaseSchema.safeParse(labels[PHASE_LABEL]);
  const phase: Phase = phaseParsed.success ? phaseParsed.data : "failed";

  const rawError = labels[ERROR_LABEL];
  let error: SafeErrorCode | undefined =
    rawError && isSafeErrorCode(rawError) ? rawError : undefined;

  if (!phaseParsed.success) error = "invalid_config";
  if (phase === "failed" && !error) error = "invalid_config";

  const detail = error ? failureDetail(labels[ERROR_DETAIL_LABEL]) : null;

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
    legacyId: labels[SANDBOX_ID_LABEL] ?? null,
    legacyJobId: labels[JOB_LABEL] ?? null,
  };
}

/**
 * Returns null for a sandbox that is not managed by this plugin and parent.
 * A legacy ID label that does not match the live handle quarantines the sandbox
 * as `id_mismatch` instead of adopting or silently ignoring it.
 */
export function decodeManagedSandbox(
  handle: SandboxHandleLike,
  parentId: string,
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

  const legacyId = labels[SANDBOX_ID_LABEL];
  if (legacyId !== undefined && legacyId !== handle.id) {
    throw new SandboxDecodeError("id_mismatch");
  }

  return decodeLabels(labels, handle);
}

export async function loadManagedSandboxes(
  runtime: SandboxRuntime,
  parentId: string,
  redaction: readonly string[] = [],
): Promise<SandboxInventory> {
  let handles: readonly SandboxHandleLike[];
  try {
    handles = await runtime.list(parentId);
  } catch (error) {
    return {
      status: "unavailable",
      error: safeError("inventory_unavailable", failureDetail(error, redaction)),
    };
  }

  const sandboxes: LoadedSandbox[] = [];
  const failures: SandboxDecodeFailure[] = [];

  for (const handle of handles) {
    try {
      const decoded = decodeManagedSandbox(handle, parentId);
      if (decoded) sandboxes.push({ sandbox: decoded, handle });
    } catch (error) {
      failures.push({
        id: handle.id,
        name: handle.name,
        runtimeStatus: normalizeRuntimeStatus(handle.status),
        code:
          error instanceof SandboxDecodeError && error.code === "id_mismatch"
            ? "id_mismatch"
            : "invalid_config",
      });
    }
  }

  return { status: "available", sandboxes, failures };
}

/** Guard used by tests and later lifecycle code. */
export function isManagedSandboxName(name: string): boolean {
  return name.startsWith(MANAGED_NAME_PREFIX) && name.length > MANAGED_NAME_PREFIX.length;
}

function rawLabels(handle: SandboxHandleLike): Record<string, string> | null {
  try {
    const parsed = RawConfigSchema.safeParse(handle.config());
    return parsed.success ? (parsed.data.labels ?? {}) : null;
  } catch {
    return null;
  }
}

export type SandboxOwnership = "owned" | "foreign" | "quarantine" | "unknown";

/**
 * Ownership requires the managed and parent labels. A present legacy ID that
 * differs from the live handle is quarantined. Absence of a legacy ID is valid
 * for new sandboxes; the name owns the current generation.
 */
export function ownershipOf(handle: SandboxHandleLike, parentId: string): SandboxOwnership {
  const labels = rawLabels(handle);
  if (labels === null) return "unknown";
  if (labels[MANAGED_LABEL] !== PLUGIN_VERSION) return "foreign";
  if (labels[PARENT_LABEL] !== parentId) return "foreign";

  const legacyId = labels[SANDBOX_ID_LABEL];
  if (legacyId !== undefined && legacyId !== handle.id) return "quarantine";
  return "owned";
}

export function ownsSandbox(handle: SandboxHandleLike, parentId: string): boolean {
  return ownershipOf(handle, parentId) === "owned";
}

/**
 * Reads the credential names a sandbox was created with. Values are ignored so
 * this is safe to use for repeated-create validation and redaction.
 */
export function sandboxCredentialNames(handle: SandboxHandleLike): CredentialName[] {
  let raw: unknown;
  try {
    raw = handle.config();
  } catch {
    return [];
  }

  const parsed = RawConfigSchema.safeParse(raw);
  if (!parsed.success) return [];

  const names = new Set<CredentialName>();

  const env = parsed.data.env;
  if (Array.isArray(env)) {
    for (const entry of env) {
      const name = asRecord(entry)?.name;
      if (typeof name === "string" && CREDENTIAL_SET.has(name)) {
        names.add(name as CredentialName);
      }
    }
  } else {
    const record = asRecord(env);
    if (record) {
      for (const name of Object.keys(record)) {
        if (CREDENTIAL_SET.has(name)) names.add(name as CredentialName);
      }
    }
  }

  const entries = asRecord(asRecord(parsed.data.network)?.secrets)?.secrets;
  if (Array.isArray(entries)) {
    for (const entry of entries) {
      const envVar = asRecord(entry)?.envVar;
      if (typeof envVar === "string" && CREDENTIAL_SET.has(envVar)) {
        names.add(envVar as CredentialName);
      }
    }
  }

  return CREDENTIAL_NAMES.filter((name) => names.has(name));
}

/**
 * Writes labels only after re-reading the exact generation. The pinned SDK's
 * `modify()` applies to a same-name replacement, so this guard is mandatory.
 */
export async function guardedModify(
  handle: SandboxHandleLike,
  labels: Readonly<Record<string, string>>,
): Promise<void> {
  let current: SandboxHandleLike;
  try {
    current = await handle.refresh();
  } catch (error) {
    throw new SandboxGenerationError(
      isSandboxReplacedError(error) ? "id_mismatch" : "runtime_unavailable",
    );
  }

  if (current.id !== handle.id) throw new SandboxGenerationError("id_mismatch");

  try {
    await current.modify({ labels });
  } catch (error) {
    if (isSandboxReplacedError(error)) throw new SandboxGenerationError("id_mismatch");
    throw error;
  }
}

export function isSandboxReplacedError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    ((error as { code?: unknown }).code === "sandboxReplaced" ||
      (error as { code?: unknown }).code === "sandbox_replaced")
  );
}

/** Advances the progress hint and optionally records a safe error. */
export async function markSandboxPhase(
  handle: SandboxHandleLike,
  phase: Phase,
  options: { readonly code?: SafeErrorCode; readonly detail?: string | null } = {},
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

  await guardedModify(handle, labels);
}

/**
 * Persists a retryable or terminal setup error while keeping the actionable
 * phase. A legacy `failed` phase is never written by new code.
 */
export async function markSandboxError(
  handle: SandboxHandleLike,
  phase: Phase,
  code: SafeErrorCode,
  detail: string | null = null,
): Promise<void> {
  await markSandboxPhase(handle, phase === "failed" ? "installing" : phase, {
    code,
    detail,
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

import { z } from "zod";
import {
  CPUS,
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
import type { ResolvedSecret } from "./secrets";

/**
 * Structural handles keep the decoder testable with fake sandboxes. The real
 * microsandbox adapter below satisfies the same interface.
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

export interface SandboxJobLike {
  inspect(): Promise<{ readonly state: string; readonly exitCode: number | null }>;
  wait(): Promise<{ readonly code: number }>;
  logs(options: { tail?: number }): Promise<readonly SandboxJobLogEntryLike[]>;
}

export interface SandboxHandleLike {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  config(): unknown;
  modify(options: { readonly labels: Readonly<Record<string, string>> }): Promise<unknown>;
  logs(options: {
    tail?: number;
    sources?: readonly string[];
  }): Promise<readonly SandboxLogEntryLike[]>;
  getJob(id: string): Promise<SandboxJobLike>;
}

export interface SandboxRuntime {
  list(parentId: string): Promise<readonly SandboxHandleLike[]>;
}

/** One guest command the create runner needs to run with an explicit user. */
export interface ExecSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly user: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly stdinNull?: boolean;
}

/** A detached guest job, reduced to what the create runner observes. */
export interface SandboxJobHandleLike {
  readonly id: string;
  wait(): Promise<{ readonly code: number }>;
  inspect(): Promise<{ readonly state: string; readonly exitCode: number | null }>;
}

/** The handle returned by a strict create, with the guest operations it needs. */
export interface SandboxCreateHandleLike {
  readonly id: string;
  readonly name: string;
  modify(options: { readonly labels: Readonly<Record<string, string>> }): Promise<void>;
  execDetached(spec: ExecSpec): Promise<SandboxJobHandleLike>;
  exec(spec: ExecSpec): Promise<string>;
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

/** The write-side slice shared by create and recovery. */
export interface SandboxLabelHandleLike {
  modify(options: { readonly labels: Readonly<Record<string, string>> }): Promise<unknown>;
}

/** Reconnects to a sandbox so recovery can run read-only guest checks. */
export interface SandboxResumeHandleLike extends SandboxLabelHandleLike {
  exec(spec: ExecSpec): Promise<string>;
}

/**
 * Host-side sandbox operations used by task 4. `resume` never starts a stopped
 * sandbox; `destroy` refuses a same-name replacement through its stable handle.
 */
export interface SandboxHost extends SandboxCreator {
  resume(name: string): Promise<SandboxResumeHandleLike>;
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

/**
 * The runtime config is a wide SDK object. Only labels are read here, and no
 * part of it is returned to callers.
 */
const RawConfigSchema = z.looseObject({
  labels: z.record(z.string(), z.string()).optional(),
});

const PhaseSchema = z.enum(PHASES);
const RuntimeStatusSchema = z.enum(RUNTIME_STATUSES);
const SAFE_LABEL_TOKEN = /^[A-Za-z0-9._:-]{1,128}$/;

function normalizeRuntimeStatus(value: string): RuntimeStatus {
  const parsed = RuntimeStatusSchema.safeParse(value);
  return parsed.success ? parsed.data : "unknown";
}

function decodeLabels(
  labels: Readonly<Record<string, string>>,
  handle: SandboxHandleLike,
  parentId: string,
): DecodedSandbox {
  const phase: Phase = (() => {
    const parsed = PhaseSchema.safeParse(labels[PHASE_LABEL]);
    return parsed.success ? parsed.data : "failed";
  })();

  const job = labels[JOB_LABEL];
  const validJob = job && SAFE_LABEL_TOKEN.test(job) ? job : undefined;

  const rawError = labels[ERROR_LABEL];
  const error: SafeErrorCode | undefined =
    rawError && isSafeErrorCode(rawError)
      ? rawError
      : phase === "failed"
        ? "invalid_config"
        : undefined;

  const idMatches = labels[SANDBOX_ID_LABEL] === handle.id;
  const normalizedPhase: Phase = idMatches ? phase : "failed";
  const normalizedError: SafeErrorCode | undefined = idMatches
    ? phase === "failed"
      ? error
      : undefined
    : "id_mismatch";

  const projected: ManagedLabels = {
    [MANAGED_LABEL]: PLUGIN_VERSION,
    [PARENT_LABEL]: parentId,
    [SANDBOX_ID_LABEL]: handle.id,
    [PHASE_LABEL]: normalizedPhase,
    ...(validJob ? { [JOB_LABEL]: validJob } : {}),
    ...(normalizedError ? { [ERROR_LABEL]: normalizedError } : {}),
  };

  return {
    id: handle.id,
    name: handle.name,
    runtimeStatus: normalizeRuntimeStatus(handle.status),
    labels: projected,
  };
}

/**
 * Returns null for a sandbox that is not managed by this plugin and parent.
 * A managed-looking sandbox whose labels are malformed or whose stable ID does
 * not match its label is projected as failed instead of being hidden.
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

  return decodeLabels(labels, handle, parentId);
}

export async function loadManagedSandboxes(
  runtime: SandboxRuntime,
  parentId: string,
): Promise<SandboxInventory> {
  let handles: readonly SandboxHandleLike[];
  try {
    handles = await runtime.list(parentId);
  } catch {
    return { status: "unavailable", error: safeError("inventory_unavailable") };
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

/** Guard used by tests and later create/recovery code. */
export function isManagedSandboxName(name: string): boolean {
  return name.startsWith(MANAGED_NAME_PREFIX) && name.length > MANAGED_NAME_PREFIX.length;
}

function rawManagedLabels(handle: SandboxHandleLike): Record<string, string> | null {
  try {
    const parsed = RawConfigSchema.safeParse(handle.config());
    return parsed.success ? (parsed.data.labels ?? {}) : null;
  } catch {
    return null;
  }
}

/**
 * Ownership requires the managed label, this parent, and a stable-ID label that
 * matches the live handle. A same-name replacement therefore never inherits an
 * earlier attempt.
 */
export function ownsSandbox(handle: SandboxHandleLike, parentId: string): boolean {
  const labels = rawManagedLabels(handle);
  return (
    labels !== null &&
    labels[MANAGED_LABEL] === PLUGIN_VERSION &&
    labels[PARENT_LABEL] === parentId &&
    labels[SANDBOX_ID_LABEL] === handle.id
  );
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

/** Writes only a fixed safe code; raw errors are dropped. */
export async function markSandboxFailed(
  handle: SandboxLabelHandleLike,
  code: SafeErrorCode,
): Promise<void> {
  try {
    await handle.modify({ labels: { [PHASE_LABEL]: "failed", [ERROR_LABEL]: code } });
  } catch {
    // The sandbox stays visible as failed/incomplete through its stable ID.
  }
}

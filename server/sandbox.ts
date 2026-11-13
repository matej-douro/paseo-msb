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
  logs(options: { tail?: number }): Promise<readonly SandboxJobLogEntryLike[]>;
}

export interface SandboxHandleLike {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  config(): unknown;
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
  inspect(): Promise<{ readonly state: string }>;
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

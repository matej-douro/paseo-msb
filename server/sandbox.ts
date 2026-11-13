import { z } from "zod";
import {
  ERROR_LABEL,
  JOB_LABEL,
  MANAGED_LABEL,
  MANAGED_NAME_PREFIX,
  PARENT_LABEL,
  PHASE_LABEL,
  PHASES,
  PLUGIN_VERSION,
  RUNTIME_STATUSES,
  SANDBOX_ID_LABEL,
  type Phase,
  type RuntimeStatus,
} from "../shared/constants";
import type { ManagedLabels } from "../shared/contracts";
import { isSafeErrorCode, safeError, type SafeErrorCode } from "../shared/errors";

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

import { ERROR_LABEL, JOB_LABEL, PHASE_LABEL, SANDBOX_ID_LABEL } from "../shared/constants";
import type { VmCreateInput, VmCreateResult } from "../shared/contracts";
import { safeError, type SafeErrorCode } from "../shared/errors";
import { inspectPiInstall, piInstallSpec, piPathCheckSpec } from "./pi-install";
import type { PendingCreate, PendingCreateStore } from "./pending";
import type { ParentHostsLike } from "./status";
import {
  ownsSandbox,
  type SandboxCreateHandleLike,
  type SandboxCreateRequest,
  type SandboxCreator,
  type SandboxJobHandleLike,
} from "./sandbox";
import { resolveSelectedSecrets, type ResolvedSecret } from "./secrets";

const MAX_CREATE_ATTEMPTS = 3;
const DEFAULT_INSTALL_TIMEOUT_MS = 600_000;

type CreateRequestBase = Omit<SandboxCreateRequest, "hostPort">;

/** A host failure with a fixed, safe code. Raw SDK and guest text never cross. */
class CreateFailure extends Error {
  constructor(readonly code: SafeErrorCode) {
    super(code);
    this.name = "CreateFailure";
  }
}

export interface CreateContext {
  readonly hosts: ParentHostsLike;
  readonly creator: SandboxCreator;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly pending: PendingCreateStore;
  /** Bounded wait for the detached Pi install; tests shorten it. */
  readonly installTimeoutMs?: number;
}

export interface CreateAttempt {
  readonly name: string;
  /** Background work. Never rejects; failures land in pending/labels. */
  readonly started: Promise<void>;
}

/**
 * `vm.create`: validates the fixed input, records the attempt, starts host-side
 * work, and returns the generated name without waiting for the runtime.
 */
export async function createVm(
  context: CreateContext,
  input: VmCreateInput,
): Promise<VmCreateResult> {
  const attempt = startCreate(context, input);
  void attempt.started.catch(() => {});
  return { name: attempt.name };
}

/**
 * Synchronous half of a create. Reusing a request ID while its attempt runs
 * returns the same name and starts nothing; restarting an empty pre-create
 * failure reuses the same name but replays no side effects.
 */
export function startCreate(context: CreateContext, input: VmCreateInput): CreateAttempt {
  const { requestId } = input;
  const existing = context.pending.find(requestId);

  if (existing && existing.phase !== "failed") {
    return { name: existing.name, started: Promise.resolve() };
  }

  const resolution = resolveSelectedSecrets(input.secretEnvVars, context.env);
  if (resolution.status === "missing") {
    throw new Error(safeError("missing_credentials").message);
  }

  const entry = existing ? context.pending.restart(requestId) : context.pending.ensure(requestId);

  return { name: entry.name, started: runCreate(context, entry, resolution.secrets) };
}

async function runCreate(
  context: CreateContext,
  entry: PendingCreate,
  secrets: readonly ResolvedSecret[],
): Promise<void> {
  let handle: SandboxCreateHandleLike | null = null;

  try {
    const parentId = await resolveParentId(context.hosts);

    const existing = await context.creator.find(entry.name);
    if (existing) {
      if (ownsSandbox(existing, parentId)) {
        context.pending.remove(entry.requestId);
        return;
      }
      throw new CreateFailure("name_conflict");
    }

    handle = await createWithPortRetry(context.creator, {
      name: entry.name,
      parentId,
      secrets,
    });

    // Persist the stable ID before the pending entry disappears so a repeated
    // request in this window sees an owned sandbox instead of a name conflict.
    await handle.modify({
      labels: {
        [SANDBOX_ID_LABEL]: handle.id,
        [PHASE_LABEL]: "installing",
      },
    });

    // The sandbox now owns progress; list/detail read it from labels.
    context.pending.remove(entry.requestId);

    const job = await startPiInstall(handle);
    await handle.modify({ labels: { [JOB_LABEL]: job.id } });
    await waitForInstall(job, context.installTimeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS);

    const output = await handle.exec(piPathCheckSpec()).catch(() => null);
    if (!output || !inspectPiInstall(output)) {
      throw new CreateFailure("path_unverified");
    }

    // Task 4 continues from here into registration.
    await handle.modify({ labels: { [PHASE_LABEL]: "registering" } });
  } catch (error) {
    await failCreate(context, entry, handle, errorCode(error));
  }
}

async function resolveParentId(hosts: ParentHostsLike): Promise<string> {
  try {
    const directory = await hosts.list();
    const serverId = directory.self.serverId;
    if (!serverId) throw new Error("missing server id");
    return serverId;
  } catch {
    throw new CreateFailure("runtime_unavailable");
  }
}

/**
 * Host port `0` is not allocated by the pinned runtime, so the runner probes a
 * free loopback port and retries with a fresh one only when creation reports a
 * bind-style failure and no sandbox appeared.
 */
async function createWithPortRetry(
  creator: SandboxCreator,
  request: CreateRequestBase,
): Promise<SandboxCreateHandleLike> {
  let portFailures = 0;

  for (let attempt = 1; attempt <= MAX_CREATE_ATTEMPTS; attempt += 1) {
    let hostPort: number;
    try {
      hostPort = await creator.probePort();
    } catch {
      throw new CreateFailure("port_unavailable");
    }

    try {
      return await creator.create({ ...request, hostPort });
    } catch (error) {
      const existing = await creator.find(request.name).catch(() => null);
      if (existing) throw new CreateFailure("create_failed");
      if (!isPortFailure(error)) throw new CreateFailure("create_failed");
      portFailures += 1;
    }
  }

  throw new CreateFailure(portFailures > 0 ? "port_unavailable" : "create_failed");
}

const PORT_FAILURE = /\b(address already in use|eaddrinuse|bind|port)\b/i;

function isPortFailure(error: unknown): boolean {
  return error instanceof Error && PORT_FAILURE.test(error.message);
}

async function startPiInstall(handle: SandboxCreateHandleLike): Promise<SandboxJobHandleLike> {
  try {
    return await handle.execDetached(piInstallSpec());
  } catch {
    throw new CreateFailure("install_failed");
  }
}

async function waitForInstall(job: SandboxJobHandleLike, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new CreateFailure("install_failed")), timeoutMs);
    });
    const exit = await Promise.race([job.wait(), timeout]);
    const info = await job.inspect().catch(() => null);

    if (exit.code !== 0 || !info || info.state !== "exited") {
      throw new CreateFailure("install_failed");
    }
  } catch (error) {
    throw error instanceof CreateFailure ? error : new CreateFailure("install_failed");
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function errorCode(error: unknown): SafeErrorCode {
  return error instanceof CreateFailure ? error.code : "create_failed";
}

/**
 * Preserves the sandbox and job for inspection. Only a short safe code is
 * written; raw errors are dropped. Before a sandbox exists the failure stays
 * on the pending entry so the same request ID can retry.
 */
async function failCreate(
  context: CreateContext,
  entry: PendingCreate,
  handle: SandboxCreateHandleLike | null,
  code: SafeErrorCode,
): Promise<void> {
  if (!handle) {
    context.pending.fail(entry.requestId, code);
    return;
  }

  // Once a sandbox exists, progress lives in labels, not in the pending map.
  context.pending.remove(entry.requestId);

  try {
    await handle.modify({
      labels: { [PHASE_LABEL]: "failed", [ERROR_LABEL]: code },
    });
  } catch {
    // The sandbox stays visible as failed/incomplete through its stable ID.
  }
}

import {
  JOB_LABEL,
  PHASE_LABEL,
  SANDBOX_ID_LABEL,
  type CredentialName,
} from "../shared/constants";
import type { VmCreateInput, VmCreateResult } from "../shared/contracts";
import { safeError, type SafeErrorCode } from "../shared/errors";
import {
  inspectPiInstall,
  piInstallSpec,
  piPathCheckSpec,
  waitForPiInstall,
} from "./pi-install";
import { failureDetail } from "./diagnostics";
import { credentialValues } from "./logs";
import type { PendingCreate, PendingCreateStore } from "./pending";
import {
  registerSandbox,
  SetupFailure,
  type RegistrationContext,
  type RegistrationHostsLike,
} from "./registration";
import {
  markSandboxFailed,
  ownsSandbox,
  type SandboxCreateHandleLike,
  type SandboxCreateRequest,
  type SandboxCreator,
  type SandboxJobHandleLike,
} from "./sandbox";
import { resolveSelectedSecrets, type ResolvedSecret } from "./secrets";
import type { SecretsStore } from "./secrets-store";

const MAX_CREATE_ATTEMPTS = 3;
const DEFAULT_INSTALL_TIMEOUT_MS = 600_000;

type CreateRequestBase = Omit<SandboxCreateRequest, "hostPort">;

interface CreatedSandbox {
  readonly handle: SandboxCreateHandleLike;
  readonly hostPort: number;
}

/** A host failure with a fixed, safe code and optional raw detail. */
class CreateFailure extends Error {
  constructor(
    readonly code: SafeErrorCode,
    readonly detail?: string | null,
  ) {
    super(code);
    this.name = "CreateFailure";
  }
}

export interface CreateContext extends RegistrationContext {
  readonly hosts: RegistrationHostsLike;
  readonly creator: SandboxCreator;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly pending: PendingCreateStore;
  readonly secretsStore: SecretsStore;
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
  const stored = await context.secretsStore.read();
  if (stored.status !== "ok") {
    throw new Error(safeError("secrets_unavailable").message);
  }

  const attempt = startCreate(context, input, stored.values);
  void attempt.started.catch(() => {});
  return { name: attempt.name };
}

/**
 * Synchronous half of a create. Reusing a request ID while its attempt runs
 * returns the same name and starts nothing; restarting an empty pre-create
 * failure reuses the same name but replays no side effects.
 */
export function startCreate(
  context: CreateContext,
  input: VmCreateInput,
  stored: ReadonlyMap<CredentialName, string> = new Map(),
): CreateAttempt {
  const { requestId } = input;
  const existing = context.pending.find(requestId);

  if (existing && existing.phase !== "failed") {
    return { name: existing.name, started: Promise.resolve() };
  }

  const resolution = resolveSelectedSecrets(input.secretEnvVars, context.env, stored);
  if (resolution.status === "missing") {
    throw new Error(safeError("missing_credentials").message);
  }

  const entry = existing ? context.pending.restart(requestId) : context.pending.ensure(requestId);
  const redactionValues = credentialValues(context.env, stored);

  return {
    name: entry.name,
    started: runCreate(context, entry, resolution.secrets, redactionValues),
  };
}

async function runCreate(
  context: CreateContext,
  entry: PendingCreate,
  secrets: readonly ResolvedSecret[],
  redactionValues: readonly string[],
): Promise<void> {
  let handle: SandboxCreateHandleLike | null = null;

  try {
    const parentId = await resolveParentId(context.hosts, redactionValues);

    const existing = await context.creator.find(entry.name);
    if (existing) {
      if (ownsSandbox(existing, parentId)) {
        context.pending.remove(entry.requestId);
        return;
      }
      throw new CreateFailure("name_conflict");
    }

    const created: CreatedSandbox = await createWithPortRetry(context.creator, {
      name: entry.name,
      parentId,
      secrets,
    }, redactionValues);
    handle = created.handle;

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

    const job = await startPiInstall(handle, redactionValues);
    await handle.modify({ labels: { [JOB_LABEL]: job.id } });
    if (!(await waitForPiInstall(job, context.installTimeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS))) {
      throw new CreateFailure(
        "install_failed",
        "the Pi install job did not exit successfully",
      );
    }

    const output = await handle.exec(piPathCheckSpec()).catch(() => null);
    if (!output || !inspectPiInstall(output)) {
      throw new CreateFailure(
        "path_unverified",
        "pi did not resolve on the daemon user PATH",
      );
    }

    await handle.modify({ labels: { [PHASE_LABEL]: "registering" } });
    await registerSandbox(
      context,
      parentId,
      { id: handle.id, name: handle.name },
      created.hostPort,
    );
    await handle.modify({ labels: { [PHASE_LABEL]: "ready" } });
  } catch (error) {
    await failCreate(
      context,
      entry,
      handle,
      errorCode(error),
      failureDetail(error, redactionValues),
    );
  }
}

async function resolveParentId(
  hosts: RegistrationHostsLike,
  redactionValues: readonly string[],
): Promise<string> {
  try {
    const directory = await hosts.list();
    const serverId = directory.self.serverId;
    if (!serverId) throw new Error("parent directory did not report a server id");
    return serverId;
  } catch (error) {
    throw new CreateFailure(
      "runtime_unavailable",
      failureDetail(error, redactionValues),
    );
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
  redactionValues: readonly string[] = [],
): Promise<CreatedSandbox> {
  let portFailures = 0;
  let lastFailure: unknown = null;

  for (let attempt = 1; attempt <= MAX_CREATE_ATTEMPTS; attempt += 1) {
    let hostPort: number;
    try {
      hostPort = await creator.probePort();
    } catch {
      throw new CreateFailure("port_unavailable");
    }

    try {
      const handle = await creator.create({ ...request, hostPort });
      return { handle, hostPort };
    } catch (error) {
      lastFailure = error;
      const existing = await creator.find(request.name).catch(() => null);
      if (existing) {
        throw new CreateFailure("create_failed", failureDetail(error, redactionValues));
      }
      if (!isPortFailure(error)) {
        throw new CreateFailure("create_failed", failureDetail(error, redactionValues));
      }
      portFailures += 1;
    }
  }

  throw new CreateFailure(
    portFailures > 0 ? "port_unavailable" : "create_failed",
    failureDetail(lastFailure, redactionValues),
  );
}

const PORT_FAILURE = /\b(address already in use|eaddrinuse|bind|port)\b/i;

function isPortFailure(error: unknown): boolean {
  return error instanceof Error && PORT_FAILURE.test(error.message);
}

async function startPiInstall(
  handle: SandboxCreateHandleLike,
  redactionValues: readonly string[],
): Promise<SandboxJobHandleLike> {
  try {
    return await handle.execDetached(piInstallSpec());
  } catch (error) {
    throw new CreateFailure(
      "install_failed",
      failureDetail(error, redactionValues),
    );
  }
}

function errorCode(error: unknown): SafeErrorCode {
  if (error instanceof CreateFailure || error instanceof SetupFailure) return error.code;
  return "create_failed";
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
  detail: string | null,
): Promise<void> {
  if (!handle) {
    context.pending.fail(entry.requestId, code, detail);
    return;
  }

  // Once a sandbox exists, progress lives in labels, not in the pending map.
  context.pending.remove(entry.requestId);
  await markSandboxFailed(handle, code, detail);
}

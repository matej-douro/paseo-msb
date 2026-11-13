import {
  ERROR_LABEL,
  PHASE_LABEL,
  type CredentialName,
  type Phase,
} from "../shared/constants";

import { failureDetail, persistedCredentialValues } from "./diagnostics";
import {
  classifyInstallJobs,
  listAllJobs,
  waitForInstallJob,
  type InstallJobOutcome,
} from "./jobs";
import { LifecycleAbortedError, type LaneToken } from "./lanes";
import type { PendingCreateStore } from "./pending";
import {
  inspectPiInstall,
  piInstallSpec,
  piPathCheckSpec,
} from "./pi-install";
import {
  ensureRegistration,
  matchingRegistrations,
  pluginRegistrations,
  removeRegistration,
  SetupFailure,
  type RegistrationContext,
  type RegistrationHostsLike,
} from "./registration";
import {
  decodeManagedSandbox,
  isSandboxReplacedError,
  type SandboxConnectHandleLike,
  markSandboxError,
  markSandboxPhase,
  ownershipOf,
  readSandboxHostPort,
  sandboxCredentialNames,
  SandboxGenerationError,
  type DecodedSandbox,
  type SandboxCreateHandleLike,
  type SandboxCreateRequest,
  type SandboxHandleLike,
  type SandboxHost,
  type SandboxRuntime,
} from "./sandbox";
import type { ResolvedSecret } from "./secrets";
import type { SecretsStore } from "./secrets-store";
import type { HostRegistrationLike } from "./status";

const MAX_CREATE_ATTEMPTS = 3;
const DEFAULT_INSTALL_TIMEOUT_MS = 600_000;

export interface ReconcileContext extends RegistrationContext {
  readonly hosts: RegistrationHostsLike;
  readonly runtime: SandboxRuntime;
  readonly sandboxHost: SandboxHost;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly secretsStore: SecretsStore;
  readonly pending: PendingCreateStore;
  /** Bounded wait for one detached Pi install; tests shorten it. */
  readonly installTimeoutMs?: number;
}

export interface ReconcileRequest {
  readonly name: string;
  /** Only `vm.create` may allocate an initial sandbox. */
  readonly allowCreate: boolean;
  readonly requestId?: string;
  /** Values resolved immediately before creation; only when creating. */
  readonly credentials?: readonly ResolvedSecret[];
  readonly credentialNames?: readonly CredentialName[];
  readonly redactionValues: readonly string[];
}

export interface ReconcileOutcome {
  readonly name: string;
  readonly phase: Phase;
  readonly registration: HostRegistrationLike | null;
  /** True when this operation advanced or cleaned up the child. */
  readonly repaired: boolean;
}

type PiState =
  | { readonly status: "ready" }
  | { readonly status: "missing" }
  | { readonly status: "replaced" }
  | { readonly status: "unknown"; readonly detail: string | null };

/**
 * The single idempotent reconciler for background Create, startup recovery, and
 * manual Repair. It observes actual resources and advances only one unambiguous
 * step. It never starts a stopped VM and never creates unless `allowCreate`.
 */
export async function reconcileName(
  context: ReconcileContext,
  request: ReconcileRequest,
  token: LaneToken,
): Promise<ReconcileOutcome> {
  token.throwIfAborted();

  const directory = await context.hosts.list().catch((error) => {
    throw new SetupFailure(
      "registrations_unavailable",
      failureDetail(error, request.redactionValues),
    );
  });
  const parentId = directory.self.serverId;
  if (!parentId) throw new SetupFailure("runtime_unavailable");

  const handle = await context.sandboxHost.find(request.name).catch(() => {
    throw new SetupFailure("runtime_unavailable");
  });

  if (!handle) return reconcileAbsent(context, request, parentId, token);

  return advanceSandbox(context, request, parentId, handle, token);
}

async function reconcileAbsent(
  context: ReconcileContext,
  request: ReconcileRequest,
  parentId: string,
  token: LaneToken,
): Promise<ReconcileOutcome> {
  const directory = await context.hosts.list().catch((error) => {
    throw new SetupFailure(
      "registrations_unavailable",
      failureDetail(error, request.redactionValues),
    );
  });
  const registrations = registrationOnlyForName(parentId, request.name, directory.hosts);

  if (!request.allowCreate) {
    if (registrations.length === 0) throw new SetupFailure("not_found");
    await removeStaleRegistrations(context, registrations);
    return {
      name: request.name,
      phase: "registering",
      registration: null,
      repaired: true,
    };
  }

  // A registration-only child means a Delete is still settling. Join that
  // cleanup instead of creating a replacement generation.
  if (registrations.length > 0) {
    await removeStaleRegistrations(context, registrations);
    if (request.requestId) context.pending.remove(request.requestId);
    return {
      name: request.name,
      phase: "registering",
      registration: null,
      repaired: true,
    };
  }

  const credentials = request.credentials ?? [];
  if (credentials.length === 0) throw new SetupFailure("missing_credentials");

  const created = await createWithPortRetry(
    context.sandboxHost,
    {
      name: request.name,
      parentId,
      secrets: credentials,
    },
    request.redactionValues,
  );

  const handle = await context.sandboxHost.find(request.name).catch(() => null);
  if (!handle) {
    throw new SetupFailure(
      "create_failed",
      "the sandbox was not visible after create",
    );
  }

  if (handle.id !== created.id) {
    throw new SetupFailure(
      "name_conflict",
      "the name was replaced between create and lookup",
    );
  }

  const ownership = ownershipOf(handle, parentId);
  if (ownership === "quarantine") throw new SetupFailure("id_mismatch");
  if (ownership !== "owned") throw new SetupFailure("name_conflict");

  token.throwIfAborted();
  if (request.requestId) context.pending.remove(request.requestId);

  return advanceSandbox(context, { ...request, allowCreate: false }, parentId, handle, token);
}

async function advanceSandbox(
  context: ReconcileContext,
  request: ReconcileRequest,
  parentId: string,
  handle: SandboxHandleLike,
  token: LaneToken,
): Promise<ReconcileOutcome> {
  const ownership = ownershipOf(handle, parentId);
  if (ownership === "quarantine") throw new SetupFailure("id_mismatch");
  if (ownership === "foreign") throw new SetupFailure("name_conflict");
  if (ownership === "unknown") throw new SetupFailure("invalid_config");

  let decoded: DecodedSandbox | null;
  try {
    decoded = decodeManagedSandbox(handle, parentId);
  } catch (error) {
    throw new SetupFailure(isSandboxDecodeError(error) ? error.code : "invalid_config");
  }
  if (!decoded) throw new SetupFailure("name_conflict");

  const redaction = mergeRedaction(request.redactionValues, handle);

  if (decoded.labels[PHASE_LABEL] === "deleting") {
    // Cleanup-only: never resume setup after a Delete tombstone. A reload that
    // observed the tombstone before destruction completes that exact deletion.
    const cleaned = await completeDeletion(context, parentId, handle, token);
    return {
      name: request.name,
      phase: "deleting",
      registration: null,
      repaired: cleaned,
    };
  }

  if (decoded.labels[ERROR_LABEL] === "invalid_config") {
    throw new SetupFailure("invalid_config");
  }

  if (request.requestId) context.pending.remove(request.requestId);

  let phase = decoded.labels[PHASE_LABEL];
  let changed = false;

  try {
    token.throwIfAborted();

    const pi = await readPiState(context, handle, redaction);
    if (pi.status === "replaced") throw new SetupFailure("id_mismatch");
    if (pi.status === "unknown") {
      throw new SetupFailure("runtime_unavailable", pi.detail);
    }

    if (pi.status === "missing") {
      // A legacy failed phase is read-only migration state. Actual Pi readiness
      // above wins; otherwise do not replay side effects from the old model.
      if (decoded.labels[PHASE_LABEL] === "failed") {
        throw new SetupFailure("install_failed");
      }
      phase = "installing";
      changed = (await ensurePiInstalled(context, handle, redaction, token)) || changed;
      const after = await readPiState(context, handle, redaction);
      if (after.status === "replaced") throw new SetupFailure("id_mismatch");
      if (after.status === "unknown") {
        throw new SetupFailure("runtime_unavailable", after.detail);
      }
      if (after.status !== "ready") {
        throw new SetupFailure("path_unverified", "pi is not at the pinned path and version");
      }
    }

    token.throwIfAborted();

    if (phase !== "ready") {
      phase = "registering";
      if (await writePhase(handle, phase, token)) changed = true;
    }

    const hostPort = readSandboxHostPort(handle);
    if (hostPort === null) throw new SetupFailure("registration_failed");

    const ensured = await ensureRegistration(
      { ...context, signal: token.signal },
      parentId,
      { id: handle.id, name: handle.name },
      hostPort,
    );
    if (ensured.changed) changed = true;

    if (
      await removeStaleSameNameRegistrations(context, parentId, handle.name, handle.id)
    ) {
      changed = true;
    }

    if (phase !== "ready") {
      phase = "ready";
      if (await writePhase(handle, phase, token)) changed = true;
    }

    return {
      name: request.name,
      phase: "ready",
      registration: ensured.registration,
      repaired: changed,
    };
  } catch (error) {
    if (error instanceof LifecycleAbortedError) throw error;
    const failure = asSetupFailure(error);
    await recordFailure(handle, phase, failure);
    throw failure;
  }
}

async function ensurePiInstalled(
  context: ReconcileContext,
  handle: SandboxHandleLike,
  redaction: readonly string[],
  token: LaneToken,
): Promise<boolean> {
  token.throwIfAborted();

  const inventory = await readInstallInventory(handle);
  if (inventory.active.length > 1) throw new SetupFailure("install_conflict");

  // A successful historical job wins over a missing legacy job label.
  if (inventory.succeeded.length > 0) return false;

  if (inventory.active.length === 1) {
    const outcome = await waitForInstallJob(
      handle,
      inventory.active[0].id,
      timeoutMs(context),
      token.signal,
    );
    interpretOutcome(outcome);
    return true;
  }

  if (inventory.failed.length > 0) {
    throw new SetupFailure("install_failed", "the recorded Pi install did not succeed");
  }

  token.throwIfAborted();
  await writePhase(handle, "installing", token);

  let jobId: string;
  try {
    const job = await context.sandboxHost.startInstall(handle, piInstallSpec());
    jobId = job.id;
  } catch (error) {
    // A launch error may be uncertain. Re-list before deciding anything.
    const after = await readInstallInventory(handle);
    if (after.active.length > 1) throw new SetupFailure("install_conflict");
    if (after.succeeded.length > 0) return true;
    if (after.active.length === 1) {
      interpretOutcome(
        await waitForInstallJob(
          handle,
          after.active[0].id,
          timeoutMs(context),
          token.signal,
        ),
      );
      return true;
    }
    if (after.failed.length > 0) throw new SetupFailure("install_failed");

    const uncertain = (error as { jobId?: unknown }).jobId;
    if (typeof uncertain === "string" && uncertain.length > 0) {
      interpretOutcome(
        await waitForInstallJob(handle, uncertain, timeoutMs(context), token.signal),
      );
      return true;
    }

    throw new SetupFailure("install_pending", failureDetail(error, redaction));
  }

  interpretOutcome(
    await waitForInstallJob(handle, jobId, timeoutMs(context), token.signal),
  );
  return true;
}

async function readInstallInventory(handle: SandboxHandleLike) {
  try {
    return classifyInstallJobs(await listAllJobs(handle));
  } catch {
    // Never start another install because inspection failed.
    throw new SetupFailure("job_inventory_unavailable");
  }
}

function interpretOutcome(outcome: InstallJobOutcome): void {
  switch (outcome.status) {
    case "succeeded":
      return;
    case "failed":
      throw new SetupFailure("install_failed", "the Pi install job did not exit successfully");
    case "running":
      throw new SetupFailure("install_pending", "the Pi install job is still running");
    case "unknown":
      throw new SetupFailure("install_pending", "the Pi install job state is unknown");
  }
}

async function readPiState(
  context: ReconcileContext,
  handle: SandboxHandleLike,
  redaction: readonly string[],
): Promise<PiState> {
  let connected: SandboxConnectHandleLike;
  try {
    connected = await context.sandboxHost.connect(handle);
  } catch (error) {
    return isSandboxReplacedError(error)
      ? { status: "replaced" }
      : { status: "unknown", detail: failureDetail(error, redaction) };
  }

  try {
    const output = await connected.exec(piPathCheckSpec());
    if (output.code !== 0) return { status: "missing" };
    return inspectPiInstall(output.stdout) ? { status: "ready" } : { status: "missing" };
  } catch (error) {
    return isSandboxReplacedError(error)
      ? { status: "replaced" }
      : { status: "unknown", detail: failureDetail(error, redaction) };
  }
}

async function createWithPortRetry(
  creator: ReconcileContext["sandboxHost"],
  request: Omit<SandboxCreateRequest, "hostPort">,
  redaction: readonly string[],
): Promise<SandboxCreateHandleLike> {
  let portFailures = 0;
  let lastFailure: unknown = null;

  for (let attempt = 1; attempt <= MAX_CREATE_ATTEMPTS; attempt += 1) {
    let hostPort: number;
    try {
      hostPort = await creator.probePort();
    } catch {
      throw new SetupFailure("port_unavailable");
    }

    try {
      return await creator.create({ ...request, hostPort });
    } catch (error) {
      lastFailure = error;
      const existing = await creator.find(request.name).catch(() => null);
      if (existing) {
        // A managed sandbox appeared; the caller continues through its exact handle.
        return { id: existing.id, name: existing.name };
      }
      if (!isPortFailure(error)) {
        throw new SetupFailure("create_failed", failureDetail(error, redaction));
      }
      portFailures += 1;
    }
  }

  throw new SetupFailure(
    portFailures > 0 ? "port_unavailable" : "create_failed",
    failureDetail(lastFailure, redaction),
  );
}

const PORT_FAILURE = /\b(address already in use|eaddrinuse|bind|port)\b/i;

function isPortFailure(error: unknown): boolean {
  return error instanceof Error && PORT_FAILURE.test(error.message);
}

async function writePhase(
  handle: SandboxHandleLike,
  phase: Phase,
  token: LaneToken,
): Promise<boolean> {
  token.throwIfAborted();
  try {
    await markSandboxPhase(handle, phase);
    return true;
  } catch (error) {
    if (error instanceof SandboxGenerationError) throw new SetupFailure("id_mismatch");
    if (isSandboxReplacedError(error)) throw new SetupFailure("id_mismatch");
    // Phase is a progress hint; a failed write must not replay a side effect.
    return false;
  }
}

async function recordFailure(
  handle: SandboxHandleLike,
  phase: Phase,
  failure: SetupFailure,
): Promise<void> {
  const detail = failure.detail ?? null;
  try {
    await markSandboxError(handle, phase, failure.code, detail);
  } catch {
    // Error labels are a diagnostic hint. Never mask the original failure.
  }
}

function registrationOnlyForName(
  parentId: string,
  name: string,
  registrations: readonly HostRegistrationLike[],
): HostRegistrationLike[] {
  return pluginRegistrations(parentId, registrations).filter(
    (registration) => registration.metadata.name === name,
  );
}

async function removeStaleRegistrations(
  context: ReconcileContext,
  registrations: readonly HostRegistrationLike[],
): Promise<void> {
  const byKey = new Map<string, HostRegistrationLike[]>();
  for (const registration of registrations) {
    const key = registration.source?.key ?? "";
    byKey.set(key, [...(byKey.get(key) ?? []), registration]);
  }

  for (const group of byKey.values()) {
    if (group.length > 1) throw new SetupFailure("registration_conflict");
    await removeRegistration(context, group[0].registrationId).catch(() => {
      throw new SetupFailure("registration_failed");
    });
  }
}

/**
 * A different live generation under the same name proves the other plugin-owned
 * registration is stale. Only exact producer/parent/name rows are considered.
 */
async function removeStaleSameNameRegistrations(
  context: ReconcileContext,
  parentId: string,
  name: string,
  currentId: string,
): Promise<boolean> {
  const directory = await context.hosts.list().catch(() => {
    throw new SetupFailure("registrations_unavailable");
  });

  const stale = pluginRegistrations(parentId, directory.hosts).filter(
    (registration) =>
      registration.metadata.name === name && registration.source?.key !== currentId,
  );

  for (const registration of stale) {
    await removeRegistration(context, registration.registrationId).catch(() => {
      throw new SetupFailure("registration_failed");
    });
  }

  return stale.length > 0;
}

/**
 * Completes a tombstoned deletion for the exact generation. This is cleanup of
 * explicit user intent, never a new setup path or an adoption of a replacement.
 */
async function completeDeletion(
  context: ReconcileContext,
  parentId: string,
  handle: SandboxHandleLike,
  token: LaneToken,
): Promise<boolean> {
  token.throwIfAborted();

  let current: SandboxHandleLike;
  try {
    current = await handle.refresh();
  } catch {
    throw new SetupFailure("delete_failed");
  }
  if (current.id !== handle.id) throw new SetupFailure("id_mismatch");

  token.throwIfAborted();
  try {
    await context.sandboxHost.destroy(current);
  } catch {
    throw new SetupFailure("delete_failed");
  }

  return cleanupGeneration(context, parentId, handle.id);
}

/** Removes only the registration for this exact generation. */
async function cleanupGeneration(
  context: ReconcileContext,
  parentId: string,
  sandboxId: string,
): Promise<boolean> {
  const directory = await context.hosts.list().catch(() => {
    throw new SetupFailure("registrations_unavailable");
  });
  const matches = matchingRegistrations(parentId, sandboxId, directory.hosts);
  if (matches.length > 1) throw new SetupFailure("registration_conflict");

  const registration = matches[0];
  if (!registration) return false;

  await removeRegistration(context, registration.registrationId).catch(() => {
    throw new SetupFailure("registration_failed");
  });
  return true;
}


/** True when the recorded credential names are a compatible repeat. */
export function credentialNamesMatch(
  recorded: readonly CredentialName[],
  requested: readonly CredentialName[],
): boolean {
  if (recorded.length === 0) return true;
  if (recorded.length !== requested.length) return false;
  const expected = new Set(recorded);
  return requested.every((name) => expected.has(name));
}

export function knownCredentialNames(handle: SandboxHandleLike): CredentialName[] {
  return sandboxCredentialNames(handle);
}

export function mergeRedaction(
  base: readonly string[],
  handle: SandboxHandleLike,
): string[] {
  let persisted: string[] = [];
  try {
    persisted = persistedCredentialValues(handle.config());
  } catch {
    persisted = [];
  }
  return [...new Set([...base, ...persisted])].sort(
    (left, right) => right.length - left.length,
  );
}

function asSetupFailure(error: unknown): SetupFailure {
  if (error instanceof SetupFailure) return error;
  return new SetupFailure("runtime_unavailable", failureDetail(error));
}

function isSandboxDecodeError(
  error: unknown,
): error is { code: "invalid_config" | "id_mismatch" } {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "SandboxDecodeError"
  );
}

function timeoutMs(context: ReconcileContext): number {
  return context.installTimeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS;
}

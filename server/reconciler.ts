import {
  ERROR_LABEL,
  PHASE_LABEL,
  sandboxName,
  type Phase,
} from "../shared/constants";
import type { VmResources } from "../shared/contracts";
import {
  legacyPiPlan,
  paseoProviderIds,
  planMatchesCredentialNames,
  plansEqual,
  type CanonicalPlan,
} from "../shared/provisioning";

import { failureDetail, persistedCredentialValues } from "./diagnostics";
import { bounded, LifecycleAbortedError, type LaneToken, type LifecycleLanes } from "./lanes";
import { runMutation, type MutationRegistry } from "./mutations";
import { ensureProvisioned } from "./provision";
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
  isSandboxNotFoundError,
  isSandboxReplacedError,
  loadManagedSandboxes,
  markSandboxError,
  markSandboxPhase,
  ownershipOf,
  readSandboxHostPort,
  sandboxCredentialNames,
  SandboxGenerationError,
  SandboxMissingError,
  type DecodedSandbox,
  type SandboxCreateHandleLike,
  type SandboxCreateRequest,
  type SandboxHandleLike,
  type SandboxHost,
  type SandboxRuntime,
} from "./sandbox";
import type { ResolvedSecret } from "./secrets";
import type { SecretsStore } from "./secrets-store";
import type { HostDirectoryLike, HostRegistrationLike } from "./status";

const MAX_CREATE_ATTEMPTS = 3;
const DEFAULT_INSTALL_TIMEOUT_MS = 600_000;
/** Bound for one non-job SDK or parent call (lookup, connect, exec, create). */
const DEFAULT_SDK_CALL_TIMEOUT_MS = 60_000;

export interface ReconcileContext extends RegistrationContext {
  readonly hosts: RegistrationHostsLike;
  readonly runtime: SandboxRuntime;
  readonly sandboxHost: SandboxHost;
  /** Raw native mutation settlement, shared by every per-name lane. */
  readonly mutations: MutationRegistry;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly secretsStore: SecretsStore;
  /** Bounded wait for one detached Pi install; tests shorten it. */
  readonly installTimeoutMs?: number;
  /** Bounded wait for one non-job SDK call; tests shorten it. */
  readonly sdkCallTimeoutMs?: number;
  /** Settlement bound for native mutations; tests shorten it. */
  readonly mutationSettleMs?: number;
}

export interface ReconcileRequest {
  readonly name: string;
  /** Only a Create attempt may allocate an initial sandbox. */
  readonly allowCreate: boolean;
  /** Present for Create; absent for recovery and Repair. */
  readonly plan?: CanonicalPlan;
  /** Present for Create; absent for recovery and Repair. */
  readonly requestId?: string;
  /** Canonical desired resources of the Create request. */
  readonly resources?: VmResources;
  /** Whether the original Create supplied an explicit resource selection. */
  readonly resourcesSpecified?: boolean;
  /** Resolves selected values only when an initial create is needed. */
  readonly resolveCredentials?: () => readonly ResolvedSecret[];
  readonly redactionValues: readonly string[];
}

export interface ReconcileOutcome {
  readonly name: string;
  readonly phase: Phase;
  readonly registration: HostRegistrationLike | null;
  /** True when this operation advanced or cleaned up the child. */
  readonly repaired: boolean;
}

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

  // An unsettled native mutation blocks advancing or allocating this name.
  if (context.mutations.pending(request.name)) {
    throw new SetupFailure("mutation_pending");
  }

  const directory = await readDirectory(context, request.redactionValues, token);
  const parentId = directory.self.serverId;
  if (!parentId) throw new SetupFailure("runtime_unavailable");

  if (request.requestId) {
    // A request that already owns a generation is advanced through that exact
    // handle, even when a different sandbox occupies the requested name.
    const owned = await findOwnedGeneration(context, parentId, request, token);
    if (owned) {
      return advanceSandbox(
        context,
        { ...request, allowCreate: false },
        parentId,
        owned,
        token,
      );
    }
  }

  const handle = await findSandbox(context, request.name, request.redactionValues, token);

  if (!handle) return reconcileAbsent(context, request, parentId, token);

  return advanceSandbox(context, request, parentId, handle, token);
}

async function reconcileAbsent(
  context: ReconcileContext,
  request: ReconcileRequest,
  parentId: string,
  token: LaneToken,
): Promise<ReconcileOutcome> {
  token.throwIfAborted();

  const directory = await readDirectory(context, request.redactionValues, token);
  const registrations = registrationOnlyForName(request.name, directory.hosts);

  if (registrations.length > 0) {
    // A registration-only child means an earlier Delete is still settling.
    // Remove only generations that are proven gone.
    await removeStaleRegistrations(
      context,
      request.name,
      registrations,
      request.redactionValues,
      token,
    );

    // A generation created between the absence check and the cleanup wins:
    // advance it instead of allocating a second sandbox under the same name.
    const appeared = await findSandbox(
      context,
      request.name,
      request.redactionValues,
      token,
    );
    if (appeared) {
      return advanceSandbox(
        context,
        { ...request, allowCreate: false },
        parentId,
        appeared,
        token,
      );
    }

    if (!request.allowCreate) {
      return {
        name: request.name,
        phase: "registering",
        registration: null,
        repaired: true,
      };
    }
  } else if (!request.allowCreate) {
    throw new SetupFailure("not_found");
  }

  const plan = request.plan;
  if (!plan) throw new SetupFailure("invalid_request");

  const credentials = request.resolveCredentials?.() ?? [];
  if (credentials.length === 0) throw new SetupFailure("missing_credentials");

  const created = await createWithPortRetry(
    context,
    {
      name: request.name,
      parentId,
      plan,
      secrets: credentials,
      requestId: request.requestId,
      resources: request.resources,
      resourcesSpecified: request.resourcesSpecified ?? false,
    },
    request.redactionValues,
    token,
  );

  const handle = await findSandbox(
    context,
    request.name,
    request.redactionValues,
    token,
  );
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

  const redaction = mergeRedaction(request.redactionValues, handle);

  let decoded: DecodedSandbox | null;
  try {
    decoded = decodeManagedSandbox(handle, parentId, redaction);
  } catch (error) {
    throw new SetupFailure(isSandboxDecodeError(error) ? error.code : "invalid_config");
  }
  if (!decoded) throw new SetupFailure("name_conflict");

  assertNameOwnership(request, decoded);

  if (decoded.labels[PHASE_LABEL] === "deleting") {
    // Cleanup-only: never resume setup after a Delete tombstone. A reload that
    // observed the tombstone before destruction completes that exact deletion.
    const cleaned = await completeDeletion(context, handle, redaction, token);
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

  // A repeated attempt must keep the plan recorded for this generation. The
  // check runs here, once, before any side effect. Legacy children compare the
  // requested plan's credentials against the credentials they were created with.
  const plan = resolvePlanForSandbox(request, decoded, handle);
  const providers = paseoProviderIds(plan);

  let phase = decoded.labels[PHASE_LABEL];
  let changed = false;

  try {
    token.throwIfAborted();

    if (phase !== "ready") {
      phase = "installing";
      if (await writePhase(context, request.name, handle, phase, token)) changed = true;
      if (await ensureProvisioned(context, handle, plan, redaction, token)) changed = true;
    }

    token.throwIfAborted();

    if (phase !== "ready") {
      phase = "registering";
      if (await writePhase(context, request.name, handle, phase, token)) changed = true;
    }

    const hostPort = readSandboxHostPort(handle);
    if (hostPort === null) throw new SetupFailure("registration_failed");

    const ensured = await ensureRegistration(
      { ...context, signal: token.signal },
      { id: handle.id, name: handle.name },
      hostPort,
      providers,
    );
    if (ensured.changed) changed = true;

    if (
      await removeStaleSameNameRegistrations(context, request.name, handle.id, redaction, token)
    ) {
      changed = true;
    }

    if (phase !== "ready") {
      phase = "ready";
      if (await writePhase(context, request.name, handle, phase, token)) changed = true;
    }

    return {
      name: request.name,
      phase: "ready",
      registration: ensured.registration,
      repaired: changed,
    };
  } catch (error) {
    if (error instanceof LifecycleAbortedError) throw error;
    const failure = asSetupFailure(error, redaction);
    await recordFailure(context, request.name, handle, phase, failure, token);
    throw failure;
  }
}

function resolvePlanForSandbox(
  request: ReconcileRequest,
  decoded: DecodedSandbox,
  handle: SandboxHandleLike,
): CanonicalPlan {
  if (request.plan) {
    if (decoded.plan) {
      if (!plansEqual(request.plan, decoded.plan)) throw new SetupFailure("invalid_request");
      return decoded.plan;
    }
    // A legacy child has no persisted plan. A retry may only replay the plan
    // whose required credentials match what this generation already has.
    if (!planMatchesCredentialNames(request.plan, sandboxCredentialNames(handle))) {
      throw new SetupFailure("invalid_request");
    }
    return request.plan;
  }

  return decoded.plan ?? legacyPiPlan();
}

async function createWithPortRetry(
  context: ReconcileContext,
  request: Omit<SandboxCreateRequest, "hostPort">,
  redaction: readonly string[],
  token: LaneToken,
): Promise<SandboxCreateHandleLike> {
  const creator = context.sandboxHost;
  let portFailures = 0;
  let lastFailure: unknown = null;

  for (let attempt = 1; attempt <= MAX_CREATE_ATTEMPTS; attempt += 1) {
    token.throwIfAborted();

    let hostPort: number;
    try {
      hostPort = await bounded(creator.probePort(), {
        timeoutMs: sdkTimeoutMs(context),
        signal: token.signal,
      });
    } catch (error) {
      if (error instanceof LifecycleAbortedError) throw error;
      throw new SetupFailure("port_unavailable");
    }

    try {
      return await bounded(creator.create({ ...request, hostPort }), {
        timeoutMs: timeoutMs(context),
        signal: token.signal,
      });
    } catch (error) {
      if (error instanceof LifecycleAbortedError) throw error;
      lastFailure = error;
      const existing = await findSandbox(
        context,
        request.name,
        redaction,
        token,
      ).catch(() => null);
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
  context: ReconcileContext,
  name: string,
  handle: SandboxHandleLike,
  phase: Phase,
  token: LaneToken,
): Promise<boolean> {
  token.throwIfAborted();
  try {
    await runMutation(
      context.mutations,
      name,
      () => markSandboxPhase(handle, phase, { tracking: tracking(context, name) }),
      {
        timeoutMs: sdkTimeoutMs(context),
        signal: token.signal,
      },
      context.mutationSettleMs,
    );
    return true;
  } catch (error) {
    if (error instanceof LifecycleAbortedError) throw error;
    if (error instanceof SandboxGenerationError) throw new SetupFailure("id_mismatch");
    if (isSandboxReplacedError(error)) throw new SetupFailure("id_mismatch");
    // Phase is a progress hint; a failed write must not replay a side effect.
    return false;
  }
}

async function recordFailure(
  context: ReconcileContext,
  name: string,
  handle: SandboxHandleLike,
  phase: Phase,
  failure: SetupFailure,
  token: LaneToken,
): Promise<void> {
  const detail = failure.detail ?? null;
  try {
    await runMutation(
      context.mutations,
      name,
      () => markSandboxError(handle, phase, failure.code, detail, tracking(context, name)),
      {
        timeoutMs: sdkTimeoutMs(context),
        signal: token.signal,
      },
      context.mutationSettleMs,
    );
  } catch {
    // Error labels are a diagnostic hint. Never mask the original failure.
  }
}

function tracking(
  context: ReconcileContext,
  name: string,
): { mutations: MutationRegistry; name: string } {
  return { mutations: context.mutations, name };
}

/**
 * Derives cleanup candidates from the authoritative parent directory and the
 * authoritative runtime inventory. A registration is not a candidate when its
 * exact generation is present in inventory (decoded or undecodable); that row
 * is attached to its sandbox or retained for Repair.
 * Returns null when either source is unavailable, because missing proof must
 * never cause a registration removal.
 *
 * The read projection is deliberately not an input: an older registration
 * hidden behind a same-name live sandbox is still a candidate here.
 */
export async function collectStaleRegistrationNames(
  context: ReconcileContext,
): Promise<readonly string[] | null> {
  let directory: HostDirectoryLike;
  try {
    directory = await bounded(context.hosts.list(), {
      timeoutMs: sdkTimeoutMs(context),
    });
  } catch {
    return null;
  }

  const parentId = directory.self.serverId;
  if (!parentId) return null;

  const inventory = await loadManagedSandboxes(context.runtime, parentId);
  if (inventory.status !== "available") return null;

  const present = new Set<string>();
  for (const loaded of inventory.sandboxes) present.add(loaded.sandbox.id);
  // An undecodable generation is still present. It is retained for Repair
  // instead of being treated as proof of deletion.
  for (const failure of inventory.failures) present.add(failure.id);

  const names = new Set<string>();
  for (const registration of pluginRegistrations(directory.hosts)) {
    const key = registration.source?.key;
    if (typeof key === "string" && present.has(key)) continue;

    const name = registration.metadata.name;
    if (typeof name === "string" && name.length > 0) names.add(name);
  }

  return [...names];
}

function registrationOnlyForName(
  name: string,
  registrations: readonly HostRegistrationLike[],
): HostRegistrationLike[] {
  return pluginRegistrations(registrations).filter(
    (registration) => registration.metadata.name === name,
  );
}

/**
 * One bounded, conservative sweep for candidate names. Each name runs in its
 * lifecycle lane, re-reads the parent directory, and removes only a
 * registration whose exact generation lookup proves it gone or replaced. A
 * pending mutation, lookup failure, or duplicate row leaves the child for
 * Repair instead of guessing.
 */
export async function pruneRegistrationOnlyNames(
  context: ReconcileContext,
  names: readonly string[],
  lanes: LifecycleLanes,
): Promise<readonly string[]> {
  const removed: string[] = [];

  for (const name of [...new Set(names)].sort()) {
    try {
      const didRemove = await lanes.run(name, (token) =>
        pruneRegistrationOnlyName(context, name, token),
      );
      if (didRemove) removed.push(name);
    } catch (error) {
      // Lanes close permanently on plugin teardown: stop the whole sweep.
      if (error instanceof LifecycleAbortedError) break;
      // Ambiguous or unavailable state stays actionable in Repair.
    }
  }

  return removed;
}

async function pruneRegistrationOnlyName(
  context: ReconcileContext,
  name: string,
  token: LaneToken,
): Promise<boolean> {
  token.throwIfAborted();
  if (context.mutations.pending(name)) return false;

  const directory = await readDirectory(context, [], token);
  const registrations = registrationOnlyForName(name, directory.hosts);
  if (registrations.length === 0) return false;

  return removeStaleRegistrations(context, name, registrations, [], token);
}

/**
 * Removes registrations whose generation is proven gone. Absence observed
 * earlier is not proof: the runtime is re-read at removal time, and a live row
 * for the same generation is kept.
 */
async function removeStaleRegistrations(
  context: ReconcileContext,
  name: string,
  registrations: readonly HostRegistrationLike[],
  redaction: readonly string[],
  token: LaneToken,
): Promise<boolean> {
  const byKey = new Map<string, HostRegistrationLike[]>();
  for (const registration of registrations) {
    const key = registration.source?.key ?? "";
    byKey.set(key, [...(byKey.get(key) ?? []), registration]);
  }

  let removed = false;
  for (const group of byKey.values()) {
    if (group.length > 1) throw new SetupFailure("registration_conflict");
    if (await removeIfGenerationGone(context, name, group[0], redaction, token)) {
      removed = true;
    }
  }

  return removed;
}

/**
 * A different live generation under the same name proves the other plugin-owned
 * registration is stale. Only exact authenticated producer rows are considered.
 */
async function removeStaleSameNameRegistrations(
  context: ReconcileContext,
  name: string,
  currentId: string,
  redaction: readonly string[],
  token: LaneToken,
): Promise<boolean> {
  const directory = await readDirectory(context, redaction, token);

  const stale = pluginRegistrations(directory.hosts).filter(
    (registration) =>
      registration.metadata.name === name && registration.source?.key !== currentId,
  );

  let removed = false;
  for (const registration of stale) {
    if (await removeIfGenerationGone(context, name, registration, redaction, token)) removed = true;
  }

  return removed;
}

/**
 * Removes one registration only when a fresh exact lookup proves its
 * generation is absent or that a different generation replaced it.
 *
 * The pinned SDK has no conditional remove; this revalidation is the strongest
 * available guarantee against deleting a live replacement's registration.
 */
async function removeIfGenerationGone(
  context: ReconcileContext,
  name: string,
  registration: HostRegistrationLike,
  redaction: readonly string[],
  token: LaneToken,
): Promise<boolean> {
  const key = registration.source?.key ?? null;
  const handle = await findSandbox(context, name, redaction, token);
  if (handle && handle.id === key) return false;

  await removeRegistration(context, registration.registrationId).catch(() => {
    throw new SetupFailure("registration_failed");
  });
  return true;
}

/**
 * Completes a tombstoned deletion for the exact generation. This is cleanup of
 * explicit user intent, never a new setup path or an adoption of a replacement.
 */
async function completeDeletion(
  context: ReconcileContext,
  handle: SandboxHandleLike,
  redaction: readonly string[],
  token: LaneToken,
): Promise<boolean> {
  token.throwIfAborted();

  let current: SandboxHandleLike;
  try {
    current = await bounded(handle.refresh(), {
      timeoutMs: sdkTimeoutMs(context),
      signal: token.signal,
    });
  } catch (error) {
    if (error instanceof LifecycleAbortedError) throw error;
    // The tombstoned generation vanished before this reload reached it. The
    // user's intent is satisfied; only its exact registration remains to clear.
    if (error instanceof SandboxMissingError || isSandboxNotFoundError(error)) {
      return cleanupGeneration(context, handle.id, redaction, token);
    }
    throw new SetupFailure("delete_failed");
  }
  if (current.id !== handle.id) throw new SetupFailure("id_mismatch");

  token.throwIfAborted();
  try {
    await bounded(context.sandboxHost.destroy(current), {
      timeoutMs: sdkTimeoutMs(context),
      signal: token.signal,
    });
  } catch (error) {
    if (error instanceof LifecycleAbortedError) throw error;
    throw new SetupFailure("delete_failed");
  }

  return cleanupGeneration(context, handle.id, redaction, token);
}

/** Removes only the registration for this exact generation. */
async function cleanupGeneration(
  context: ReconcileContext,
  sandboxId: string,
  redaction: readonly string[],
  token: LaneToken,
): Promise<boolean> {
  const directory = await readDirectory(context, redaction, token);
  const matches = matchingRegistrations(sandboxId, directory.hosts);
  if (matches.length > 1) throw new SetupFailure("registration_conflict");

  const registration = matches[0];
  if (!registration) return false;

  await removeRegistration(context, registration.registrationId).catch(() => {
    throw new SetupFailure("registration_failed");
  });
  return true;
}

function mergeRedaction(
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

function asSetupFailure(error: unknown, redaction: readonly string[]): SetupFailure {
  if (error instanceof SetupFailure) return error;
  return new SetupFailure("runtime_unavailable", failureDetail(error, redaction));
}

/** Reads the parent directory under a bound and the lane's abort signal. */
async function readDirectory(
  context: ReconcileContext,
  redaction: readonly string[],
  token: LaneToken,
): Promise<HostDirectoryLike> {
  try {
    return await bounded(context.hosts.list(), {
      timeoutMs: sdkTimeoutMs(context),
      signal: token.signal,
    });
  } catch (error) {
    if (error instanceof LifecycleAbortedError) throw error;
    throw new SetupFailure("registrations_unavailable", failureDetail(error, redaction));
  }
}

/** Looks up the exact named sandbox under a bound and the lane's abort signal. */
async function findSandbox(
  context: ReconcileContext,
  name: string,
  redaction: readonly string[],
  token: LaneToken,
): Promise<SandboxHandleLike | null> {
  token.throwIfAborted();
  try {
    return await bounded(context.sandboxHost.find(name), {
      timeoutMs: sdkTimeoutMs(context),
      signal: token.signal,
    });
  } catch (error) {
    if (error instanceof LifecycleAbortedError) throw error;
    throw new SetupFailure("runtime_unavailable", failureDetail(error, redaction));
  }
}

/**
 * Scans managed inventory for the generation that carries this request marker.
 * An unavailable inventory is a safe failure: allocation must not proceed
 * without knowing whether this request already owns a VM. A malformed
 * generation cannot prove ownership and is left to the name lookup to report.
 */
async function findOwnedGeneration(
  context: ReconcileContext,
  parentId: string,
  request: ReconcileRequest,
  token: LaneToken,
): Promise<SandboxHandleLike | null> {
  token.throwIfAborted();

  let handles: readonly SandboxHandleLike[];
  try {
    handles = await bounded(context.runtime.list(parentId), {
      timeoutMs: sdkTimeoutMs(context),
      signal: token.signal,
    });
  } catch (error) {
    if (error instanceof LifecycleAbortedError) throw error;
    throw new SetupFailure("inventory_unavailable", failureDetail(error, request.redactionValues));
  }

  for (const handle of handles) {
    let decoded: DecodedSandbox | null;
    try {
      decoded = decodeManagedSandbox(handle, parentId, request.redactionValues);
    } catch {
      continue;
    }
    if (decoded?.requestId === request.requestId) return handle;
  }

  return null;
}

function resourcesEqual(left: VmResources, right: VmResources): boolean {
  return (
    left.cpus === right.cpus &&
    left.memoryMib === right.memoryMib &&
    left.diskMib === right.diskMib
  );
}

/**
 * A Create request may only advance a generation it owns. A live sandbox with
 * another request marker, or a markerless legacy sandbox under an explicitly
 * chosen name, is a name conflict and is never adopted. A markerless legacy
 * generation accepts only the generated name and an omitted resource selection.
 */
function assertNameOwnership(request: ReconcileRequest, decoded: DecodedSandbox): void {
  const requestId = request.requestId;
  if (!requestId) return;

  if (decoded.requestId !== null) {
    if (decoded.requestId !== requestId) {
      throw new SetupFailure("name_conflict");
    }

    const owned = `the request already owns ${decoded.id}`;
    if (decoded.name !== request.name) throw new SetupFailure("invalid_request", owned);
    if (!request.plan || !decoded.plan || !plansEqual(request.plan, decoded.plan)) {
      throw new SetupFailure("invalid_request", owned);
    }
    if (request.resourcesSpecified !== decoded.resourcesSpecified) {
      throw new SetupFailure("invalid_request", owned);
    }
    if (
      !request.resources ||
      !decoded.requestedResources ||
      !resourcesEqual(request.resources, decoded.requestedResources)
    ) {
      throw new SetupFailure("invalid_request", owned);
    }
    return;
  }

  if (request.name !== sandboxName(requestId)) {
    throw new SetupFailure("name_conflict");
  }
  if (request.resourcesSpecified) {
    throw new SetupFailure("invalid_request", "the legacy sandbox has no resource selection");
  }
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

function sdkTimeoutMs(context: ReconcileContext): number {
  return context.sdkCallTimeoutMs ?? DEFAULT_SDK_CALL_TIMEOUT_MS;
}

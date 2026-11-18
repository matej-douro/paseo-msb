import { RESOURCES_ENV_VAR } from "../shared/constants";
import type {
  ResizeOutcome,
  VmResizeInput,
  VmResizeResult,
  VmResources,
} from "../shared/contracts";
import { safeError } from "../shared/errors";
import { bounded, LifecycleAbortedError, type LaneToken } from "./lanes";
import { runMutation, type MutationRegistry } from "./mutations";
import type { RegistrationContext } from "./registration";
import {
  decodeManagedSandbox,
  guardedModify,
  isSandboxNotFoundError,
  isSandboxReplacedError,
  ownershipOf,
  readSandboxMaxMemoryMib,
  SandboxDecodeError,
  SandboxGenerationError,
  SandboxMissingError,
  type DecodedSandbox,
  type SandboxHandleLike,
  type SandboxHost,
  type SandboxModifyOptionsLike,
} from "./sandbox";
import type { HostDirectoryLike } from "./status";

const DEFAULT_RESIZE_TIMEOUT_MS = 60_000;

export interface ResizeContext extends RegistrationContext {
  readonly hosts: RegistrationContext["hosts"];
  readonly sandboxHost: SandboxHost;
  /** Raw native mutation settlement, shared with Create, Repair, and Delete. */
  readonly mutations: MutationRegistry;
  /** Redaction values for persisted diagnostic labels. */
  readonly redactionValues?: readonly string[];
  /** Bound for one resize parent/runtime call; tests shorten it. */
  readonly resizeTimeoutMs?: number;
  /** Settlement bound for native mutations; tests shorten it. */
  readonly mutationSettleMs?: number;
}

/**
 * `vm.resize` is the only resource mutation. It refreshes the exact generation,
 * enforces grow-only disk and known baselines, applies the verified SDK policy,
 * persists canonical desired resources, and reports the aggregate outcome.
 */
export async function resizeVm(
  context: ResizeContext,
  input: VmResizeInput,
  token: LaneToken,
): Promise<VmResizeResult> {
  if (input.memoryMib === undefined && input.diskMib === undefined) {
    throw new Error(safeError("invalid_request").message);
  }

  token.throwIfAborted();
  if (context.mutations.pending(input.name)) {
    throw new Error(safeError("mutation_pending").message);
  }

  const directory = await readDirectory(context, token);
  const parentId = directory.self.serverId;
  if (!parentId) throw new Error(safeError("runtime_unavailable").message);

  const handle = await findSandbox(context, input.name, token);
  if (!handle || handle.id !== input.id) {
    throw new Error(safeError("id_mismatch").message);
  }
  if (ownershipOf(handle, parentId) !== "owned") {
    throw new Error(safeError("id_mismatch").message);
  }

  const refreshed = await refreshExact(context, handle, token);
  if (!refreshed || refreshed.id !== input.id) {
    throw new Error(safeError("id_mismatch").message);
  }

  const decoded = decodeSandbox(refreshed, parentId, context.redactionValues ?? []);
  const observed = decoded.resources;
  const requested = decoded.requestedResources;
  const memoryTarget = input.memoryMib;
  const diskTarget = input.diskMib;

  // A null observation has no safe baseline. The plugin never guesses one.
  if (memoryTarget !== undefined && observed.memoryMib === null) {
    throw new Error(safeError("invalid_request").message);
  }
  if (diskTarget !== undefined) {
    if (observed.diskMib === null) throw new Error(safeError("invalid_request").message);
    if (diskTarget < observed.diskMib) throw new Error(safeError("invalid_request").message);
  }
  if (input.restart && refreshed.status !== "running") {
    throw new Error(safeError("invalid_request").message);
  }

  const memoryChanges = memoryTarget !== undefined && memoryTarget !== observed.memoryMib;
  const diskChanges = diskTarget !== undefined && diskTarget !== observed.diskMib;
  // A target that matches the observation but not the persisted desired value
  // only clears the pending desired value; resources stay as they are.
  const memoryStale =
    memoryTarget !== undefined && requested.memoryMib !== memoryTarget;
  const diskStale =
    diskTarget !== undefined && requested.diskMib !== diskTarget;
  const restart = input.restart === true;

  if (!memoryChanges && !diskChanges && !memoryStale && !diskStale) {
    return result(input, "unchanged", observed, requested);
  }

  const desired = desiredResources(observed, memoryTarget, diskTarget);

  // An unreported memory cap gives no safe live-growth bound. Preflight before
  // modify() and never include maxMemory in a modify call.
  const maxMemory = readSandboxMaxMemoryMib(refreshed);
  const growthAboveCap =
    memoryChanges &&
    memoryTarget !== undefined &&
    (maxMemory === null || memoryTarget > maxMemory);
  if (growthAboveCap && !restart) {
    return result(input, "restart_required", observed, requested);
  }

  const options: SandboxModifyOptionsLike = {
    ...(memoryChanges ? { memory: memoryTarget } : {}),
    ...(diskChanges ? { rootDiskSize: diskTarget } : {}),
    policy: restart ? "restart" : "no_restart",
    // A restart call can persist the desired value atomically. A no_restart
    // call cannot: the runtime rejects env changes without a restart. When an
    // untargeted observation is unreported there is no complete desired value
    // to record, so the env write is skipped rather than persisting `null`.
    ...(restart && desired
      ? { env: { [RESOURCES_ENV_VAR]: JSON.stringify(desired) } }
      : {}),
  };

  let plan: unknown = null;
  if (memoryChanges || diskChanges) {
    try {
      plan = await runMutation(
        context.mutations,
        input.name,
        () => guardedModify(refreshed, options, tracking(context, input.name)),
        { timeoutMs: resizeTimeoutMs(context), signal: token.signal },
        context.mutationSettleMs,
      );
    } catch (error) {
      return await handleMutationFailure(context, input, error, parentId, observed, requested, token);
    }
  }

  // Persist the desired value for a no_restart change or a clear-only request.
  if (desired && !restart && (memoryChanges || diskChanges || memoryStale || diskStale)) {
    try {
      await runMutation(
        context.mutations,
        input.name,
        () =>
          guardedModify(
            refreshed,
            {
              env: { [RESOURCES_ENV_VAR]: JSON.stringify(desired) },
              policy: "next_start",
            },
            tracking(context, input.name),
          ),
        { timeoutMs: resizeTimeoutMs(context), signal: token.signal },
        context.mutationSettleMs,
      );
    } catch (error) {
      return await handleMutationFailure(context, input, error, parentId, observed, requested, token);
    }
  }

  let verified: DecodedSandbox;
  try {
    const after = await refreshExact(context, refreshed, token);
    if (!after) throw new Error(safeError("id_mismatch").message);
    verified = decodeSandbox(after, parentId, context.redactionValues ?? []);
  } catch (error) {
    if (error instanceof Error && error.message === safeError("id_mismatch").message) throw error;
    return result(input, "resize_failed", observed, requested);
  }

  const confirmed =
    (memoryTarget === undefined || verified.resources.memoryMib === memoryTarget) &&
    (diskTarget === undefined || verified.resources.diskMib === diskTarget);

  return result(
    input,
    outcomeFor(plan, restart, confirmed),
    verified.resources,
    verified.requestedResources,
  );
}

function result(
  input: VmResizeInput,
  outcome: ResizeOutcome,
  observed: { readonly cpus: number; readonly memoryMib: number | null; readonly diskMib: number | null },
  requested: VmResources,
): VmResizeResult {
  const pending =
    requested.cpus !== observed.cpus ||
    requested.memoryMib !== observed.memoryMib ||
    requested.diskMib !== observed.diskMib
      ? requested
      : null;

  return {
    name: input.name,
    id: input.id,
    result: outcome,
    resources: { cpus: observed.cpus, memoryMib: observed.memoryMib, diskMib: observed.diskMib },
    requestedResources: pending,
  };
}

async function handleMutationFailure(
  context: ResizeContext,
  input: VmResizeInput,
  error: unknown,
  parentId: string,
  observed: DecodedSandbox["resources"],
  requested: VmResources,
  token: LaneToken,
): Promise<VmResizeResult> {
  if (error instanceof LifecycleAbortedError) throw error;
  // An unsettled native call is an RPC-level retry, not a resize outcome.
  if (context.mutations.pending(input.name)) {
    throw new Error(safeError("mutation_pending").message);
  }
  if (
    error instanceof SandboxMissingError ||
    error instanceof SandboxGenerationError ||
    isSandboxReplacedError(error)
  ) {
    throw new Error(safeError("id_mismatch").message);
  }

  // A settled apply failure leaves the previous resources visible. Re-read once
  // so the response is not a stale guess, but never surface raw SDK text.
  let current: DecodedSandbox | null = null;
  try {
    const handle = await findSandbox(context, input.name, token);
    if (handle && handle.id === input.id) {
      current = decodeSandbox(handle, parentId, context.redactionValues ?? []);
    }
  } catch {
    current = null;
  }
  return result(input, "resize_failed", current?.resources ?? observed, current?.requestedResources ?? requested);
}

/** Maps SDK plan signals and the confirmed config to the DESIGN §7.2 outcome. */
function outcomeFor(plan: unknown, restart: boolean, confirmed: boolean): ResizeOutcome {
  const signals = planSignals(plan);

  if (signals.failed) return "resize_failed";
  if (restart && (signals.restartRequired || signals.guestRefused || !confirmed)) {
    return "resize_failed";
  }
  if (!restart && (signals.restartRequired || signals.guestRefused)) {
    return "restart_required";
  }
  if (signals.converging || !confirmed) return "converging";
  return "applied";
}

interface PlanSignals {
  readonly failed: boolean;
  readonly restartRequired: boolean;
  readonly guestRefused: boolean;
  readonly converging: boolean;
}

function planSignals(value: unknown): PlanSignals {
  const plan = asRecord(value);
  if (!plan) {
    return { failed: false, restartRequired: false, guestRefused: false, converging: false };
  }

  let failed = Array.isArray(plan.conflicts) && plan.conflicts.length > 0;
  let restartRequired = false;
  let guestRefused = false;
  let converging = false;

  for (const change of asArray(plan.changes)) {
    const disposition = asRecord(change)?.disposition;
    if (disposition === "requires restart") restartRequired = true;
    else if (disposition === "unsupported") failed = true;
    else if (disposition === "next start") converging = true;
  }

  for (const status of asArray(plan.resizeStatus)) {
    const state = asRecord(status)?.state;
    if (state === "failed") failed = true;
    else if (state === "guest-refused") guestRefused = true;
    else if (state === "accepted" || state === "converging") converging = true;
  }

  return { failed, restartRequired, guestRefused, converging };
}

function desiredResources(
  observed: DecodedSandbox["resources"],
  memoryTarget: number | undefined,
  diskTarget: number | undefined,
): VmResources | null {
  const memoryMib = memoryTarget ?? observed.memoryMib;
  const diskMib = diskTarget ?? observed.diskMib;
  if (memoryMib === null || diskMib === null) return null;
  return { cpus: observed.cpus, memoryMib, diskMib };
}

function decodeSandbox(
  handle: SandboxHandleLike,
  parentId: string,
  redaction: readonly string[],
): DecodedSandbox {
  let decoded: DecodedSandbox | null;
  try {
    decoded = decodeManagedSandbox(handle, parentId, redaction);
  } catch (error) {
    if (error instanceof SandboxDecodeError) throw new Error(safeError(error.code).message);
    throw new Error(safeError("invalid_config").message);
  }
  if (!decoded) throw new Error(safeError("id_mismatch").message);
  return decoded;
}

async function readDirectory(
  context: ResizeContext,
  token: LaneToken,
): Promise<HostDirectoryLike> {
  try {
    return await bounded(context.hosts.list(), {
      timeoutMs: resizeTimeoutMs(context),
      signal: token.signal,
    });
  } catch (error) {
    if (error instanceof LifecycleAbortedError) throw error;
    throw new Error(safeError("registrations_unavailable").message);
  }
}

async function findSandbox(
  context: ResizeContext,
  name: string,
  token: LaneToken,
): Promise<SandboxHandleLike | null> {
  try {
    return await bounded(context.sandboxHost.find(name), {
      timeoutMs: resizeTimeoutMs(context),
      signal: token.signal,
    });
  } catch (error) {
    if (error instanceof LifecycleAbortedError) throw error;
    throw new Error(safeError("runtime_unavailable").message);
  }
}

async function refreshExact(
  context: ResizeContext,
  handle: SandboxHandleLike,
  token: LaneToken,
): Promise<SandboxHandleLike | null> {
  try {
    const current = await bounded(handle.refresh(), {
      timeoutMs: resizeTimeoutMs(context),
      signal: token.signal,
    });
    if (current.id !== handle.id) throw new SandboxGenerationError("id_mismatch");
    return current;
  } catch (error) {
    if (error instanceof LifecycleAbortedError) throw error;
    if (error instanceof SandboxMissingError || isSandboxNotFoundError(error)) return null;
    if (error instanceof SandboxGenerationError || isSandboxReplacedError(error)) {
      throw new Error(safeError("id_mismatch").message);
    }
    throw new Error(safeError("runtime_unavailable").message);
  }
}

function tracking(context: ResizeContext, name: string) {
  return { mutations: context.mutations, name };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function resizeTimeoutMs(context: ResizeContext): number {
  return context.resizeTimeoutMs ?? DEFAULT_RESIZE_TIMEOUT_MS;
}

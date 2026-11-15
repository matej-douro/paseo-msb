import type { VmDeleteInput, VmDeleteResult } from "../shared/contracts";
import { safeError } from "../shared/errors";
import { bounded, LifecycleAbortedError, type LaneToken } from "./lanes";
import { runMutation, type MutationRegistry } from "./mutations";
import {
  matchingRegistrations,
  removeRegistration,
  type RegistrationContext,
} from "./registration";
import {
  isIncompleteSandboxError,
  isSandboxNotFoundError,
  isSandboxReplacedError,
  markSandboxPhase,
  ownershipOf,
  SandboxGenerationError,
  SandboxMissingError,
  type SandboxHandleLike,
  type SandboxHost,
} from "./sandbox";

/** Bound for one Delete parent/runtime call. */
const DEFAULT_DELETE_TIMEOUT_MS = 60_000;

function deleteTimeout(context: DeleteContext): number {
  return context.deleteTimeoutMs ?? DEFAULT_DELETE_TIMEOUT_MS;
}

export interface DeleteContext extends RegistrationContext {
  readonly hosts: RegistrationContext["hosts"];
  readonly sandboxHost: SandboxHost;
  /** Raw native mutation settlement, shared with Create and Repair. */
  readonly mutations: MutationRegistry;
  /** Bound for one Delete parent/runtime call; tests shorten it. */
  readonly deleteTimeoutMs?: number;
  /** Settlement bound for native mutations; tests shorten it. */
  readonly mutationSettleMs?: number;
}

/**
 * `vm.delete` runs in the same per-name lane as Create/Repair. It persists a
 * `deleting` tombstone before destruction, uses the exact generation handle, and
 * removes only the `(producer, id)` registration. Missing resources are success.
 *
 * Every parent/runtime call is bounded and carries the lane's abort signal, so
 * Delete can never stall plugin teardown or a queued same-name operation.
 */
export async function deleteVm(
  context: DeleteContext,
  input: VmDeleteInput,
  token: LaneToken,
): Promise<VmDeleteResult> {
  if (input.confirmName !== input.name) {
    throw new Error(safeError("invalid_request").message);
  }

  token.throwIfAborted();

  // The lane runner aborts the logical resize before Delete starts. An
  // unsettled native mutation still blocks tombstoning and destruction.
  if (context.mutations.pending(input.name)) {
    throw new Error(safeError("mutation_pending").message);
  }

  // Registrations must be readable before anything is destroyed, so an
  // unavailable daemon never leaves an unmanaged running VM behind.
  const directory = await listDirectory(context, token);
  const parentId = directory.self.serverId;

  const handle = await findSandbox(context, input.name, token);

  if (!handle) {
    await removeRegistrationWithoutSandbox(context, input, token);
    return { name: input.name, removed: true };
  }

  if (handle.id !== input.id) throw new Error(safeError("id_mismatch").message);

  const ownership = ownershipOf(handle, parentId);
  if (ownership === "quarantine") throw new Error(safeError("id_mismatch").message);
  if (ownership !== "owned") throw new Error(safeError("invalid_config").message);

  token.throwIfAborted();

  // Tombstone first. A generation that vanished is already deleted. The SDK's
  // specific interrupted-create state cannot be refreshed or labelled, but its
  // exact handle is still generation-checked and safe to destroy.
  let vanished = false;
  let incomplete = false;
  try {
    await runMutation(
      context.mutations,
      input.name,
      () =>
        markSandboxPhase(handle, "deleting", {
          tracking: { mutations: context.mutations, name: input.name },
        }),
      { timeoutMs: deleteTimeout(context), signal: token.signal },
      context.mutationSettleMs,
    );
  } catch (error) {
    if (error instanceof LifecycleAbortedError) throw error;
    // A bounded timeout is not settlement: the native write may still apply.
    if (context.mutations.pending(input.name)) {
      throw new Error(safeError("mutation_pending").message);
    }
    if (isIncompleteSandboxError(error)) {
      incomplete = true;
    } else if (error instanceof SandboxMissingError || isSandboxNotFoundError(error)) {
      vanished = true;
    } else {
      throw new Error(safeError("delete_failed").message);
    }
  }

  if (!vanished && context.mutations.pending(input.name)) {
    throw new Error(safeError("mutation_pending").message);
  }

  if (!vanished) {
    // Re-read after a successful tombstone: `modify()` can hit a replacement.
    // Incomplete creation cannot be refreshed; destroy() still rejects a stale
    // handle, so a replacement remains protected in that path as well.
    const current = incomplete ? handle : await refreshExact(context, handle, token);
    token.throwIfAborted();

    if (current) {
      try {
        await bounded(context.sandboxHost.destroy(current), {
          timeoutMs: deleteTimeout(context),
          signal: token.signal,
        });
      } catch (error) {
        if (error instanceof LifecycleAbortedError) throw error;
        throw new Error(safeError("delete_failed").message);
      }
    }
  }

  // After destruction, remove only this generation's registration. A failure
  // leaves a visible registration-only child for Repair/Delete.
  const after = await listDirectory(context, token);
  const matches = matchingRegistrations(input.id, after.hosts);
  if (matches.length > 1) {
    throw new Error(safeError("registration_conflict").message);
  }

  for (const registration of matches) {
    try {
      await removeRegistration(context, registration.registrationId);
    } catch {
      throw new Error(safeError("registration_failed").message);
    }
  }

  return { name: input.name, removed: true };
}

async function removeRegistrationWithoutSandbox(
  context: DeleteContext,
  input: VmDeleteInput,
  token: LaneToken,
): Promise<void> {
  const directory = await listDirectory(context, token);

  const matches = matchingRegistrations(input.id, directory.hosts).filter(
    (registration) => registration.metadata.name === input.name,
  );

  if (matches.length > 1) {
    throw new Error(safeError("registration_conflict").message);
  }

  for (const registration of matches) {
    try {
      await removeRegistration(context, registration.registrationId);
    } catch {
      throw new Error(safeError("registration_failed").message);
    }
  }
}

async function listDirectory(context: DeleteContext, token: LaneToken) {
  try {
    return await bounded(context.hosts.list(), {
      timeoutMs: deleteTimeout(context),
      signal: token.signal,
    });
  } catch (error) {
    if (error instanceof LifecycleAbortedError) throw error;
    throw new Error(safeError("registrations_unavailable").message);
  }
}

async function findSandbox(
  context: DeleteContext,
  name: string,
  token: LaneToken,
): Promise<SandboxHandleLike | null> {
  try {
    return await bounded(context.sandboxHost.find(name), {
      timeoutMs: deleteTimeout(context),
      signal: token.signal,
    });
  } catch (error) {
    if (error instanceof LifecycleAbortedError) throw error;
    throw new Error(safeError("runtime_unavailable").message);
  }
}


async function refreshExact(
  context: DeleteContext,
  handle: SandboxHandleLike,
  token: LaneToken,
): Promise<SandboxHandleLike | null> {
  try {
    const current = await bounded(handle.refresh(), {
      timeoutMs: deleteTimeout(context),
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
    throw new Error(safeError("delete_failed").message);
  }
}

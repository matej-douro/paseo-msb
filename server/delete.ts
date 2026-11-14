import type { VmDeleteInput, VmDeleteResult } from "../shared/contracts";
import { safeError } from "../shared/errors";
import { bounded, LifecycleAbortedError, type LaneToken } from "./lanes";
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

/** Bound for one parent/runtime call made by Delete. */
const DELETE_CALL_TIMEOUT_MS = 60_000;

export interface DeleteContext extends RegistrationContext {
  readonly hosts: RegistrationContext["hosts"];
  readonly sandboxHost: SandboxHost;
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
    await bounded(markSandboxPhase(handle, "deleting"), {
      timeoutMs: DELETE_CALL_TIMEOUT_MS,
      signal: token.signal,
    });
  } catch (error) {
    if (error instanceof LifecycleAbortedError) throw error;
    if (isIncompleteSandboxError(error)) {
      incomplete = true;
    } else if (error instanceof SandboxMissingError || isSandboxNotFoundError(error)) {
      vanished = true;
    } else {
      throw new Error(safeError("delete_failed").message);
    }
  }

  if (!vanished) {
    // Re-read after a successful tombstone: `modify()` can hit a replacement.
    // Incomplete creation cannot be refreshed; destroy() still rejects a stale
    // handle, so a replacement remains protected in that path as well.
    const current = incomplete ? handle : await refreshExact(handle, token);
    token.throwIfAborted();

    if (current) {
      try {
        await bounded(context.sandboxHost.destroy(current), {
          timeoutMs: DELETE_CALL_TIMEOUT_MS,
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
      timeoutMs: DELETE_CALL_TIMEOUT_MS,
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
      timeoutMs: DELETE_CALL_TIMEOUT_MS,
      signal: token.signal,
    });
  } catch (error) {
    if (error instanceof LifecycleAbortedError) throw error;
    throw new Error(safeError("runtime_unavailable").message);
  }
}


async function refreshExact(
  handle: SandboxHandleLike,
  token: LaneToken,
): Promise<SandboxHandleLike | null> {
  try {
    const current = await bounded(handle.refresh(), {
      timeoutMs: DELETE_CALL_TIMEOUT_MS,
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

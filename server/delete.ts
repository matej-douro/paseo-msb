import type { VmDeleteInput, VmDeleteResult } from "../shared/contracts";
import { safeError } from "../shared/errors";
import type { LaneToken } from "./lanes";
import {
  matchingRegistrations,
  removeRegistration,
  type RegistrationContext,
} from "./registration";
import {
  decodeManagedSandbox,
  isSandboxReplacedError,
  markSandboxPhase,
  ownershipOf,
  SandboxGenerationError,
  type SandboxHandleLike,
  type SandboxHost,
} from "./sandbox";

export interface DeleteContext extends RegistrationContext {
  readonly hosts: RegistrationContext["hosts"];
  readonly sandboxHost: SandboxHost;
}

/**
 * `vm.delete` runs in the same per-name lane as Create/Repair. It persists a
 * `deleting` tombstone before destruction, uses the exact generation handle, and
 * removes only the `(producer, id)` registration. Missing resources are success.
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
  const directory = await context.hosts.list().catch(() => {
    throw new Error(safeError("registrations_unavailable").message);
  });
  const parentId = directory.self.serverId;

  const handle = await context.sandboxHost.find(input.name).catch(() => {
    throw new Error(safeError("runtime_unavailable").message);
  });

  if (!handle) {
    await removeRegistrationWithoutSandbox(context, parentId, input);
    return { name: input.name, removed: true };
  }

  if (handle.id !== input.id) throw new Error(safeError("id_mismatch").message);

  const ownership = ownershipOf(handle, parentId);
  if (ownership === "quarantine") throw new Error(safeError("id_mismatch").message);
  if (ownership !== "owned") throw new Error(safeError("invalid_config").message);

  try {
    const decoded = decodeManagedSandbox(handle, parentId);
    if (!decoded) throw new Error(safeError("invalid_config").message);
  } catch {
    throw new Error(safeError("invalid_config").message);
  }

  token.throwIfAborted();

  // Tombstone first. If this cannot be written, the VM is not destroyed.
  try {
    await markSandboxPhase(handle, "deleting");
  } catch {
    throw new Error(safeError("delete_failed").message);
  }

  // Re-read the exact generation after the tombstone write. The SDK's
  // `modify()` can hit a replacement, so never destroy without this check.
  const current = await refreshExact(handle);
  token.throwIfAborted();

  try {
    await context.sandboxHost.destroy(current);
  } catch {
    throw new Error(safeError("delete_failed").message);
  }

  // After destruction, remove only this generation's registration. A failure
  // leaves a visible registration-only child for Repair/Delete.
  const after = await context.hosts.list().catch(() => {
    throw new Error(safeError("registration_failed").message);
  });
  const matches = matchingRegistrations(parentId, input.id, after.hosts);
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
  parentId: string,
  input: VmDeleteInput,
): Promise<void> {
  const directory = await context.hosts.list().catch(() => {
    throw new Error(safeError("registrations_unavailable").message);
  });

  const matches = matchingRegistrations(parentId, input.id, directory.hosts).filter(
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

async function refreshExact(handle: SandboxHandleLike): Promise<SandboxHandleLike> {
  try {
    const current = await handle.refresh();
    if (current.id !== handle.id) throw new SandboxGenerationError("id_mismatch");
    return current;
  } catch (error) {
    if (error instanceof SandboxGenerationError || isSandboxReplacedError(error)) {
      throw new Error(safeError("id_mismatch").message);
    }
    throw new Error(safeError("delete_failed").message);
  }
}

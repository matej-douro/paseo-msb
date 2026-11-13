import type { VmDeleteInput, VmDeleteResult } from "../shared/contracts";
import { safeError } from "../shared/errors";
import {
  matchingRegistrations,
  removeRegistration,
  type RegistrationContext,
} from "./registration";
import { ownsSandbox, type SandboxHost } from "./sandbox";

export interface DeleteContext extends RegistrationContext {
  readonly sandboxHost: SandboxHost;
}

/**
 * `vm.delete`: requires the exact name and stable ID, destroys that sandbox
 * through its stable handle, then removes its registrations. Already-missing
 * resources are success; a failure after destruction leaves the stale
 * registration for Repair.
 */
export async function deleteVm(
  context: DeleteContext,
  input: VmDeleteInput,
): Promise<VmDeleteResult> {
  if (input.confirmName !== input.name) {
    throw new Error(safeError("invalid_request").message);
  }

  // Registrations must be readable before anything is destroyed, so an
  // unavailable daemon never leaves an unmanaged running VM behind.
  const directory = await context.hosts.list().catch(() => {
    throw new Error(safeError("registrations_unavailable").message);
  });
  const parentId = directory.self.serverId;

  const handle = await context.sandboxHost.find(input.name).catch(() => {
    throw new Error(safeError("runtime_unavailable").message);
  });

  if (handle) {
    if (handle.id !== input.id) throw new Error(safeError("id_mismatch").message);
    if (!ownsSandbox(handle, parentId)) {
      throw new Error(safeError("invalid_config").message);
    }
  }

  const registrationIds = matchingRegistrations(
    parentId,
    input.id,
    directory.hosts,
  ).map((registration) => registration.registrationId);

  if (handle) {
    await context.sandboxHost.destroy(handle).catch(() => {
      throw new Error(safeError("delete_failed").message);
    });
  }

  for (const registrationId of registrationIds) {
    await removeRegistration(context, registrationId).catch(() => {
      throw new Error(safeError("registration_failed").message);
    });
  }

  return { name: input.name, removed: true };
}

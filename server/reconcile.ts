import { ERROR_LABEL, PHASE_LABEL } from "../shared/constants";
import type { VmReconcileInput, VmReconcileResult } from "../shared/contracts";
import { safeError, type SafeError, type SafeErrorCode } from "../shared/errors";
import { finishInstall, registerLoaded, type RecoveryContext } from "./recovery";
import {
  matchingRegistrations,
  removeRegistration,
  SetupFailure,
  staleRegistrations,
} from "./registration";
import { loadManagedSandboxes, ownsSandbox, type LoadedSandbox } from "./sandbox";
import type { HostRegistrationLike } from "./status";

export type ReconcileContext = RecoveryContext;

/**
 * `vm.reconcile`: resumes valid setup, restores missing registrations, and
 * removes confirmed stale registrations. It never creates, starts, adopts, or
 * deletes a sandbox and refuses ambiguous, foreign, or failed-install state.
 */
export async function reconcileVm(
  context: ReconcileContext,
  input: VmReconcileInput,
): Promise<VmReconcileResult> {
  const directory = await context.hosts.list().catch(() => {
    throw new Error(safeError("registrations_unavailable").message);
  });
  const parentId = directory.self.serverId;

  const inventory = await loadManagedSandboxes(context.runtime, parentId);
  if (inventory.status !== "available") {
    throw new Error(safeError("inventory_unavailable").message);
  }

  const repaired = new Set<string>();
  const errors: { name: string; error: SafeError }[] = [];

  const targets = input.name
    ? inventory.sandboxes.filter((loaded) => loaded.sandbox.name === input.name)
    : inventory.sandboxes;

  for (const loaded of targets) {
    try {
      const changed = await repairSandbox(context, parentId, directory.hosts, loaded);
      if (changed) repaired.add(loaded.sandbox.name);
    } catch (error) {
      errors.push({ name: loaded.sandbox.name, error: safeError(errorCode(error)) });
    }
  }

  const liveSandboxIds = new Set(inventory.sandboxes.map((loaded) => loaded.sandbox.id));
  const stale = staleRegistrations(parentId, liveSandboxIds, directory.hosts).filter(
    (registration) => !input.name || registration.metadata.name === input.name,
  );

  for (const registration of stale) {
    const name = registration.metadata.name || registration.registrationId;
    try {
      await removeRegistration(context, registration.registrationId);
      repaired.add(name);
    } catch (error) {
      errors.push({ name, error: safeError(errorCode(error)) });
    }
  }

  if (input.name && targets.length === 0 && stale.length === 0) {
    errors.push({ name: input.name, error: safeError("not_found") });
  }

  return { repaired: [...repaired].sort(), errors };
}

async function repairSandbox(
  context: ReconcileContext,
  parentId: string,
  registrations: readonly HostRegistrationLike[],
  loaded: LoadedSandbox,
): Promise<boolean> {
  const { sandbox, handle } = loaded;

  if (!ownsSandbox(handle, parentId)) throw new SetupFailure("id_mismatch");

  const matches = matchingRegistrations(parentId, sandbox.id, registrations);
  if (matches.length > 1) throw new SetupFailure("registration_conflict");

  switch (sandbox.labels[PHASE_LABEL]) {
    case "installing":
      await finishInstall(context, loaded);
      await registerLoaded(context, parentId, loaded);
      return true;

    case "registering":
      await registerLoaded(context, parentId, loaded);
      return true;

    case "ready":
      if (matches.length === 0) {
        await registerLoaded(context, parentId, loaded);
        return true;
      }
      return false;

    case "failed":
      throw new SetupFailure(sandbox.labels[ERROR_LABEL] ?? "invalid_config");

    default:
      throw new SetupFailure("create_failed");
  }
}

function errorCode(error: unknown): SafeErrorCode {
  return error instanceof SetupFailure ? error.code : "registration_failed";
}

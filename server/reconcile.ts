import type { VmReconcileInput, VmReconcileResult } from "../shared/contracts";
import { safeError, type SafeError } from "../shared/errors";
import { credentialValues } from "./logs";
import { LifecycleAbortedError, type LifecycleLanes, type LaneToken } from "./lanes";
import { reconcileName, type ReconcileContext } from "./reconciler";
import { pluginRegistrations, SetupFailure } from "./registration";
import {
  loadManagedSandboxes,
  type SandboxDecodeFailure,
} from "./sandbox";
import type { SecretsStore } from "./secrets-store";

export interface ReconcileVmContext extends ReconcileContext {
  readonly lanes: LifecycleLanes;
  readonly secretsStore: SecretsStore;
}

/**
 * `vm.reconcile` is the single Repair mutation. It resumes unambiguous setup,
 * restores missing registrations, and removes confirmed stale plugin-owned
 * registrations. It never creates, starts, adopts, or deletes a sandbox.
 */
export async function reconcileVm(
  context: ReconcileVmContext,
  input: VmReconcileInput,
): Promise<VmReconcileResult> {
  const directory = await context.hosts.list().catch(() => {
    throw new Error(safeError("registrations_unavailable").message);
  });
  const parentId = directory.self.serverId;
  if (!parentId) throw new Error(safeError("runtime_unavailable").message);

  const stored = await context.secretsStore.read();
  const redactionValues = credentialValues(
    context.env,
    stored.status === "ok" ? stored.values : new Map(),
  );

  const inventory = await loadManagedSandboxes(
    context.runtime,
    parentId,
    redactionValues,
  );
  if (inventory.status !== "available") {
    throw new Error(safeError("inventory_unavailable").message);
  }

  const repaired = new Set<string>();
  const errors: { name: string; error: SafeError }[] = [];

  const targets = new Set<string>();
  if (input.name) {
    targets.add(input.name);
  } else {
    for (const loaded of inventory.sandboxes) targets.add(loaded.sandbox.name);
    for (const registration of pluginRegistrations(parentId, directory.hosts)) {
      const name = registration.metadata.name;
      if (typeof name === "string" && name.length > 0) targets.add(name);
    }
  }

  const decodeFailures = new Map<string, SandboxDecodeFailure>();
  for (const failure of inventory.failures) {
    decodeFailures.set(failure.name, failure);
    if (!input.name || input.name === failure.name) {
      errors.push({ name: failure.name, error: safeError(failure.code) });
    }
  }

  for (const name of targets) {
    if (decodeFailures.has(name)) continue;

    try {
      const outcome = await context.lanes.run(name, (token: LaneToken) =>
        reconcileName(
          { ...context, signal: token.signal },
          { name, allowCreate: false, redactionValues },
          token,
        ),
      );
      if (outcome.repaired) repaired.add(name);
    } catch (error) {
      if (error instanceof LifecycleAbortedError) continue;
      errors.push({ name, error: toSafeError(error) });
    }
  }

  return { repaired: [...repaired].sort(), errors };
}

function toSafeError(error: unknown): SafeError {
  if (error instanceof SetupFailure) {
    return safeError(error.code, error.detail ?? null);
  }
  return safeError("registration_failed");
}

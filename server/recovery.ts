import { credentialValues } from "./logs";
import { LifecycleAbortedError, type LifecycleLanes } from "./lanes";
import {
  reconcileName,
  type ReconcileContext,
} from "./reconciler";
import { pluginRegistrations } from "./registration";
import { loadManagedSandboxes } from "./sandbox";
import type { SecretsStore } from "./secrets-store";

export interface RecoveryContext extends ReconcileContext {
  readonly lanes: LifecycleLanes;
  readonly secretsStore: SecretsStore;
}

/**
 * Runs once on first plugin use. It rediscovers labelled sandboxes and
 * plugin-owned registrations and feeds each name to the same idempotent
 * reconciler. Uncertain or ambiguous state is left untouched; a transient
 * directory/inventory failure leaves recovery retryable.
 */
export async function recoverManagedSandboxes(
  context: RecoveryContext,
): Promise<void> {
  const directory = await context.hosts.list().catch(() => null);
  if (!directory) throw new Error("registrations unavailable");

  const parentId = directory.self.serverId;
  if (!parentId) throw new Error("parent id unavailable");

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
  if (inventory.status !== "available") throw new Error("inventory unavailable");

  const names = new Set<string>();
  for (const loaded of inventory.sandboxes) names.add(loaded.sandbox.name);
  for (const registration of pluginRegistrations(parentId, directory.hosts)) {
    const name = registration.metadata.name;
    if (typeof name === "string" && name.length > 0) names.add(name);
  }

  if (names.size === 0) return;

  const work = [...names].map((name) =>
    context.lanes
      .run(name, (token) =>
        reconcileName(
          context,
          { name, allowCreate: false, redactionValues },
          token,
        ),
      )
      .catch((error) => {
        if (error instanceof LifecycleAbortedError) return;
        // Failures are recorded as safe phase/error hints by the reconciler.
      }),
  );

  await Promise.allSettled(work);
}

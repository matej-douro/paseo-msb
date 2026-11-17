import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import {
  secretsDeleteRpc,
  secretsListRpc,
  secretsSetRpc,
  vmCreateRpc,
  vmDeleteRpc,
  vmDetailRpc,
  vmDismissRpc,
  vmListRpc,
  vmMetricsRpc,
  vmReconcileRpc,
  vmResizeRpc,
} from "../shared/contracts";
import { CLEANUP_SETTLE_MS, type CredentialName } from "../shared/constants";
import { safeError } from "../shared/errors";
import { createVm } from "./create";
import { deleteVm } from "./delete";
import { createLifecycleLanes, LifecycleAbortedError } from "./lanes";
import { createMetricsCoalescer, createParentIdCache, readVmMetrics } from "./metrics";
import { createMutationRegistry } from "./mutations";
import { connectPaseoTools } from "./paseo-tools";
import { createPendingCreateStore, dismissPendingCreate } from "./pending";
import { createRegistrationPruner } from "./prune";
import { reconcileVm } from "./reconcile";
import { recoverManagedSandboxes } from "./recovery";
import { readVmDetail, readVmList, type ReadContext } from "./rpc";
import { resizeVm } from "./resize";
import { createMicrosandboxHost, createMicrosandboxRuntime } from "./runtime";
import { listSecrets, storedCredentialNames } from "./secrets";
import {
  createSecretsStore,
  defaultSecretsFilePath,
} from "./secrets-store";

/**
 * Registers the six lifecycle RPCs plus the plugin credential store. One
 * per-name lifecycle lane serializes Create, recovery, Repair, and Delete.
 * Recovery starts on first use and is retried after a transient failure.
 */
export function registerRpcHandlers(server: PluginServerContext): () => Promise<void> {
  const pending = createPendingCreateStore();
  const secretsStore = createSecretsStore(defaultSecretsFilePath(process.env), {
    secureExistingDirectory: true,
  });
  const lanes = createLifecycleLanes();
  const mutations = createMutationRegistry();
  const parents = createParentIdCache();
  const metrics = createMetricsCoalescer();
  const pruner = createRegistrationPruner();
  let recovery: Promise<void> | null = null;
  let recoveryDone = false;

  async function readContext(paseo: PluginHandlerContext["paseo"]): Promise<ReadContext> {
    const stored = await secretsStore.read();
    const values: ReadonlyMap<CredentialName, string> =
      stored.status === "ok" ? stored.values : new Map();

    return {
      hosts: paseo.hosts,
      runtime: createMicrosandboxRuntime(paseo),
      pending: pending.list(),
      env: process.env,
      storedCredentials: storedCredentialNames(values),
      storedSecrets: values,
      onParentId: (parentId) => parents.remember(parentId),
    };
  }

  function reconcileContext(paseo: PluginHandlerContext["paseo"]) {
    return {
      hosts: paseo.hosts,
      runtime: createMicrosandboxRuntime(paseo),
      sandboxHost: createMicrosandboxHost(paseo),
      mutations,
      env: process.env,
      pending,
      secretsStore,
      lanes,
      paseoTools: connectPaseoTools,
    };
  }

  function cleanupContext(paseo: PluginHandlerContext["paseo"]) {
    return {
      hosts: paseo.hosts,
      sandboxHost: createMicrosandboxHost(paseo),
    };
  }

  function ensureRecovery(paseo: PluginHandlerContext["paseo"]): void {
    // The cleanup schedule starts with the same first-use activation as
    // recovery. It is independent of the UI and of any single recovery attempt.
    pruner.start(cleanupContext(paseo));
    if (recoveryDone || recovery) return;

    recovery = recoverManagedSandboxes(reconcileContext(paseo))
      .then(() => {
        recoveryDone = true;
      })
      .catch(() => {
        // A transient directory/inventory failure stays retryable on next use.
      })
      .finally(() => {
        recovery = null;
      });
  }

  server.handle(vmListRpc, async (_input, { paseo }) => {
    ensureRecovery(paseo);
    const result = await readVmList(await readContext(paseo));

    // The sweep derives its own candidates from the parent directory and
    // runtime, so this read projection is never its work queue. It is
    // fire-and-forget: polling never waits for a sweep.
    pruner.schedule(cleanupContext(paseo));

    return result;
  });

  server.handle(vmDetailRpc, async (input, { paseo }) => {
    ensureRecovery(paseo);
    return readVmDetail(await readContext(paseo), input);
  });

  server.handle(vmCreateRpc, (input, { paseo }) => {
    ensureRecovery(paseo);
    return createVm(reconcileContext(paseo), input);
  });

  server.handle(vmDismissRpc, (input) => dismissPendingCreate(pending, input.name));

  server.handle(vmDeleteRpc, (input, { paseo }) => {
    const context = reconcileContext(paseo);
    return lanes
      .run(
        input.name,
        (token) => deleteVm(context, input, token),
        { abortPrevious: true },
      )
      .catch((error) => {
        if (error instanceof LifecycleAbortedError) {
          throw new Error(safeError("delete_failed").message);
        }
        throw error;
      });
  });

  server.handle(vmReconcileRpc, (input, { paseo }) =>
    reconcileVm(reconcileContext(paseo), input),
  );

  server.handle(vmResizeRpc, (input, { paseo }) => {
    const context = { ...reconcileContext(paseo), redactionValues: [] };
    return lanes
      .run(input.name, (token) => resizeVm(context, input, token))
      .catch((error) => {
        if (error instanceof LifecycleAbortedError) {
          throw new Error(safeError("mutation_pending").message);
        }
        throw error;
      });
  });

  server.handle(vmMetricsRpc, (input, { paseo }) =>
    readVmMetrics(
      {
        hosts: paseo.hosts,
        sandboxHost: createMicrosandboxHost(paseo),
        parents,
        coalescer: metrics,
      },
      input,
    ),
  );

  server.handle(secretsListRpc, () => listSecrets(secretsStore, process.env));

  server.handle(secretsSetRpc, async (input) => {
    try {
      await secretsStore.set(input.name, input.value);
    } catch {
      throw new Error(safeError("secrets_unavailable").message);
    }
    return { name: input.name };
  });

  server.handle(secretsDeleteRpc, async (input) => {
    try {
      const removed = await secretsStore.delete(input.name);
      return { name: input.name, removed };
    } catch {
      throw new Error(safeError("secrets_unavailable").message);
    }
  });

  // Paseo tears the old plugin down before starting the replacement and allows
  // two seconds for cleanup. `settle` permanently closes every lane before it
  // waits, so no Create, recovery, Repair, or later Repair target can begin a
  // side effect during or after teardown. Never wait for an install or
  // registration timeout.
  return async () => {
    pruner.stop();
    await lanes.settle(CLEANUP_SETTLE_MS);
  };
}

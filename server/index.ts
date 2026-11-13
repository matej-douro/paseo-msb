import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import {
  secretsDeleteRpc,
  secretsListRpc,
  secretsSetRpc,
  vmCreateRpc,
  vmDeleteRpc,
  vmDetailRpc,
  vmListRpc,
  vmReconcileRpc,
} from "../shared/contracts";
import type { CredentialName } from "../shared/constants";
import { safeError } from "../shared/errors";
import { createVm } from "./create";
import { deleteVm } from "./delete";
import { createPendingCreateStore } from "./pending";
import { reconcileVm } from "./reconcile";
import { recoverManagedSandboxes } from "./recovery";
import { readVmDetail, readVmList, type ReadContext } from "./rpc";
import { createMicrosandboxHost, createMicrosandboxRuntime } from "./runtime";
import { listSecrets, storedCredentialNames } from "./secrets";
import {
  createSecretsStore,
  defaultSecretsFilePath,
} from "./secrets-store";

/**
 * Registers the five lifecycle RPCs plus the plugin credential store. Recovery
 * runs once on first use, so a plugin reload resumes unambiguous setup without
 * a terminal history.
 */
export function registerRpcHandlers(server: PluginServerContext): () => void {
  const pending = createPendingCreateStore();
  const secretsStore = createSecretsStore(defaultSecretsFilePath(process.env));
  let recovery: Promise<void> | null = null;

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
    };
  }

  function setupContext(paseo: PluginHandlerContext["paseo"]) {
    return {
      hosts: paseo.hosts,
      runtime: createMicrosandboxRuntime(paseo),
      sandboxHost: createMicrosandboxHost(paseo),
    };
  }

  function ensureRecovery(paseo: PluginHandlerContext["paseo"]): void {
    if (recovery) return;
    recovery = recoverManagedSandboxes(setupContext(paseo)).catch(() => {});
  }

  server.handle(vmListRpc, async (_input, { paseo }) => {
    ensureRecovery(paseo);
    return readVmList(await readContext(paseo));
  });

  server.handle(vmDetailRpc, async (input, { paseo }) => {
    ensureRecovery(paseo);
    return readVmDetail(await readContext(paseo), input);
  });

  server.handle(vmCreateRpc, (input, { paseo }) => {
    ensureRecovery(paseo);
    const setup = setupContext(paseo);
    return createVm(
      {
        ...setup,
        creator: setup.sandboxHost,
        env: process.env,
        pending,
        secretsStore,
      },
      input,
    );
  });

  server.handle(vmDeleteRpc, (input, { paseo }) =>
    deleteVm(
      {
        hosts: paseo.hosts,
        sandboxHost: createMicrosandboxHost(paseo),
      },
      input,
    ),
  );

  server.handle(vmReconcileRpc, (input, { paseo }) =>
    reconcileVm(setupContext(paseo), input),
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

  return () => {};
}

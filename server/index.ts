import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import {
  vmCreateRpc,
  vmDeleteRpc,
  vmDetailRpc,
  vmListRpc,
  vmReconcileRpc,
} from "../shared/contracts";
import { createVm } from "./create";
import { deleteVm } from "./delete";
import { createPendingCreateStore } from "./pending";
import { reconcileVm } from "./reconcile";
import { recoverManagedSandboxes } from "./recovery";
import { readVmDetail, readVmList, type ReadContext } from "./rpc";
import { createMicrosandboxHost, createMicrosandboxRuntime } from "./runtime";

/**
 * Registers the five v1 RPC contracts. Recovery runs once on first use, so a
 * plugin reload resumes unambiguous setup without a terminal history.
 */
export function registerRpcHandlers(server: PluginServerContext): () => void {
  const pending = createPendingCreateStore();
  let recovery: Promise<void> | null = null;

  function readContext(paseo: PluginHandlerContext["paseo"]): ReadContext {
    return {
      hosts: paseo.hosts,
      runtime: createMicrosandboxRuntime(paseo),
      pending: pending.list(),
      env: process.env,
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

  server.handle(vmListRpc, (_input, { paseo }) => {
    ensureRecovery(paseo);
    return readVmList(readContext(paseo));
  });

  server.handle(vmDetailRpc, (input, { paseo }) => {
    ensureRecovery(paseo);
    return readVmDetail(readContext(paseo), input);
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

  return () => {};
}

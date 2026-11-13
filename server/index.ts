import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import {
  vmCreateRpc,
  vmDeleteRpc,
  vmDetailRpc,
  vmListRpc,
  vmReconcileRpc,
} from "../shared/contracts";
import { createVm } from "./create";
import { createPendingCreateStore } from "./pending";
import { deleteVm, readVmDetail, readVmList, reconcileVm, type ReadContext } from "./rpc";
import { createMicrosandboxCreator, createMicrosandboxRuntime } from "./runtime";

/**
 * Registers the five v1 RPC contracts. Creation runs in the background;
 * delete and reconcile fail with a safe not-implemented error until task 4.
 */
export function registerRpcHandlers(server: PluginServerContext): () => void {
  const pending = createPendingCreateStore();

  function readContext(paseo: PluginHandlerContext["paseo"]): ReadContext {
    return {
      hosts: paseo.hosts,
      runtime: createMicrosandboxRuntime(paseo),
      pending: pending.list(),
      env: process.env,
    };
  }

  server.handle(vmListRpc, (_input, { paseo }) => readVmList(readContext(paseo)));
  server.handle(vmDetailRpc, (input, { paseo }) => readVmDetail(readContext(paseo), input));
  server.handle(vmCreateRpc, (input, { paseo }) =>
    createVm(
      {
        hosts: paseo.hosts,
        creator: createMicrosandboxCreator(paseo),
        env: process.env,
        pending,
      },
      input,
    ),
  );
  server.handle(vmDeleteRpc, () => deleteVm());
  server.handle(vmReconcileRpc, () => reconcileVm());

  return () => {};
}

import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import {
  vmCreateRpc,
  vmDeleteRpc,
  vmDetailRpc,
  vmListRpc,
  vmReconcileRpc,
} from "../shared/contracts";
import { listPendingCreates } from "./pending";
import { createVm, deleteVm, readVmDetail, readVmList, reconcileVm, type ReadContext } from "./rpc";
import { createMicrosandboxRuntime } from "./runtime";

/**
 * Registers the five v1 RPC contracts. Task 2 wires the read side; mutation
 * handlers fail with a safe not-implemented error until tasks 3 and 4.
 */
export function registerRpcHandlers(server: PluginServerContext): () => void {
  function readContext(paseo: PluginHandlerContext["paseo"]): ReadContext {
    return {
      hosts: paseo.hosts,
      runtime: createMicrosandboxRuntime(paseo),
      pending: listPendingCreates(),
      env: process.env,
    };
  }

  server.handle(vmListRpc, (_input, { paseo }) => readVmList(readContext(paseo)));
  server.handle(vmDetailRpc, (input, { paseo }) => readVmDetail(readContext(paseo), input));
  server.handle(vmCreateRpc, () => createVm());
  server.handle(vmDeleteRpc, () => deleteVm());
  server.handle(vmReconcileRpc, () => reconcileVm());

  return () => {};
}

import type { PluginServerContext } from "@getpaseo/plugin/server";
import { vmDetail, vmList, type PendingChild } from "../shared/contracts";
import { createReadHandlers } from "./rpc";
import { createSandboxInventory } from "./sandbox";

export function contributeServer(server: PluginServerContext) {
  const pendingCreates = new Map<string, PendingChild>();
  const handlers = createReadHandlers({
    inventory: createSandboxInventory(),
    pendingCreates,
    env: process.env,
  });

  server.handle(vmList, handlers.list);
  server.handle(vmDetail, handlers.detail);

  return () => {};
}

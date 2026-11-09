import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  vmCreate,
  vmDetail,
  vmList,
  type PendingChild,
} from "../shared/contracts";
import { createCreateHandler } from "./create";
import { createReadHandlers } from "./rpc";
import { createMicrosandboxRuntime, createSandboxInventory } from "./sandbox";

export function contributeServer(server: PluginServerContext) {
  const pendingCreates = new Map<string, PendingChild>();
  const runtime = createMicrosandboxRuntime();
  const handlers = createReadHandlers({
    inventory: createSandboxInventory(),
    pendingCreates,
    env: process.env,
  });
  const createHandler = createCreateHandler({
    pending: pendingCreates,
    runtime,
    env: process.env,
  });

  server.handle(vmList, handlers.list);
  server.handle(vmDetail, handlers.detail);
  server.handle(vmCreate, createHandler.create);

  return () => {};
}

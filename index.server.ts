import type { PluginServerContext } from "@getpaseo/plugin/server";
import { registerRpcHandlers } from "./server/index";

export default function contribute(server: PluginServerContext) {
  return registerRpcHandlers(server);
}

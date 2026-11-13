#!/usr/bin/env node
/**
 * Checks this plugin against a running parent daemon.
 *
 * Connects over the daemon's websocket endpoint, reports the plugin's load
 * state, and invokes `vm.list`. Use it after switching the desktop app to an
 * externally started daemon, or to verify the CLI-daemon path:
 *
 *   PASEO_PARENT_URL=ws://127.0.0.1:6780/ws npm run check:plugin
 */
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";

const url = process.env.PASEO_PARENT_URL?.trim() || "ws://127.0.0.1:6780/ws";
const password = process.env.PASEO_PASSWORD?.trim() || undefined;
const pluginId = "paseo-msb";

const client = new DaemonClient({
  url,
  clientId: `paseo-msb-check-${process.pid}`,
  connectTimeoutMs: 15_000,
  ...(password ? { password } : {}),
});

try {
  await client.connect();
  console.log(`node:      ${process.version} (${process.platform}/${process.arch})`);
  console.log(`daemon:    ${url}`);

  const plugins = await client.listPlugins();
  const plugin = plugins.find((entry) => entry.id === pluginId);
  if (!plugin) {
    console.error(`plugin:    ${pluginId} is not installed on this daemon`);
    process.exitCode = 1;
  } else {
    console.log(`plugin:    ${plugin.status ?? plugin.enabled ?? "unknown"}`);
  }

  const list = await client.invokePluginRpc(pluginId, "vm.list", {});
  console.log(`inventory: ${list.inventory.status}`);
  if (list.inventory.status !== "available") {
    console.log(`error:     ${list.inventory.error.message}`);
    if (list.inventory.error.detail) console.log(`detail:    ${list.inventory.error.detail}`);
    process.exitCode = 1;
  }
  console.log(`registrations: ${list.registrations.status}`);
  if (list.registrations.status !== "available" && list.registrations.error.detail) {
    console.log(`registration detail: ${list.registrations.error.detail}`);
  }
  console.log(`children:  ${list.children.length}`);
  for (const child of list.children) {
    const phase = child.kind === "sandbox" ? child.labels["paseo-msb-phase"] : child.phase;
    console.log(`  - ${child.kind} ${child.name} (${phase})`);
  }
} catch (error) {
  console.error(`check failed: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
} finally {
  await client.close().catch(() => {});
}

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createHostClient } from "@getpaseo/client/node";
import { createPaseoApi } from "@getpaseo/client";

export function getFreePort(bind = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, bind, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close((error) => {
        if (error) reject(error);
        else if (!port) reject(new Error("did not obtain a free port"));
        else resolve(port);
      });
    });
  });
}

export function canBind(port, bind = "127.0.0.1") {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen(port, bind, () => {
      server.close(() => resolve(true));
    });
  });
}

function health(port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const request = http.get(
      { hostname: "127.0.0.1", port, path: "/api/health", timeout: timeoutMs },
      (response) => {
        response.resume();
        resolve(response.statusCode === 200);
      },
    );
    request.on("timeout", () => {
      request.destroy();
      resolve(false);
    });
    request.on("error", () => resolve(false));
  });
}

async function waitForHealth(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await health(port)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`parent daemon did not become healthy on 127.0.0.1:${port}`);
}

export async function startIsolatedParent(options = {}) {
  const home = options.home ?? fs.mkdtempSync(path.join(os.tmpdir(), "paseo-msb-spike-parent-"));
  const port = options.port ?? (await getFreePort());
  const logPath = path.join(home, "daemon.log");
  const log = fs.openSync(logPath, "a");
  const child = spawn(process.env.PASEO_BIN ?? "paseo", ["daemon", "run", "--home", home], {
    env: {
      PATH: process.env.PATH ?? "",
      HOME: home,
      TMPDIR: process.env.TMPDIR ?? os.tmpdir(),
      LANG: process.env.LANG ?? "C.UTF-8",
      PASEO_HOME: home,
      PASEO_LISTEN: `127.0.0.1:${port}`,
      PASEO_RELAY_ENABLED: "false",
      PASEO_LOG_FORMAT: "json",
      PASEO_LOG_LEVEL: "warn",
      PASEO_PASSWORD: "",
    },
    stdio: ["ignore", log, log],
    detached: true,
  });
  child.unref();
  fs.closeSync(log);
  const handle = {
    home,
    port,
    url: `http://127.0.0.1:${port}`,
    logPath,
    child,
  };
  try {
    const timeoutMs = options.timeoutMs ?? 30_000;
    await waitForHealth(port, timeoutMs);
    await waitForWebSocket(handle.url, timeoutMs);
  } catch (error) {
    await stopIsolatedParent(handle);
    throw error;
  }
  return handle;
}

async function waitForWebSocket(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const client = createHostClient(url.replace(/^https?:\/\//, ""), {
        clientId: `paseo-msb-spike-ready-${process.pid}`,
        clientType: "cli",
        appVersion: "0.15.0",
        connectTimeoutMs: 2_000,
        reconnect: { enabled: false },
      });
      await client.connect();
      await client.close();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(`parent daemon websocket did not become ready: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

export async function stopIsolatedParent(handle) {
  if (!handle?.child?.pid) return;
  const pid = handle.child.pid;
  if (handle.child.exitCode !== null) return;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      return;
    }
  }
  const exited = await Promise.race([
    new Promise((resolve) => handle.child.once("exit", () => resolve(true))),
    new Promise((resolve) => setTimeout(() => resolve(false), 10_000)),
  ]);
  if (!exited) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }
}

export async function restartIsolatedParent(handle) {
  await stopIsolatedParent(handle);
  const restarted = await startIsolatedParent({ home: handle.home, port: handle.port });
  Object.assign(handle, restarted);
  return handle;
}

export async function connectParent(url, options = {}) {
  const connection = url.replace(/^https?:\/\//, "");
  const client = createHostClient(connection, {
    clientId: options.clientId ?? `paseo-msb-spike-${process.pid}`,
    clientType: "cli",
    appVersion: options.appVersion ?? "0.15.0",
    connectTimeoutMs: options.connectTimeoutMs ?? 15_000,
    reconnect: { enabled: false },
  });
  await client.connect();
  const api = createPaseoApi(client);
  return {
    client,
    api,
    async close() {
      await client.close();
    },
  };
}

export async function waitForHost(api, registrationId, status, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const directory = await api.hosts.list();
    last = directory.hosts.find((entry) => entry.registrationId === registrationId) ?? null;
    if (last?.status === status) return last;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `registration ${registrationId} did not reach ${status}; last=${last ? `${last.status} ${last.error?.code ?? ""}` : "missing"}`,
  );
}

export async function waitForProvider(api, provider, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const result = await api.providers.listAvailable();
    last = result.providers.find((entry) => entry.provider === provider) ?? null;
    if (last?.available) return last;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return last;
}

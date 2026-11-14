#!/usr/bin/env node
/**
 * Task 1.2 spike: resource read, legacy caps, and resize semantics.
 *
 * Creates a V1.1 sandbox with explicit memory, maxMemory, root disk, and a
 * 2-second metrics interval, then resizes RAM and disk through `modify()`.
 * Repeats the resource paths on a V1-shaped sandbox with no explicit
 * maxMemory, no resources env, and no metrics interval.
 *
 * Run against an isolated parent daemon and the pinned runtime:
 *
 *   node scripts/spikes/verify-v11-resources.mjs \
 *     --parent "$PASEO_PARENT_URL" --image "$PASEO_IMAGE_PIN" --timeout 300
 *
 * Environment:
 *   PASEO_PARENT_URL   Parent daemon WebSocket URL (default ws://127.0.0.1:6780/ws)
 *   PASEO_PASSWORD     Parent daemon password, when required
 *
 * Results are recorded in docs/spikes/v11-resources.md. Every registration and
 * sandbox is removed in `finally`.
 */

import { createPaseoClient } from "@getpaseo/client";
import { MiB, Sandbox } from "microsandbox";
import net from "node:net";
import { parseArgs } from "node:util";

const GUEST_PORT = 6767;
const GUEST_USER = "paseo";
const INIT_COMMAND = "/usr/bin/tini";
const INIT_ARGS = ["--", "/usr/local/bin/paseo-docker-entrypoint"];
const SPIKE_LABEL = "paseo-msb-v11-resources-spike";
const V11 = {
  cpus: 2,
  memoryMib: 4096,
  maxMemoryMib: 32768,
  diskMib: 10240,
  metricsSampleIntervalMs: 2000,
};
const LEGACY = { cpus: 2, memoryMib: 4096, diskMib: 10240 };

const { values } = parseArgs({
  options: {
    parent: {
      type: "string",
      default: process.env.PASEO_PARENT_URL?.trim() || "ws://127.0.0.1:6780/ws",
    },
    image: {
      type: "string",
      default: process.env.PASEO_IMAGE_PIN?.trim() || "ghcr.io/getpaseo/paseo:0.15.4",
    },
    timeout: { type: "string", default: "300" },
    password: { type: "string", default: process.env.PASEO_PASSWORD?.trim() || "" },
  },
  allowPositionals: false,
});

const PARENT_URL = values.parent;
const IMAGE = values.image;
const ONLINE_TIMEOUT_MS = Math.min(Number(values.timeout) * 1_000, 120_000);
const PASSWORD = values.password;
const nonce = `${process.pid}-${Date.now().toString(36)}`;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function attempt(operation) {
  try {
    return { rejected: false, value: await operation() };
  } catch (error) {
    return {
      rejected: true,
      name: error instanceof Error ? error.name : typeof error,
      code: typeof error?.code === "string" ? error.code : null,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function waitFor(label, predicate, { timeoutMs, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  return { timedOut: true, label, lastError: lastError?.message ?? null };
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close(() => (port ? resolve(port) : reject(new Error("no free port"))));
    });
  });
}

function planResult(result) {
  if (result.rejected) return { error: result };
  return result.value;
}

function restartResult(result) {
  if (result.rejected) return { error: result };
  return { id: result.value.id, name: result.value.name, status: result.value.status };
}

function readState(handle) {
  const config = handle.config();
  return {
    status: handle.status,
    resources: {
      cpus: config.resources?.cpus ?? null,
      memoryMib: config.resources?.memoryMib ?? null,
      maxMemoryMib: config.resources?.maxMemoryMib ?? null,
    },
    diskMib: config.image?.Oci?.rootDisk?.sizeMib ?? null,
    metricsSampleIntervalMs: config.runtime?.metricsSampleIntervalMs ?? null,
    createdAt: handle.createdAt?.toISOString() ?? null,
    updatedAt: handle.updatedAt?.toISOString() ?? null,
    ports: config.network?.ports ?? [],
    resourcesEnv:
      config.env?.find((entry) => entry.key === "PASEO_MSB_RESOURCES")?.value ?? null,
  };
}

async function guestFacts(handle) {
  try {
    const sandbox = await handle.connect();
    const df = await sandbox.execWith("df", (builder) =>
      builder.args(["-m", "/"]).user(GUEST_USER),
    );
    const memory = await sandbox.execWith("sh", (builder) =>
      builder.args(["-lc", "awk '/MemTotal/ {print $2}' /proc/meminfo"]).user(GUEST_USER),
    );
    const resourcesEnv = await sandbox.execWith("sh", (builder) =>
      builder
        .args(["-lc", "printenv PASEO_MSB_RESOURCES || true"])
        .user(GUEST_USER),
    );
    const uptime = await sandbox.execWith("sh", (builder) =>
      builder.args(["-lc", "cut -d' ' -f1 /proc/uptime"]).user(GUEST_USER),
    );
    return {
      rootFilesystem: String(df.stdout()).trim().split("\n").at(-1) ?? null,
      memTotalKb: Number(String(memory.stdout()).trim()) || null,
      resourcesEnv: String(resourcesEnv.stdout()).trim() || null,
      uptimeSeconds: Number(String(uptime.stdout()).trim()) || null,
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

async function refreshed(handle) {
  const next = await handle.refresh();
  await sleep(1_500);
  const final = await next.refresh();
  return { handle: final, state: readState(final) };
}

async function record(observations, label, result, handle) {
  const entry = { label };
  if (result) entry.modify = planResult(result);
  if (handle) {
    const next = await refreshed(handle);
    entry.state = next.state;
    entry.guest = await guestFacts(next.handle);
    handle = next.handle;
  }
  observations.push(entry);
  process.stdout.write(`${JSON.stringify(entry)}\n`);
  return handle;
}

async function createSandbox({ name, hostPort, maxMemoryMib, metricsSampleIntervalMs, env }) {
  let builder = Sandbox.builder(name)
    .image(IMAGE)
    .cpus(2)
    .memory(MiB(4096))
    .rootDisk(10240)
    .detached(true)
    .init(INIT_COMMAND, INIT_ARGS)
    .labels({ [SPIKE_LABEL]: "v11" });

  if (hostPort) builder = builder.port(hostPort, GUEST_PORT);
  if (maxMemoryMib) builder = builder.maxMemory(MiB(maxMemoryMib));
  if (metricsSampleIntervalMs) builder = builder.metricsSampleIntervalMs(metricsSampleIntervalMs);
  for (const [key, value] of Object.entries(env ?? {})) builder = builder.env(key, value);

  const created = await builder.create();
  return Sandbox.get(name).then((handle) => ({ created, handle }));
}

async function waitOnline(parent, registrationId, timeoutMs) {
  return waitFor(
    "registration online",
    async () => {
      const directory = await parent.hosts.list();
      const row = directory.hosts.find(
        (candidate) => candidate.registrationId === registrationId,
      );
      if (!row) return null;
      return row.status === "online" && row.serverId
        ? { status: row.status, serverId: row.serverId, label: row.label }
        : null;
    },
    { timeoutMs },
  );
}

async function v11Scenario(observations, parent) {
  const name = `paseo-v11-res-${nonce}`;
  const hostPort = await findFreePort();
  const created = await createSandbox({
    name,
    hostPort,
    maxMemoryMib: V11.maxMemoryMib,
    metricsSampleIntervalMs: V11.metricsSampleIntervalMs,
    env: {
      PASEO_MSB_RESOURCES: JSON.stringify({
        cpus: V11.cpus,
        memoryMib: V11.memoryMib,
        diskMib: V11.diskMib,
      }),
    },
  });
  let handle = created.handle;

  const add = await parent.hosts.add({
    connection: `127.0.0.1:${hostPort}`,
    label: name,
    metadata: { source: "paseo-msb", name },
    sourceKey: handle.id,
  });
  const onlineInitial = await waitOnline(parent, add.registrationId, ONLINE_TIMEOUT_MS);
  assert(!onlineInitial.timedOut, "initial registration did not come online");

  const initialState = {
    createdId: created.created.id,
    handleId: handle.id,
    createStatus: handle.status,
    registration: { id: add.registrationId, ...onlineInitial },
    state: readState(handle),
    guest: await guestFacts(handle),
  };
  observations.push({ label: "v11-initial", ...initialState });
  process.stdout.write(`${JSON.stringify({ label: "v11-initial", ...initialState })}\n`);

  const dryRuns = {
    memoryGrow: { memory: 6144, policy: "no_restart", dryRun: true },
    memoryShrink: { memory: 2048, policy: "no_restart", dryRun: true },
    diskGrow: { rootDiskSize: 12288, policy: "no_restart", dryRun: true },
    diskShrink: { rootDiskSize: 9216, policy: "no_restart", dryRun: true },
    combined: {
      memory: 6144,
      rootDiskSize: 12288,
      policy: "no_restart",
      dryRun: true,
    },
    cpus: { cpus: 4, policy: "no_restart", dryRun: true },
    maxMemory: { maxMemory: 16384, policy: "no_restart", dryRun: true },
    envNoRestart: {
      env: { PASEO_MSB_RESOURCES: "{\"cpus\":2,\"memoryMib\":6144,\"diskMib\":12288}" },
      policy: "no_restart",
      dryRun: true,
    },
    envNextStart: {
      env: { PASEO_MSB_RESOURCES: "{\"cpus\":2,\"memoryMib\":6144,\"diskMib\":12288}" },
      policy: "next_start",
      dryRun: true,
    },
  };
  for (const [label, options] of Object.entries(dryRuns)) {
    const result = await attempt(() => handle.modify(options));
    const entry = { label: `v11-dry-${label}`, options, plan: planResult(result) };
    observations.push(entry);
    process.stdout.write(`${JSON.stringify(entry)}\n`);
  }

  handle = await record(
    observations,
    "v11-apply-memory-grow",
    await attempt(() => handle.modify({ memory: 6144, policy: "no_restart" })),
    handle,
  );
  assert(readState(handle).resources.memoryMib === 6144, "memory growth was not observed");

  handle = await record(
    observations,
    "v11-apply-memory-shrink",
    await attempt(() => handle.modify({ memory: 2048, policy: "no_restart" })),
    handle,
  );

  handle = await record(
    observations,
    "v11-apply-disk-grow",
    await attempt(() => handle.modify({ rootDiskSize: 12288, policy: "no_restart" })),
    handle,
  );
  assert(readState(handle).diskMib === 12288, "disk growth was not observed");

  handle = await record(
    observations,
    "v11-apply-combined",
    await attempt(() =>
      handle.modify({ memory: 8192, rootDiskSize: 14336, policy: "no_restart" }),
    ),
    handle,
  );
  const combinedState = readState(handle);
  assert(combinedState.resources.memoryMib === 8192, "combined memory change was not observed");
  assert(combinedState.diskMib === 14336, "combined disk change was not observed");

  const combinedEnvNoRestart = await attempt(() =>
    handle.modify({
      memory: 6144,
      env: { PASEO_MSB_RESOURCES: "{\"cpus\":2,\"memoryMib\":6144,\"diskMib\":14336}" },
      policy: "no_restart",
    }),
  );
  const combinedEnvEntry = {
    label: "v11-apply-resources-plus-env-no-restart",
    modify: planResult(combinedEnvNoRestart),
    state: readState(handle),
    guest: await guestFacts(handle),
  };
  observations.push(combinedEnvEntry);
  process.stdout.write(`${JSON.stringify(combinedEnvEntry)}\n`);
  assert(combinedEnvNoRestart.rejected, "runtime applied resources plus env without a restart");

  const shrinkDisk = await attempt(() =>
    handle.modify({ rootDiskSize: 10240, policy: "no_restart" }),
  );
  const shrinkDiskEntry = {
    label: "v11-apply-disk-shrink",
    modify: planResult(shrinkDisk),
  };
  observations.push(shrinkDiskEntry);
  process.stdout.write(`${JSON.stringify(shrinkDiskEntry)}\n`);
  assert(shrinkDisk.rejected, "runtime accepted a root-disk shrink");

  const cpuChange = await attempt(() => handle.modify({ cpus: 4, policy: "no_restart" }));
  const cpuEntry = { label: "v11-apply-cpus", modify: planResult(cpuChange) };
  observations.push(cpuEntry);
  process.stdout.write(`${JSON.stringify(cpuEntry)}\n`);
  assert(cpuChange.rejected, "runtime accepted a CPU change during resize");

  const maxMemoryNoRestart = await attempt(() =>
    handle.modify({ maxMemory: 16384, policy: "no_restart" }),
  );
  const maxMemoryEntry = {
    label: "v11-apply-max-memory-no-restart",
    modify: planResult(maxMemoryNoRestart),
    state: readState(handle),
  };
  observations.push(maxMemoryEntry);
  process.stdout.write(`${JSON.stringify(maxMemoryEntry)}\n`);
  assert(maxMemoryNoRestart.rejected, "runtime changed maxMemory without a restart");

  const envNoRestart = await attempt(() =>
    handle.modify({
      env: { PASEO_MSB_RESOURCES: "{\"cpus\":2,\"memoryMib\":8192,\"diskMib\":14336}" },
      policy: "no_restart",
    }),
  );
  const envNoRestartEntry = {
    label: "v11-apply-env-no-restart",
    modify: planResult(envNoRestart),
    state: readState(handle),
    guest: await guestFacts(handle),
  };
  observations.push(envNoRestartEntry);
  process.stdout.write(`${JSON.stringify(envNoRestartEntry)}\n`);
  assert(envNoRestart.rejected, "runtime applied an env change without a restart");

  handle = await record(
    observations,
    "v11-apply-env-next-start",
    await attempt(() =>
      handle.modify({
        env: { PASEO_MSB_RESOURCES: "{\"cpus\":2,\"memoryMib\":8192,\"diskMib\":14336}" },
        policy: "next_start",
      }),
    ),
    handle,
  );

  const portBefore = readState(handle).ports;
  const idBefore = handle.id;
  const uptimeBefore = await attempt(() => handle.metrics().then((m) => m.uptimeMs));

  const firstRestart = await attempt(() => handle.restart());
  assert(!firstRestart.rejected, "first restart failed");
  handle = await Sandbox.get(name);
  const immediateFirstGuest = await guestFacts(handle);
  const afterFirst = await refreshed(handle);
  handle = afterFirst.handle;
  const onlineFirst = await waitOnline(parent, add.registrationId, ONLINE_TIMEOUT_MS);
  assert(!onlineFirst.timedOut, "registration did not return online after first restart");

  const firstRestartEntry = {
    label: "v11-restart-1",
    restart: restartResult(firstRestart),
    state: afterFirst.state,
    guest: await guestFacts(handle),
    registration: onlineFirst,
    sameId: handle.id === idBefore,
    samePorts: JSON.stringify(afterFirst.state.ports) === JSON.stringify(portBefore),
    uptimeBefore: planResult(uptimeBefore),
    immediateGuest: immediateFirstGuest,
  };
  observations.push(firstRestartEntry);
  process.stdout.write(`${JSON.stringify(firstRestartEntry)}\n`);
  assert(handle.id === idBefore, "restart changed the sandbox generation");
  assert(
    JSON.stringify(afterFirst.state.ports) === JSON.stringify(portBefore),
    "restart changed the published port",
  );

  const uptimeAfterFirst = await attempt(() => handle.metrics().then((m) => m.uptimeMs));
  const guestBeforeSecond = await guestFacts(handle);
  const secondRestart = await attempt(() => handle.restart());
  assert(!secondRestart.rejected, "second restart failed");
  handle = await Sandbox.get(name);
  const immediateSecondGuest = await guestFacts(handle);
  const afterSecond = await refreshed(handle);
  handle = afterSecond.handle;
  const onlineSecond = await waitOnline(parent, add.registrationId, ONLINE_TIMEOUT_MS);
  assert(!onlineSecond.timedOut, "registration did not return online after second restart");
  const uptimeAfterSecond = await attempt(() => handle.metrics().then((m) => m.uptimeMs));
  const secondRestartEntry = {
    label: "v11-restart-2-identical",
    restart: restartResult(secondRestart),
    state: afterSecond.state,
    guest: await guestFacts(handle),
    registration: onlineSecond,
    sameId: handle.id === idBefore,
    samePorts: JSON.stringify(afterSecond.state.ports) === JSON.stringify(portBefore),
    uptimeAfterFirst: planResult(uptimeAfterFirst),
    uptimeAfterSecond: planResult(uptimeAfterSecond),
    guestBeforeSecond,
    immediateGuest: immediateSecondGuest,
  };
  observations.push(secondRestartEntry);
  process.stdout.write(`${JSON.stringify(secondRestartEntry)}\n`);

  const maxMemoryRestart = await attempt(() =>
    handle.modify({ maxMemory: 16384, policy: "restart" }),
  );
  assert(!maxMemoryRestart.rejected, "maxMemory restart failed");
  handle = await Sandbox.get(name);
  const afterMaxMemory = await refreshed(handle);
  handle = afterMaxMemory.handle;
  const onlineMaxMemory = await waitOnline(parent, add.registrationId, ONLINE_TIMEOUT_MS);
  assert(!onlineMaxMemory.timedOut, "registration did not return online after maxMemory restart");
  const maxMemoryRestartEntry = {
    label: "v11-apply-max-memory-restart",
    modify: planResult(maxMemoryRestart),
    state: afterMaxMemory.state,
    guest: await guestFacts(handle),
    registration: onlineMaxMemory,
  };
  observations.push(maxMemoryRestartEntry);
  process.stdout.write(`${JSON.stringify(maxMemoryRestartEntry)}\n`);

  await handle.stop();
  handle = await Sandbox.get(name);
  const stoppedState = readState(handle);
  const stoppedRestart = await attempt(() =>
    handle.modify({ memory: 10240, policy: "restart" }),
  );
  handle = await Sandbox.get(name);
  const stoppedRestartEntry = {
    label: "v11-state-stopped-restart",
    status: stoppedState.status,
    modify: planResult(stoppedRestart),
    state: readState(handle),
  };
  observations.push(stoppedRestartEntry);
  process.stdout.write(`${JSON.stringify(stoppedRestartEntry)}\n`);
  assert(
    readState(handle).status === "stopped",
    "a restart-policy modify started a stopped sandbox",
  );

  const stoppedDisk = await attempt(() =>
    handle.modify({ rootDiskSize: 16384, policy: "no_restart" }),
  );
  handle = await Sandbox.get(name);
  const stoppedDiskEntry = {
    label: "v11-state-stopped-disk",
    modify: planResult(stoppedDisk),
    state: readState(handle),
  };
  observations.push(stoppedDiskEntry);
  process.stdout.write(`${JSON.stringify(stoppedDiskEntry)}\n`);

  await Sandbox.startDetached(name);
  handle = await Sandbox.get(name);
  const started = await refreshed(handle);
  handle = started.handle;
  const startedEntry = { label: "v11-state-after-start", state: started.state };
  observations.push(startedEntry);
  process.stdout.write(`${JSON.stringify(startedEntry)}\n`);

  await handle.pause();
  handle = await Sandbox.get(name);
  const pausedState = readState(handle);
  const pausedRestart = await attempt(() =>
    handle.modify({ memory: 12288, policy: "restart" }),
  );
  handle = await Sandbox.get(name);
  const pausedEntry = {
    label: "v11-state-paused-restart",
    status: pausedState.status,
    modify: planResult(pausedRestart),
    state: readState(handle),
  };
  observations.push(pausedEntry);
  process.stdout.write(`${JSON.stringify(pausedEntry)}\n`);
  assert(pausedRestart.rejected, "runtime modified a paused sandbox");

  await handle.resume();
  handle = await Sandbox.get(name);
  const resumed = await refreshed(handle);
  handle = resumed.handle;
  const resumedEntry = { label: "v11-state-after-resume", state: resumed.state };
  observations.push(resumedEntry);
  process.stdout.write(`${JSON.stringify(resumedEntry)}\n`);

  await handle.kill();
  await sleep(1_000);
  handle = await Sandbox.get(name);
  const killedState = readState(handle);
  const killedRestart = await attempt(() =>
    handle.modify({ memory: 12288, policy: "restart" }),
  );
  handle = await Sandbox.get(name);
  const killedEntry = {
    label: "v11-state-killed-restart",
    status: killedState.status,
    modify: planResult(killedRestart),
    state: readState(handle),
  };
  observations.push(killedEntry);
  process.stdout.write(`${JSON.stringify(killedEntry)}\n`);

  await Sandbox.startDetached(name);
  handle = await Sandbox.get(name);

  return {
    name,
    sandboxId: idBefore,
    registrationId: add.registrationId,
    observations,
    finalState: readState(handle),
  };
}

async function legacyScenario(observations) {
  const name = `paseo-v11-legacy-${nonce}`;
  const created = await createSandbox({ name });
  let handle = created.handle;
  const initial = {
    label: "legacy-initial",
    createdId: created.created.id,
    createStatus: handle.status,
    state: readState(handle),
    guest: await guestFacts(handle),
  };
  observations.push(initial);
  process.stdout.write(`${JSON.stringify(initial)}\n`);

  for (const [label, options] of Object.entries({
    memoryGrow: { memory: 6144, policy: "no_restart", dryRun: true },
    combined: {
      memory: 6144,
      rootDiskSize: 12288,
      policy: "no_restart",
      dryRun: true,
    },
    maxMemoryNoRestart: { maxMemory: 32768, policy: "no_restart", dryRun: true },
    maxMemoryRestart: {
      memory: 6144,
      maxMemory: 32768,
      policy: "restart",
      dryRun: true,
    },
  })) {
    const result = await attempt(() => handle.modify(options));
    const entry = { label: `legacy-dry-${label}`, plan: planResult(result) };
    observations.push(entry);
    process.stdout.write(`${JSON.stringify(entry)}\n`);
  }

  const combinedNoRestart = await attempt(() =>
    handle.modify({ memory: 6144, rootDiskSize: 12288, policy: "no_restart" }),
  );
  handle = await Sandbox.get(name);
  const combinedNoRestartEntry = {
    label: "legacy-apply-combined-no-restart",
    modify: planResult(combinedNoRestart),
    state: readState(handle),
    guest: await guestFacts(handle),
  };
  observations.push(combinedNoRestartEntry);
  process.stdout.write(`${JSON.stringify(combinedNoRestartEntry)}\n`);
  assert(combinedNoRestart.rejected, "legacy combined resize did not require a restart");

  const maxMemoryNoRestart = await attempt(() =>
    handle.modify({ maxMemory: 16384, policy: "no_restart" }),
  );
  const maxMemoryEntry = {
    label: "legacy-apply-max-memory-no-restart",
    modify: planResult(maxMemoryNoRestart),
  };
  observations.push(maxMemoryEntry);
  process.stdout.write(`${JSON.stringify(maxMemoryEntry)}\n`);
  assert(maxMemoryNoRestart.rejected, "legacy maxMemory changed without a restart");

  const growRestart = await attempt(() =>
    handle.modify({ memory: 6144, maxMemory: 32768, policy: "restart" }),
  );
  assert(!growRestart.rejected, "legacy restart resize failed");
  handle = await Sandbox.get(name);
  const afterGrow = await refreshed(handle);
  handle = afterGrow.handle;
  const growEntry = {
    label: "legacy-apply-grow-restart",
    modify: planResult(growRestart),
    state: afterGrow.state,
    guest: await guestFacts(handle),
  };
  observations.push(growEntry);
  process.stdout.write(`${JSON.stringify(growEntry)}\n`);
  assert(readState(handle).resources.memoryMib === 6144, "legacy memory growth was not observed");

  return { name, observations };
}

async function main() {
  const summary = {
    startedAt: new Date().toISOString(),
    parentUrl: PARENT_URL,
    image: IMAGE,
    v11: V11,
    legacy: LEGACY,
    observations: [],
    cleanup: { registrations: [], sandboxes: [], verifiedRemovals: [] },
  };
  const parent = createPaseoClient({
    url: PARENT_URL,
    clientId: `paseo-msb-v11-resources-spike-${nonce}`,
    connectTimeoutMs: 15_000,
    ...(PASSWORD ? { password: PASSWORD } : {}),
  });
  const createdNames = new Set();
  const registrations = new Set();
  const sourceKeys = new Set();

  try {
    await parent.connect();
    summary.parent = {
      serverId: (await parent.hosts.list()).self.serverId,
    };

    const v11 = await v11Scenario(summary.observations, parent);
    createdNames.add(v11.name);
    registrations.add(v11.registrationId);
    sourceKeys.add(v11.sandboxId);
    summary.v11Result = {
      name: v11.name,
      registrationId: v11.registrationId,
      finalState: v11.finalState,
    };

    const legacy = await legacyScenario(summary.observations);
    createdNames.add(legacy.name);
    summary.legacyResult = { name: legacy.name };
  } finally {
    // A lost add response may have created a row without a known id.
    try {
      const directory = await parent.hosts.list();
      for (const row of directory.hosts) {
        if (row.source?.key && sourceKeys.has(row.source.key)) {
          registrations.add(row.registrationId);
        }
      }
    } catch {
      // Cleanup still attempts recorded registrations below.
    }

    for (const registrationId of [...registrations].reverse()) {
      try {
        await parent.hosts.remove(registrationId);
        summary.cleanup.registrations.push({
          registrationId,
          removed: true,
        });
      } catch (error) {
        summary.cleanup.registrations.push({
          registrationId,
          removed: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    for (const name of [...createdNames].reverse()) {
      const handle = await Sandbox.get(name).catch(() => null);
      try {
        if (handle) await handle.destroy({ force: true, timeoutMs: 15_000 });
        else await Sandbox.remove(name);
        summary.cleanup.sandboxes.push({ name, removed: true });
      } catch (error) {
        try {
          await Sandbox.remove(name);
          summary.cleanup.sandboxes.push({
            name,
            removed: true,
            fallback: "Sandbox.remove",
          });
        } catch (fallbackError) {
          summary.cleanup.sandboxes.push({
            name,
            removed: false,
            error: error instanceof Error ? error.message : String(error),
            fallbackError:
              fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
          });
        }
      }
    }

    for (const name of createdNames) {
      const remaining = await Sandbox.get(name)
        .then((handle) => ({ name, remaining: true, id: handle.id }))
        .catch(() => ({ name, remaining: false }));
      summary.cleanup.verifiedRemovals.push(remaining);
    }

    try {
      const directory = await parent.hosts.list();
      summary.cleanup.registrationsRemaining = directory.hosts
        .filter((row) => registrations.has(row.registrationId))
        .map((row) => row.registrationId);
    } catch (error) {
      summary.cleanup.registrationsRemainingError =
        error instanceof Error ? error.message : String(error);
    }

    try {
      await parent.close();
    } catch {
      // ignore
    }

    summary.finishedAt = new Date().toISOString();
    summary.pass =
      summary.cleanup.registrations.every((entry) => entry.removed) &&
      summary.cleanup.sandboxes.every((entry) => entry.removed) &&
      summary.cleanup.verifiedRemovals.every((entry) => !entry.remaining) &&
      (summary.cleanup.registrationsRemaining?.length ?? 0) === 0;

    process.stdout.write(`\nSPIKE_RESULT ${JSON.stringify(summary)}\n`);
    process.stdout.write(`\n${summary.pass ? "PASS" : "FAIL"} resource spike\n`);
    if (!summary.pass) process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`\nSpike failed: ${error instanceof Error ? error.stack : error}\n`);
  process.exitCode = 1;
});

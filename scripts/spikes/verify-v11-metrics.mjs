#!/usr/bin/env node
/**
 * Task 1.3 spike: metrics sampling and availability.
 *
 * Creates a V1.1 sandbox with a 2-second metrics sample interval and a
 * V1-shaped sandbox with the runtime default. Both are polled at the client's
 * 3-second cadence. The V1.1 sandbox is also used to restart-counter and
 * writable-upper-layer probes, while a third sandbox with metrics disabled
 * records the disabled error. Stopped, paused, and stale-handle reads record the
 * remaining typed outcomes.
 *
 * Run against the pinned runtime:
 *
 *   node scripts/spikes/verify-v11-metrics.mjs \
 *     --image "$PASEO_IMAGE_PIN" --timeout 180
 *
 * Results are recorded in docs/spikes/v11-metrics.md. Every sandbox is removed
 * in `finally`.
 */

import { MiB, Sandbox } from "microsandbox";
import { parseArgs } from "node:util";

const GUEST_USER = "paseo";
const INIT_COMMAND = "/usr/bin/tini";
const INIT_ARGS = ["--", "/usr/local/bin/paseo-docker-entrypoint"];
const QUIET_INIT_ARGS = ["--", "/bin/sh", "-c", "exec sleep infinity"];
const SPIKE_LABEL = "paseo-msb-v11-metrics-spike";
const PROBE_FILE = "paseo-metrics-probe.bin";
const V11 = {
  metricsSampleIntervalMs: 2000,
  pollCadenceMs: 3000,
  polls: 5,
  restartPolls: 3,
  writeProbeMib: 32,
};
const LEGACY = {
  pollCadenceMs: 3000,
  polls: 5,
};
const CUMULATIVE_FIELDS = [
  "vcpuTimeNs",
  "diskReadBytes",
  "diskWriteBytes",
  "netRxBytes",
  "netTxBytes",
  "uptimeMs",
];
const BYTES_PER_MIB = 1024 * 1024;
const SETTLE = {
  maxWaitMs: 30_000,
  cadenceMs: 3_000,
  maxDeltaBytes: 2 * BYTES_PER_MIB,
  maxCpuPercent: 15,
  requiredQuietPolls: 2,
};

const { values } = parseArgs({
  options: {
    image: {
      type: "string",
      default: process.env.PASEO_IMAGE_PIN?.trim() || "ghcr.io/getpaseo/paseo:0.15.4",
    },
    timeout: { type: "string", default: "180" },
  },
  allowPositionals: false,
});

const IMAGE = values.image;
const TIMEOUT_MS = Math.max(Number(values.timeout) || 180, 30) * 1_000;
const ONLINE_TIMEOUT_MS = Math.min(TIMEOUT_MS, 120_000);
const nonce = `${process.pid}-${Date.now().toString(36)}`;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function iso(ms) {
  return new Date(ms).toISOString();
}

function trimText(value) {
  return String(value).trim();
}

function errorRecord(error) {
  return {
    name: error instanceof Error ? error.name : typeof error,
    code: typeof error?.code === "string" ? error.code : null,
    message: error instanceof Error ? error.message : String(error),
  };
}

async function attempt(operation) {
  try {
    return { rejected: false, value: await operation() };
  } catch (error) {
    return { rejected: true, ...errorRecord(error) };
  }
}

function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs} ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function attemptTimeout(operation, timeoutMs = 15_000, label = "operation") {
  return attempt(() => withTimeout(operation(), timeoutMs, label));
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

function runtimeState(handle) {
  const config = handle.config();
  return {
    id: handle.id,
    status: handle.status,
    metricsSampleIntervalMs: config.runtime?.metricsSampleIntervalMs ?? null,
    disableMetricsSample: config.runtime?.disableMetricsSample ?? null,
    cpus: config.resources?.cpus ?? null,
    memoryMib: config.resources?.memoryMib ?? null,
    maxMemoryMib: config.resources?.maxMemoryMib ?? null,
    rootDiskMib: config.image?.Oci?.rootDisk?.sizeMib ?? null,
  };
}

function parseDf(text) {
  const line =
    text
      .trim()
      .split("\n")
      .map((row) => row.trim())
      .filter((row) => /\s\/$/.test(row))
      .at(-1) ?? null;
  if (!line) return null;
  const [filesystem, totalMib, usedMib, availableMib, usePercent, mount] = line.split(/\s+/);
  return {
    filesystem,
    totalMib: Number(totalMib),
    usedMib: Number(usedMib),
    availableMib: Number(availableMib),
    usePercent,
    mount,
  };
}

function sampleFields(sample) {
  if (!sample || sample.error) return null;
  return Object.fromEntries(
    [
      "timestamp",
      "timestampMs",
      "ageMs",
      "stale",
      "cpuPercent",
      "vcpuTimeNs",
      "memoryBytes",
      "memoryLimitBytes",
      "memoryAvailableBytes",
      "diskReadBytes",
      "diskWriteBytes",
      "netRxBytes",
      "netTxBytes",
      "upperUsedBytes",
      "upperFreeBytes",
      "upperHostAllocatedBytes",
      "uptimeMs",
    ].map((key) => [key, sample[key]]),
  );
}

function compareSamples(previous, current) {
  if (!previous || previous.error || current.error) return null;
  const delta = {};
  for (const key of CUMULATIVE_FIELDS) {
    delta[key] = current[key] - previous[key];
  }
  return {
    sincePreviousMs: current.requestedAtMs - previous.requestedAtMs,
    sameTimestamp: current.timestampMs === previous.timestampMs,
    nonIncreasingTimestamp: current.timestampMs <= previous.timestampMs,
    regressions: CUMULATIVE_FIELDS.filter((key) => delta[key] < 0),
    delta,
  };
}

async function readSample(handle, timeoutMs = 15_000) {
  const requestedAtMs = Date.now();
  const result = await attemptTimeout(() => handle.metrics(), timeoutMs, "metrics()");
  const receivedAtMs = Date.now();
  const base = {
    requestedAt: iso(requestedAtMs),
    requestedAtMs,
    receivedAt: iso(receivedAtMs),
    receivedAtMs,
  };
  if (result.rejected) {
    return {
      ...base,
      error: { name: result.name, code: result.code, message: result.message },
    };
  }
  const metrics = result.value;
  const timestampMs = metrics.timestamp instanceof Date ? metrics.timestamp.getTime() : null;
  const ageMs = Number.isFinite(timestampMs) ? receivedAtMs - timestampMs : null;
  return {
    ...base,
    timestamp: Number.isFinite(timestampMs) ? iso(timestampMs) : null,
    timestampMs: Number.isFinite(timestampMs) ? timestampMs : null,
    ageMs,
    stale: ageMs === null ? null : ageMs > 10_000 || ageMs < -5_000,
    cpuPercent: metrics.cpuPercent,
    vcpuTimeNs: metrics.vcpuTimeNs,
    memoryBytes: metrics.memoryBytes,
    memoryLimitBytes: metrics.memoryLimitBytes,
    memoryAvailableBytes: metrics.memoryAvailableBytes,
    diskReadBytes: metrics.diskReadBytes,
    diskWriteBytes: metrics.diskWriteBytes,
    netRxBytes: metrics.netRxBytes,
    netTxBytes: metrics.netTxBytes,
    upperUsedBytes: metrics.upperUsedBytes,
    upperFreeBytes: metrics.upperFreeBytes,
    upperHostAllocatedBytes: metrics.upperHostAllocatedBytes,
    uptimeMs: metrics.uptimeMs,
  };
}

function record(observations, entry) {
  observations.push(entry);
  process.stdout.write(`${JSON.stringify(entry)}\n`);
  return entry;
}

async function poll(observations, handle, count, cadenceMs, label) {
  const samples = [];
  for (let index = 0; index < count; index += 1) {
    if (index > 0) await sleep(cadenceMs);
    const sample = await readSample(handle);
    const entry = {
      label,
      index,
      cadenceMs: index === 0 ? null : cadenceMs,
      sample,
      comparison: compareSamples(samples.at(-1), sample),
    };
    record(observations, entry);
    samples.push(sample);
  }
  return samples;
}

async function tightPair(observations, handle, label) {
  const first = await readSample(handle);
  const second = await readSample(handle);
  return record(observations, {
    label,
    first: sampleFields(first),
    second: sampleFields(second),
    firstError: first.error ?? null,
    secondError: second.error ?? null,
    elapsedMs: second.requestedAtMs - first.requestedAtMs,
    sameTimestamp:
      first.timestampMs !== null && second.timestampMs !== null
        ? first.timestampMs === second.timestampMs
        : null,
  });
}

async function guestProbe(handle) {
  try {
    const sandbox = await handle.connect();
    const df = await sandbox.execWith("df", (builder) =>
      builder.args(["-m", "/"]).user(GUEST_USER),
    );
    const stat = await sandbox.execWith("sh", (builder) =>
      builder.args(["-lc", "stat -f -c 'blocks=%b free=%f avail=%a bsize=%S' /"]).user(GUEST_USER),
    );
    const mount = await sandbox.execWith("sh", (builder) =>
      builder.args(["-lc", "mount | grep ' on / ' || true"]).user(GUEST_USER),
    );
    const dfText = trimText(df.stdout());
    return {
      df: parseDf(dfText),
      dfText,
      statfs: trimText(stat.stdout()),
      mount: trimText(mount.stdout()),
    };
  } catch (error) {
    return { error: errorRecord(error) };
  }
}

async function createSandbox({
  name,
  metricsSampleIntervalMs,
  disableMetricsSample,
  initArgs = INIT_ARGS,
}) {
  let builder = Sandbox.builder(name)
    .image(IMAGE)
    .cpus(2)
    .memory(MiB(4096))
    .rootDisk(10240)
    .detached(true)
    .init(INIT_COMMAND, initArgs)
    .labels({ [SPIKE_LABEL]: "v11" });

  if (metricsSampleIntervalMs !== undefined) {
    builder = builder.metricsSampleIntervalMs(metricsSampleIntervalMs);
  }
  if (disableMetricsSample) builder = builder.disableMetricsSample();

  const created = await builder.create();
  const handle = await Sandbox.get(name);
  return { created, handle };
}

async function waitRunning(handle, timeoutMs) {
  const result = await waitFor(
    "running",
    async () => {
      const next = await handle.refresh();
      return next.status === "running" ? next : null;
    },
    { timeoutMs },
  );
  assert(!result.timedOut, `sandbox ${handle.name} did not reach running`);
  return result;
}

async function waitMetricsAfter(handle, sinceMs, timeoutMs) {
  const result = await waitFor(
    "metrics after restart",
    async () => {
      const sample = await readSample(handle);
      return !sample.error && sample.timestampMs !== null && sample.timestampMs >= sinceMs - 1_000
        ? sample
        : null;
    },
    { timeoutMs, intervalMs: 1_000 },
  );
  assert(!result.timedOut, `metrics did not advance after restart: ${JSON.stringify(result)}`);
  return result;
}

async function waitMetricsAvailable(handle, timeoutMs) {
  const result = await waitFor(
    "metrics available",
    async () => {
      const sample = await readSample(handle);
      return sample.error ? null : sample;
    },
    { timeoutMs, intervalMs: 1_000 },
  );
  assert(!result.timedOut, `metrics never became available: ${JSON.stringify(result)}`);
  return result;
}

async function waitQuiet(observations, handle, label) {
  const deadline = Date.now() + SETTLE.maxWaitMs;
  const samples = [];
  let previous = null;
  let quietPolls = 0;

  while (Date.now() < deadline) {
    const sample = await readSample(handle);
    samples.push(sample);
    if (!sample.error && previous && !previous.error) {
      const comparison = compareSamples(previous, sample);
      const activityBytes =
        Math.abs(comparison.delta.netRxBytes) +
        Math.abs(comparison.delta.netTxBytes) +
        Math.abs(comparison.delta.diskWriteBytes);
      const isQuiet =
        activityBytes <= SETTLE.maxDeltaBytes && sample.cpuPercent <= SETTLE.maxCpuPercent;
      quietPolls = isQuiet ? quietPolls + 1 : 0;
    }
    previous = sample;
    if (quietPolls >= SETTLE.requiredQuietPolls) break;
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    await sleep(Math.min(SETTLE.cadenceMs, remainingMs));
  }

  return record(observations, {
    label,
    quietPolls,
    settled: quietPolls >= SETTLE.requiredQuietPolls,
    samples: samples.map(sampleFields),
    errors: samples.filter((sample) => sample.error).map((sample) => sample.error),
  });
}

function sampleSummary(samples) {
  const successful = samples.filter((sample) => !sample.error);
  const errors = samples.filter((sample) => sample.error);
  const ages = successful.map((sample) => sample.ageMs).filter((age) => Number.isFinite(age));
  const timestampDeltas = successful
    .map((sample, index) =>
      index === 0 ? null : sample.timestampMs - successful[index - 1].timestampMs,
    )
    .filter((delta) => Number.isFinite(delta));
  return {
    count: samples.length,
    successful: successful.length,
    errors,
    duplicateTimestamps: samples
      .map((sample, index) =>
        index === 0 ? null : sample.timestampMs === samples[index - 1].timestampMs,
      )
      .filter((value) => value !== null),
    nonIncreasingTimestamps: timestampDeltas.filter((delta) => delta <= 0),
    timestampDeltasMs: timestampDeltas,
    ageMs: ages,
    staleSamples: successful.filter((sample) => sample.stale).length,
    regressions: samples
      .map((sample, index) => (index === 0 ? null : compareSamples(samples[index - 1], sample)))
      .filter((comparison) => comparison?.regressions.length),
  };
}

async function upperLayerProbe(observations, handle) {
  const probePath = `/home/paseo/${PROBE_FILE}`;
  const writeBytes = V11.writeProbeMib * BYTES_PER_MIB;
  const settle = await waitQuiet(observations, handle, "v11-settle");
  assert(settle.settled, "guest did not settle before the upper-layer probe");
  const beforeSample = await readSample(handle);
  assert(!beforeSample.error, "metrics were unavailable before the upper-layer probe");
  const beforeGuest = await guestProbe(handle);

  const write = await attempt(() =>
    handle
      .connect()
      .then((sandbox) =>
        sandbox.execWith("sh", (builder) =>
          builder
            .args([
              "-lc",
              `dd if=/dev/urandom of=${probePath} bs=1048576 count=${V11.writeProbeMib} conv=fsync 2>&1 && sync`,
            ])
            .user(GUEST_USER),
        ),
      ),
  );
  assert(!write.rejected, "upper-layer probe write failed");
  await sleep(V11.metricsSampleIntervalMs + 1_500);
  const afterSample = await readSample(handle);
  assert(!afterSample.error, "metrics were unavailable after the upper-layer write");
  const afterGuest = await guestProbe(handle);
  const fileFacts = await attempt(() =>
    handle
      .connect()
      .then((sandbox) =>
        sandbox.execWith("sh", (builder) =>
          builder
            .args(["-lc", `du -m ${probePath}; stat -c '%b %B' ${probePath}`])
            .user(GUEST_USER),
        ),
      ),
  );

  const remove = await attempt(() =>
    handle
      .connect()
      .then((sandbox) =>
        sandbox.execWith("sh", (builder) =>
          builder.args(["-lc", `rm -f ${probePath} && sync`]).user(GUEST_USER),
        ),
      ),
  );
  assert(!remove.rejected, "upper-layer probe cleanup failed");
  await sleep(V11.metricsSampleIntervalMs + 1_000);
  const cleanedSample = await readSample(handle);
  const cleanedGuest = await guestProbe(handle);

  const upperUsedDeltaBytes =
    beforeSample.upperUsedBytes !== null && afterSample.upperUsedBytes !== null
      ? afterSample.upperUsedBytes - beforeSample.upperUsedBytes
      : null;
  const dfUsedDeltaMib =
    beforeGuest.df && afterGuest.df ? afterGuest.df.usedMib - beforeGuest.df.usedMib : null;
  const upperCapacityMib =
    afterSample.upperUsedBytes !== null && afterSample.upperFreeBytes !== null
      ? (afterSample.upperUsedBytes + afterSample.upperFreeBytes) / BYTES_PER_MIB
      : null;
  const rootDiskMib = runtimeState(handle).rootDiskMib;
  const upperUsedMatchesDf =
    afterSample.upperUsedBytes !== null && afterGuest.df
      ? Math.abs(afterSample.upperUsedBytes / BYTES_PER_MIB - afterGuest.df.usedMib) <= 16
      : null;
  const upperCapacityMatchesRootDisk =
    upperCapacityMib !== null && rootDiskMib !== null
      ? Math.abs(upperCapacityMib - rootDiskMib) <= Math.max(64, rootDiskMib * 0.05)
      : null;
  const writeObservedInUpperUsed =
    upperUsedDeltaBytes !== null ? upperUsedDeltaBytes >= writeBytes * 0.9 : false;
  const writeObservedInDfUsed =
    dfUsedDeltaMib !== null ? dfUsedDeltaMib >= V11.writeProbeMib * 0.9 : false;

  const entry = record(observations, {
    label: "v11-upper-layer-probe",
    probePath,
    writeBytes,
    settle: { quietPolls: settle.quietPolls, settled: settle.settled },
    writeOutput: write.rejected ? write : trimText(write.value.stdout()),
    fileFacts: fileFacts.rejected ? fileFacts : trimText(fileFacts.value.stdout()),
    removeOutput: remove.rejected ? remove : trimText(remove.value.stdout()),
    before: {
      sample: sampleFields(beforeSample),
      guest: beforeGuest,
    },
    after: {
      sample: sampleFields(afterSample),
      guest: afterGuest,
    },
    cleaned: {
      sample: sampleFields(cleanedSample),
      guest: cleanedGuest,
    },
    derived: {
      upperUsedDeltaBytes,
      dfUsedDeltaMib,
      upperCapacityMib,
      rootDiskMib,
      upperUsedMatchesDf,
      upperCapacityMatchesRootDisk,
      writeObservedInUpperUsed,
      writeObservedInDfUsed,
    },
  });

  assert(writeObservedInUpperUsed, "write probe was not visible in upperUsedBytes");
  assert(writeObservedInDfUsed, "write probe was not visible in guest df used");
  return entry.derived;
}

async function restartScenario(observations, handle, name) {
  const before = await readSample(handle);
  assert(!before.error, "metrics were unavailable before restart");
  const idBefore = handle.id;
  const restartRequestedAtMs = Date.now();
  const restart = await attempt(() => handle.restart());
  assert(!restart.rejected, "restart failed");

  let next = await Sandbox.get(name);
  next = await waitRunning(next, ONLINE_TIMEOUT_MS);
  const firstAfter = await waitMetricsAfter(next, restartRequestedAtMs, ONLINE_TIMEOUT_MS);
  const samples = [
    firstAfter,
    ...(await poll(observations, next, V11.restartPolls, V11.pollCadenceMs, "v11-post-restart")),
  ];
  const after = samples.find((sample) => !sample.error);
  assert(after, "no successful metrics sample after restart");

  const regressions = CUMULATIVE_FIELDS.filter((key) => after[key] < before[key]);
  const entry = record(observations, {
    label: "v11-restart",
    idBefore,
    idAfter: next.id,
    sameGeneration: next.id === idBefore,
    restart: restart.rejected
      ? restart
      : { id: restart.value.id, name: restart.value.name, status: restart.value.status },
    before: sampleFields(before),
    firstAfter: sampleFields(firstAfter),
    samples: samples.map(sampleFields),
    derived: {
      regressions,
      uptimeRegressed: after.uptimeMs < before.uptimeMs,
      timestampAdvanced:
        firstAfter.timestampMs !== null && before.timestampMs !== null
          ? firstAfter.timestampMs > before.timestampMs
          : null,
    },
  });
  assert(next.id === idBefore, "restart changed the sandbox generation");
  assert(after.uptimeMs < before.uptimeMs, "uptime did not regress across restart");
  return { handle: next, entry };
}

async function v11Scenario(observations, createdNames) {
  const name = `paseo-v11-met-${nonce}`;
  createdNames.add(name);
  const { created, handle: initial } = await createSandbox({
    name,
    metricsSampleIntervalMs: V11.metricsSampleIntervalMs,
  });
  let handle = await waitRunning(initial, ONLINE_TIMEOUT_MS);
  const runtime = runtimeState(handle);
  assert(
    runtime.metricsSampleIntervalMs === V11.metricsSampleIntervalMs,
    "V1.1 metrics sample interval was not applied",
  );

  const startup = await readSample(handle);
  record(observations, { label: "v11-startup", sample: startup });
  const firstAvailable = await waitMetricsAvailable(handle, ONLINE_TIMEOUT_MS);
  record(observations, { label: "v11-first-available", sample: sampleFields(firstAvailable) });
  await sleep(V11.pollCadenceMs);
  const initialSamples = await poll(
    observations,
    handle,
    V11.polls,
    V11.pollCadenceMs,
    "v11-poll",
  );
  const initialSummary = sampleSummary(initialSamples);
  record(observations, { label: "v11-poll-summary", summary: initialSummary });
  assert(
    initialSummary.successful === V11.polls,
    "fewer than five V1.1 samples succeeded after metrics became available",
  );
  assert(initialSummary.staleSamples === 0, "a V1.1 sample was stale");
  assert(
    initialSummary.ageMs.every((age) => age <= 5_000),
    "a V1.1 sample was more than 5 seconds old",
  );

  const pair = await tightPair(observations, handle, "v11-tight-pair");
  const restarted = await restartScenario(observations, handle, name);
  handle = restarted.handle;

  const stop = await attempt(() => handle.stop());
  assert(!stop.rejected, "stopping the V1.1 sandbox failed");
  await sleep(1_000);
  const stoppedHandle = await Sandbox.get(name);
  const stoppedMetrics = await attemptTimeout(
    () => stoppedHandle.metrics(),
    10_000,
    "stopped metrics()",
  );
  const stopped = record(observations, {
    label: "v11-stopped",
    status: stoppedHandle.status,
    metrics: stoppedMetrics.rejected
      ? { rejected: true, ...errorRecord(stoppedMetrics) }
      : { rejected: false, sample: sampleFields(stoppedMetrics.value) },
  });
  assert(
    stoppedMetrics.rejected,
    "a stopped V1.1 sandbox returned metrics instead of a typed error",
  );
  assert(stoppedMetrics.code, "a stopped V1.1 sandbox returned an untyped metrics error");

  return {
    name,
    createdId: created.id,
    sandboxId: handle.id,
    runtime,
    startup,
    initialSummary,
    pair,
    restart: restarted.entry,
    stopped,
  };
}

async function upperScenario(observations, createdNames) {
  const name = `paseo-v11-met-upper-${nonce}`;
  createdNames.add(name);
  const { created, handle: initial } = await createSandbox({
    name,
    metricsSampleIntervalMs: V11.metricsSampleIntervalMs,
    initArgs: QUIET_INIT_ARGS,
  });
  const handle = await waitRunning(initial, ONLINE_TIMEOUT_MS);
  const runtime = runtimeState(handle);
  assert(
    runtime.metricsSampleIntervalMs === V11.metricsSampleIntervalMs,
    "upper-layer probe sandbox metrics interval was not applied",
  );
  await waitMetricsAvailable(handle, ONLINE_TIMEOUT_MS);
  const upper = await upperLayerProbe(observations, handle);
  return { name, createdId: created.id, runtime, upper };
}

async function legacyScenario(observations, createdNames, destroyedNames) {
  const name = `paseo-v11-met-legacy-${nonce}`;
  createdNames.add(name);
  const { created, handle: initial } = await createSandbox({ name });
  const handle = await waitRunning(initial, ONLINE_TIMEOUT_MS);
  const runtime = runtimeState(handle);

  const samples = await poll(observations, handle, LEGACY.polls, LEGACY.pollCadenceMs, "legacy-poll");
  const summary = sampleSummary(samples);
  record(observations, { label: "legacy-poll-summary", summary });

  await tightPair(observations, handle, "legacy-tight-pair");

  const pause = await attempt(() => handle.pause());
  assert(!pause.rejected, "pausing the legacy sandbox failed");
  await sleep(1_000);
  const pausedHandle = await Sandbox.get(name);
  const pausedMetrics = await attemptTimeout(() => pausedHandle.metrics(), 10_000, "paused metrics()");
  const paused = record(observations, {
    label: "legacy-paused",
    status: pausedHandle.status,
    metrics: pausedMetrics.rejected
      ? { rejected: true, ...errorRecord(pausedMetrics) }
      : { rejected: false, sample: sampleFields(pausedMetrics.value) },
  });

  await pausedHandle.resume();
  const resumedHandle = await waitRunning(await Sandbox.get(name), ONLINE_TIMEOUT_MS);
  const resumed = await readSample(resumedHandle);
  record(observations, {
    label: "legacy-resumed",
    status: resumedHandle.status,
    sample: sampleFields(resumed),
    error: resumed.error ?? null,
  });

  const stop = await attempt(() => resumedHandle.stop());
  assert(!stop.rejected, "stopping the legacy sandbox failed");
  await sleep(1_000);
  const stoppedHandle = await Sandbox.get(name);
  const stoppedMetrics = await attemptTimeout(
    () => stoppedHandle.metrics(),
    10_000,
    "legacy stopped metrics()",
  );
  const stopped = record(observations, {
    label: "legacy-stopped",
    status: stoppedHandle.status,
    metrics: stoppedMetrics.rejected
      ? { rejected: true, ...errorRecord(stoppedMetrics) }
      : { rejected: false, sample: sampleFields(stoppedMetrics.value) },
  });

  const destroy = await attempt(() => stoppedHandle.destroy({ force: true, timeoutMs: 15_000 }));
  assert(!destroy.rejected, "destroying the legacy sandbox failed");
  destroyedNames.add(name);
  await sleep(1_000);
  const staleMetrics = await attemptTimeout(
    () => stoppedHandle.metrics(),
    10_000,
    "legacy stale-handle metrics()",
  );
  const stale = record(observations, {
    label: "legacy-stale-handle",
    metrics: staleMetrics.rejected
      ? { rejected: true, ...errorRecord(staleMetrics) }
      : { rejected: false, sample: sampleFields(staleMetrics.value) },
  });
  assert(staleMetrics.rejected, "a destroyed enabled sandbox returned metrics");
  assert(staleMetrics.code, "a destroyed enabled sandbox returned an untyped metrics error");

  return { name, createdId: created.id, runtime, summary, paused, stopped, stale };
}

async function disabledScenario(observations, createdNames) {
  const name = `paseo-v11-met-disabled-${nonce}`;
  createdNames.add(name);
  const { created, handle: initial } = await createSandbox({
    name,
    disableMetricsSample: true,
  });
  const handle = await waitRunning(initial, ONLINE_TIMEOUT_MS);
  const runtime = runtimeState(handle);
  assert(runtime.disableMetricsSample === true, "metrics were not disabled in the config");

  const disabledMetrics = await attemptTimeout(
    () => handle.metrics(),
    10_000,
    "disabled metrics()",
  );
  const disabled = record(observations, {
    label: "v11-disabled",
    runtime,
    metrics: disabledMetrics.rejected
      ? { rejected: true, ...errorRecord(disabledMetrics) }
      : { rejected: false, sample: sampleFields(disabledMetrics.value) },
  });
  assert(disabledMetrics.rejected, "a metrics-disabled sandbox returned metrics");

  return {
    name,
    createdId: created.id,
    runtime,
    disabled,
  };
}

async function main() {
  const summary = {
    startedAt: new Date().toISOString(),
    image: IMAGE,
    plan: {
      v11MetricsSampleIntervalMs: V11.metricsSampleIntervalMs,
      pollCadenceMs: V11.pollCadenceMs,
      polls: V11.polls,
      restartPolls: V11.restartPolls,
      writeProbeMib: V11.writeProbeMib,
      legacyPollCadenceMs: LEGACY.pollCadenceMs,
      legacyPolls: LEGACY.polls,
    },
    observations: [],
    cleanup: { sandboxes: [], verifiedRemovals: [] },
  };
  const createdNames = new Set();
  const destroyedNames = new Set();
  let scenarioError = null;

  try {
    const v11 = await v11Scenario(summary.observations, createdNames);
    summary.v11 = {
      name: v11.name,
      sandboxId: v11.sandboxId,
      runtime: v11.runtime,
      startup: v11.startup,
      poll: v11.initialSummary,
      tightPair: v11.pair,
    };

    const upper = await upperScenario(summary.observations, createdNames);
    summary.upper = {
      name: upper.name,
      runtime: upper.runtime,
      probe: upper.upper,
    };

    const legacy = await legacyScenario(
      summary.observations,
      createdNames,
      destroyedNames,
    );
    summary.legacy = {
      name: legacy.name,
      runtime: legacy.runtime,
      poll: legacy.summary,
      paused: legacy.paused,
      stopped: legacy.stopped,
      stale: legacy.stale,
    };

    const disabled = await disabledScenario(summary.observations, createdNames);
    summary.disabled = disabled;

    const v11Metrics = summary.v11.poll;
    const stopped = v11.stopped.metrics;
    const disabledMetrics = disabled.disabled.metrics;
    const stale = legacy.stale.metrics;
    const errorCodes = [stopped.code, disabledMetrics.code, stale.code].filter(Boolean);
    summary.checks = {
      v11IntervalApplied: v11.runtime.metricsSampleIntervalMs === V11.metricsSampleIntervalMs,
      v11StartupTyped: !v11.startup.error || Boolean(v11.startup.error.code),
      v11SeveralFreshSamples:
        v11Metrics.successful >= 4 &&
        v11Metrics.staleSamples === 0 &&
        v11Metrics.ageMs.every((age) => age <= 5_000),
      v11TimestampAdvanced: v11Metrics.timestampDeltasMs.some((delta) => delta > 0),
      legacySamplesOrTypedUnavailable:
        legacy.summary.successful > 0 || legacy.summary.errors.every((error) => Boolean(error.code)),
      stoppedTyped: Boolean(stopped.code),
      disabledTyped: disabledMetrics.code === "metricsDisabled",
      staleTyped: Boolean(stale.code),
      errorCodesDistinguishable: new Set(errorCodes).size >= 2,
      upperWriteObserved:
        upper.upper.writeObservedInUpperUsed && upper.upper.writeObservedInDfUsed,
      restartRegressedUptime: v11.restart.derived.uptimeRegressed,
      restartStableGeneration: v11.restart.sameGeneration,
    };
  } catch (error) {
    scenarioError = error;
    throw error;
  } finally {
    for (const name of [...createdNames].reverse()) {
      if (destroyedNames.has(name)) {
        summary.cleanup.sandboxes.push({ name, removed: true, removedInScenario: true });
        summary.cleanup.verifiedRemovals.push({ name, remaining: false });
        continue;
      }
      const handle = await Sandbox.get(name).catch(() => null);
      try {
        if (handle) await handle.destroy({ force: true, timeoutMs: 15_000 });
        else await Sandbox.remove(name);
        summary.cleanup.sandboxes.push({ name, removed: true });
      } catch (error) {
        try {
          await Sandbox.remove(name);
          summary.cleanup.sandboxes.push({ name, removed: true, fallback: "Sandbox.remove" });
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
      if (destroyedNames.has(name)) continue;
      const remaining = await Sandbox.get(name)
        .then((handle) => ({ name, remaining: true, id: handle.id }))
        .catch(() => ({ name, remaining: false }));
      summary.cleanup.verifiedRemovals.push(remaining);
    }

    summary.finishedAt = new Date().toISOString();
    const checksPass =
      scenarioError === null &&
      Boolean(summary.checks) &&
      Object.values(summary.checks).every(Boolean);
    const cleanupPass =
      summary.cleanup.sandboxes.every((entry) => entry.removed) &&
      summary.cleanup.verifiedRemovals.every((entry) => !entry.remaining);
    summary.failure = scenarioError ? errorRecord(scenarioError) : null;
    summary.pass = checksPass && cleanupPass;

    process.stdout.write(`\nSPIKE_RESULT ${JSON.stringify(summary)}\n`);
    process.stdout.write(`\n${summary.pass ? "PASS" : "FAIL"} metrics spike\n`);
    if (!summary.pass) process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`\nSpike failed: ${error instanceof Error ? error.stack : error}\n`);
  process.exitCode = 1;
});

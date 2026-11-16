import {
  MAX_SAMPLE_FUTURE_SKEW_MS,
  METRICS_POLL_INTERVAL_MS,
  STALE_SAMPLE_MS,
} from "../shared/constants";
import type {
  MetricsSample,
  MetricsUnavailableReason,
} from "../shared/contracts";

/** Shown for a rate that has no baseline yet, or after a reset. */
export const METRICS_RATE_PLACEHOLDER = "\u2014";

export interface MetricsRates {
  readonly diskReadBytesPerSecond: number | null;
  readonly diskWriteBytesPerSecond: number | null;
  readonly netRxBytesPerSecond: number | null;
  readonly netTxBytesPerSecond: number | null;
}

/** One sample with rates derived from the previous sample, when safe. */
export interface MetricsSnapshot extends MetricsRates {
  readonly sample: MetricsSample;
}

export interface MetricsTracker {
  /** Drops the baseline so the next sample cannot derive rates. */
  reset(): void;
  /**
   * Folds one sample in. A new generation, an older/stale/future timestamp, an
   * uptime regression, or any cumulative-counter regression resets the
   * baseline. A duplicate timestamp keeps the previously derived rates.
   */
  apply(
    sample: MetricsSample,
    generationId: string,
    receivedAt?: number,
  ): MetricsSnapshot;
}

interface Baseline {
  readonly generationId: string;
  readonly sample: MetricsSample;
  readonly time: number;
  readonly rates: MetricsRates;
}

const NO_RATES: MetricsRates = {
  diskReadBytesPerSecond: null,
  diskWriteBytesPerSecond: null,
  netRxBytesPerSecond: null,
  netTxBytesPerSecond: null,
};

export function createMetricsTracker(): MetricsTracker {
  let baseline: Baseline | null = null;

  return {
    reset() {
      baseline = null;
    },

    apply(sample, generationId, receivedAt = Date.now()) {
      const time = Date.parse(sample.timestamp);
      if (!Number.isFinite(time)) {
        baseline = null;
        return { sample, ...NO_RATES };
      }

      if (!baseline || baseline.generationId !== generationId) {
        baseline = { generationId, sample, time, rates: NO_RATES };
        return { sample, ...NO_RATES };
      }

      const age = receivedAt - time;
      if (age > STALE_SAMPLE_MS || -age > MAX_SAMPLE_FUTURE_SKEW_MS) {
        baseline = { generationId, sample, time, rates: NO_RATES };
        return { sample, ...NO_RATES };
      }

      if (time === baseline.time) {
        return { sample, ...baseline.rates };
      }

      const previous = baseline.sample;
      if (
        time < baseline.time ||
        sample.uptimeMs < previous.uptimeMs ||
        sample.diskReadBytes < previous.diskReadBytes ||
        sample.diskWriteBytes < previous.diskWriteBytes ||
        sample.netRxBytes < previous.netRxBytes ||
        sample.netTxBytes < previous.netTxBytes
      ) {
        baseline = { generationId, sample, time, rates: NO_RATES };
        return { sample, ...NO_RATES };
      }

      const seconds = (time - baseline.time) / 1000;
      const rates: MetricsRates = {
        diskReadBytesPerSecond:
          (sample.diskReadBytes - previous.diskReadBytes) / seconds,
        diskWriteBytesPerSecond:
          (sample.diskWriteBytes - previous.diskWriteBytes) / seconds,
        netRxBytesPerSecond: (sample.netRxBytes - previous.netRxBytes) / seconds,
        netTxBytesPerSecond: (sample.netTxBytes - previous.netTxBytes) / seconds,
      };
      baseline = { generationId, sample, time, rates };
      return { sample, ...rates };
    },
  };
}

const BYTE_UNITS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"] as const;

/** Formats a byte count with binary units, never inventing a missing value. */
export function formatBytes(bytes: number): string {
  let value = Math.max(0, bytes);
  let unit = 0;

  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }

  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${BYTE_UNITS[unit]}`;
}

export function formatPercent(percent: number): string {
  return `${Math.round(percent * 10) / 10}%`;
}

export function formatUptime(uptimeMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(uptimeMs / 1000));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export function formatMemory(sample: MetricsSample): string {
  return `${formatBytes(sample.memoryBytes)} / ${formatBytes(sample.memoryLimitBytes)}`;
}

/**
 * The SDK's upper-layer counters describe the writable overlay root, not the
 * read-only image layers. Either field may be null right after a create or
 * restart, in which case the size is unreported.
 */
export function formatRootDisk(sample: MetricsSample): string | null {
  if (sample.upperUsedBytes === null || sample.upperFreeBytes === null) return null;
  return `${formatBytes(sample.upperUsedBytes)} / ${formatBytes(
    sample.upperUsedBytes + sample.upperFreeBytes,
  )}`;
}

export function formatRate(bytesPerSecond: number | null): string {
  return bytesPerSecond === null
    ? METRICS_RATE_PLACEHOLDER
    : `${formatBytes(bytesPerSecond)}/s`;
}

export interface MetricsRow {
  readonly label: string;
  readonly value: string;
}

/** Display rows for one snapshot. CPU is shown directly, never differentiated. */
export function metricsRows(snapshot: MetricsSnapshot): MetricsRow[] {
  const rows: MetricsRow[] = [
    { label: "CPU", value: formatPercent(snapshot.sample.cpuPercent) },
    { label: "Memory", value: formatMemory(snapshot.sample) },
    { label: "Uptime", value: formatUptime(snapshot.sample.uptimeMs) },
    {
      label: "Disk",
      value: `R ${formatRate(snapshot.diskReadBytesPerSecond)}  W ${formatRate(
        snapshot.diskWriteBytesPerSecond,
      )}`,
    },
    {
      label: "Network",
      value: `RX ${formatRate(snapshot.netRxBytesPerSecond)}  TX ${formatRate(
        snapshot.netTxBytesPerSecond,
      )}`,
    },
  ];

  const rootDisk = formatRootDisk(snapshot.sample);
  if (rootDisk) rows.push({ label: "Root disk", value: rootDisk });

  return rows;
}

/** Fixed, human-readable text for every unavailable reason. */
export function metricsUnavailableText(reason: MetricsUnavailableReason): string {
  switch (reason) {
    case "no_sandbox":
      return "Metrics are unavailable because this child's sandbox no longer exists.";
    case "not_running":
      return "Metrics are available only while this VM is running.";
    case "disabled":
      return "Metrics sampling is disabled for this VM.";
    case "unavailable":
      return "Metrics are temporarily unavailable.";
  }
}

export interface MetricsPoller {
  start(): void;
  stop(): void;
  readonly active: boolean;
}

/**
 * A single-flight poller: the next request is scheduled only after the previous
 * one settles, and stopping cancels a pending tick. `stop()` is the unmount and
 * selection-change path.
 */
export function createMetricsPoller(
  poll: () => Promise<void>,
  intervalMs: number = METRICS_POLL_INTERVAL_MS,
): MetricsPoller {
  let active = false;
  let inFlight = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const scheduleNext = () => {
    if (!active) return;
    timer = setTimeout(() => {
      timer = null;
      void run();
    }, intervalMs);
  };

  const run = async (): Promise<void> => {
    if (!active || inFlight) return;
    inFlight = true;

    try {
      await poll();
    } catch {
      // A failed read is not fatal; the next tick observes again.
    } finally {
      inFlight = false;
      scheduleNext();
    }
  };

  return {
    get active() {
      return active;
    },

    start() {
      if (active) return;
      active = true;
      timer = setTimeout(() => {
        timer = null;
        void run();
      }, 0);
    },

    stop() {
      active = false;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}

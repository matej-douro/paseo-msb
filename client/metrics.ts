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

/** At the 3-second poll cadence this is about three minutes of samples. */
export const METRICS_HISTORY_LIMIT = 60;

export interface MetricsRates {
  readonly diskReadBytesPerSecond: number | null;
  readonly diskWriteBytesPerSecond: number | null;
  readonly netRxBytesPerSecond: number | null;
  readonly netTxBytesPerSecond: number | null;
}

export type MetricsSampleChange =
  | "baseline"
  | "duplicate"
  | "continuous"
  | "discontinuous"
  | "invalid";

/** One sample with rates derived from the previous sample, when safe. */
export interface MetricsSnapshot extends MetricsRates {
  readonly sample: MetricsSample;
  readonly change: MetricsSampleChange;
}

export interface MetricsTracker {
  /** Drops the baseline so the next sample cannot derive rates. */
  reset(): void;
  /**
   * Folds one sample in. A new generation, an older/stale/future timestamp, an
   * uptime regression, or any cumulative-counter regression starts a new
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

function classifyMetricsSample(
  baseline: Baseline | null,
  sample: MetricsSample,
  generationId: string,
  receivedAt: number,
): MetricsSampleChange {
  const time = Date.parse(sample.timestamp);
  if (!Number.isFinite(time)) return "invalid";
  if (!baseline || baseline.generationId !== generationId) return "baseline";

  // A repeated timestamp is a duplicate even when the sample is stale; it must
  // not append a new point on every poll.
  if (time === baseline.time) return "duplicate";

  const age = receivedAt - time;
  if (age > STALE_SAMPLE_MS || -age > MAX_SAMPLE_FUTURE_SKEW_MS) {
    return "discontinuous";
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
    return "discontinuous";
  }

  return "continuous";
}

export function createMetricsTracker(): MetricsTracker {
  let baseline: Baseline | null = null;

  return {
    reset() {
      baseline = null;
    },

    apply(sample, generationId, receivedAt = Date.now()) {
      const change = classifyMetricsSample(
        baseline,
        sample,
        generationId,
        receivedAt,
      );
      if (change === "invalid") {
        baseline = null;
        return { sample, change, ...NO_RATES };
      }
      if (!baseline || change === "baseline" || change === "discontinuous") {
        baseline = {
          generationId,
          sample,
          time: Date.parse(sample.timestamp),
          rates: NO_RATES,
        };
        return { sample, change, ...NO_RATES };
      }
      if (change === "duplicate") {
        baseline = { ...baseline, sample };
        return { sample, change, ...baseline.rates };
      }

      const previous = baseline.sample;
      const seconds = (Date.parse(sample.timestamp) - baseline.time) / 1000;
      const rates: MetricsRates = {
        diskReadBytesPerSecond:
          (sample.diskReadBytes - previous.diskReadBytes) / seconds,
        diskWriteBytesPerSecond:
          (sample.diskWriteBytes - previous.diskWriteBytes) / seconds,
        netRxBytesPerSecond: (sample.netRxBytes - previous.netRxBytes) / seconds,
        netTxBytesPerSecond: (sample.netTxBytes - previous.netTxBytes) / seconds,
      };
      baseline = {
        generationId,
        sample,
        time: Date.parse(sample.timestamp),
        rates,
      };
      return { sample, change, ...rates };
    },
  };
}

/** One point in the bounded rolling chart history. */
export interface MetricsHistoryPoint {
  readonly sample: MetricsSample;
  readonly rates: MetricsRates;
  /** Points sharing a segment may be connected; a new segment is a gap. */
  readonly segment: number;
}

export interface MetricsHistory {
  readonly points: readonly MetricsHistoryPoint[];
  append(
    sample: MetricsSample,
    generationId: string,
    receivedAt?: number,
  ): readonly MetricsHistoryPoint[];
  reset(): void;
}

function ratesOf(snapshot: MetricsSnapshot): MetricsRates {
  return {
    diskReadBytesPerSecond: snapshot.diskReadBytesPerSecond,
    diskWriteBytesPerSecond: snapshot.diskWriteBytesPerSecond,
    netRxBytesPerSecond: snapshot.netRxBytesPerSecond,
    netTxBytesPerSecond: snapshot.netTxBytesPerSecond,
  };
}

/**
 * A bounded in-memory ring for one selected generation. A duplicate timestamp
 * adds no point; a discontinuous sample starts a new segment instead of
 * connecting across it. Older points are evicted once the limit is reached.
 */
export function createMetricsHistory(
  limit: number = METRICS_HISTORY_LIMIT,
): MetricsHistory {
  const max = Math.max(1, Math.floor(limit));
  let points: readonly MetricsHistoryPoint[] = [];
  let tracker = createMetricsTracker();
  let generation: string | null = null;
  let segment = 0;

  return {
    get points() {
      return points;
    },

    reset() {
      points = [];
      tracker.reset();
      generation = null;
      segment = 0;
    },

    append(sample, generationId, receivedAt = Date.now()) {
      if (generation !== generationId) {
        points = [];
        tracker = createMetricsTracker();
        generation = generationId;
        segment = 0;
      }

      const snapshot = tracker.apply(sample, generationId, receivedAt);
      if (snapshot.change === "invalid") {
        points = [];
        segment = 0;
        return points;
      }

      const last = points.length > 0 ? points[points.length - 1] : null;
      if (snapshot.change === "duplicate" && last) {
        points = [...points.slice(0, -1), { ...last, sample }];
        return points;
      }

      if (!last || snapshot.change === "baseline") {
        segment = 0;
        points = [{ sample, rates: ratesOf(snapshot), segment }];
        return points;
      }
      if (snapshot.change === "discontinuous") {
        segment += 1;
      }

      points = [
        ...points,
        { sample, rates: ratesOf(snapshot), segment },
      ].slice(-max);
      return points;
    },
  };
}

export type MetricsSeriesKey =
  | "cpu"
  | "memoryUsed"
  | "diskRead"
  | "diskWrite"
  | "netRx"
  | "netTx";

export type MetricsFamily = "cpu" | "memory" | "diskIo" | "network";

export interface MetricsSeriesDefinition {
  readonly key: MetricsSeriesKey;
  readonly family: MetricsFamily;
  readonly label: string;
  /** Fixed categorical colour, independent of the theme's status colours. */
  readonly color: string;
}

/**
 * The colours are a fixed, vivid categorical palette so every line is distinct
 * on both light and dark surfaces; they deliberately do not reuse the theme's
 * semantic status colours.
 */
export const METRICS_SERIES: readonly MetricsSeriesDefinition[] = [
  {
    key: "cpu",
    family: "cpu",
    label: "CPU",
    color: "#3B82F6",
  },
  {
    key: "memoryUsed",
    family: "memory",
    label: "Memory used",
    color: "#22C55E",
  },
  {
    key: "diskRead",
    family: "diskIo",
    label: "Disk read",
    color: "#F59E0B",
  },
  {
    key: "diskWrite",
    family: "diskIo",
    label: "Disk write",
    color: "#EF4444",
  },
  {
    key: "netRx",
    family: "network",
    label: "Network RX",
    color: "#06B6D4",
  },
  {
    key: "netTx",
    family: "network",
    label: "Network TX",
    color: "#A855F7",
  },
];

export const METRICS_FAMILIES: readonly MetricsFamily[] = [
  "cpu",
  "memory",
  "diskIo",
  "network",
];

/** The reported value for one series, or null when the sample omits it. */
export function metricsSeriesValue(
  point: MetricsHistoryPoint,
  key: MetricsSeriesKey,
): number | null {
  const { sample, rates } = point;
  switch (key) {
    case "cpu":
      return sample.cpuPercent;
    case "memoryUsed":
      return sample.memoryBytes;
    case "diskRead":
      return rates.diskReadBytesPerSecond;
    case "diskWrite":
      return rates.diskWriteBytesPerSecond;
    case "netRx":
      return rates.netRxBytesPerSecond;
    case "netTx":
      return rates.netTxBytesPerSecond;
  }
}

function reportedSeriesValue(
  point: MetricsHistoryPoint,
  key: MetricsSeriesKey,
): number | null {
  const value = metricsSeriesValue(point, key);
  return value === null || value < 0 ? null : value;
}

function familySeries(family: MetricsFamily): MetricsSeriesDefinition[] {
  return METRICS_SERIES.filter((series) => series.family === family);
}

function familyMax(
  family: MetricsFamily,
  points: readonly MetricsHistoryPoint[],
): number {
  if (family === "cpu") {
    // CPU is a percentage line; 100 keeps the common case stable and a
    // multi-core burst above 100% still stays inside the plot.
    return points.reduce(
      (max, point) => Math.max(max, point.sample.cpuPercent),
      100,
    );
  }

  if (family === "memory") {
    return points.reduce(
      (max, point) =>
        Math.max(max, point.sample.memoryLimitBytes, point.sample.memoryBytes),
      0,
    ) || 1;
  }

  let max = 0;
  for (const point of points) {
    for (const series of familySeries(family)) {
      const value = reportedSeriesValue(point, series.key);
      if (value !== null) max = Math.max(max, value);
    }
  }
  return max || 1;
}

export interface MetricsChartPoint {
  readonly x: number;
  readonly y: number;
}

/** One contiguous run of a series; a gap or segment change starts a new run. */
export interface MetricsChartLine {
  readonly series: MetricsSeriesKey;
  readonly label: string;
  readonly color: string;
  readonly points: readonly MetricsChartPoint[];
}

export interface MetricsChartModel {
  readonly lines: readonly MetricsChartLine[];
}

export interface MetricsChartLegendItem {
  readonly series: MetricsSeriesKey;
  readonly label: string;
  readonly color: string;
}

const CHART_LEFT_INSET = 6;
const CHART_RIGHT_INSET = 6;
/** Keeps line strokes and point dots inside the bordered content box. */
export const METRICS_PLOT_PADDING = 3;

interface ChartGeometry {
  readonly left: number;
  readonly spacing: number;
}

/** The same geometry is used to draw points and to map the cursor back to one. */
function chartGeometry(width: number, capacity: number): ChartGeometry {
  const left = Math.min(CHART_LEFT_INSET, width / 3);
  const right = Math.min(CHART_RIGHT_INSET, width / 6);
  const usable = Math.max(0, width - left - right);
  return { left, spacing: usable / Math.max(1, capacity - 1) };
}

/**
 * Fixed spacing based on the configured window, not the current point count.
 * Points therefore start at the left and keep their distance while the chart
 * fills up instead of spreading across the whole width.
 */
function chartX(
  index: number,
  width: number,
  capacity: number,
): number {
  const { left, spacing } = chartGeometry(width, capacity);
  return left + index * spacing;
}

/**
 * One merged line chart for every live series. Each family keeps its own
 * scale so unlike units are never added together; series are plotted
 * independently rather than stacked, so a line's height is its own value.
 */
export function metricsChart(
  points: readonly MetricsHistoryPoint[],
  width: number,
  height: number,
  capacity: number = METRICS_HISTORY_LIMIT,
): MetricsChartModel {
  if (points.length === 0 || width <= 0 || height <= 0) {
    return { lines: [] };
  }

  const usableHeight = Math.max(0, height - METRICS_PLOT_PADDING * 2);
  const lines: MetricsChartLine[] = [];

  for (const family of METRICS_FAMILIES) {
    const max = familyMax(family, points);
    const series = familySeries(family);

    for (const seriesDefinition of series) {
      const runs: MetricsChartPoint[][] = [];
      let current: MetricsChartPoint[] = [];
      let previousSegment: number | null = null;

      points.forEach((point, pointIndex) => {
        const value = reportedSeriesValue(point, seriesDefinition.key);
        if (value === null) {
          if (current.length > 0) runs.push(current);
          current = [];
          previousSegment = null;
          return;
        }
        if (previousSegment !== null && point.segment !== previousSegment) {
          if (current.length > 0) runs.push(current);
          current = [];
        }

        current.push({
          x: chartX(pointIndex, width, capacity),
          y: METRICS_PLOT_PADDING + (1 - value / max) * usableHeight,
        });
        previousSegment = point.segment;
      });
      if (current.length > 0) runs.push(current);

      for (const run of runs) {
        lines.push({
          series: seriesDefinition.key,
          label: seriesDefinition.label,
          color: seriesDefinition.color,
          points: run,
        });
      }
    }
  }

  return { lines };
}

/** Y position of a gridline at a fraction from the top of the data span. */
export function metricsGridlineTop(ratio: number, height: number): number {
  const usableHeight = Math.max(0, height - METRICS_PLOT_PADDING * 2);
  return METRICS_PLOT_PADDING + ratio * usableHeight;
}

/** One legend entry per series that has at least one reported point. */
export function metricsChartLegend(
  model: MetricsChartModel,
): MetricsChartLegendItem[] {
  const seen = new Set<MetricsSeriesKey>();
  const items: MetricsChartLegendItem[] = [];

  for (const line of model.lines) {
    if (seen.has(line.series)) continue;
    seen.add(line.series);
    items.push({
      series: line.series,
      label: line.label,
      color: line.color,
    });
  }

  return items;
}

/** Horizontal position in pixels for one point at the fixed window spacing. */
export function metricsPointX(
  points: readonly MetricsHistoryPoint[],
  index: number,
  width: number,
  capacity: number = METRICS_HISTORY_LIMIT,
): number | null {
  if (width <= 0 || index < 0 || index >= points.length) return null;
  return chartX(index, width, capacity);
}

/** The newest point with this timestamp, or null when it is not present. */
export function metricsIndexByTimestamp(
  points: readonly MetricsHistoryPoint[],
  timestamp: string,
): number | null {
  for (let index = points.length - 1; index >= 0; index -= 1) {
    if (points[index].sample.timestamp === timestamp) return index;
  }
  return null;
}

/** The reported point nearest a horizontal pixel offset in the chart. */
export function metricsPointIndexAt(
  points: readonly MetricsHistoryPoint[],
  offsetX: number,
  width: number,
  capacity: number = METRICS_HISTORY_LIMIT,
): number | null {
  if (points.length === 0 || width <= 0) return null;

  const { left, spacing } = chartGeometry(width, capacity);
  const target = spacing > 0 ? (offsetX - left) / spacing : 0;

  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (let index = 0; index < points.length; index += 1) {
    const distance = Math.abs(index - target);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  }

  return bestIndex;
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

export function formatRate(bytesPerSecond: number | null): string {
  return bytesPerSecond === null
    ? METRICS_RATE_PLACEHOLDER
    : `${formatBytes(bytesPerSecond)}/s`;
}

/** Deterministic UTC clock for a sample timestamp, e.g. `14:32:03`. */
export function formatSampleClock(timestamp: string): string {
  const time = Date.parse(timestamp);
  if (!Number.isFinite(time)) return METRICS_RATE_PLACEHOLDER;
  return new Date(time).toISOString().slice(11, 19);
}

export interface MetricsTooltipRow {
  readonly label: string;
  readonly value: string;
}

export interface MetricsTooltip {
  readonly timestamp: string;
  readonly clock: string;
  readonly rows: readonly MetricsTooltipRow[];
}

/** Exact values for one point. Unreported rates are `—`, never zero. */
export function metricsTooltip(point: MetricsHistoryPoint): MetricsTooltip {
  const { sample, rates } = point;
  const rows: MetricsTooltipRow[] = [
    { label: "CPU", value: formatPercent(sample.cpuPercent) },
    { label: "Memory", value: formatMemory(sample) },
  ];

  rows.push({ label: "Uptime", value: formatUptime(sample.uptimeMs) });
  rows.push({
    label: "Disk read",
    value: formatRate(rates.diskReadBytesPerSecond),
  });
  rows.push({
    label: "Disk write",
    value: formatRate(rates.diskWriteBytesPerSecond),
  });
  rows.push({ label: "Network RX", value: formatRate(rates.netRxBytesPerSecond) });
  rows.push({ label: "Network TX", value: formatRate(rates.netTxBytesPerSecond) });

  return {
    timestamp: sample.timestamp,
    clock: formatSampleClock(sample.timestamp),
    rows,
  };
}

export interface MetricsChartAccessibility {
  readonly label: string;
  readonly value: string;
}

/**
 * The chart's accessibility label and value. Exact readings are never
 * hover-only: a screen reader hears the selected or latest sample.
 */
export function metricsChartAccessibility(
  points: readonly MetricsHistoryPoint[],
  selectedIndex: number | null,
): MetricsChartAccessibility {
  if (points.length === 0) {
    return { label: "Live metrics chart", value: "No samples yet." };
  }

  const validIndex =
    selectedIndex !== null && selectedIndex >= 0 && selectedIndex < points.length
      ? selectedIndex
      : null;
  const index = validIndex ?? points.length - 1;
  const tooltip = metricsTooltip(points[index]);
  const values = tooltip.rows
    .map((row) => `${row.label} ${row.value}`)
    .join(", ");
  const selection =
    validIndex === null
      ? "Latest sample"
      : `Sample ${index + 1} of ${points.length}`;

  return {
    label: `Live metrics chart, ${points.length} sample${
      points.length === 1 ? "" : "s"
    }`,
    value: `${selection} at ${tooltip.clock} UTC. ${values}.`,
  };
}

export interface RootDiskUsage {
  readonly usedBytes: number;
  readonly totalBytes: number;
  readonly percent: number;
}

/**
 * Writable upper-layer usage against its reported capacity. Null when either
 * field is unreported or the total is non-positive, so a missing disk is never
 * shown as zero.
 */
export function rootDiskUsage(sample: MetricsSample): RootDiskUsage | null {
  const used = sample.upperUsedBytes;
  const free = sample.upperFreeBytes;
  if (used === null || free === null) return null;

  const total = used + free;
  if (!(total > 0)) return null;

  return {
    usedBytes: used,
    totalBytes: total,
    percent: (used / total) * 100,
  };
}

export function rootDiskUsageText(usage: RootDiskUsage): string {
  return `${formatBytes(usage.usedBytes)} / ${formatBytes(
    usage.totalBytes,
  )} (${Math.round(usage.percent)}%)`;
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

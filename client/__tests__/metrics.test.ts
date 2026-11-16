import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MetricsSample } from "../../shared/contracts";
import {
  createMetricsHistory,
  createMetricsPoller,
  createMetricsTracker,
  formatBytes,
  formatPercent,
  formatUptime,
  METRICS_HISTORY_LIMIT,
  METRICS_RATE_PLACEHOLDER,
  METRICS_SERIES,
  metricsChart,
  metricsChartAccessibility,
  metricsChartLegend,
  metricsGridlineTop,
  metricsIndexByTimestamp,
  metricsPointIndexAt,
  metricsPointX,
  metricsTooltip,
  metricsUnavailableText,
  rootDiskUsage,
  rootDiskUsageText,
  type MetricsHistoryPoint,
} from "../metrics";

const GENERATION = "sandbox_1";
const T0 = "2026-11-16T00:00:00.000Z";
const T2 = "2026-11-16T00:00:02.000Z";
const T3 = "2026-11-16T00:00:03.000Z";

function sample(overrides: Partial<MetricsSample> = {}): MetricsSample {
  return {
    timestamp: T0,
    cpuPercent: 18,
    memoryBytes: 1024 ** 3,
    memoryLimitBytes: 4 * 1024 ** 3,
    memoryAvailableBytes: 3 * 1024 ** 3,
    diskReadBytes: 1_000,
    diskWriteBytes: 2_000,
    netRxBytes: 3_000,
    netTxBytes: 4_000,
    upperUsedBytes: 1024 ** 3,
    upperFreeBytes: 3 * 1024 ** 3,
    uptimeMs: 12_000,
    ...overrides,
  };
}

function timeOf(timestamp: string): number {
  return Date.parse(timestamp);
}

function at(seconds: number): string {
  return new Date(Date.parse(T0) + seconds * 1000).toISOString();
}

describe("formatBytes", () => {
  it("uses binary units and keeps sub-unit values exact", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024)).toBe("1.0 KiB");
    expect(formatBytes(840 * 1024)).toBe("840 KiB");
    expect(formatBytes(1.7 * 1024 ** 3)).toBe("1.7 GiB");
    expect(formatBytes(10 * 1024 ** 3)).toBe("10.0 GiB");
  });
});

describe("formatUptime", () => {
  it("renders seconds, minutes, hours, and days", () => {
    expect(formatUptime(41_000)).toBe("41s");
    expect(formatUptime(761_000)).toBe("12m 41s");
    expect(formatUptime(3 * 3_600_000 + 4 * 60_000)).toBe("3h 4m");
    expect(formatUptime(2 * 86_400_000 + 3 * 3_600_000)).toBe("2d 3h");
  });
});

describe("createMetricsHistory", () => {
  it("starts one point at segment 0 without rates", () => {
    const points = createMetricsHistory().append(sample(), GENERATION, timeOf(T0));

    expect(points).toHaveLength(1);
    expect(points[0].segment).toBe(0);
    expect(points[0].rates.diskReadBytesPerSecond).toBeNull();
  });

  it("evicts older points beyond the configured window", () => {
    const history = createMetricsHistory(3);
    for (let index = 0; index < 5; index += 1) {
      const timestamp = at(index * 2);
      history.append(
        sample({ timestamp, uptimeMs: 12_000 + index * 2_000 }),
        GENERATION,
        timeOf(timestamp),
      );
    }

    expect(history.points.map((point) => point.sample.timestamp)).toEqual([
      at(4),
      at(6),
      at(8),
    ]);
  });

  it("keeps the shared window by default", () => {
    const history = createMetricsHistory();
    for (let index = 0; index < METRICS_HISTORY_LIMIT + 5; index += 1) {
      const timestamp = at(index * 2);
      history.append(
        sample({ timestamp, uptimeMs: 12_000 + index * 2_000 }),
        GENERATION,
        timeOf(timestamp),
      );
    }

    expect(history.points).toHaveLength(METRICS_HISTORY_LIMIT);
  });

  it("adds no point for a duplicate timestamp but updates absolute values", () => {
    const history = createMetricsHistory();
    history.append(sample(), GENERATION, timeOf(T0));
    const points = history.append(
      sample({ diskReadBytes: 999 }),
      GENERATION,
      timeOf(T0),
    );

    expect(points).toHaveLength(1);
    expect(points[0].sample.diskReadBytes).toBe(999);
    expect(points[0].rates.diskReadBytesPerSecond).toBeNull();
  });

  it("adds no point for a repeated stale timestamp", () => {
    const history = createMetricsHistory();
    history.append(sample(), GENERATION, timeOf(T0));
    for (let index = 0; index < 3; index += 1) {
      history.append(sample(), GENERATION, timeOf(T0) + 20_000);
    }

    expect(history.points).toHaveLength(1);
    expect(history.points[0].segment).toBe(0);
  });

  it("starts a new segment at a counter regression", () => {
    const history = createMetricsHistory();
    history.append(sample(), GENERATION, timeOf(T0));
    history.append(
      sample({ timestamp: T2, uptimeMs: 14_000, netTxBytes: 8_000 }),
      GENERATION,
      timeOf(T2),
    );
    const points = history.append(
      sample({ timestamp: T3, uptimeMs: 16_000, netTxBytes: 0 }),
      GENERATION,
      timeOf(T3),
    );

    expect(points[points.length - 1].segment).toBe(1);
    expect(points[points.length - 1].rates.netTxBytesPerSecond).toBeNull();
  });

  it("starts a new segment at a stale sample", () => {
    const history = createMetricsHistory();
    history.append(sample(), GENERATION, timeOf(T0));
    history.append(sample({ timestamp: T2, uptimeMs: 14_000 }), GENERATION, timeOf(T2));
    const points = history.append(
      sample({ timestamp: T3, uptimeMs: 16_000 }),
      GENERATION,
      timeOf(T3) + 10_001,
    );

    expect(points[points.length - 1].segment).toBe(1);
    expect(points[points.length - 1].rates.netTxBytesPerSecond).toBeNull();
  });

  it("starts a new segment at a future-dated sample", () => {
    const history = createMetricsHistory();
    history.append(sample(), GENERATION, timeOf(T0));
    const points = history.append(
      sample({ timestamp: T3 }),
      GENERATION,
      timeOf(T3) - 5_001,
    );

    expect(points[points.length - 1].segment).toBe(1);
  });

  it("resets points when the generation changes", () => {
    const history = createMetricsHistory();
    history.append(sample(), GENERATION, timeOf(T0));
    const points = history.append(sample({ timestamp: T2 }), "sandbox_2", timeOf(T2));

    expect(points).toHaveLength(1);
    expect(points[0].segment).toBe(0);
  });

  it("clears on reset", () => {
    const history = createMetricsHistory();
    history.append(sample(), GENERATION, timeOf(T0));
    history.reset();

    expect(history.points).toHaveLength(0);
  });
});

function twoPointHistory(): readonly MetricsHistoryPoint[] {
  const history = createMetricsHistory();
  history.append(sample(), GENERATION, timeOf(T0));
  history.append(
    sample({
      timestamp: T2,
      uptimeMs: 14_000,
      diskReadBytes: 3_000,
      diskWriteBytes: 6_000,
      netRxBytes: 9_000,
      netTxBytes: 12_000,
    }),
    GENERATION,
    timeOf(T2),
  );
  return history.points;
}

describe("METRICS_SERIES", () => {
  it("gives every graphed series a distinct colour", () => {
    const colors = METRICS_SERIES.map((series) => series.color);

    expect(new Set(colors).size).toBe(colors.length);
    expect(colors.every((color) => /^#[0-9A-F]{6}$/i.test(color))).toBe(true);
  });
});

describe("metricsChart", () => {
  it("starts at the left and keeps fixed spacing for a partial window", () => {
    const model = metricsChart(twoPointHistory(), 300, 60);
    const cpu = model.lines.find((line) => line.series === "cpu");
    if (!cpu) throw new Error("expected a CPU line");

    expect(cpu.points[0].x).toBeCloseTo(6);
    expect(cpu.points[1].x - cpu.points[0].x).toBeCloseTo((300 - 12) / 59);
    expect(cpu.points[1].x).toBeLessThan(20);
  });

  it("merges every live series into one model with a legend", () => {
    const model = metricsChart(twoPointHistory(), 300, 60);

    expect(metricsChartLegend(model).map((item) => item.series)).toEqual([
      "cpu",
      "memoryUsed",
      "diskRead",
      "diskWrite",
      "netRx",
      "netTx",
    ]);
  });

  it("normalizes memory used against the reported limit", () => {
    const model = metricsChart(twoPointHistory(), 300, 60);
    const used = model.lines.find((line) => line.series === "memoryUsed");
    if (!used) throw new Error("expected a memory line");

    // Second point: 1 GiB used of a 4 GiB limit, inside 3px padding.
    expect(used.points[1].y).toBeCloseTo(43.5);
  });

  it("plots each rate series at its own value instead of stacking", () => {
    const model = metricsChart(twoPointHistory(), 300, 60);
    const read = model.lines.find((line) => line.series === "diskRead");
    const write = model.lines.find((line) => line.series === "diskWrite");
    if (!read || !write) throw new Error("expected disk lines");

    // Only the second sample has rates: read 1000 B/s, write 2000 B/s;
    // family max is 2000, so read sits halfway and write at the top padding.
    expect(read.points[0].y).toBeCloseTo(30);
    expect(write.points[0].y).toBeCloseTo(3);
  });

  it("breaks a line at a segment change instead of connecting across it", () => {
    const history = createMetricsHistory();
    history.append(sample(), GENERATION, timeOf(T0));
    history.append(
      sample({ timestamp: T2, uptimeMs: 14_000 }),
      GENERATION,
      timeOf(T2),
    );
    history.append(sample({ timestamp: T3, uptimeMs: 200 }), GENERATION, timeOf(T3));

    const cpuLines = metricsChart(history.points, 300, 60).lines.filter(
      (line) => line.series === "cpu",
    );
    expect(cpuLines).toHaveLength(2);
    expect(cpuLines.map((line) => line.points.length)).toEqual([2, 1]);
  });

  it("starts rate series only once a baseline exists", () => {
    const diskRead = metricsChart(twoPointHistory(), 300, 60).lines.find(
      (line) => line.series === "diskRead",
    );
    if (!diskRead) throw new Error("expected a disk-read line");

    expect(diskRead.points).toHaveLength(1);
    expect(diskRead.points[0].x).toBeCloseTo(6 + (300 - 12) / 59);
  });

  it("renders a single sample as one point per series", () => {
    const model = metricsChart(
      createMetricsHistory().append(sample(), GENERATION, timeOf(T0)),
      300,
      60,
    );

    expect(model.lines.length).toBeGreaterThan(0);
    expect(model.lines.every((line) => line.points.length === 1)).toBe(true);
  });
});

describe("metricsPointIndexAt", () => {
  const width = 300;
  const capacity = METRICS_HISTORY_LIMIT;

  it("selects the point under the cursor and clamps outside the chart", () => {
    const points = twoPointHistory();
    const first = metricsPointX(points, 0, width, capacity);
    const second = metricsPointX(points, 1, width, capacity);
    if (first === null || second === null) {
      throw new Error("expected point positions");
    }

    expect(metricsPointIndexAt(points, first, width, capacity)).toBe(0);
    expect(metricsPointIndexAt(points, second, width, capacity)).toBe(1);
    expect(metricsPointIndexAt(points, -100, width, capacity)).toBe(0);
    expect(metricsPointIndexAt(points, 1000, width, capacity)).toBe(1);
    expect(metricsPointIndexAt([], 100, width, capacity)).toBeNull();
    expect(metricsPointIndexAt(points, 100, 0, capacity)).toBeNull();
  });

  it("round-trips every point position", () => {
    const points = twoPointHistory();

    for (let index = 0; index < points.length; index += 1) {
      const x = metricsPointX(points, index, width, capacity);
      if (x === null) throw new Error("expected point position");
      expect(metricsPointIndexAt(points, x, width, capacity)).toBe(index);
    }
  });
});

describe("metricsPointX", () => {
  it("uses fixed window spacing and returns null outside the chart", () => {
    const points = twoPointHistory();

    expect(metricsPointX(points, 0, 300, 60)).toBeCloseTo(6);
    expect(metricsPointX(points, 1, 300, 60)).toBeCloseTo(6 + 288 / 59);
    expect(metricsPointX(points, -1, 300)).toBeNull();
    expect(metricsPointX(points, 2, 300)).toBeNull();
    expect(metricsPointX(points, 0, 0)).toBeNull();
  });

  it("places the last point of a full window at the right inset", () => {
    const history = createMetricsHistory();
    for (let index = 0; index < METRICS_HISTORY_LIMIT; index += 1) {
      const timestamp = at(index * 2);
      history.append(
        sample({ timestamp, uptimeMs: 12_000 + index * 2_000 }),
        GENERATION,
        timeOf(timestamp),
      );
    }

    expect(
      metricsPointX(
        history.points,
        METRICS_HISTORY_LIMIT - 1,
        300,
        METRICS_HISTORY_LIMIT,
      ),
    ).toBeCloseTo(294);
  });

  it("keeps the left inset inside a very narrow chart", () => {
    expect(metricsPointX(twoPointHistory(), 0, 9, 60)).toBeCloseTo(3);
  });
});

describe("metricsIndexByTimestamp", () => {
  it("returns the newest matching point and null when absent", () => {
    const history = createMetricsHistory();
    history.append(sample({ timestamp: at(10) }), GENERATION, timeOf(at(10)));
    history.append(
      sample({ timestamp: at(6), uptimeMs: 6_000 }),
      GENERATION,
      timeOf(at(6)),
    );
    history.append(
      sample({ timestamp: at(10), uptimeMs: 10_000 }),
      GENERATION,
      timeOf(at(10)),
    );

    expect(metricsIndexByTimestamp(history.points, at(10))).toBe(2);
    expect(metricsIndexByTimestamp(history.points, at(0))).toBeNull();
  });
});

describe("metricsGridlineTop", () => {
  it("aligns gridlines to the padded data span", () => {
    expect(metricsGridlineTop(0, 60)).toBeCloseTo(3);
    expect(metricsGridlineTop(0.5, 60)).toBeCloseTo(30);
    expect(metricsGridlineTop(1, 60)).toBeCloseTo(57);
  });
});

describe("metricsTooltip", () => {
  it("reports the graphed values with placeholders for missing rates", () => {
    const points = createMetricsHistory().append(sample(), GENERATION, timeOf(T0));
    const tooltip = metricsTooltip(points[0]);
    const rows = Object.fromEntries(tooltip.rows.map((row) => [row.label, row.value]));

    expect(tooltip.clock).toBe("00:00:00");
    expect(rows.CPU).toBe("18%");
    expect(rows.Memory).toBe("1.0 GiB / 4.0 GiB");
    expect(rows["Disk read"]).toBe(METRICS_RATE_PLACEHOLDER);
  });
});

describe("metricsChartAccessibility", () => {
  it("exposes the latest sample when nothing is selected", () => {
    const accessibility = metricsChartAccessibility(twoPointHistory(), null);

    expect(accessibility.label).toBe("Live metrics chart, 2 samples");
    expect(accessibility.value).toContain("Latest sample at 00:00:02 UTC");
    expect(accessibility.value).toContain("CPU 18%");
  });

  it("describes the selected sample and an empty chart", () => {
    const accessibility = metricsChartAccessibility(twoPointHistory(), 0);

    expect(accessibility.value).toContain("Sample 1 of 2 at 00:00:00 UTC");
    expect(metricsChartAccessibility([], 0)).toEqual({
      label: "Live metrics chart",
      value: "No samples yet.",
    });
  });

  it("falls back to the latest sample for an out-of-range index", () => {
    const points = twoPointHistory();

    expect(metricsChartAccessibility(points, 99).value).toContain(
      "Latest sample at 00:00:02 UTC",
    );
    expect(metricsChartAccessibility(points, -1).value).toContain(
      "Latest sample at 00:00:02 UTC",
    );
  });
});

describe("rootDiskUsage", () => {
  it("computes the writable upper-layer ratio", () => {
    const usage = rootDiskUsage(sample());
    if (!usage) throw new Error("expected root-disk usage");

    expect(usage.usedBytes).toBe(1024 ** 3);
    expect(usage.totalBytes).toBe(4 * 1024 ** 3);
    expect(usage.percent).toBeCloseTo(25);
    expect(rootDiskUsageText(usage)).toBe("1.0 GiB / 4.0 GiB (25%)");
  });

  it("is null for missing fields and non-positive totals", () => {
    expect(rootDiskUsage(sample({ upperUsedBytes: null }))).toBeNull();
    expect(rootDiskUsage(sample({ upperFreeBytes: null }))).toBeNull();
    expect(rootDiskUsage(sample({ upperUsedBytes: 0, upperFreeBytes: 0 }))).toBeNull();
  });
});

describe("createMetricsTracker", () => {
  it("derives rates from consecutive samples", () => {
    const tracker = createMetricsTracker();
    tracker.apply(sample(), GENERATION, timeOf(T0));
    const snapshot = tracker.apply(
      sample({
        timestamp: T2,
        uptimeMs: 14_000,
        diskReadBytes: 3_000,
        diskWriteBytes: 6_000,
        netRxBytes: 9_000,
        netTxBytes: 12_000,
      }),
      GENERATION,
      timeOf(T2),
    );

    expect(snapshot.diskReadBytesPerSecond).toBe(1_000);
    expect(snapshot.diskWriteBytesPerSecond).toBe(2_000);
    expect(snapshot.netRxBytesPerSecond).toBe(3_000);
    expect(snapshot.netTxBytesPerSecond).toBe(4_000);
  });

  it("keeps prior rates for a duplicate timestamp without recomputing", () => {
    const tracker = createMetricsTracker();
    tracker.apply(sample(), GENERATION, timeOf(T0));
    const first = tracker.apply(
      sample({
        timestamp: T2,
        uptimeMs: 14_000,
        diskReadBytes: 3_000,
        diskWriteBytes: 6_000,
        netRxBytes: 9_000,
        netTxBytes: 12_000,
      }),
      GENERATION,
      timeOf(T2),
    );
    const duplicate = tracker.apply(
      sample({ timestamp: T2, diskReadBytes: 999_999 }),
      GENERATION,
      timeOf(T2),
    );

    expect(duplicate.sample.diskReadBytes).toBe(999_999);
    expect(duplicate.diskReadBytesPerSecond).toBe(first.diskReadBytesPerSecond);
    expect(duplicate.netTxBytesPerSecond).toBe(first.netTxBytesPerSecond);
  });

  it("uses a duplicate's updated counters for the next delta", () => {
    const tracker = createMetricsTracker();
    tracker.apply(sample({ diskReadBytes: 1_000 }), GENERATION, timeOf(T0));
    tracker.apply(sample({ diskReadBytes: 2_000 }), GENERATION, timeOf(T0));
    const next = tracker.apply(
      sample({ timestamp: T2, uptimeMs: 14_000, diskReadBytes: 3_000 }),
      GENERATION,
      timeOf(T2),
    );

    expect(next.diskReadBytesPerSecond).toBe(500);
  });

  it("resets rates for a stale sample", () => {
    const tracker = createMetricsTracker();
    tracker.apply(sample(), GENERATION, timeOf(T0));
    tracker.apply(sample({ timestamp: T2 }), GENERATION, timeOf(T2));
    const stale = tracker.apply(
      sample({ timestamp: T3 }),
      GENERATION,
      timeOf(T3) + 10_001,
    );

    expect(stale.diskReadBytesPerSecond).toBeNull();
    expect(stale.sample.timestamp).toBe(T3);
  });

  it("resets rates for a future-dated sample", () => {
    const tracker = createMetricsTracker();
    tracker.apply(sample(), GENERATION, timeOf(T0));
    const future = tracker.apply(sample({ timestamp: T3 }), GENERATION, timeOf(T3) - 5_001);

    expect(future.netRxBytesPerSecond).toBeNull();
  });

  it("resets rates for a different generation", () => {
    const tracker = createMetricsTracker();
    tracker.apply(sample(), GENERATION, timeOf(T0));
    tracker.apply(sample({ timestamp: T2 }), GENERATION, timeOf(T2));
    const changed = tracker.apply(
      sample({ timestamp: T3 }),
      "sandbox_2",
      timeOf(T3),
    );

    expect(changed.diskReadBytesPerSecond).toBeNull();
  });

  it("resets rates for a non-increasing timestamp", () => {
    const tracker = createMetricsTracker();
    tracker.apply(sample(), GENERATION, timeOf(T0));
    tracker.apply(sample({ timestamp: T2 }), GENERATION, timeOf(T2));
    const older = tracker.apply(sample({ timestamp: T0 }), GENERATION, timeOf(T0));

    expect(older.diskWriteBytesPerSecond).toBeNull();
  });

  it("resets rates when uptime regresses", () => {
    const tracker = createMetricsTracker();
    tracker.apply(sample({ uptimeMs: 12_000 }), GENERATION, timeOf(T0));
    const restarted = tracker.apply(
      sample({ timestamp: T2, uptimeMs: 200 }),
      GENERATION,
      timeOf(T2),
    );

    expect(restarted.diskReadBytesPerSecond).toBeNull();
  });

  it("resets rates when any cumulative counter regresses", () => {
    for (const field of [
      "diskReadBytes",
      "diskWriteBytes",
      "netRxBytes",
      "netTxBytes",
    ] as const) {
      const tracker = createMetricsTracker();
      tracker.apply(sample(), GENERATION, timeOf(T0));
      const snapshot = tracker.apply(
        sample({ timestamp: T2, [field]: 0 }),
        GENERATION,
        timeOf(T2),
      );

      expect(snapshot.diskReadBytesPerSecond).toBeNull();
      expect(snapshot.diskWriteBytesPerSecond).toBeNull();
      expect(snapshot.netRxBytesPerSecond).toBeNull();
      expect(snapshot.netTxBytesPerSecond).toBeNull();
    }
  });

  it("treats an invalid timestamp as a new baseline", () => {
    const tracker = createMetricsTracker();
    tracker.apply(sample(), GENERATION, timeOf(T0));
    const invalid = tracker.apply(
      sample({ timestamp: "not-a-timestamp" } as unknown as MetricsSample),
      GENERATION,
      timeOf(T0),
    );

    expect(invalid.netTxBytesPerSecond).toBeNull();
  });
});

describe("metricsUnavailableText", () => {
  it("gives every reason a distinct, fixed explanation", () => {
    const texts = [
      metricsUnavailableText("no_sandbox"),
      metricsUnavailableText("not_running"),
      metricsUnavailableText("disabled"),
      metricsUnavailableText("unavailable"),
    ];

    expect(new Set(texts).size).toBe(4);
    for (const text of texts) {
      expect(text.length).toBeGreaterThan(10);
    }
  });
});

describe("createMetricsPoller", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("polls immediately, then once per interval after completion", async () => {
    const poll = vi.fn(async () => {});
    const poller = createMetricsPoller(poll, 3_000);

    poller.start();
    expect(poller.active).toBe(true);
    expect(poll).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(0);
    expect(poll).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2_999);
    expect(poll).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(poll).toHaveBeenCalledTimes(2);
  });

  it("stays single-flight while a request is slow", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const poll = vi.fn(async () => {
      calls += 1;
      if (calls === 1) await gate;
    });
    const poller = createMetricsPoller(poll, 3_000);

    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls).toBe(1);

    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);

    await vi.advanceTimersByTimeAsync(3_000);
    expect(calls).toBe(2);
  });

  it("stops on the unmount path", async () => {
    const poll = vi.fn(async () => {});
    const poller = createMetricsPoller(poll, 3_000);

    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(poll).toHaveBeenCalledTimes(1);

    poller.stop();
    expect(poller.active).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(poll).toHaveBeenCalledTimes(1);
  });

  it("does not schedule again when stopped mid-request", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const poll = vi.fn(async () => {
      await gate;
    });
    const poller = createMetricsPoller(poll, 3_000);

    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(poll).toHaveBeenCalledTimes(1);

    poller.stop();
    release();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(poll).toHaveBeenCalledTimes(1);
  });

  it("ignores repeated starts and keeps polling after a failed read", async () => {
    const poll = vi.fn(async () => {
      throw new Error("metrics read failed");
    });
    const poller = createMetricsPoller(poll, 3_000);

    poller.start();
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(poll).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(3_000);
    expect(poll).toHaveBeenCalledTimes(2);
  });
});

describe("formatPercent", () => {
  it("keeps at most one decimal", () => {
    expect(formatPercent(18)).toBe("18%");
    expect(formatPercent(15.54)).toBe("15.5%");
  });
});

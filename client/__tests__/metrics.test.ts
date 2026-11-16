import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MetricsSample } from "../../shared/contracts";
import {
  createMetricsPoller,
  createMetricsTracker,
  formatBytes,
  formatPercent,
  formatUptime,
  METRICS_RATE_PLACEHOLDER,
  metricsRows,
  metricsUnavailableText,
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

describe("metricsRows", () => {
  it("shows absolute values and placeholders for the first sample", () => {
    const snapshot = createMetricsTracker().apply(sample(), GENERATION, timeOf(T0));
    const rows = Object.fromEntries(metricsRows(snapshot).map((row) => [row.label, row.value]));

    expect(rows.CPU).toBe("18%");
    expect(rows.Memory).toBe("1.0 GiB / 4.0 GiB");
    expect(rows.Uptime).toBe("12s");
    expect(rows.Disk).toBe(`R ${METRICS_RATE_PLACEHOLDER}  W ${METRICS_RATE_PLACEHOLDER}`);
    expect(rows.Network).toBe(`RX ${METRICS_RATE_PLACEHOLDER}  TX ${METRICS_RATE_PLACEHOLDER}`);
    expect(rows["Root disk"]).toBe("1.0 GiB / 4.0 GiB");
  });

  it("omits root-disk data that the sample does not report", () => {
    const snapshot = createMetricsTracker().apply(
      sample({ upperUsedBytes: null, upperFreeBytes: null }),
      GENERATION,
      timeOf(T0),
    );

    expect(metricsRows(snapshot).some((row) => row.label === "Root disk")).toBe(false);
  });

  it("uses cpuPercent directly without differentiating it", () => {
    const tracker = createMetricsTracker();
    tracker.apply(sample({ cpuPercent: 10 }), GENERATION, timeOf(T0));
    const snapshot = tracker.apply(sample({ timestamp: T2, cpuPercent: 42 }), GENERATION, timeOf(T2));

    expect(metricsRows(snapshot).find((row) => row.label === "CPU")?.value).toBe("42%");
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

# V1.1 metrics sampling spike results

Verified on 2026-11-15 on macOS arm64 (Apple silicon) against
`microsandbox@0.7.14` and `ghcr.io/getpaseo/paseo:0.15.4`. This spike reads the
microsandbox SDK directly and does not require a parent daemon.

Command:

```sh
node scripts/spikes/verify-v11-metrics.mjs \
  --image ghcr.io/getpaseo/paseo:0.15.4 \
  --timeout 180
```

The script is
[`scripts/spikes/verify-v11-metrics.mjs`](../../scripts/spikes/verify-v11-metrics.mjs).
It creates four sandboxes and removes all of them in `finally`:

| Sandbox | Shape | Purpose |
| --- | --- | --- |
| V1.1 | Paseo entrypoint, `metricsSampleIntervalMs(2000)` | Sampling, duplicate, restart, stopped |
| Upper | Quiet `/bin/sh -c "exec sleep infinity"` init, `metricsSampleIntervalMs(2000)` | Upper-layer write probe without a busy guest daemon |
| V1 | Paseo entrypoint, no explicit metrics interval | Default interval and legacy behavior |
| Disabled | Paseo entrypoint, `disableMetricsSample()` | Disabled error |

The quiet sandbox is used only for the upper-layer probe. The Paseo daemon does
a large amount of setup I/O immediately after create, which makes a 32 MiB write
probe unmeasurable if it runs at the same time. The probe still uses the same
image, root disk, and sampling interval.

## Sampling cadence

`config.runtime.metricsSampleIntervalMs` is `2000` on the V1.1 sandbox and
`1000` on the V1-shaped sandbox. The script polls at the client's 3-second
cadence and records the SDK timestamp, receipt time, age, and counter deltas.

V1.1 samples after metrics first became available:

| Poll | SDK timestamp | Age at receipt |
| --- | --- | --- |
| 0 | `00:00:52.796Z` | 1860 ms |
| 1 | `00:00:56.968Z` | 690 ms |
| 2 | `00:00:59.059Z` | 1602 ms |
| 3 | `00:01:03.226Z` | 439 ms |
| 4 | `00:01:05.301Z` | 1367 ms |

Observed SDK timestamp gaps were `4172`, `2091`, `4167`, and `2075` ms. No
timestamp was duplicated or non-increasing at the 3-second cadence. Polling a
2-second source at 3 seconds therefore normally observes a fresh sample, but the
gap alternates between roughly one and two sample intervals because of phase. Do
not assume a 2-second gap between consecutive polls.

The V1 sandbox sampled at its default 1000 ms interval. Four consecutive
3-second polls succeeded with ages of `790`, `587`, `377`, and `169` ms; no
timestamps were duplicated or stale.

### Startup race

Immediately after the sandbox reports `running`, `metrics()` can fail before the
runtime has published its first live slot:

```text
CustomError code="custom"
message="sandbox <id> has no verified live metrics slot"
```

The first successful sample arrived about 1 second later. This is a raw SDK
custom error, not one of the typed metrics errors. `vm.metrics` must map it to
the fixed unavailable reason and must not expose the message text. The client
should treat the initial unavailable result as normal and keep polling.

## Duplicate samples

Two immediate back-to-back `metrics()` calls returned the same SDK timestamp and
identical values:

```text
first:  timestamp=00:01:05.301Z  cpuPercent=15.54  uptimeMs=14811
second: timestamp=00:01:05.301Z  cpuPercent=15.54  uptimeMs=14811
```

A duplicate read is safe and cheap at the SDK level. The client must update
absolute values without recomputing rates when the timestamp is unchanged. The
server's per-`(name, id)` coalescing is still needed because an unsettled native
call must not be started repeatedly.

## Restart and cumulative counters

A restart kept the same generation (`local:251`) and advanced the wall-clock
timestamp, but reset the guest:

| Field | Before restart | First sample after restart |
| --- | --- | --- |
| `uptimeMs` | 14811 | 254 |
| `vcpuTimeNs` | 4166299832 | 186014541 |
| `diskReadBytes` | 126985216 | 59970560 |
| `diskWriteBytes` | 39243776 | 196608 |
| `netRxBytes` | 167955322 | 0 |
| `netTxBytes` | 564767 | 180 |
| `upperUsedBytes` | 161497088 | `null` |
| `upperFreeBytes` | 10314059776 | `null` |

Every cumulative counter regressed. The client's rate reset rule must include an
`uptimeMs` regression and any cumulative counter regression, not only a
generation change or non-increasing timestamp. The first post-restart sample can
also have `upperUsedBytes` and `upperFreeBytes` set to `null`; render them as
unreported rather than zero.

## Availability and typed errors

| State | `status` | `metrics()` result |
| --- | --- | --- |
| Running | `running` | Sample |
| Stopped | `stopped` | Rejected, `code="sandboxNotRunning"` |
| Paused | `paused` | **Sample from before the pause**, no error |
| Metrics disabled | `running` | Rejected, `code="metricsDisabled"` |
| Destroyed handle | `stopped` | Rejected, `code="sandboxNotRunning"` |

Notable findings:

- A paused VM still returns its last sample. DESIGN §7.3 says `vm.metrics` reads
  only while the generation is running, so the server must gate on
  `handle.status === "running"` rather than relying on the SDK error. A paused
  VM should be reported as unavailable, not as live metrics.
- A destroyed enabled handle reports `sandboxNotRunning`, not
  `sandboxNotFound`. The server's `no_sandbox` and `id_mismatch` checks must
  happen before handing the handle to `metrics()`; its fixed unavailable result
  remains correct for this case.
- `disableMetricsSample()` leaves `metricsSampleIntervalMs` at its default
  (`1000`) while setting `disableMetricsSample: true`. The server must inspect
  the disable flag, not infer disabled state from the interval.
- Stopped and disabled are distinct (`sandboxNotRunning` versus
  `metricsDisabled`). No `metricsUnavailable` error was observed in these states;
  the client's fixed reason is still the correct public representation.

## `upperUsedBytes` / `upperFreeBytes`

The quiet sandbox wrote a 32 MiB file to `/home/paseo/paseo-metrics-probe.bin`
(`du -m` reported `32`; `stat` reported `65536` blocks of 512 bytes = 32 MiB):

| Measurement | Before write | After write |
| --- | --- | --- |
| `upperUsedBytes` | 61,440 | 33,624,064 |
| `upperFreeBytes` | 10,475,495,424 | 10,441,932,800 |
| `upperUsed + upperFree` | 9990.27 MiB | 9990.27 MiB |
| Guest `df -m /` used | 1 MiB | 33 MiB |
| Guest root disk | 10007 MiB total | 10007 MiB total |

The write increased `upperUsedBytes` by `33,562,624` bytes (32.0 MiB), exactly
matching the file, and `df -m /` used increased by 32 MiB. After the file was
removed, both returned to their baseline (`69,632` bytes and 1 MiB).

The guest mounts `/` as an overlay with a writable `upperdir` under
`/.msb/rootfs/upperfs/upper`; `upperUsed + upperFree` is about 9990 MiB against a
10240 MiB managed root disk (about 2.4% filesystem overhead). `upperUsedBytes`
therefore describes the **writable upper layer of the overlay root**, not the
read-only lower image layers. `df -m /` reports the same upper filesystem, so
the two values agree within a few MiB on an idle guest.

## Consequences for tasks 3.3 and 4.2

- The server should return a fixed unavailable reason for the startup
  `custom` error, stopped VMs, disabled metrics, and any other SDK failure. It
  should not surface `sandboxNotRunning`, `metricsDisabled`, or raw messages.
- The server must gate on `status === "running"` so a paused VM is unavailable
  even though the SDK returns a stale sample.
- The client should poll every 3 seconds only while the detail is visible,
  single-flight, and accept unavailable results during the first second after
  create without showing a hard failure.
- A 3-second poll of a 2-second sampler normally sees a fresh sample, but
  timestamp gaps can be about 2 or 4.1 seconds. Staleness must be based on the
  SDK timestamp, not on the poll interval.
- Duplicate timestamps must update absolute values without recomputing rates.
  Rate baselines reset on a generation change, a non-increasing timestamp, an
  `uptimeMs` regression, or any cumulative counter regression.
- `upperUsedBytes` / `upperFreeBytes` are the writable upper layer, not the
  whole root disk. If either is `null`, show it as unreported; this occurs on the
  first sample and immediately after a restart.

## Cleanup

All four sandboxes were destroyed in `finally` and verified absent:

```text
paseo-v11-met-3010-mwh2jqv1        removed
paseo-v11-met-upper-3010-mwh2jqv1  removed
paseo-v11-met-legacy-3010-mwh2jqv1 removed
paseo-v11-met-disabled-3010-mwh2jqv1 removed
```

## Outcome

PASS. The runtime exposes fresh metrics at the configured interval, reports
distinct stopped and disabled errors, returns duplicate samples for immediate
re-reads, resets counters across restart, and its upper-layer fields match the
writable overlay usage observed through `df -m /`.

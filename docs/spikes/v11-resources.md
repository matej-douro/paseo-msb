# V1.1 resource resize spike results

Verified on 2026-11-14 on macOS arm64 (Apple silicon) against a live parent
daemon with `microsandbox@0.7.14`, parent daemon `0.15.4`, and
`ghcr.io/getpaseo/paseo:0.15.4`.

Command:

```sh
node scripts/spikes/verify-v11-resources.mjs \
  --parent ws://127.0.0.1:6780/ws \
  --image ghcr.io/getpaseo/paseo:0.15.4 \
  --timeout 300
```

The script is
[`scripts/spikes/verify-v11-resources.mjs`](../../scripts/spikes/verify-v11-resources.mjs).
It creates a V1.1 sandbox and a V1-shaped legacy sandbox, records every
`modify()` plan and `resizeStatus`, reads the config back after `refresh()`, and
removes every registration and sandbox in `finally`.

## Reading resources

The observed values come from the refreshed sandbox config:

| Resource | Config key |
| --- | --- |
| CPU | `config.resources.cpus` |
| Memory | `config.resources.memoryMib` |
| Maximum memory | `config.resources.maxMemoryMib` |
| Root disk | `config.image.Oci.rootDisk.sizeMib` |
| Metrics interval | `config.runtime.metricsSampleIntervalMs` |
| Published port | `config.network.ports[]` |

`handle.config()` is a cached snapshot. After `modify()` the handle must be
refreshed before reading resources:

```js
const next = await handle.refresh();
const config = next.config();
```

Without `refresh()`, the config still reports the pre-modify values even when
the change was applied.

## V1.1 sandbox

Created as `paseo-v11-res-95152-mwh0a25i` (`local:241`) with
`cpus: 2`, `memoryMib: 4096`, `maxMemoryMib: 32768`, `rootDiskSizeMib: 10240`,
and `metricsSampleIntervalMs: 2000`. The registration
`hst_0b5a9ca9-fe60-467f-81ca-c9629f017131` published
`127.0.0.1:49598 -> 6767` and came online before the resize work started.

Initial observed state:

```text
resources: cpus=2 memoryMib=4096 maxMemoryMib=32768
root disk: 10240 MiB
metrics interval: 2000 ms
guest MemTotal: 4025792 KiB
guest df -m /: overlay 10007 MiB
```

### Dry-run plans

| Request | Disposition | Result |
| --- | --- | --- |
| Memory 6144, `no_restart` | `live` | Plan only; nothing applied |
| Memory 2048, `no_restart` | `live` | Plan only; nothing applied |
| Disk 12288, `no_restart` | `live` | Plan only; nothing applied |
| Disk 9216, `no_restart` | conflict | Shrink rejected by the planner |
| Memory 6144 + disk 12288, `no_restart` | both `live` | Plan only; nothing applied |
| CPU 4, `no_restart` | `requires restart` | `cpus` and `max_cpus` both require restart |
| `maxMemory` 16384, `no_restart` | `requires restart` | Boot-time cap cannot change live |
| Env change, `no_restart` | `requires restart` | Live exec defaults are unavailable |
| Env change, `next_start` | `next start` | Persists for future execs |

`dryRun` therefore discovers restart requirements without applying anything.

### Applied resizes

| Request | Plan | Observed after refresh | Guest |
| --- | --- | --- | --- |
| Memory 6144, `no_restart` | `resizeStatus: memory converging` (`actual 4 GiB`, `enforced 6 GiB`) | `memoryMib: 6144` | MemTotal ≈ 6122944 KiB |
| Memory 2048, `no_restart` | `resizeStatus: memory applied` (`actual 6 GiB`, `enforced 4 GiB`) | `memoryMib: 2048` | MemTotal stayed ≈ 4025792 KiB |
| Disk 12288, `no_restart` | `root_disk_size live`; no `resizeStatus` | `diskMib: 12288` | `df -m /` grew to 12022 MiB |
| Memory 8192 + disk 14336, `no_restart` | memory `converging`, disk `live` | `memoryMib: 8192`, `diskMib: 14336` | MemTotal ≈ 8220096 KiB; `df -m /` 14038 MiB |
| Disk 10240 (shrink), apply | `CustomError: root disk size ... shrink is not supported` | No change | No change |
| CPU 4, apply | `CustomError: cpus requires restart` | No change | No change |
| `maxMemory` 16384, `no_restart` | `CustomError: max_memory requires restart` | No change | No change |
| Env change, `no_restart` | `CustomError: env requires restart` | No change | No change |
| `maxMemory` 16384, `restart` | `max_memory requires restart`, `applied: true` | `maxMemoryMib: 16384` | Restarted; registration and port survived |

Notes:

- A fresh `handle.refresh()` is required to observe every successful change.
- `resizeStatus` is the live RAM convergence signal. Disk changes have an empty
  `resizeStatus`; confirm them through the refreshed config and guest `df`.
- The SDK reported memory shrink to 2048 as `applied`, but the guest stayed at
  approximately 4 GiB. The config reported 2048 MiB. Treat the SDK's
  `resizeStatus` as authoritative for the reported outcome, but do not claim
  guest-level shrink beyond what the runtime actually enforced. A
  `guest-refused` state was not produced by this runtime.
- V1.1 sandboxes with an explicit large `maxMemory` resize RAM live. V1-shaped
  legacy sandboxes report `live CPU and memory resize are not available in this
  runtime yet`.

### Env persistence and atomicity

`no_restart` cannot persist an env change: the plan says `requires restart`, and
applying it throws `env requires restart`. A combined
`memory + env` request with `no_restart` also throws, and neither memory nor env
changes: the request is atomic on failure.

`next_start` does persist the env change without a restart. The refreshed
config shows the new value, and new guest execs see it. The warning states that
running processes keep their old environment.

This matters for task 3.2: including `PASEO_MSB_RESOURCES` in the same
`no_restart` `modify()` call as resource targets makes the whole resize fail.
The implementation must either omit env from `no_restart`, use `next_start` for
the env write, or reject the request before calling `modify()`.

### Restart behavior

The published port stayed `127.0.0.1:49598 -> 6767`, the generation id stayed
`local:241`, and the registration returned online after each restart.

| Restart | Immediate guest uptime | Result |
| --- | --- | --- |
| First `restart()` | 0.11 s | Guest rebooted; config, env, disk, and registration survived |
| Identical second `restart()` | 0.10 s | Guest rebooted again; `updatedAt` changed again |

`updatedAt` changed on both restarts (`22:57:30.735Z`, then `22:57:38.583Z`).
An identical restart call still restarts the running sandbox.

### VM state under `policy: "restart"`

| State | Observed runtime behavior |
| --- | --- |
| Running | Restarts; guest uptime resets; port and registration survive |
| Stopped | Applies config as `next start`; **does not start**; remains `stopped` |
| Paused | Rejects with `CustomError: memory is unsupported`; remains `paused`; config unchanged |
| Killed | Becomes `stopped`, not `crashed`; restart policy then applies `next start`, does not start |
| Created | Detached create reported `running` immediately; a `created` state was not reproducible |
| Crashed | Not reproducible. `kill()` became `stopped`; no `crashed` state was produced |

Task 3.2 must not rely on the runtime to reject restart on non-running VMs. It
must require the exact generation to be `running` before using
`policy: "restart"` or including a restart-only field.

## Legacy V1 sandbox

Created as `paseo-v11-legacy-95152-mwh0a25i` with `memoryMib: 4096` and
`rootDiskSizeMib: 10240`, no explicit `maxMemory`, no
`PASEO_MSB_RESOURCES`, and no metrics interval.

Initial observed state:

```text
resources: cpus=2 memoryMib=4096 maxMemoryMib=4096
root disk: 10240 MiB
metrics interval: 1000 ms
guest MemTotal: 4025788 KiB
```

The legacy default cap is exactly the boot memory: 4096 MiB. The default
metrics cadence is 1000 ms. Neither is reported as null.

| Request | Result |
| --- | --- |
| Memory 6144, `no_restart` | Plan: `memory` and `max_memory` `requires restart`; `applied: false`; config unchanged |
| Memory 6144 + disk 12288, `no_restart` | Plan: memory and `max_memory` require restart; disk is `live`; applying throws `memory requires restart` and applies **nothing** (disk stayed 10240 MiB) |
| `maxMemory` 32768, `no_restart` | Plan requires restart; applying throws `max_memory requires restart` |
| Memory 6144 + `maxMemory` 32768, `restart` | Applied; `memoryMib: 6144`, `maxMemoryMib: 32768`; guest MemTotal ≈ 6079928 KiB |

The legacy path cannot grow RAM without a restart. A mixed RAM+disk
`no_restart` request is rejected atomically: the live disk change is not
partially applied. `maxMemory` can be changed with `restart`; without an
explicit cap, the runtime also plans to raise the cap to the requested memory
when a restart is allowed.

## Outcome mapping for task 3.2

- `live` + `resizeStatus: converging` means the RAM change was accepted and is
  converging; re-read after refresh before claiming `applied`.
- `live` + `resizeStatus: applied` means the SDK accepted the RAM change. The
  refreshed config is the observation source. A guest-level shrink may be
  smaller than requested without a `guest-refused` state.
- Disk `live` has no `resizeStatus`; confirm it through the refreshed
  `rootDisk.sizeMib` and, where relevant, guest `df`.
- `requires restart` under `no_restart` must become `restart_required` before
  `modify()`, using `dryRun` to discover it. Applying such a request throws and
  changes nothing.
- `requires restart` under `restart` applies for a running generation only.
  For stopped, paused, killed, or otherwise non-running generations, reject
  before `modify()`; the runtime will not enforce that policy.
- Root-disk shrink is a planner conflict and an apply-time error. It must be
  `invalid_request` before `modify()`.
- CPU changes are not part of V1.1; the runtime reports `cpus requires restart`.
- A paused VM refuses modification with an unsupported error. V1.1 must not call
  `modify()` for a paused generation.
- `created` and `crashed` were not reproducible on the pinned runtime. Detached
  create reports `running`; `kill()` and guest exits report `stopped`. V1.1 still
  follows DESIGN §7.2: any non-`running` generation is invalid for a restart.

## Cleanup

The spike removed registration
`hst_0b5a9ca9-fe60-467f-81ca-c9629f017131` and both sandboxes
(`paseo-v11-res-95152-mwh0a25i`, `paseo-v11-legacy-95152-mwh0a25i`) in
`finally`. Post-cleanup checks found no remaining registrations or sandboxes.

## Outcome

PASS. Live RAM and disk resizes are observable after `refresh()`; the combined
RAM+disk request works on V1.1; root-disk shrink and CPU changes are rejected;
restart preserves the published port and registration; legacy caps are
understood; and `no_restart` is atomic when a restart-only field is present.
The implementation must preflight with `dryRun` and keep env writes out of the
`no_restart` call.

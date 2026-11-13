# Identity and lifecycle spike results

Task 7 of [TASKS.md](../../TASKS.md), required by [DESIGN.md](../../DESIGN.md)
section 8 before lifecycle code changes. Verified on 2026-11-13 on macOS arm64
(Apple silicon) with `msb 0.7.14`, `microsandbox@0.7.14`, parent daemon
`0.15.4`, and `ghcr.io/getpaseo/paseo:0.15.4`.

Command:

```sh
npm run spike:identity
```

The script is
[`scripts/spikes/verify-identity-lifecycle.mjs`](../../scripts/spikes/verify-identity-lifecycle.mjs).
It creates one sandbox, destroys it, recreates the same name as a replacement,
and exercises every stale handle operation. It then runs detached jobs,
recovers them through paginated inventory and a fresh handle, and proves
registration semantics from both a plain client and a real directory plugin
([`scripts/spikes/fixtures/identity-plugin/`](../../scripts/spikes/fixtures/identity-plugin/)).

## Exact-handle matrix

| Operation on a captured `SandboxHandle` after a same-name replacement | Result |
| --- | --- |
| `refresh()` | Rejects `SandboxReplacedError` (`code: sandboxReplaced`) |
| `connect()` | Rejects `SandboxReplacedError` |
| `listJobsWith(...)` | Rejects `JobError` (`code: sandbox_replaced`) |
| `getJob(id)` | Rejects `JobError` (`code: sandbox_replaced`) |
| `destroy()` | Rejects `SandboxReplacedError`; the replacement survives |
| `modify({ labels })` | **Accepted and applied to the replacement** |

`modify()` does not verify the captured generation. The reconciler must call
`handle.refresh()` (or `connect()`), compare the returned `id`, and treat
`sandboxReplaced` / `sandbox_replaced` as a quarantined generation before every
label write. A stale handle must never be used for a phase or error write.

`refresh()` and `connect()` on an unchanged sandbox return the same `id`. Guest
execution works through a connected handle and reports the non-root `paseo` user.

## Paginated job recovery

- `SandboxHandle.listJobsWith(b => b.all(true).limit(n))` is a manual pagination
  API: callers must follow `nextCursor` until it is null. A single call does not
  return the complete inventory.
- Repeating a cursor is detectable; the plugin treats it as an inspection
  failure and never launches another install.
- `JobInfo.command` is the exact argv, e.g.
  `["sh", "-lc", "echo spike-success"]`. It includes the executable and every
  argument, so the pinned Pi install argv can be matched exactly.
- Observed states after a reload:
  - successful: `state: exited`, `exitCode: 0`
  - confirmed failure: `state: exited`, `exitCode: 7`
  - killed while running: `state: exited`, `exitCode: -1`
- A fresh `Sandbox.get(name)` recovers jobs started by an earlier handle.
- `JobState` includes `starting`, `running`, `exited`, `failed`, and `lost`.
  `lost` was not reproducible by killing a job; a killed job becomes `exited`
  with `exitCode: -1`. The plugin must treat `lost`, a nonzero `exitCode`, and a
  non-null `failure` as a confirmed unsuccessful install.
- An uncertain launch (`definitely-not-a-real-command`) produced
  `JobError` with `code: exec_failed` and **no `jobId`**. `JobError.jobId` is
  optional; when present the plugin re-lists inventory and inspects that exact
  id. When absent, it never starts a second job until inventory is conclusive.

## Real-plugin registration semantics

A plain `createPaseoClient` connection registers with producer `owner`. A real
directory plugin registers with producer `plugin:<plugin id>`; the spike plugin
reported `plugin:paseo-msb-identity-spike`, so the production predicate is
`source.id === "plugin:paseo-msb"` with `source.key === handle.id`.

| Case | Observed result |
| --- | --- |
| First add | Returns one registration with the authenticated producer id |
| Unchanged repeated add | Returns the same registration; no duplicate |
| Disabled registration + unchanged add | Remains `enabled: false`, status `disabled` |
| Changed metadata add on the same source key | Rejects `source_conflict` |
| Explicit `hosts.update` | Updates label, metadata, connection, and enabled state |
| Lost-response retry after the config changed | Rejects `source_conflict`; a list-first retry confirms the existing row |
| `hosts.remove` | Removes the registration |

Because changed input conflicts rather than updating, the reconciler must list
first and only `add` when no exact `(producer, source.key)` row exists. A
`source_conflict` response is followed by a re-list; identical configuration is
reused, and changed configuration uses an explicit `hosts.update`. Metadata and
labels are configuration, not ownership proof.

## Required narrow fallbacks

None beyond the task 1 pins. The spike confirms the design's
`refresh`-before-`modify` rule, manual job pagination, and list-before-add
registration rule.

## Scope

No product scope was added. The spike plugin is scratch verification only and is
never installed by the product.

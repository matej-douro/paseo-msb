# Lifecycle and identity findings

Review snapshot: `e247bb0`. This document expands review findings 3 and 5 and the related identity/transaction issues.

Resolution: [DESIGN.md](./DESIGN.md) selects the name-based model, and [TASKS.md](./TASKS.md) task 7 implements it. This file remains supporting analysis of the original failures, not a competing design.

Task 7 additionally verified two runtime behaviors not known at review time:

- `SandboxHandle.modify()` does **not** reject a same-name replacement; it applies
the write to the replacement. Every label write therefore refreshes the handle and
compares the exact generation first (see `server/sandbox.ts` `guardedModify`).
- A changed `hosts.add` for an existing `(producer, source.key)` raises
`source_conflict`; an unchanged add returns the existing registration. The
reconciler lists first and only adds when the exact row is absent.

Full spike results: [docs/spikes/identity-lifecycle.md](./docs/spikes/identity-lifecycle.md).

## API facts that affect the design

- Microsandbox already owns a stable sandbox ID. A `SandboxHandle` captures that ID, and operations such as `destroy()` reject a same-name replacement. The ID does not need to be copied into a label to target a loaded handle.
- Paseo assigns plugin registrations the authenticated producer ID `plugin:paseo-msb`. Its connected-host registry keys idempotency by `(source.id, source.key)` and serializes registration mutations. Repeating an unchanged `hosts.add` returns the existing registration; changed input raises `source_conflict`. See the [v0.15.4 registry implementation](https://github.com/getpaseo/paseo/blob/1c00b365c9e0b74c1580eba33d905d693125ae21/packages/server/src/server/connected-hosts/index.ts#L121-L164) and [plugin producer assignment](https://github.com/getpaseo/paseo/blob/1c00b365c9e0b74c1580eba33d905d693125ae21/packages/server/src/server/websocket-server.ts#L1547-L1550).
- An unchanged add deliberately retains a user's disabled state. Metadata updates replace the whole map. Labels and metadata are display/configuration, not authenticated ownership proof. See [Connected hosts ownership](https://github.com/getpaseo/paseo/blob/1c00b365c9e0b74c1580eba33d905d693125ae21/docs/connected-hosts.md#L13-L17).
- Microsandbox exposes paginated detached-job inventory, including `JobInfo.command`, and uncertain launch errors can carry `JobError.jobId`. These may allow missing job labels to be recovered, but the exact restart and pagination behavior still needs a vertical spike.
- Paseo fully tears down an old plugin before starting its replacement and awaits plugin cleanup, but escalates to SIGTERM after two seconds and SIGKILL two seconds later. Cleanup must cancel promptly rather than wait for install/registration timeouts. See the [v0.15.4 shutdown implementation](https://github.com/getpaseo/paseo/blob/1c00b365c9e0b74c1580eba33d905d693125ae21/packages/server/src/server/plugins/runtime.ts#L1353-L1364).

There is no atomic transaction spanning microsandbox and the parent daemon. The achievable goal is serialized, idempotent operations with explicit recovery after every uncertain result.

## Finding 1: lifecycle operations are not serialized

Original review item 3.

Recovery starts without being awaited at `server/index.ts:60-76`. Create, Delete, and Repair run independently at `server/index.ts:75-102`, and the plugin cleanup at `server/index.ts:124` does not stop or join background work.

### Active create can be marked failed

1. Create writes `paseo-msb-id` and `phase=installing` at `server/create.ts:148-155`.
2. The detached install has not started yet, so no job label exists.
3. Recovery lists the same sandbox and enters the `installing` branch at `server/recovery.ts:40-55`.
4. `finishInstall()` sees no job ID and raises `install_failed` at `server/recovery.ts:79-87`.
5. Recovery writes `phase=failed` while the original create continues. Depending on timing, either runner can win the final label write, leaving a successful child marked failed or a failed child marked ready.

A similar race exists while either runner checks and writes registration state.

### Delete can be followed by a late registration

1. Setup checks the parent directory and decides registration is missing.
2. Delete destroys the sandbox and removes matching registrations.
3. The suspended setup resumes and calls `hosts.add`.
4. A registration for the deleted sandbox remains, while Delete has already returned success.

Paseo's unchanged-add idempotency prevents duplicate registrations for the exact same `(source.id, source.key)`, but it does not solve this ordering problem or competing phase writes.

### Recovery can be disabled by a transient startup failure

`server/index.ts:60-63` caches the recovery promise permanently. `server/recovery.ts:33-38` returns normally when the directory or inventory is unavailable. A transient first-use failure therefore prevents automatic recovery for the rest of the plugin process.

### Required invariant

At most one lifecycle operation may advance a given sandbox name at a time. Create, startup recovery, manual Repair, Delete, and stale-registration cleanup must participate in the same coordination scheme. Old plugin work must be cancelled before replacement code can issue new side effects.

## Finding 2: Repair treats incomplete inventory as proof of deletion

Original review item 5.

`loadManagedSandboxes()` separates successfully decoded sandboxes from `failures` at `server/sandbox.ts:333-350`. Repair then:

1. Builds `liveSandboxIds` only from successful decodes at `server/reconcile.ts:54-55`.
2. Treats a registration whose VM ID is absent from that set as stale.
3. Removes it at `server/reconcile.ts:59-63`.

A sandbox whose `config()` is temporarily unreadable or malformed is still present in microsandbox, but its valid registration can be deleted. This violates the requirement to leave ambiguous state untouched.

Two related fail-open paths exist:

- Runtime inventory is label-filtered. A live VM with removed or unreadable ownership labels is not evidence of absence.
- `server/runtime.ts:87-90` silently accepts a repeated pagination cursor and returns the accumulated partial inventory as successful.

### Required invariant

Never remove a registration based solely on absence from managed, decoded, label-filtered inventory.

Before stale-registration removal, prove the old runtime generation is absent using either:

- an exact `Sandbox.get(registration.metadata.name)` followed by comparison of `handle.id` with `registration.source.key`; or
- a complete, unfiltered runtime ID inventory with checked pagination.

A different live ID under the same name proves the old generation is stale; the old registration must never be attached to the replacement. Any lookup, decode, or pagination error blocks destructive cleanup. Registration-only state must remain visible so the user can retry Delete or Repair.

## Finding 3: current ID persistence creates unmanageable crash windows

Original review items 4, 6, and 8.

### Missing stable-ID label

1. `Sandbox.builder(...).create()` creates the durable VM with managed, parent, and `creating` labels, but no stable-ID label (`server/sandbox.ts:158-180`).
2. A crash occurs, or the subsequent `modify()` fails, before `server/create.ts:148-155` writes `paseo-msb-id`.
3. A same-request retry finds the VM but rejects it because `ownsSandbox()` requires the missing label (`server/sandbox.ts:372-379`).
4. Delete has the live name and runtime ID but rejects the VM as `invalid_config` (`server/delete.ts:39-43`).
5. Repair also refuses it. The only remaining cleanup is the `msb` CLI, contrary to the design.

This does not require a process crash. If `create()` throws after the VM actually appeared, `createWithPortRetry()` finds it at `server/create.ts:237-242` but retains no handle. The pending attempt is marked failed; its retry hits the same ownership rejection.

### Missing job label

1. The detached install starts at `server/create.ts:160`.
2. A crash or failed label write occurs before the job ID is persisted at `server/create.ts:161`.
3. Recovery cannot await the job and marks the VM failed. A later successful job does not make Repair available because all failed phases are rejected at `server/reconcile.ts:106-110`.

The SDK can return a recoverable `JobError.jobId`, but `startPiInstall()` currently discards it at `server/create.ts:262-272`.

### Registration identity is duplicated and inconsistent

The runtime ID is currently copied into `paseo-msb-id`, `registration.source.key`, and `registration.metadata.vm`. Matching then differs by operation:

- mutations accept `source.key === id` OR `metadata.vm === id` (`server/registration.ts:102-112`);
- stale cleanup uses only `metadata.vm` (`server/registration.ts:119-134`);
- read projection does not apply the same parent/ownership checks (`server/status.ts:79-105`).

When no live sandbox exists, Delete also fails to validate the registration's name (`server/delete.ts:35-50`). A mismatched name/ID request can therefore remove another child's registration.

## Recommended design: one identity per resource, one reconciler

### Identity model

| Concern | Proposed authority |
| --- | --- |
| Logical create attempt | `paseo-<requestId>`; strict name creation and the pending entry until a sandbox exists |
| VM generation | Microsandbox `handle.id`; use the exact loaded handle for mutations |
| Sandbox ownership | Atomic managed + parent labels supplied at creation |
| Registration identity | `(registration.source.id === "plugin:paseo-msb", registration.source.key === handle.id)` |
| Registration display/configuration | Label and metadata `{ source: "paseo-msb", name: <sandbox name> }`; not ownership proof |
| Pi install | Detached-job ID while live; exact pinned argv plus job inventory for rediscovery |

This removes `metadata.vm`. `paseo-msb-id` and `paseo-msb-job` can be removed after their replacement-recovery behavior is proven, or retained temporarily as verified hints during migration. A present mismatched legacy ID label must quarantine the VM rather than silently adopting it.

Every operation should use one strict registration predicate based on authenticated producer and source key. A same-producer/key row with wrong metadata is an owned row needing validation/update, not a foreign row that can be followed by another add.

### One lifecycle lane per name

Use one idempotent `reconcile(name)` implementation for background Create, startup recovery, and manual Repair:

1. Re-read the current sandbox and registration state.
2. Verify ownership and exact runtime identity.
3. Inspect actual Pi/job state and advance only the next unambiguous step.
4. Use the parent's unchanged-add idempotency for registration; inspect conflicts and use `hosts.update` only for deliberate configuration changes.
5. Persist phase as a progress hint, not as proof that an external side effect occurred.

The pending attempt should retain its request ID and selected credential **names**, never values. Retrying with different names must be rejected rather than silently keeping the first selection. Once a sandbox exists, the sandbox wins over the pending row and repeated Create joins reconciliation instead of merely returning.

Plugin cleanup should abort waits and prevent further side effects, then settle promptly within the parent's two-second soft-shutdown budget. Every runner must revalidate its generation/tombstone after an uncancellable await before performing the next side effect.

### Errors and retryability

Do not turn every error into a terminal `failed` phase.

- A running job, timeout, job-inspection error, or inventory error means **unknown/progress**, not failed install. Return distinct states instead of the boolean from `waitForPiInstall()`.
- A confirmed nonzero job exit is a failed install.
- Registration timeout/failure and provider unavailability are retryable; keep the setup step and attach a safe error.
- If Pi's exact path/version is present, installation is complete regardless of missing job history.
- If job history is unavailable, do not launch another install. Zero, one, and multiple active matching jobs need explicit handling; multiple terminal jobs alone are not a conflict once retries are supported.

### Delete protocol

1. Join the same per-name lifecycle lane and invalidate the active runner generation.
2. Persist `phase=deleting` before destruction. Recovery treats it as cleanup-only.
3. Re-read the exact handle, validate name, ownership, and `handle.id`, then destroy through that handle.
4. After old work has settled, re-read runtime/registrations and remove only `(plugin:paseo-msb, exact runtime ID)` registrations.
5. Treat confirmed missing resources as success. If removal fails after destruction, keep a registration-only child visible with working Delete/Repair actions.
6. A reload during deletion resumes cleanup, never setup. After a fully confirmed Delete, request-ID idempotency ends; a later create is a new VM generation.

## Same-name replacement policy is an explicit tradeoff

Removing the durable expected-ID label means managed + parent labels cannot distinguish the original pre-registration VM from a same-name replacement carrying identical labels. There are two coherent choices:

1. **Name owns the current managed generation (simplest).** The request name identifies the logical attempt, while `handle.id` prevents stale handles and registrations from affecting another generation. A replacement never inherits the old registration because its source key differs. This is reasonable if request-ID idempotency ends after Delete and managed same-name adoption is intentional.
2. **Always reject same-name replacement (current stated rule).** A durable expected-ID witness is still required somewhere. Keep the ID label and define narrow recovery for the initial no-ID window. A state-free implementation cannot provide this stronger guarantee before the first ID write.

In either model, `resume(name)` must stop performing an unverified fresh `Sandbox.get(name)` as at `server/runtime.ts:118-124`. Connect through the exact loaded handle and verify the connected sandbox ID so a replacement cannot be adopted between the ownership check and guest operation.

## Required spikes before implementing the redesign

1. **Exact-handle matrix:** verify `refresh`, `connect`, `modify`, and job listing against same-name replacements, not just `destroy()`.
2. **Job recovery:** verify actual `JobInfo.command`, `.all()` with forced pagination, running/exited/failed/lost states, uncertain `JobError.jobId`, and reload immediately before/after launch.
3. **Real-plugin registration semantics:** verify `source.id=plugin:paseo-msb`, unchanged-add idempotency, disabled-state preservation, changed-metadata conflict, explicit update, and lost-response retry. Current fakes use `source.id="plugin"`, so they do not prove the production ownership predicate.
4. **Lifecycle races:** place barriers around create, job launch, add response, and destroy; exercise concurrent Create/recovery/Repair/Delete and reload during deletion. Verify no late setup or registration survives final cleanup.

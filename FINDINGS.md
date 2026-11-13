# Lifecycle and identity findings

Review snapshot: `904b83a`. [DESIGN.md](./DESIGN.md) is the target design; [TASKS.md](./TASKS.md) task 8 tracks the remaining implementation and verification work.

Task 7 resolved the original structural findings: new VMs no longer require durable ID/job labels, setup uses one reconciler and per-name lanes, legacy ID mismatches are quarantined, pending creates carry retry names, registration-only children have basic actions, and selected-VM logs redact persisted creation-time values.

Current validation: typecheck, lint, and 144 unit tests pass. The live release test was skipped in this review. The findings below are current-code issues, not the resolved findings from `e247bb0`.

## 1. Shutdown can admit new lifecycle work

`abortAll()` cancels only generations that already exist (`server/lanes.ts:76-97`), while `settle()` takes a one-time pending snapshot (`server/lanes.ts:126-138`). Multi-name Repair catches `LifecycleAbortedError` and continues to its next target (`server/reconcile.ts:70-85`).

Failure sequence:

1. Repair is processing A; B has not started.
2. Cleanup aborts A and snapshots pending work.
3. Repair catches A's cancellation and calls `lanes.run(B)`.
4. B receives a new generation and starts after `abortAll()`.
5. Cleanup returns while B can still perform side effects concurrently with the replacement plugin.

**Required outcome:** cleanup permanently closes the lanes, and every later `run()` is rejected before queueing. No work may start after closure, including work queued by an already-running multi-name operation.

## 2. Pending Create state has permanent no-op outcomes

The registration-only Create branch starts reconciliation with `allowCreate: false` (`server/create.ts:88-97`). That branch removes registrations but never removes the request from pending state (`server/reconciler.ts:135-143`). Every later Create sees a non-failed pending entry and returns without working (`server/create.ts:65-70`). The pending row also suppresses the registration-only row (`server/status.ts:215-226`).

Queued cancellation has a similar result: `startBackground()` swallows `LifecycleAbortedError` without settling the pending entry (`server/create.ts:150-159`). Delete can therefore leave a permanent `creating` row that future Creates blindly join.

**Required outcome:** every running, successful, failed, and cancelled attempt has one explicit settlement path. A settled entry can never block later reconciliation, and registration-only failures remain visible and actionable.

## 3. Create preflight is blocking and racy

`createVm()` awaits `startCreate()`, which performs sandbox lookup and potentially `hosts.list()` before returning (`server/create.ts:60-107`). A slow external API prevents the immediate `{ name }` response and leaves no pending row to observe.

Two concurrent initial calls can also bypass credential-name validation. Both may observe no pending entry; the first `pending.ensure()` records one selection, while the second returns that entry without rechecking (`server/pending.ts:63-65`) but retains its own resolved values. If the first attempt fails, the second can create with the other selection instead of rejecting the request.

**Required outcome:** synchronously reserve and validate the request before external awaits, return immediately, and run all preflight in the same per-name lane. Same-request credential names are checked exactly once against the original selection.

## 4. Registration repair remains incomplete and inconsistent

`ensureRegistration()` computes the desired connection but compares only label and metadata before deciding whether to update (`server/registration.ts:163-167,208-218`). A registration pointing to an old loopback port is never repaired.

`isOwnedRegistration()` also requires the display label to retain the parent prefix (`server/registration.ts:100-122`), despite labels being mutable configuration rather than ownership proof. Editing the label hides the row from matching, after which add/re-list conflict handling cannot find it again. Read projection applies different parent filtering from mutations (`server/status.ts:215-226`), so another parent's registration may be displayed but not repaired or deleted.

**Required outcome:** use the current parent directory plus authenticated `(source.id, source.key)` as the ownership predicate everywhere. Compare/update the connection through the parent's canonical target description, repair label/metadata explicitly, and preserve disabled state.

## 5. Public diagnostics still bypass redaction

- `hosts.list()` errors use bare `failureDetail(error)` (`server/rpc.ts:35-42`).
- Persisted error-detail labels are decoded without redaction (`server/sandbox.ts:282-307`).
- Unexpected reconciler errors are formatted without the merged redaction set before being persisted (`server/reconciler.ts:640-643`).

An upstream error or legacy label containing a current or removed credential can therefore cross `vm.list` or `vm.detail`.

**Required outcome:** one centralized diagnostic boundary redacts every public/persisted message against current environment/store values and relevant persisted VM values, including inventory-wide and legacy-detail paths.

## 6. Exact-generation mutation and stale cleanup are not atomic

`guardedModify()` performs `refresh()`, compares the ID, then calls `modify()` (`server/sandbox.ts:469-485`). The identity spike proved that stale-handle `modify()` can affect a replacement (`docs/spikes/identity-lifecycle.md:31-36`). A replacement between those calls can receive A's phase/error/`deleting` labels, potentially causing B's deletion despite Delete carrying A's ID.

Stale-registration cleanup has a similar race: the reconciler observes no sandbox (`server/reconciler.ts:112-116`), then later reads and removes registrations (`server/reconciler.ts:127-149,512-527`) without revalidating runtime absence. A generation created between those observations can lose its live registration. `removeStaleSameNameRegistrations()` has the analogous newer-generation window (`server/reconciler.ts:534-553`).

These races require replacement by an external or overlapping process, but they violate the documented stale-generation guarantee.

**Required outcome:** use a runtime operation with genuine exact-generation semantics and revalidate destructive cleanup at removal time. If the pinned SDK cannot provide the required guarantee, narrow `DESIGN.md` explicitly instead of treating refresh-then-modify as sufficient.

## 7. Job waits and legacy recovery can stall or skip active work

`getJob()` and final `inspect()` are outside timeout/abort races (`server/jobs.ts:107-136`). A hung SDK call can therefore block Delete and shutdown behind the lane despite the configured timeout.

Legacy migration also rejects `failed/install_failed` before inspecting job inventory (`server/reconciler.ts:249-256`). The old implementation could write that state for a timeout or inspection error while the detached job continued running. New recovery should await actual active work rather than preserve the old false-terminal outcome.

**Required outcome:** every job API await is bounded and abortable, and legacy recovery classifies actual Pi/job state before declaring a terminal install failure.

## 8. UI and contract state still contains false certainties

- `isEmptyInventory()` checks only child count (`client/state.ts:149-151`), so unavailable inventory can show "No child VMs yet".
- Null detail children are described as deleted even when inventory is unavailable (`client/ChildDetail.tsx:176-181`).
- Registration-unavailable and registration-absent both become `registration: null` (`server/status.ts:100-107`), displayed as "Not registered".
- Detail polling can clear another selection generation's in-flight lock, allowing same-generation responses to overwrite each other (`client/hooks/useVmDetail.ts:33-79`). Manual list refresh may be skipped while a pre-mutation poll is active (`client/hooks/useVmList.ts:31-46`).
- `storePath` remains in the RPC/UI (`shared/contracts.ts:210-215`, `server/secrets.ts:70-87`) despite the names/sources-only design. Store `chmod` failures remain best-effort (`server/secrets-store.ts:106-116`) rather than enforcing the documented permissions.

**Required outcome:** unavailable, empty, missing, and unregistered remain distinct; latest-request-wins polling and post-mutation reads are explicit; registration-only rows are never hidden by pending state; RPC and store behavior match the design.

## 9. Checked release claims exceed executable coverage

`TASKS.md` task 7 reports race, crash-window, and raw-log coverage that the current tests do not establish:

- Release reloads only during `installing`, not deletion, and performs Delete serially (`tests/integration/vertical.test.ts:288-292,513-550`).
- It has no concurrent lifecycle scenarios or required side-effect barriers.
- It scans RPC observations and plugin logs only (`tests/integration/vertical.test.ts:565-571`), not raw sandbox/job/system logs or test artifacts.
- It lacks removed/replaced creation-time canaries, environment-only credentials, and injected upstream errors containing old values.
- Its install assertion allows any nonzero number of jobs (`tests/integration/vertical.test.ts:348-353`).
- Runtime/SDK versions and image digests are not fully asserted.
- Several identity-spike outcomes are recorded rather than asserted, so `npm run spike:identity` is not a complete regression gate.

**Required outcome:** implement the full design release matrix: after-side-effect uncertainty, concurrent operations, reload during install and deletion, exact resource counts, real pin assertions, store/environment and removed/replaced canaries, raw microsandbox logs, and no destructive fallback for malformed config/pagination. Until then, task 7's broad verification statements are not accepted as complete.

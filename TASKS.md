# V1.1 implementation tasks

Derived from [DESIGN.md](./DESIGN.md). DESIGN.md is the authoritative spec and is
not changed by this plan.

Working rules:

- One task per PR. Split a task if it grows beyond about one day.
- Sections are in dependency order. Complete the verification spikes before
  feature code that relies on their assumptions.
- A task that depends on a spike is not ready until the spike records the pinned
  runtime behavior it assumes.
- Every task leaves `npm run typecheck`, `npm run lint`, and `npm test` passing.
  Tasks that change runtime behavior add or update the relevant unit test.
- Spike scripts must clean up sandboxes and registrations in `finally`.
- Acceptance boxes are the definition of done, not a suggestion list.

## 1. Verification spikes

### 1.1 Verify named registration and host display

Create a sandbox with a custom name, register it with `label = <name>` and
`metadata = { source, name }`, and inspect the parent host directory. Confirm
that Paseo's host picker uses the registration name rather than the guest
daemon's internal hostname. Also check the 1–63 character lowercase-slug rule
against the pinned runtime and parent.

Command:
`node scripts/spikes/verify-v11-host-name.mjs --parent "$PASEO_PARENT_URL" --name paseo-v11-name-probe`

Pass: The host directory exposes the chosen name in `label` and
`metadata.name`, Paseo's picker shows that name, and a duplicate strict create
fails without replacing the first sandbox.

Fail: Paseo displays a different name, the parent rewrites the label, or the
chosen name is rejected by microsandbox.

Acceptance:

- [x] Script records the sandbox name, registration label, metadata, and host
      directory row.
- [x] A screenshot or written note records what Paseo's host picker displays.
- [x] Result is captured in `docs/spikes/v11-host-name.md`.
- [x] If the picker ignores registration names, DESIGN §3 is amended before
      task 2.5. (Not required: the picker renders the registration label.)
- [x] Sandbox and registration are removed in `finally`.

Files: `scripts/spikes/verify-v11-host-name.mjs`,
`docs/spikes/v11-host-name.md`

### 1.2 Verify resource read, legacy caps, and resize semantics

On the pinned runtime, create a V1.1 sandbox with explicit `rootDisk`, `memory`,
`maxMemory`, and a 2-second metrics sample interval. Read the config back and
record the exact keys for CPU, memory, max memory, and root-disk size. Then
resize RAM up and down and grow the root disk, first with
`policy: "no_restart"` and then with `policy: "restart"` when required.

Repeat with a V1-shaped sandbox that has no explicit `maxMemory`, no resources
variable, and no metrics interval. Record its default cap and whether
`maxMemory` can be modified with and without restart.

Command:
`node scripts/spikes/verify-v11-resources.mjs --parent "$PASEO_PARENT_URL" --image "$PASEO_IMAGE_PIN" --timeout 300`

Pass: The script distinguishes live, converging, guest-refused, unsupported,
and restart-required outcomes; observed config matches applied values; a
combined RAM+disk request is handled; the published loopback port and
registration survive a restart; root-disk shrink is rejected; and the legacy
cap path is understood.

Fail: A supported resize cannot be observed, the port changes after restart, the
runtime accepts a shrink, or the legacy cap cannot be changed safely.

Acceptance:

- [x] Script records the create config, every `modify()` plan, `resizeStatus`,
      change dispositions, observed config before and after, and guest `df -m /`
      where applicable.
- [x] Script records the legacy default `maxMemory`, whether it can be changed,
      and what happens to `created`, `stopped`, `paused`, and `crashed` VMs
      under `policy: "restart"`. (`created` and `crashed` were not reproducible:
      detached create reports `running`; `kill()` reports `stopped`.)
- [x] Script records whether `no_restart` persists config/env before a restart,
      whether an identical `restart` call still restarts, and whether `dryRun`
      can discover a restart requirement without applying.
- [x] Script records combined RAM+disk behavior and partial application.
- [x] Result is captured in `docs/spikes/v11-resources.md`.
- [x] Task 3.2 uses only outcomes verified here; unsupported cases become
      `resize_failed` or `restart_required` as appropriate. Env writes must not
      be combined with a `no_restart` resource call.
- [x] Sandboxes and registrations are removed in `finally`.

Files: `scripts/spikes/verify-v11-resources.mjs`,
`docs/spikes/v11-resources.md`

### 1.3 Verify metrics sampling and availability

Read metrics from a V1 sandbox created without an explicit sample interval and
from a V1.1 sandbox created with `metricsSampleIntervalMs(2000)`. Poll at the
3-second cadence and record duplicate/stale timestamps. Confirm the meaning of
`upperUsedBytes`/`upperFreeBytes`, behavior while stopped, and the typed errors
for disabled and unavailable metrics.

Command:
`node scripts/spikes/verify-v11-metrics.mjs --image "$PASEO_IMAGE_PIN" --timeout 180`

Pass: A running V1.1 sandbox produces fresh samples at roughly the requested
interval; polling at 3 seconds shows whether duplicate timestamps occur; a V1
sandbox either produces samples with its default cadence or reports a typed
unavailable reason; a stopped sandbox reports a distinct not-running outcome;
disabled/unavailable errors are distinguishable.

Fail: Metrics are unavailable in a way the SDK does not expose safely, or the
sample fields cannot be mapped without raw-error leakage.

Acceptance:

- [x] Script records several consecutive samples, timestamps, configured
      sampling interval, and poll cadence.
- [x] Script records duplicate/stale behavior, counter regressions across a
      restart, and the stopped/disabled/unavailable error codes.
- [x] Script records whether `upperUsedBytes`/`upperFreeBytes` describe the root
      filesystem or only the writable upper layer.
- [x] Result is captured in `docs/spikes/v11-metrics.md`.
- [x] Sandbox is removed in `finally`.

Files: `scripts/spikes/verify-v11-metrics.mjs`,
`docs/spikes/v11-metrics.md`

## 2. Shared contracts and state

### 2.1 Add V1.1 contracts, constants, and safe errors

Define the canonical name schema, resource request/read schemas, metrics
schemas, and the `vm.metrics` and `vm.resize` RPCs. Extend `vm.create` and child
DTOs without exposing raw config. Keep `paseo-msb=v1` as the managed-label value.

Acceptance:

- [x] Name schema accepts `paseo-<uuid>` and lowercase slugs, and rejects
      uppercase, `/`, whitespace, leading/trailing hyphens, and names over 63
      characters.
- [x] `vm.create` accepts optional `name` and a complete optional `resources`
      pair; defaults are 4096 MiB RAM and 10240 MiB disk with CPU fixed at 2.
- [x] `vm.resize` requires `name`, `id`, and at least one of `memoryMib` or
      `diskMib`; `restart` is optional.
- [x] Resource bounds match DESIGN §7.2. Observed `memoryMib`/`diskMib` may be
      null for legacy VMs; pending resources are non-null. Create accepts any
      valid disk, while resize rejects a shrink, a null disk baseline, and a
      memory target with a null baseline.
- [x] `vm.detail` accepts an optional `requestId` to select a pending attempt;
      `id` and `requestId` are mutually exclusive, and detail does not include
      metrics.
- [x] Pending child DTOs include `resourcesSpecified`; sandbox and
      registration-only DTOs do not.
- [x] `vm.metrics` has a discriminated availability result with fixed reasons
      for no sandbox, not running, disabled, and unavailable.
- [x] `mutation_pending` and `resize_failed` are safe error codes; metrics
      reasons are a fixed enum, not raw strings.
- [x] Constants include the 2-second sample interval, 3-second client poll,
      `STALE_SAMPLE_MS` threshold (10 seconds), and a 5-second future-skew bound.
- [x] Contract tests cover valid and invalid payloads.

Files: `shared/constants.ts`, `shared/contracts.ts`, `shared/errors.ts`,
`tests/server/contracts.test.ts`

### 2.2 Carry name and resources through pending creates

Extend the pending entry and reservation comparison. A repeated request must
match the original name, plan, and resources; a different one is a conflict.
Two different requests may briefly reserve the same name; they remain distinct
by request ID.

Acceptance:

- [x] Pending entries and pending DTOs retain `name`, canonical `resources`,
      and the resources-specified flag.
- [x] Same request ID with the same name/plan/resources/specified flag joins
      the running attempt or restarts a failed one.
- [x] Same request ID with a different name, plan, resources, or specified flag
      is `invalid_request`.
- [x] Different request IDs may reserve the same name; both entries remain
      distinct and visible until reconciliation or dismissal resolves them.
- [x] Create returns the derived name immediately and never waits for sandbox
      work.
- [x] Retry-create input reconstructs the original request ID, name, resources,
      and plan.
- [x] Pending-store tests cover join, restart, conflict, same-name attempts, and
      settlement.

Files: `server/pending.ts`, `server/create.ts`,
`tests/server/pending.test.ts`, `tests/server/create.test.ts`

### 2.3 Extend the sandbox create plan and adapter

Add the request and resources environment variables, explicit root disk,
maximum hotpluggable memory, metrics sample interval, and the resize/metrics
surface to the adapter interfaces. Keep the create plan pure so fake-runtime
tests can assert the pinned values.

Acceptance:

- [ ] New create plans include `PASEO_MSB_REQUEST`,
      `PASEO_MSB_RESOURCES`, `PASEO_MSB_RESOURCES_SPECIFIED`, the requested root
      disk, 2 CPUs, requested memory, `maxMemory` at the allowed maximum, and a
      2-second metrics interval.
- [ ] The real runtime sets `.image(...).rootDisk(...).cpus(...)
      .memory(...).maxMemory(...).metricsSampleIntervalMs(...)` in SDK order.
- [ ] `SandboxHandleLike` exposes the raw `modify()` promise, metrics, and the
      modify options the server needs; fake sandboxes implement them.
- [ ] Create tests assert the plan and builder inputs, including the absence of
      secret values in labels and resource variables.
- [ ] No raw config is added to any public DTO.

Files: `server/sandbox.ts`, `server/runtime.ts`,
`tests/server/fake-runtime.ts`, `tests/server/create.test.ts`,
`tests/server/config.test.ts`

### 2.4 Decode resources and project them into list/detail

Read observed resources from the sandbox config only, with snake_case and
camelCase fallbacks. Read desired resources and the request marker from the
managed environment. Do not substitute desired values for observations.

Acceptance:

- [ ] New sandboxes report CPU, memory, and root-disk size from config.
- [ ] Legacy fields are `null` when not reported; an unreported root disk is
      never invented.
- [ ] `requestedResources`, the internal request marker, and the
      resources-specified flag are decoded from environment; malformed request,
      resources, or specified-flag values are `invalid_config`.
- [ ] A live sandbox supersedes the pending attempt with the same request
      marker, or a legacy sandbox supersedes the pending attempt whose generated
      name matches; a different request's failed/slow pending row stays visible.
- [ ] Pending, sandbox, and registration-only DTOs have explicit resource
      shapes; pending rows expose `resourcesSpecified`, sandbox rows expose
      requested resources, and registration-only rows have no fabricated
      resources.
- [ ] The decoder never leaks raw config, env, credential values, or the request
      marker through public DTOs.
- [ ] List/detail tests cover new, legacy, malformed, partially reported, and
      same-name pending/sandbox merges.

Files: `server/sandbox.ts`, `server/status.ts`, `server/rpc.ts`,
`tests/server/list.test.ts`, `tests/server/detail.test.ts`,
`tests/server/config.test.ts`

### 2.5 Enforce name ownership, request identity, and registration display

Pass the request ID into the reconciler. Scan managed inventory for
`PASEO_MSB_REQUEST` before allocation. A request that already owns a generation
must use the same name, plan, resources, and resources-specified flag. A
markerless legacy generation rejects explicit resources. Update registration
label/metadata to the canonical name and repair drift.

Acceptance:

- [ ] A repeated request ID after readiness finds its generation and does not
      create a second VM.
- [ ] A repeated request ID with a different name, plan, or resources is
      rejected as `invalid_request`, naming the already-owned generation.
- [ ] A different request under the same name fails with `name_conflict` and
      never relabels, adopts, or destroys the existing sandbox.
- [ ] A repeated request after readiness must match the persisted
      resources-specified flag as well as name/plan/resources.
- [ ] A legacy sandbox without `PASEO_MSB_REQUEST` is joinable only when its
      name is exactly `paseo-<requestId>` and the request did not explicitly
      supply resources. An explicit resource selection against a markerless
      legacy sandbox is `invalid_request`.
- [ ] New registrations use `label = <name>` and
      `metadata = { source: "paseo-msb", name }`.
- [ ] Recovery/Repair update an enabled V1 registration from
      `<parent>/<name>` to `<name>`; a disabled registration is untouched.
- [ ] Recovery, Repair, and Create still produce at most one registration per
      generation.
- [ ] Tests cover same-request join, different-request conflict, post-ready
      request reuse, legacy omitted-vs-explicit resources, foreign-name
      conflict, duplicate pending rows, and registration drift.

Files: `server/reconciler.ts`, `server/registration.ts`,
`server/status.ts`, `server/recovery.ts`, `server/reconcile.ts`,
`tests/server/create.test.ts`, `tests/server/reconcile.test.ts`,
`tests/server/recovery.test.ts`, `tests/server/list.test.ts`

## 3. Server operations

### 3.1 Add native mutation settlement

Track every exact native `modify()` promise per name, including phase, error,
environment, resource, and `deleting` tombstone labels. A `bounded()` timeout or
lifecycle abort is not settlement. Delete and same-name allocation must not
proceed while a mutation remains unsettled.

Acceptance:

- [ ] A per-name mutation registry records every raw native `modify()` promise,
      including phase/error labels and the `deleting` tombstone, and clears it
      only when that promise settles.
- [ ] The resize lane is held until the native call settles or the short
      settlement bound expires; an RPC timeout does not free the lane.
- [ ] Delete aborts the logical resize, then checks the registry. An unsettled
      mutation returns `mutation_pending` without tombstoning or destroying.
- [ ] The `deleting` tombstone is registered and awaited. If it does not settle,
      Delete returns `mutation_pending` and does not destroy.
- [ ] Same-name Create/Repair checks the registry and returns
      `mutation_pending` instead of allocating or advancing.
- [ ] `bounded()` is not treated as cancellation or settlement anywhere in the
      label/resize/Delete path.
- [ ] The raw-SDK identity contract is extended to label, environment, and
      resource `modify()` writes against a same-name replacement.
- [ ] Unit tests cover settled, timed-out, aborted, tombstone, label-write, and
      process-cleanup paths.
- [ ] The external-replacement residual window remains documented and is not
      claimed closed.

Files: `server/mutations.ts`, `server/lanes.ts`, `server/sandbox.ts`,
`server/reconciler.ts`, `server/delete.ts`, `server/index.ts`,
`tests/server/mutations.test.ts`, `tests/server/delete.test.ts`,
`tests/integration/identity-contract.test.ts`

### 3.2 Implement `vm.resize`

Add the lane-serialized resize mutation using the mutation registry. It must
refresh and compare the exact generation, enforce bounds and grow-only disk,
handle legacy memory caps, apply with the verified policy, persist the desired
resources, and report an honest outcome.

Acceptance:

- [ ] `vm.resize` rejects an unknown child or name/id mismatch with
      `id_mismatch`, and unreadable inventory/runtime with a safe error.
- [ ] An unknown/extra payload field is rejected.
- [ ] A target equal to observed and requested returns `unchanged` without
      calling `modify()`; a target equal to observed but different from
      requested clears the pending desired value.
- [ ] A disk target below observed is `invalid_request`; a disk change with an
      observed null baseline is `invalid_request`. A memory target with an
      observed null baseline is `invalid_request`.
- [ ] `no_restart` produces `applied`, `converging`, or `restart_required`
      according to the verified SDK outcome and the DESIGN §7.2 precedence
      table.
- [ ] `applied` is returned only when observed config confirms the target;
      unreported or still-different values cannot be reported as applied.
- [ ] A `no_restart` RAM target above the legacy/unknown `maxMemory` cap
      returns `restart_required` before calling `modify()` and never includes
      `maxMemory`.
- [ ] Legacy RAM growth includes `maxMemory` only on `restart: true`; the
      restart path returns `applied` or `resize_failed` per the spike, while the
      no-restart path returns `restart_required` as above.
- [ ] `restart: true` is accepted only for the exact generation when it is
      `running`; created/stopped/crashed/paused VMs are rejected and never
      started.
- [ ] The same modify call writes canonical `PASEO_MSB_RESOURCES`, and the
      response includes observed and requested resources.
- [ ] Mixed RAM+disk changes use the stated severity order and are unit tested,
      including a converging-plus-restart-required request that must return
      `restart_required`.
- [ ] Raw SDK messages never cross the RPC boundary.
- [ ] Unit tests cover bounds, shrink, null baseline, no-op, clear-pending,
      statuses, generation mismatch, legacy cap, restart states, modify failure,
      and concurrent Delete.

Files: `server/resize.ts`, `server/index.ts`, `server/sandbox.ts`,
`tests/server/resize.test.ts`, `tests/server/fake-runtime.ts`

### 3.3 Implement `vm.metrics`

Add a dedicated exact-generation metrics RPC. It must not read inventory, jobs,
or logs. It should resolve the handle, verify the generation and ownership, and
return a bounded snapshot or a fixed unavailable reason. Coalesce native reads
so repeated timeouts or multiple clients do not accumulate `metrics()` calls.

Acceptance:

- [ ] `vm.metrics` resolves the named handle, compares `handle.id`, verifies the
      managed and parent labels, and returns `not_running` without calling
      `metrics()` for a non-running generation.
- [ ] A missing handle is `no_sandbox`; a different generation is the
      `id_mismatch` RPC error; foreign/malformed labels are `unavailable`.
- [ ] The parent ID comes from a cache refreshed by `vm.list`/`vm.detail`, with
      one bounded directory read when the cache is empty.
- [ ] A running sandbox returns a sample with the DESIGN §7.3 numeric fields and
      the SDK timestamp.
- [ ] `metricsDisabled` maps to `disabled`; other read failures map to
      `unavailable`; a timeout does not stall or fail other reads.
- [ ] The server coalesces by `(name, id)`: one raw `metrics()` promise is
      shared, a timed-out RPC does not start another native read, and the entry
      clears only on actual settlement.
- [ ] No raw SDK error text is returned.
- [ ] `vm.metrics` does not read inventory, jobs, or logs.
- [ ] Unit tests cover available, no-sandbox, stopped, disabled, unavailable,
      timeout, repeated timeout with one native invocation, malformed values,
      NaN/infinity/negative counters, invalid timestamps, foreign labels, and
      generation mismatch.

Files: `server/metrics.ts`, `server/rpc.ts`, `server/sandbox.ts`,
`server/index.ts`, `tests/server/metrics.test.ts`,
`tests/server/fake-runtime.ts`

## 4. Client

### 4.1 Add name, resources, and same-name attempt selection to Create

Add the optional name field, fixed CPU display, and editable RAM/root-disk
fields. Keep retry inputs intact. Make pending rows and detail selection
request-ID aware so two attempts may share a name safely.

Acceptance:

- [ ] The name field shows the generated-name placeholder; invalid local input
      blocks submit with a clear message.
- [ ] RAM and disk default to 4096 MiB and 10240 MiB; CPU is read-only at 2.
- [ ] RAM/disk validation matches the shared bounds and steps.
- [ ] Create sends `name` only when the user entered one, plus `resources`.
- [ ] Synchronous validation/credential errors stay in the modal. An
      asynchronous `name_conflict` appears on the new pending child and can be
      dismissed; the modal does not claim to have detected it.
- [ ] Retry create preserves the original name, resources, and whether
      resources were explicitly supplied.
- [ ] Pending rows use request ID in their key and selection; detail requests
      include `requestId` for pending children.
- [ ] Compact and wide layouts remain usable.
- [ ] Pure validation/formatting/selection helpers are unit tested.

Files: `client/CreateChild.tsx`, `client/ChildList.tsx`, `client/screen.tsx`,
`client/state.ts`, `client/hooks/useVmDetail.ts`,
`client/__tests__/state.test.ts`

### 4.2 Add the live metrics panel and poller

Add a dedicated `useVmMetrics` poller and a detail panel. Poll only while a
running sandbox's detail is visible, with single-flight scheduling and
stale/duplicate handling.

Acceptance:

- [ ] The poller runs every 3000 ms only when enabled, schedules the next
      request after completion, and stops on unmount or selection change.
- [ ] The poller is single-flight; a slow request does not accumulate
      overlapping calls.
- [ ] CPU, memory, disk I/O, network, uptime, and root-disk data are formatted
      from the sample without inventing values.
- [ ] The first sample shows absolute values and `—` for rates.
- [ ] Rates reset on generation change, non-increasing timestamps, stale or
      future SDK timestamps beyond `STALE_SAMPLE_MS`/clock-skew bounds, uptime
      regression, and cumulative counter regression; duplicate samples do not
      recompute rates.
- [ ] CPU uses `cpuPercent` directly and is not differentiated.
- [ ] Stopped, disabled, unavailable, and no-sandbox states have fixed,
      human-readable messages and do not look like zero usage.
- [ ] Pending and registration-only children do not show a live metrics panel.
- [ ] Poll scheduling and rate state are extracted into pure helpers and tested
      with fake timers for cadence, slow requests, unmount, duplicates, and
      resets.

Files: `client/ChildDetail.tsx`, `client/hooks/useVmMetrics.ts`,
`client/metrics.ts`, `client/state.ts`, `client/ui.tsx`,
`client/__tests__/metrics.test.ts`

### 4.3 Add the resize flow and resource display

Show observed and requested resources in the detail, with an **Edit resources**
action, and show known/requested RAM/disk in list rows. The dialog submits
`vm.resize`; when the result is `restart_required`, explain the disconnect and
require a second explicit confirmation before calling again with
`restart: true`.

Acceptance:

- [ ] The detail shows RAM/disk, and `requestedResources` when a restart is
      pending.
- [ ] List rows show requested resources for pending children and known
      observed resources for sandboxes; null fields are omitted.
- [ ] The resize dialog defaults to current/requested values, enforces bounds,
      disallows disk shrink, disables disk editing when the observed disk is
      null, and disables RAM editing when observed memory is null.
- [ ] `unchanged`, `applied`, `converging`, and `restart_required` each produce
      distinct feedback; only the last offers a restart action.
- [ ] The restart action is shown only for a running VM; created/stopped/
      crashed/paused VMs show why the plugin will not start them.
- [ ] The restart confirmation names the child and says active sessions will
      disconnect.
- [ ] Successful resize and restart refresh the detail, metrics, and list.
- [ ] Errors stay in the dialog or as a toast without closing it.
- [ ] No general stop/start/restart controls are introduced.
- [ ] Dialog validation and restart-state transitions are extracted into pure
      helpers and unit tested.

Files: `client/ChildDetail.tsx`, `client/ChildList.tsx`, `client/screen.tsx`,
`client/state.ts`, `client/ui.tsx`, `client/__tests__/resize.test.ts`

## 5. Verification and documentation

### 5.1 Names, request IDs, legacy, and registration integration

Drive names and request identity through the real runtime and parent daemon.

Acceptance:

- [ ] A custom-named child reaches ready, appears under that name in
      `vm.list`, and has a registration row with the name in `label` and
      `metadata.name`.
- [ ] A second request using the same name fails with `name_conflict` and
      leaves the first generation untouched.
- [ ] Two same-name pending attempts remain distinct and the losing conflict
      stays visible after the winner becomes a sandbox.
- [ ] A repeated request ID after readiness is rejected if it changes the
      name/selection, resources-specified flag, or resources and does not create
      a second VM.
- [ ] Generated names still work, and a real V1-shaped child without request or
      resources markers can be listed, repaired, and deleted without being
      adopted by a new request. An omitted-resources retry may join it; an
      explicit resource selection is rejected.
- [ ] The V1-shaped fixture has no explicit root disk, `maxMemory`, or metrics
      interval, and keeps the old `<parent>/<name>` registration label.
- [ ] Canary credentials remain absent from RPC output, logs, raw sinks,
      pending state, labels, env, and test artifacts.
- [ ] `npm run typecheck`, `npm run lint`, `npm test`, and
      `npm run test:release` pass on the verified pins.

Files: `tests/integration/vertical.test.ts`,
`tests/integration/fixtures/harness.ts`, `tests/integration/fixtures/README.md`,
`docs/release-test.md`

### 5.2 Resources, resize, and mutation settlement integration

Drive create-time resources and every resize outcome through the real runtime
and parent daemon.

Acceptance:

- [ ] Create-time RAM/disk are visible and match the requested values.
- [ ] RAM growth and shrink cover applied, converging, and restart-required
      outcomes as verified by the resource spike.
- [ ] Legacy `maxMemory` growth is covered or explicitly rejected with
      `resize_failed`; it never creates a second VM or loses the registration.
- [ ] Root-disk growth works; shrink and legacy-null disk changes are rejected.
- [ ] Restart is rejected for created/stopped/crashed/paused VMs and never
      starts them.
- [ ] A confirmed restart returns the routed host online on the same published
      port.
- [ ] Delete waits for an unsettled native mutation, including an unsettled
      `deleting` tombstone, and returns `mutation_pending` instead of
      destroying.
- [ ] A mixed converging-plus-restart-required resize returns
      `restart_required`, not `converging`.
- [ ] The identity contract covers stale-handle label, env, and resource writes.
- [ ] `docs/release-test.md` documents the new cases.

Files: `tests/integration/vertical.test.ts`,
`tests/integration/identity-contract.test.ts`,
`tests/integration/fixtures/harness.ts`, `docs/release-test.md`

### 5.3 Metrics and polling integration

Drive `vm.metrics` and the 3-second poll through the real runtime and parent
daemon.

Acceptance:

- [ ] Two consecutive metrics polls return live samples with SDK timestamps.
- [ ] A deliberately slow metrics read is bounded and does not delay or fail
      detail/log reads. The single-flight poll behavior is covered by the
      fake-timer test from task 4.2.
- [ ] Repeated metrics RPCs against an unresolved native read coalesce to one
      `metrics()` invocation; the entry clears after actual settlement.
- [ ] Stopped, disabled, and unavailable reasons are covered.
- [ ] Duplicate/stale samples and a restart with counter/uptime reset do not
      produce negative or fabricated rates.
- [ ] `vm.metrics` does not read inventory, jobs, or logs; a metrics failure
      does not fail detail or logs.
- [ ] `docs/release-test.md` documents the metrics checks.

Files: `tests/integration/vertical.test.ts`, `docs/release-test.md`

### 5.4 Update user documentation and changelog

Remove the V1 claims that names and sizes are fixed and metrics are absent.
Describe names, create-time resources, resize semantics, live metrics, and the
remaining limits.

Acceptance:

- [ ] README describes optional names, the 2-CPU/4096-MiB/10240-MiB defaults,
      the resource bounds, disk grow-only behavior, and live metrics.
- [ ] README states that only a confirmed resize of a running VM may restart it
      and that there are still no general lifecycle controls, CPU resize,
      rename, disk shrink, or metrics history.
- [ ] CHANGELOG has an Unreleased V1.1 entry covering names, resources, resize,
      live metrics, and registration display migration.
- [ ] `docs/release-test.md` no longer links to the old
      `generation-exact-label-writes-pinned-sdk-limitation` heading; it points
      to the current `Generation-exact mutations` section.
- [ ] No documentation claims that V1.1 can rename an existing child or shrink
      a disk.
- [ ] Links to `DESIGN.md` and the release test remain valid.

Files: `README.md`, `CHANGELOG.md`, `docs/release-test.md`

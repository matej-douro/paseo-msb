# Changelog

Completed work for paseo-msb, one entry per commit in chronological order. Merge commits are
listed where they close a PR. This file replaces the historical task and audit records;
[DESIGN.md](./DESIGN.md) is the authoritative spec and [TASKS.md](./TASKS.md) tracks what is still
open.

## 2026-11-13

### `01c2e76` — Add the shared provisioning catalog, planner, and provisioner

- Added `shared/provisioning/` with the data-only provider/integration catalog, plan validation and
  canonical hashing, deterministic content-addressed provision script rendering, and the status
  contract, plus 24 unit tests.

### `3baa290` — Document the provisioning design

- Recorded the agreed provider/integration selection model, credential direction, provisioning
  semantics, pins, and remaining verification in `docs/provisioning.md`.

### `cfbfb88` — Install selected providers and integrations

- Replaced `secretEnvVars` with the provider/integration plan, persisted `PASEO_MSB_PLAN`, added
  `CLAUDE_CODE_OAUTH_TOKEN`, raised the default VM memory to 4096 MiB, and injected only the
  credentials the selected options require.
- Replaced the Pi-only install path with one idempotent provision script and detached job, made all
  provisioning failures fatal, and confirmed every selected Paseo provider before `ready`.
- Rebuilt the Create screen around collapsible Providers and Integrations sections with availability
  reasons, nested LLM options, and a derived-credential confirmation; detail now shows the plan.

### `ba669e5` — Exercise the provider plan and provision job in the release test

- Updated the real-runtime test to create a plan, wait for the plan-hash provision job and
  `status.json`, and assert the selected provider and pinned version in the child.

### `e841d6e` — Document the provider and integration flow

- Updated the README, DESIGN, TASKS, and provisioning doc for the new selection model, six fixed
  credentials, 4096 MiB shape, provider toolchain pins, and remaining live matrix.

## 2026-11-02

### `a8e5715` — Initial commit

- Created the `README.md` stub.

### `2f570b3` — Add v1 design for VM-backed Paseo hosts

- Added `DESIGN.md` for the VM-backed Paseo host model and expanded the README.

### `c9b8c48` — Merge PR #1 (`design/v1`)

### `251b83e` — Add TASKS.md

- Added the initial implementation plan derived from `DESIGN.md` (1,178 lines): tasks, acceptance
  criteria, and touched files.

### `f7c99e5` — Merge PR #4 (`design/tasks`)

### `718f720` — Merge PR #5 (`design/v1`)

## 2026-11-09

### `10a957e` — Revise v1 design around persistent microsandbox state

- Reworked `DESIGN.md` around persistent microsandbox state and rewrote the task plan to match.

### `f5f5766` — Merge PR #6 (`docs/design-review-updates`)

### `7629a66` — Reduce v1 to a minimal Paseo-managed vertical slice

- Cut the design and plan down to the minimal vertical slice: one fixed image, five RPCs, one
  management screen.

### `385adc3` — Merge PR #7 (`docs/minimal-v1`)

### `79c6359` — Add Neuralwatt and GitHub secret passthrough

- Added the Neuralwatt and GitHub credential-to-host mappings to the design and task plan.

### `6efd566` — Merge PR #8 (`docs/add-v1-secret-bindings`)

## 2026-11-13

### `c739174` — chore: add spike dependencies and ignore generated files

- Pinned the Paseo client and microsandbox SDK versions used by the vertical slice.
- Ignored `node_modules` and scratch output.

### `25618d6` — test: add end-to-end vertical slice verification spike

- Added `scripts/spikes/verify-vertical-slice.mjs` and an HTTPS echo fixture.
- Covered fixed sandbox creation, non-root Pi installation, host registration, routed provider
  refresh, header-only secret substitution, blocked destinations, restart recovery, port release,
  and stable-ID replacement against the pinned Paseo image.

### `939f616` — docs: record vertical slice results and pins

- Added `docs/spikes/vertical-slice.md` with the verified image, runtime, and Pi pins, acceptance
  results, and the explicit-tini and host-port-probe fallbacks.
- Marked task 1 complete.

### `53b7b19` — chore: scaffold the paseo-msb plugin project

- Added the plugin manifest at the verified Paseo 0.15.4 floor, a strict TypeScript project, and
  build/typecheck/test scripts with the plugin SDK dev dependencies.

### `2b64510` — feat: add v1 constants and typed RPC contracts

- Pinned the image, Pi package, resources, guest port, labels, and the five credential-to-host
  mappings in `shared/constants.ts`.
- Defined exactly `vm.list`, `vm.detail`, `vm.create`, `vm.delete`, and `vm.reconcile` with safe
  error codes and no credential values.

### `ac218fb` — feat: add read-only sandbox inventory and projection

- Listed label-filtered sandboxes for the current parent, joined parent registrations by stable ID,
  and merged an initially empty pending-create map.
- Strict config decoding exposes only stable ID, name, labels, runtime status, and registration
  identity/status; detail adds bounded, redacted sandbox and job logs and distinguishes unavailable
  from empty inventory.
- Registered mutation contracts behind a safe `not_implemented` error; the client entry rendered a
  placeholder screen.

### `cee27f0` — test: cover config decoding and read-only RPC behavior

- Added fake sandbox and parent-host fixtures and tests for the strict decoder, stable-ID joins,
  pending merging, unavailable versus empty inventory, log bounds and redaction, and contract
  strictness.

### `608924f` — docs: mark task 2 complete

- Recorded the read-only scope and the safe `not_implemented` mutation handlers; updated project
  status.

### `b6f9868` — fix: load microsandbox at runtime instead of bundling it

- Paseo compiles plugin server code to CommonJS, so the ESM SDK's `import.meta.url` is undefined and
  the plugin failed to load.
- Resolved the installed directory-source path from `paseo.config.get()` and imported the package at
  runtime; recorded the constraint in the spike notes.

### `731473e` — feat: add create-time safe errors and paseo- name prefix

- Added create-time safe error codes and the `paseo-<requestId>` name prefix.

### `5a768d0` — feat: add sandbox create plan, secret resolution, and Pi install specs

- Added the sandbox create plan, parent-environment secret resolution, and pinned Pi install specs.

### `5c57ff8` — feat: implement idempotent background child creation

- Implemented `vm.create` background work: validate selected credential names, add a pending entry,
  return `{ name }` immediately, then create the fixed detached VM with labels, loopback port, and
  header-only microsandbox secrets, and install pinned Pi through `execDetachedWith`.
- Per-request-ID idempotency prevents a second name or ownership of a same-name replacement; phase
  and short safe error codes are observable through list/detail, and no secret value enters pending
  state, RPC, or logs.

### `5117645` — test: cover background creation, retries, and redaction

- Added fake-runtime coverage for success, duplicate request ID, pull/boot/install failure, missing
  credentials, port retry, and redaction.

### `f4a54cf` — docs: mark task 3 complete

### `d5185c1` — feat: implement registration, recovery, Repair, and Delete

- Moved Pi-ready sandboxes through `registering` using the stable sandbox ID as `sourceKey`, waited
  for routed online, refreshed providers, confirmed Pi, and reached `ready`.
- Added plugin-init recovery by persisted IDs, `vm.reconcile` to resume setup and restore or remove
  registrations without creating, starting, adopting, or deleting sandboxes, and `vm.delete` guarded
  by name, stable ID, and confirmation.
- Delete reads registrations before destroying so an unavailable daemon never leaves an unmanaged
  running VM; failed and incomplete children are deletable through the UI.

### `ae52075` — test: cover recovery, Repair, and Delete

- Added recovery, Repair, and Delete suites covering interruption at each phase, reload with one
  detached job, stale/duplicate/foreign registrations, missing resources, and unavailable inventory.

### `60e65eb` — docs: mark task 4 complete

### `28133f6` — feat: add client state helpers and polling hooks

- Added pure client state helpers, request-ID generation, and the list/detail polling hooks.

### `0395079` — feat: build the single VM management screen

- Added the create confirmation, pending/managed list, and a detail pane with bounded logs, Repair,
  and Delete in one sidebar screen; polling runs only while mounted and the selection reconnects by
  sandbox name.

### `e95421b` — test: cover client helpers and request IDs

### `157c0ec` — docs: mark task 5 complete

### `1c4ec30` — feat: add a plugin-managed credential store

- Added `<PASEO_HOME>/plugin-data/paseo-msb/secrets.json` (0700 directory, 0600 file,
  `PASEO_MSB_SECRETS_FILE` override) for the five fixed names.
- `secrets.list`/`secrets.set`/`secrets.delete` expose names and sources only; create resolves
  stored values before parent environment values and fails safely when the store is unavailable;
  redaction now covers both sources.

### `b8ec96e` — feat: manage stored credentials in the plugin screen

- Added the in-screen credential manager and marked each available name as Stored or Environment in
  the create confirmation.

### `453a769` — test: cover credential store persistence and precedence

### `84ef65f` — docs: document the plugin credential store

- Updated `DESIGN.md`, the README, and the task plan (task 5b).

### `8b5f4d0` — feat: surface bounded failure details

- Returned a redacted, bounded reason alongside the fixed safe error code for pending creates and
  failed sandboxes, persisted it as a managed label, and rendered it in the single screen, including
  inventory and registration failures.

### `bf961c4` — test: add the real-runtime vertical release test

- Added `npm run test:release`, which drives the five lifecycle RPCs against a pinned parent,
  reloads during Pi installation, restores and cleans up registrations, and verifies the stored
  credential only reaches the microsandbox secret entry.

### `3af1f33` — docs: document operation, diagnostics, and the release check

- README now records requirements, pins, the five credentials, Create/Repair/Delete behavior, the
  loopback trust boundary, reload limitations, failure diagnostics, and the release-test command.

### `e247bb0` — chore: setup biome and fix lints

- Added the Biome configuration and fixed lints across client, server, and integration tests.

### `94620a6` — docs: add latest audit results

- Added the first `FINDINGS.md` audit of lifecycle and identity races: unserialized lifecycle
  operations, destructive Repair on incomplete inventory, and unmanageable ID/job persistence crash
  windows.
- Added task 7 acceptance criteria in `TASKS.md` and revised `DESIGN.md` around the name-based
  identity model.

### `6003ed2` — test(spikes): verify identity and lifecycle API semantics

- Added `scripts/spikes/verify-identity-lifecycle.mjs` and its fixture plugin.
- Recorded the exact-handle matrix, complete paginated job recovery, and real-plugin registration
  behavior. Proved that the pinned `modify()` applies to a same-name replacement and that
  registration updates must list before add.

### `315b760` — feat: implement name-based identity and transactional reconciliation

- Replaced the separate create, recovery, and repair runners with one per-name reconciler and
  serialized lifecycle lanes.
- Added generation-guarded label writes, structured job outcomes, strict plugin registration
  identity, tombstoned Delete, fail-closed stale-registration cleanup, legacy ID quarantine,
  registration-only children, and pending-create retry in the UI.
- Updated contracts, status projection, and unit/release tests.

### `904b83a` — docs: document name-based identity and task 7 results

- Documented the reconciler, generation-guarded writes, retryable failure semantics, tombstoned
  Delete, registration-only children, legacy label migration, and the validated release flow.
- Marked task 7 complete; a follow-up review subsequently reopened residual races (see `399bce8`).

### `399bce8` — docs: add latest audit results

- Rewrote `FINDINGS.md` with the nine post-`904b83a` lifecycle/identity findings: shutdown admitting
  new work, permanent pending-create no-ops, blocking and racy create preflight, incomplete
  registration repair, redaction bypasses, non-atomic generation/stale cleanup, unbounded job waits,
  false-certainty UI/contract state, and release claims exceeding executable coverage.
- Added task 8 acceptance criteria in `TASKS.md`.

### `b9ca43f` — refactor(secrets): drop the store path and enforce owner-only permissions

- `secrets.list` now returns names and sources only, matching the design.
- Store `chmod` failures are fatal instead of best effort.

### `40a9828` — fix(lifecycle): close lanes, bound waits, and settle creates once

- Plugin cleanup permanently closes every lane, so no Create, recovery, Repair target, or Delete can
  start a side effect afterwards.
- Every job, guest, label, log, lookup, create, and destroy call is bounded and carries the lane's
  abort signal.
- Create reserves the request synchronously, returns before external work, resolves credentials
  inside the lane, and settles the pending attempt exactly once on success, failure, or cancellation.
- Registration ownership is the parent directory plus the authenticated producer and source key;
  connection, label, and metadata drift are repaired without re-enabling disabled registrations.
- Stale-registration cleanup revalidates runtime absence at removal time; legacy
  `failed/install_failed` labels are reclassified from job inventory before any terminal decision.

### `f41ce0d` — feat(client): distinguish availability states and make polling latest-wins

- Empty inventory now requires available inventory and registrations; unavailable registrations read
  as unknown rather than "Not registered".
- Detail can select an exact generation when a failed pending attempt and a registration-only child
  share a name.
- Poll responses are latest-request-wins, and manual post-mutation refreshes are no longer skipped
  behind an active poll.

### `84831b5` — feat(diagnostics): surface native addon load failures

- `failureDetail` walks the whole cause chain, so an inventory error shows the dlopen reason instead
  of only napi-rs's npm hint.
- Added `check:native` (pinned addon under system Node and the signed `Paseo.app` runtime) and
  `check:plugin` (plugin load state and `vm.list` against a running daemon).

### `dac8355` — test: assert release pins, raw logs, and identity spike outcomes

- The identity spike now asserts every stale-handle result and records the `modify()` limitation.
- The release test asserts the SDK pin, exactly one install job, the exact image, raw sandbox, job,
  and system logs, and replaced and removed credential canaries.

### `be805b1` — docs: record task 8 and the native addon limitation

- Documented lane closure, create settlement, registration repair, the pinned `modify()` limitation,
  availability states, and the new checks.
- Added workstation guidance for the macOS hardened-runtime Team ID failure.
- Marked task 8 complete except for the live release verification.

### `bd1cc24` — Update package-lock.json

### `e5548b7` — fix(pi): keep the missing-Pi probe out of the sandbox log

- Short-circuited the Pi path/version probe so a fresh sandbox no longer writes
  `sh: 1: pi: not found` to stderr before the first install; asserted the pinned path/version parser.

### `68bbcc3` — feat(client): split the VM screen into list and detail panels

- Replaced the full-width header with a panel that puts Create child and Manage secrets above the VM
  list, and wrapped the detail pane in a bordered sheet so the two columns read as separate areas.

### `7cb392b` — feat(client): show setup and VM pills with collapsible logs

- Derived a setup-health pill from the stored phase and safe error code and a VM-status pill from
  runtime folded with registration reachability; both render filled in list rows and the detail sheet.
- Moved Repair and Delete into the detail header as icon buttons with hover tooltips.
- Rendered the sandbox and Pi install logs as collapsible monospace blocks with line counts and a
  separate timestamp column.

### `c67c659` — feat(credentials): present the store as a table with in-field actions

- Replaced the credential cards with name/value rows, dropped the status pill, and masked stored
  values as a fixed run of dots.
- Moved save and remove to ghost icon actions inside the value field, enabled only when the action is
  possible.

### `0b6f9d7` — docs: describe the pill split and the log blocks

- Recorded the two-pill list presentation, collapsible monospace logs, and icon actions in the
  design's UI section.

## Resolved audit findings (task 8)

The nine findings recorded in `FINDINGS.md` at `904b83a` were closed by `40a9828`, `f41ce0d`,
`b9ca43f`, and `dac8355`:

1. **Shutdown admitted new lifecycle work.** `settle()` permanently closes all lanes before waiting;
   every job, guest, label, log, lookup, create, and destroy call is bounded and abortable.
2. **Pending Create could no-op permanently.** Create reserves synchronously and settles each
   attempt exactly once on success, failure, or cancellation; registration-only failures stay
   visible and actionable.
3. **Create preflight was blocking and racy.** Reservation and credential-name validation happen
   synchronously before external awaits; preflight runs in the per-name lane against the original
   selection.
4. **Registration repair was incomplete and inconsistent.** Ownership is the parent directory plus
   authenticated `(source.id, source.key)`; connection, label, and metadata drift are repaired in one
   update and disabled registrations are never re-enabled.
5. **Public diagnostics bypassed redaction.** One diagnostic boundary redacts directory errors,
   unexpected reconciler errors, legacy labels, and persisted VM values.
6. **Generation mutation and stale cleanup were not atomic.** Stale cleanup re-reads the runtime at
   removal time. The pinned `modify()` cannot bind a generation, so `DESIGN.md` documents the
   limitation and the residual tombstone window rather than claiming atomicity.
7. **Job waits and legacy recovery could stall or skip work.** All job API awaits are bounded and
   abortable; legacy `failed/install_failed` labels are reclassified from complete job inventory.
8. **UI and contract state carried false certainties.** Unavailable, empty, missing, and unregistered
   are distinct; polling is latest-request-wins; `secrets.list` is names/sources only; store
   permissions are enforced.
9. **Release claims exceeded coverage.** The identity spike asserts every stale-handle outcome, and
   the unit/release suites cover lane closure, cancellation, reload during deletion, exact install
   counts, pins, raw log sinks, and replaced/removed credential canaries. The live release run on the
   documented pins remains open in `TASKS.md`.

### Known limitation carried forward

The pinned microsandbox `modify()` is not generation-bound: a stale handle can affect a same-name
replacement. Label writes refresh and compare the exact generation first, and cleanup revalidates at
removal time, but a residual tombstone window remains. This is documented in `DESIGN.md`; no further
work is planned unless the SDK adds generation-bound mutation.

# Changelog

Notable user-visible changes to paseo-msb, grouped by release date. The
authoritative architecture is [DESIGN.md](./DESIGN.md).

## Unreleased

### Added

- Every plan installs a plugin-provided `paseo-msb-vm` skill into
  `~/.agents/skills` and `~/.claude/skills` that describes the VM's guest user,
  paths, tool pins, selected plan, and provisioning status. The step is
  re-applied after the Paseo tools skill selection so it survives that
  reconcile; a ready child keeps the copy from its last provisioning, though a
  later daemon-side skill reconcile may remove it and recreating the child
  restores it.
- Create accepts explicit CPU, RAM, and root-disk selections within the
  documented bounds; the defaults are 2 CPUs, 4096 MiB RAM, and 10240 MiB root
  disk.
- A child's detail can edit RAM and grow its root disk without recreating it.
  A resize reports `applied`, `unchanged`, `converging`, `restart_required`, or
  `resize_failed`; only a confirmed resize of a running VM may restart it, and
  a resize never writes the `maxMemory` hotplug cap or creates a second VM.
- A running child's detail shows a bounded live resource chart for CPU, memory,
  disk I/O, network, and root-disk usage. Samples are polled from `vm.metrics`
  every 3 seconds, kept only for the open detail, and never persisted.
- A **Paseo tools** integration enables Paseo tools for the selected providers
  and installs all bundled orchestration skills once the child is online and its
  selected providers are ready. It needs no credential and is unchecked by
  default.
- Failed pending Create attempts can be dismissed without a plugin reload.
- The release suite covers concurrent Create/Repair, registration drift, an
  injected Delete tombstone that is refused and removable only with Delete,
  stale generations, foreign-name conflicts, provision-job conflicts, and the
  raw-SDK stale-handle identity contract.

### Changed

- The Create screen’s provision-job identity ignores runtime-only integrations
  such as **Paseo tools**, so existing plans keep their content-addressed job
  hash.
- The Create screen no longer repeats resource step and bounds help beneath
  the RAM/root-disk sliders and the CPU field.
- Create identity is now the child name: the form submits a short generated
  `paseo-<token>` name, only one attempt exists per name, and a same-name Create
  joins only when its plan and resource shape match. Request IDs and the guest
  `PASEO_MSB_REQUEST` marker were removed.
- New parent registrations use the canonical child name as `label` and
  `metadata.name`; Repair corrects display drift.
- Delete and background cleanup share one rule: a plugin-owned host row survives
  only while an exact lookup of its child name returns that row's generation id.
  Delete no longer writes a durable `deleting` tombstone; it destroys the
  confirmed generation and removes every plugin-owned host row for the name, and
  the sweep converges any row left by an interrupted Delete. A leftover
  `deleting` tombstone from an earlier version is never resumed, replaced, or
  destroyed automatically: it lists as an undecodable child and only Delete
  removes it.
- Registration-only children are presented as transient cleanup states: while
  absence is unproven they show `VM state unknown`, not `Missing`, and Repair
  and Delete remain available.
- Create and Retry check credential-store availability before acting; store
  failures surface as action errors and toasts rather than stale availability.
- Selection remains stable when a pending child becomes a sandbox, duplicate
  action toasts and cleanup were removed, and credential mutations disable all
  row actions while one is pending.
- Sandbox and provisioning output appears as one chronological log with exact
  duplicates removed instead of separate log panels.
- Documentation is organized around user-facing operation, with provisioning and
  release-test references under `docs/` and a grouped changelog.

### Fixed

- A clear-only resize sent with `restart: true`—a target that already matches
  the observed resources but differs from the persisted desired value—now
  records the cleared value instead of reporting `applied` while the stale
  pending value stayed visible. Such a request never restarts the VM.
- Git and registry installs no longer fail with
  `Could not resolve type dependency "microsandbox"`: those installs stage a
  bare checkout, so `paseo-plugin.json` now runs
  `npm ci --omit=dev --ignore-scripts` before the compiler resolves imports.
  `zod` moved to `dependencies` because the bundled server and client code
  import it at runtime, so a production-only install must include it.
- A Create blocked by an existing attempt for the same name now suggests
  retrying, dismissing, or choosing another name instead of only saying the
  request is invalid.
- A failed pending Create stays visible beside a same-name sandbox, so its error
  can be retried or dismissed. A post-allocation failure is not repeated as a
  second pending row.
- A VM destroyed outside the plugin (for example with `msb`) no longer leaves
  its parent-daemon host registration behind: a lightweight background sweep,
  also triggerable by `vm.list`, removes every plugin-owned row whose child name
  no longer resolves to that row's generation id.
- A Delete interrupted after destroying the VM no longer leaves a permanent
  parent-daemon host row: the next sweep, Repair, or Delete removes it by the
  same rule. A registration-only child can also be deleted while a native
  mutation is unsettled.
- Repeated Create and recovery can join an existing VM after its current
  credentials were removed or the store became unavailable.
- Delete accepts an owned exact-generation VM with an invalid historical plan,
  handles already-vanished and interrupted-create generations, and preserves
  replacement safeguards.
- Parent directory reads and sandbox pagination are bounded.
- Queued Create cancellation settles its pending reservation, and plugin-owned
  registrations use one recovery predicate.
- The missing-status probe on a fresh VM no longer adds a `cat` error line to
  the creation logs.
- Secret-store overrides no longer chmod an unrelated existing parent directory.

### Removed

- Backwards compatibility with children created by paseo-msb 1.0.x. A sandbox
  without `PASEO_MSB_PLAN`/`PASEO_MSB_RESOURCES`, with a persisted `failed`
  phase, or with a leftover `deleting` tombstone is no longer adopted, joined,
  repaired, or cleaned up automatically: it lists as an undecodable
  (`Quarantined`) child and only Delete removes it. The legacy Pi-only install
  job and its recovery path, the legacy `paseo-msb-id`/`paseo-msb-job` identity
  labels and their quarantine rule, and the legacy `install_failed`,
  `install_pending`, `install_conflict`, and `path_unverified` error codes are
  gone. A resize never writes `maxMemory`; every new child boots with the
  maximum hotplug cap.
- Superseded spike harnesses and their fixtures; the durable identity contract
  now lives in the integration suite.
- Unused client helpers, test-only server helpers, dead constants, the unused
  React Query dependency, and documentation-only image digest constants.

### Known limitations

- The Paseo desktop app keeps its own saved-host registry. Once the app has used
  a child, it stores a discovered `via:<parent>` routed profile there and does
  not remove it when the parent daemon stops listing the child. A deleted child
  can therefore remain in the app's host picker or settings as `Offline` after
  `paseo host ls`, the parent `hosts.json`, and the plugin list are clean. Remove
  it in the app's host settings. Plugin client code receives only `useHosts()`
  and `getPaseoClient()`, so a plugin cannot edit the app's registry; pruning
  routed profiles in the app's host discovery is the expected upstream fix.

## 2026-11-14

### Added

- Brand icons for Claude, Pi, Anthropic, OpenAI, Gemini, NeuralWatt, and GitHub.

### Changed

- The Create screen presents Providers and Integrations as settings-style
  sections with provider icons, availability reasons, switches, and exclusive
  radio options for Claude auth.
- The VM list header uses icon actions for Manage secrets and Create child, and
  sits above the list so hover tooltips are not painted behind rows.
- Credential rows keep a fixed monospace name column on wide layouts and stack
  on compact; long names truncate in the middle, and the save action improves
  contrast.
- Documentation matches the implemented provider flow, provisioning-job
  behavior, legacy retry behavior, and six-credential count.

### Fixed

- A failed provisioning job now reports `provisioning step <id> failed` from
  `status.json` instead of a generic job failure.

### Security

- The release test covers the Claude, Pi, NeuralWatt, and GitHub CLI matrix,
  including environment-sourced credentials, store and environment canaries,
  replaced and removed creation-time values, raw sandbox/job/system log sinks,
  and live provisioning fault injection.

### Known limitations

- The pinned microsandbox `modify()` is not generation-bound: a stale handle can
  affect a same-name replacement. Label writes refresh and compare the
  generation first, and cleanup revalidates at removal time, but a residual
  tombstone window remains. See [DESIGN.md](./DESIGN.md).

## 2026-11-13

### Added

- Provider and integration plans selecting from six fixed credentials, with
  only the required credentials injected into the child.
- A plugin-managed credential store with `secrets.list`, `secrets.set`, and
  `secrets.delete`.
- A deterministic, content-addressed provisioning script and status contract
  for idempotent, retryable provider and integration setup.
- A single management screen for credentials, create confirmation, pending and
  managed children, detail logs, Repair, and Delete.
- Name-based identity and reconciliation: one serialized lane per name,
  generation-checked operations, tombstoned deletion, registration-only
  children, and legacy label handling.
- `npm run test:release`, covering lifecycle RPCs, reload during provisioning,
  registration repair and cleanup, delete, and credential non-leakage.
- `check:native` and `check:plugin` diagnostics for the native addon and plugin
  load state.

### Changed

- The fixed VM shape is `2 CPU` and `4096 MiB`; Claude, Pi, and GitHub CLI are
  installed only when selected.
- Create, list, and detail report provider/integration progress and bounded
  failure detail.
- The credential manager became a table with in-field actions.

### Fixed

- The microsandbox SDK is loaded at runtime from the plugin directory, avoiding
  the CommonJS `import.meta.url` failure.
- Lifecycle lanes close permanently on cleanup; job, guest, label, log, and
  destroy calls are bounded and abortable; Create settles each pending attempt
  exactly once.
- Registration ownership uses the authenticated producer and source key, repairs
  configuration drift, and preserves user-disabled registrations.
- Stale-registration cleanup revalidates runtime absence at removal time.
- Availability, empty, missing, and unregistered states are distinct, and
  polling is latest-request-wins.
- `PASEO_MSB_PLAN` reaches the sandbox, and concurrent provision runs serialize
  with a guest `flock`.
- The provisioning status trap runs before the plan-hash guard.
- The missing-Pi probe no longer writes `pi: not found` to the sandbox log.

### Security

- `secrets.list` returns names and sources only; the store enforces owner-only
  permissions.
- Redaction is centralized across RPC output, pending state, labels, and logs,
  including values persisted in managed VM config.
- Inventory failures surface the full native-addon cause chain.

## 2026-11-09

### Changed

- The design was reduced to a minimal vertical slice: one fixed image, five
  lifecycle RPCs, and one management screen.
- NeuralWatt and GitHub credential passthrough were added to the design.

## 2026-11-02

### Added

- Initial v1 design for VM-backed Paseo hosts.

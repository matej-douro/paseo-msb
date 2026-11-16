# Changelog

Notable user-visible changes to paseo-msb, grouped by release date. The
authoritative architecture is [DESIGN.md](./DESIGN.md).

## Unreleased

### Added

- Failed pending Create attempts can be dismissed without a plugin reload.
- The release suite covers concurrent Create/Repair, registration drift,
  deletion-tombstone recovery, Create over a deleting tombstone, stale
  generations, foreign-name conflicts, provision-job conflicts, and the raw-SDK
  stale-handle identity contract.

### Changed

- Create identity is now the child name: the form submits a short generated
  `paseo-<token>` name, only one attempt exists per name, and a same-name Create
  joins only when its plan and resource shape match. Request IDs and the guest
  `PASEO_MSB_REQUEST` marker were removed.
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

- A Create that meets a Delete tombstone completes that cleanup and allocates a
  fresh generation instead of reporting success for cleanup alone.
- A Create blocked by an existing attempt for the same name now suggests
  retrying, dismissing, or choosing another name instead of only saying the
  request is invalid.
- A failed pending Create stays visible beside a same-name sandbox, so its error
  can be retried or dismissed. A post-allocation failure is not repeated as a
  second pending row.
- A VM destroyed outside the plugin (for example with `msb`) no longer leaves
  its host registration behind: `vm.list` starts a conservative sweep that
  removes a registration only after an exact lookup proves its generation is
  gone or replaced.
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

- Superseded spike harnesses and their fixtures; the durable identity contract
  now lives in the integration suite.
- Unused client helpers, test-only server helpers, dead constants, the unused
  React Query dependency, and documentation-only image digest constants.

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

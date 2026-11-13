# Minimal v1 implementation tasks

Derived from [DESIGN.md](./DESIGN.md), which is the authoritative spec.

Working rules:

- One task per PR, in order. Do not start feature code until task 1 passes.
- Keep the fixed v1 scope. Add no settings document, provider abstraction, lifecycle options, or decision framework.
- The runtime-dependent release test is mandatory on a supported parent.

Tasks 1-6 record the initial implementation and its verification. `DESIGN.md` and task 7 define
the target wherever those historical identity/lifecycle notes differ.

## 1. Prove the pinned vertical slice

Create one scratch plugin/script that boots the official Paseo image, installs Pi, registers the child, refreshes Pi, and removes it. Verify the complete external API contract before building the plugin.

Acceptance:

- [x] Record the full guest image digest, parent daemon version, microsandbox SDK/runtime versions, and exact Pi package version used by the remaining tasks.
- [x] Verify guest Node >= 22.19, npm, `.init("auto")`, non-root global Pi installation, and `pi` on the daemon user's PATH.
- [x] Verify loopback publishing with host port `0`; if unsupported, prove a minimal bind-probe/retry alternative and prompt release after stop.
- [x] Verify detached survival, stable-ID replacement checks, persisted labels/config/logs, and detached-job inspection after plugin and parent-daemon restart.
- [x] Verify a loopback child without `PASEO_PASSWORD`, or the minimal internal-password fallback, plus routed online, `hosts.remove`, and Pi detection after `providers.refresh()`.
- [x] Verify header-only secret substitution and blocked-destination behavior with a controlled HTTPS endpoint and fake values. Verify all five fixed guest variables contain placeholders rather than raw values.
- [x] Record results and any required narrow fallback in `docs/spikes/vertical-slice.md`; do not expand the product scope.

Result: [docs/spikes/vertical-slice.md](./docs/spikes/vertical-slice.md). Narrow fallbacks: the image requires explicit tini init (`.init("auto")` fails), and host port `0` is not allocated, so creation uses a bind-probe/retry port.

Files: `package.json`, `package-lock.json`, `scripts/spikes/verify-vertical-slice.mjs`, `scripts/spikes/fixtures/`, `docs/spikes/vertical-slice.md`

## 2. Scaffold the plugin and read-only RPCs

Create the parent plugin, fixed constants, five RPC contracts, and read-side projection. The client entry may render only a placeholder in this task.

Acceptance:

- [x] Manifest matches the verified parent floor and client/server/shared import boundaries.
- [x] `shared/constants.ts` contains the image/Pi pins, 2 CPUs, 2048 MiB, guest port, labels, and five fixed credential-to-host mappings.
- [x] Zod contracts implement exactly `vm.list`, `vm.detail`, `vm.create`, `vm.delete`, and `vm.reconcile` with safe errors and no secret values.
- [x] Server lists label-filtered sandboxes for the current parent and joins them with parent registrations and an initially empty pending-create map.
- [x] Strict config decoding returns only stable ID, name, labels, runtime status, registration identity/status, and available credential names. Raw config and env never cross RPC.
- [x] `vm.detail` returns bounded, redacted sandbox/job logs and distinguishes unavailable inventory from empty inventory.
- [x] Typecheck, build, and focused config/RPC tests pass.

Result: mutation RPCs are registered but return the safe `not_implemented` error until tasks 3 and 4.

Files: `paseo-plugin.json`, `tsconfig.json`, `index.client.tsx`, `index.server.ts`, `shared/`, `server/index.ts`, `server/rpc.ts`, `server/sandbox.ts`, `server/runtime.ts`, `server/status.ts`, `server/logs.ts`, `server/pending.ts`, `client/screen.tsx`, `tests/server/`

## 3. Implement idempotent background creation with Pi and secrets

Add `vm.create` and the host-side runner through Pi readiness, leaving registration wiring to task 4.

Acceptance:

- [x] The client request ID produces `paseo-<requestId>`; strict create and repeated requests cannot allocate a second name or own a same-name replacement.
- [x] `vm.create` validates selected fixed credential names, resolves their values from parent env, adds a pending entry, starts background work, and returns `{ name }` immediately.
- [x] The runner creates the fixed detached VM with labels, `.init("auto")`, loopback port, and header-only microsandbox secrets. No secret value is written to the pending map, RPC, or logs.
- [x] Stable sandbox and job IDs are persisted in labels; Pi installs as `paseo` with the verified package and flags through `execDetachedWith`, and daemon-user PATH is verified.
- [x] Phase and short safe error codes are observable through list/detail. Pending creates remain visible after UI navigation without terminal history.
- [x] Fake-runtime tests cover success, duplicate request ID, pull/boot/install failure, missing credentials, port retry, and redaction.

Result: creation is idempotent per request ID, returns before host work, and continues through registration once task 4 landed. The pinned image still requires the task 1 fallback of explicit tini init instead of `.init("auto")`, and host port `0` still needs the probe-and-retry loop. Raw SDK and guest errors never reach pending state or labels; only fixed safe codes do.

Files: `server/create.ts`, `server/pending.ts`, `server/pi-install.ts`, `server/secrets.ts`, `server/sandbox.ts`, `shared/`, `tests/server/create.test.ts`, `tests/server/fake-runtime.ts`

## 4. Implement registration, recovery, Repair, and Delete

Complete the create workflow and all remaining server mutations.

Acceptance:

- [x] Pi-ready sandboxes move to `registering`, use stable sandbox ID as `sourceKey`, wait for routed online, refresh providers, confirm Pi, and become `ready`.
- [x] Plugin init rediscovers labelled sandboxes and resumes only unambiguous install/registration work by persisted IDs; uncertain state remains failed without replaying side effects.
- [x] `vm.reconcile` resumes valid setup, restores missing registrations, and removes confirmed stale registrations. It never creates, starts, adopts, or deletes a sandbox and refuses ambiguous/foreign duplicates.
- [x] `vm.delete` requires matching name, stable ID, and confirmation; destroys that exact sandbox, removes its registration, and treats missing resources as success.
- [x] Failed and incomplete children can be deleted entirely through Paseo UI. A post-destroy registration failure remains repairable.
- [x] Tests cover interruption at each phase, reload with one detached job, stale registration, duplicate/foreign registration, missing resources, and unavailable inventory without destructive fallback.

Result: registration, recovery, Repair, and Delete are wired through the five RPCs. Recovery starts once on first plugin use because the plugin server contribution has no Paseo client at load; it then rediscovers labelled sandboxes and resumes only persisted, unambiguous work. `vm.delete` reads registrations before destroying so an unavailable daemon never leaves an unmanaged running VM.

Files: `server/registration.ts`, `server/recovery.ts`, `server/reconcile.ts`, `server/delete.ts`, `server/create.ts`, `server/index.ts`, `tests/server/`

## 5. Build the single Paseo management screen

Implement all v1 UI in one sidebar screen with no additional management surfaces.

Acceptance:

- [x] Create child confirmation shows fixed image/resources and available credential checkboxes by name only, requires at least one, and generates one request ID per logical attempt.
- [x] List shows pending creates and managed children with phase, runtime status, registration state, and safe errors. Polling stops on unmount without stopping host work.
- [x] Detail reconnects by sandbox name after navigation and shows bounded read-only logs, Repair, and Delete.
- [x] Delete confirmation names the child and states that its sandbox and registration are removed.
- [x] Loading, empty, partial-unavailable, failed, and repair-error states are usable on desktop and mobile and use approved primitives/theme colors.
- [x] Children are opened only through Paseo's normal host picker. No metrics, custom resource/provider fields, shell, copy, start/stop, or extra navigation actions are added.

Result: one sidebar screen renders the create confirmation, pending/managed list, and a detail pane with bounded logs, Repair, and Delete. Two polling hooks refresh list and detail every 2.5 seconds only while mounted; the selected child comes from the screen params so it reconnects by sandbox name after navigation. Pure client helpers and request-ID generation are covered by vitest; rendering uses plugin UI primitives and theme colors only.

Files: `index.client.tsx`, `client/screen.tsx`, `client/CreateChild.tsx`, `client/ChildList.tsx`, `client/ChildDetail.tsx`, `client/hooks/`, `client/__tests__/`

## 5b. Add a plugin-managed credential store

Let the single screen manage the five fixed credential values instead of requiring the parent daemon environment to carry them.

Acceptance:

- [x] Values for only the five fixed names persist in a 0600 file under the Paseo home plugin data directory; `PASEO_MSB_SECRETS_FILE` overrides the path.
- [x] `secrets.list`, `secrets.set`, and `secrets.delete` expose names and sources only; no RPC, log, DTO, pending state, or label ever returns a value.
- [x] `vm.create` resolves a stored value before the parent environment and fails safely when the store is unavailable.
- [x] The single screen can add, replace, and remove stored values, and the create confirmation marks each available name as Stored or Environment.
- [x] Tests cover persistence, permissions, corrupt files, precedence, redaction, and unavailable stores.

Result: the plugin owns a small file store (`<PASEO_HOME>/plugin-data/paseo-msb/secrets.json`, directory 0700, file 0600, overridable with `PASEO_MSB_SECRETS_FILE`). The five fixed names remain the only accepted keys and upstream allowlists are unchanged. Stored values take precedence over parent environment values for new VMs; existing VMs are unaffected until recreated. All list/detail redaction now covers both sources.

Files: `server/secrets-store.ts`, `server/secrets.ts`, `shared/contracts.ts`, `server/index.ts`, `client/ManageSecrets.tsx`, `client/hooks/useSecrets.ts`, `tests/server/secrets-store.test.ts`

## 6. Pass the vertical release test and document operation

Add one real-runtime test through the plugin RPCs and replace contributor speculation in README with concise operating instructions.

Acceptance:

- [x] Test drives all five RPCs: create returns immediately, independent list/detail calls observe progress, routed host reaches online, and Pi appears after refresh.
- [x] Reload during installation produces one sandbox, detached job, and registration; Repair restores a missing/stale registration without another VM.
- [x] A fake fixed credential from the plugin store reaches only the allowed substitution path and never appears in RPC output, plugin logs, pending state, or test artifacts.
- [x] Delete cleans the exact sandbox and registration; repeated delete and Repair are safe.
- [x] Test runs in the release check on the verified parent/runtime/image/Pi pins.
- [x] README records requirements, pins, the five parent env credentials, Create/Repair/Delete behavior, loopback trust boundary, reload limitations, and release-test command.

Result: `npm run test:release` installs or reloads this checkout as a directory plugin on a reachable parent, stores a fake fixed credential, and drives the five lifecycle RPCs. It reloads the plugin while the detached Pi install is running, verifies one sandbox/job/registration, restores a removed registration, removes a stale one, and deletes the exact sandbox and registration twice. The stored value is checked at the microsandbox secret boundary and scanned out of RPC outputs and plugin logs. Live header substitution and blocked destinations remain covered by the task 1 spike because the plugin cannot add test-only hosts or interception settings. List/detail now expose a bounded, redacted failure detail (also stored as `paseo-msb-error-detail`) so runtime failures are investigable; the release parent must be able to load the microsandbox native addon, which the signed macOS app's hardened runtime rejects on this host, so the documented check uses `@getpaseo/cli` under system Node.

Files: `tests/integration/vertical.test.ts`, `tests/integration/fixtures/`, `package.json`, `README.md`, `server/diagnostics.ts`, `tests/server/diagnostics.test.ts`

## 7. Implement name-based identity and transactional reconciliation

The initial implementation proved the APIs, but review found duplicated identity state,
competing setup runners, unrecoverable label-write windows, and destructive cleanup on ambiguous
inventory. The selected target is now specified in [DESIGN.md](./DESIGN.md); this task implements
that design rather than adding another state model. [FINDINGS.md](./FINDINGS.md) retains the
failure sequences and API evidence.

### Acceptance


- [x] Pass the exact-handle, paginated job-recovery, and real-plugin registration spikes required
  by `DESIGN.md` section 8 before changing lifecycle code.
- [x] Replace separate Create/recovery/Repair runners with the per-name reconciler. Fault injection
  and concurrent operations cannot corrupt state or leave late work after Delete/reload.
- [x] Remove new VM dependence on durable ID/job labels and duplicate registration metadata while
  quarantining mismatched legacy IDs. Same-request retries preserve credential names and verify
  exact handles so stale generation IDs cannot mutate replacements; registration-only children
  remain actionable.
- [x] Implement structured job outcomes and retryable registration/provider failures. Every crash
  window has a UI recovery path, with at most one current VM, active install, and registration per
  logical attempt and no CLI cleanup.
- [x] Implement tombstoned Delete and fail-closed stale-registration cleanup. Malformed config,
  missing labels, lookup failures, and bad pagination never authorize destructive cleanup.
- [x] Centralize safe diagnostics/redaction across current and creation-time credentials, keep DTOs
  allowlisted, and verify canaries against public output and raw microsandbox logs.
- [x] Update affected contracts, UI, migration notes, and `README.md`. `npm run typecheck`,
  `npm run lint`, `npm test`, and `npm run test:release` pass on the verified pins.

Result: the exact-handle matrix, paginated job recovery, and real-plugin producer
semantics are recorded in [docs/spikes/identity-lifecycle.md](./docs/spikes/identity-lifecycle.md).
The spike found that the pinned SDK's `modify()` applies to a same-name replacement,
so every label write now refreshes and compares the exact generation first. The
reconciler in `server/reconciler.ts` is the only setup path; `server/lanes.ts`
serializes per name, aborts on Delete/reload, and skips cancelled queued work.
Structured job outcomes, list-before-add registration, stale-registration exact
lookups, tombstoned Delete, redaction of persisted VM values, registration-only
children, and legacy label quarantine are covered by unit and release tests.

Files: `shared/`, `server/`, `client/`, `tests/`, `scripts/spikes/`, `docs/spikes/`,
`README.md`

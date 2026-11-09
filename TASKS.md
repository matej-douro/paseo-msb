# Implementation tasks

Derived from [DESIGN.md](./DESIGN.md). DESIGN.md is the authoritative spec and is not changed by this plan.

Working rules:

- One task per PR. Split a task if it grows beyond about one day.
- Complete verification spikes before feature code that relies on them.
- `blocked by: N` refers to assumption N in DESIGN.md section 12. Do not treat the assumption as settled until its spike passes.
- A task that names a `Decide:` item is not ready until that decision is recorded under "Needs decision".
- SDK primitives may land before their orchestration. End-to-end lifecycle tasks in section 8 assume sections 4 through 7 are complete.
- Runtime-dependent tests may be skipped locally only when their prerequisites are absent. They are mandatory in the release check.

## 1. Verification spikes

### 1.1 Verify the guest toolchain for Pi

Boot the pinned Paseo image from `Decide: initial guest image digest and update policy` and inspect Node, npm, user IDs, global npm prefix, and executable paths as the `paseo` user.

Command: `node scripts/spikes/verify-guest-toolchain.mjs --image "$PASEO_IMAGE_PIN"`

Pass: Node is 22.19 or newer, npm is on the `paseo` user PATH, the user exists, and the designed non-root global install location is usable.
Fail: Any condition is false. Open `Decide: Node provisioning fallback if assumption 1 fails`.

Acceptance:

- [ ] Exit 0 only when every pass condition holds.
- [ ] Output records image digest, versions, user identity, npm prefix, and absolute paths.
- [ ] Result is captured in `docs/spikes/01-guest-toolchain.md`.

Files: `scripts/spikes/verify-guest-toolchain.mjs`, `docs/spikes/01-guest-toolchain.md`

### 1.2 Verify init auto supervises the guest daemon

Boot with `.init("auto")` and a published loopback port. Inspect PID 1 and confirm the daemon remains reachable after privilege drop.

Command: `node scripts/spikes/verify-init-auto.mjs --image "$PASEO_IMAGE_PIN" --timeout 180`

Acceptance:

- [ ] PID 1 is the image entrypoint or supervisor and the daemon runs as `paseo`.
- [ ] The script records first successful connection and fails if the port later closes.
- [ ] Result is captured in `docs/spikes/02-init-auto.md`.

Files: `scripts/spikes/verify-init-auto.mjs`, `docs/spikes/02-init-auto.md`

### 1.3 Verify authenticated registration, routing, and removal

From a scratch plugin handler, register a password-protected loopback child using the exact credential-bearing connection grammar. Poll `hosts.list()`, open a routed client, repeat the unchanged add, and remove the registration.

Command: `node scripts/spikes/verify-host-registration.mjs --parent "$PASEO_PARENT_URL" --child-port "$CHILD_PORT"`

Acceptance:

- [ ] The child requires `PASEO_PASSWORD`; no unsecured child is used.
- [ ] Registration reaches online without an app restart and routed status can be read.
- [ ] Unchanged `sourceKey` add is idempotent and `hosts.remove` works on the target parent version.
- [ ] Output prints registration identity and timing, never the password or credential-bearing connection.
- [ ] Result records the exact supported connection grammar and parent version in `docs/spikes/03-host-registration.md`.
- [ ] If removal is unavailable, open `Decide: fallback when the parent has no registration removal API`.

Files: `scripts/spikes/verify-host-registration.mjs`, `scripts/spikes/fixtures/rpc-plugin/`, `docs/spikes/03-host-registration.md`

### 1.4 Verify routed provider refresh detects Pi

Boot a VM, install Pi, register it, and call `providers.refresh()` through `paseo.hosts.client(childId)`.

Command: `node scripts/spikes/verify-provider-refresh.mjs --image "$PASEO_IMAGE_PIN" --timeout 300`

Acceptance:

- [ ] Agent lists before and after refresh are printed without credentials.
- [ ] Pi appears immediately after refresh without a guest daemon restart.
- [ ] Result is captured in `docs/spikes/04-provider-refresh.md`.

Files: `scripts/spikes/verify-provider-refresh.mjs`, `docs/spikes/04-provider-refresh.md`
blocked by: 1, 2, 3

### 1.5 Verify concurrent loopback ports and release

Start several VMs with distinct loopback bindings, stop each, and verify every port can be rebound within the timeout.

Command: `node scripts/spikes/verify-port-lifecycle.mjs --count 5 --release-timeout 15`

Acceptance:

- [ ] Per-VM port, bind result, stop time, release time, and rebind result are recorded.
- [ ] Every VM has a unique working port and every stopped VM releases it.
- [ ] Result is captured in `docs/spikes/05-port-lifecycle.md`.

Files: `scripts/spikes/verify-port-lifecycle.mjs`, `docs/spikes/05-port-lifecycle.md`

### 1.6 Verify persistent sandbox identity, config, logs, and jobs

Create a labelled detached sandbox, start a detached job, reload or disable and re-enable the plugin, then restart the parent daemon. Reattach by name and stable ID, decode config, inspect the job, and read sandbox and job logs.

Command: `node scripts/spikes/verify-detached-survival.mjs --image "$PASEO_IMAGE_PIN" --parent "$PASEO_PARENT_URL"`

Acceptance:

- [ ] Sandbox ID, name, status, labels, resources, env, and published port persist across each step.
- [ ] Reattachment verifies the expected ID after `Sandbox.get(name)`, and an old stable handle rejects actions on a same-name replacement.
- [ ] A detached job can be inspected after plugin reload without being started again.
- [ ] Sandbox and job logs remain readable on running and stopped sandboxes.
- [ ] Label-filtered pagination returns all managed fixtures and config decoding handles the actual SDK JSON shape.
- [ ] Result is captured in `docs/spikes/06-detached-survival.md`.

Files: `scripts/spikes/verify-detached-survival.mjs`, `docs/spikes/06-detached-survival.md`

### 1.7 Verify Pi secret substitution against a controlled HTTPS endpoint

Use a controlled endpoint outside blocked private, loopback, link-local, and metadata ranges. Pass a placeholder into the guest and verify substitution only at configured locations and destinations.

Command: `node scripts/spikes/verify-secret-substitution.mjs --echo-url "$ECHO_HTTPS_URL"`

Acceptance:

- [ ] Header, query, body, placeholder allowance, and blocked destination cases are covered.
- [ ] HTTP/2 body substitution is asserted to remain unsupported rather than expected to succeed.
- [ ] Output never prints real credentials or credential-bearing URLs.
- [ ] Result is captured in `docs/spikes/07-secret-substitution.md`.

Files: `scripts/spikes/verify-secret-substitution.mjs`, `docs/spikes/07-secret-substitution.md`

### 1.8 Verify control settings conflicts on the target parent

Exercise the plugin settings API on the exact parent version from `Decide: minimum parent daemon version and requirements.paseo value`. Verify defaults, revision conflicts, migration errors, reset, and reinstall behavior.

Acceptance:

- [ ] Two writes from one revision produce one success and one conflict.
- [ ] Missing documents use defaults and newer unsupported versions are not overwritten.
- [ ] Reset and reinstall semantics match the control-document recovery design.
- [ ] Result is captured in `docs/spikes/08-control-settings.md`.

Files: `scripts/spikes/verify-control-settings.mjs`, `scripts/spikes/fixtures/settings-plugin/`, `docs/spikes/08-control-settings.md`

## 2. Plugin scaffold and RPC skeleton

### 2.1 Create the plugin package and manifest

Scaffold client, server, and shared entry points. Declare the parent feature floor chosen in `Decide: minimum parent daemon version and requirements.paseo value`.

Acceptance:

- [ ] Plugin loads on a development parent without errors.
- [ ] Manifest requirements cover connected hosts, routed clients, registration removal, and plugin settings.
- [ ] Typecheck and build pass on a clean checkout.
- [ ] Client code follows React Native and `theme.colors` boundaries.

Files: `paseo-plugin.json`, `package.json`, `tsconfig.json`, `index.client.tsx`, `index.server.ts`, `client/screen.tsx`, `server/index.ts`, `shared/index.ts`

### 2.2 Define shared RPC contracts and public DTOs

Add Zod request and response schemas for every RPC in DESIGN.md section 9, including operation progress, partial availability, drift, and safe errors.

Acceptance:

- [ ] Every RPC has request and response schemas and representative fixtures.
- [ ] `vm.create` returns an operation ID immediately rather than modeling a blocking create.
- [ ] Public VM DTOs are allowlisted and cannot contain raw config, env, secrets, passwords, or credential-bearing connections.
- [ ] Errors distinguish validation, conflict, unavailable, and runtime failures.
- [ ] No RPC imports client or server modules.

Files: `shared/rpc.ts`, `shared/errors.ts`, `shared/types.ts`, `shared/operations.ts`

### 2.3 Register handler skeletons and typed client transport

Register stubs and a typed client wrapper with timeout and error normalization.

Acceptance:

- [ ] Every contract has a handler returning a stable not-implemented error.
- [ ] Timeout, validation, unavailable, and runtime errors remain distinct.
- [ ] Unknown RPCs return a stable error code.
- [ ] Handler registration has tests.

Files: `server/rpc.ts`, `server/index.ts`, `client/rpc.ts`, `shared/rpc.ts`

### 2.4 Add server lifecycle, logging, and test harness

Wire init and async teardown, structured logs, an abort-aware operation context, and dependency injection for microsandbox and Paseo APIs.

Acceptance:

- [ ] Init and teardown complete cleanly without stopping detached sandboxes or jobs.
- [ ] Logs include operation ID, sandbox identity, and lifecycle step without credentials.
- [ ] Tests can replace all SDK and parent APIs with fakes.
- [ ] A failing handler or background operation does not crash the plugin subprocess.

Files: `server/index.ts`, `server/context.ts`, `server/logger.ts`, `tests/server/harness.ts`

### 2.5 Add client shell and navigation entry points

Register the screen, sidebar item, and Command Center items for open and create. Keep the shell free of data fetching until the next UI tasks.

Acceptance:

- [ ] Screen opens from the sidebar and both commands.
- [ ] Shell renders on desktop and mobile widths.
- [ ] Create navigation is separate from operation-progress navigation by ID.
- [ ] Navigation registration is isolated from list and detail components.

Files: `client/screen.tsx`, `client/commands.ts`, `index.client.tsx`, `client/components/Shell.tsx`

## 3. State ownership and control document

### 3.1 Implement managed labels and strict sandbox config decoding

Decode unknown SDK config into a strict internal schema for the fields the plugin owns. Build the sanitized `ResolvedVm` projection and readiness/autoStart labels.

Acceptance:

- [ ] Valid config produces name, stable ID, status, timestamps, resources, image, and loopback port.
- [ ] Pi bindings expose only approved policy fields, never values or placeholders unless explicitly declared safe.
- [ ] Raw env, secret entries, and full config never appear in public DTOs or logs.
- [ ] Missing, duplicate, malformed, or unsupported fields produce `incompatible`, not guessed defaults.
- [ ] Foreign-parent sandboxes are ignored.

Files: `server/sandbox-config.ts`, `shared/labels.ts`, `shared/types.ts`, `tests/server/sandbox-config.test.ts`
blocked by: 6

### 3.2 Define the control settings and operation schemas

Implement `ControlDocument` with `nextSandboxNumber` and bounded create-operation history. Operation requests may contain credential source keys but no credential values or daemon password.

Acceptance:

- [ ] Valid documents round-trip without field loss.
- [ ] Every phase, ID, timestamp, safe error, and retry-relevant request field is represented.
- [ ] Secret values, `PASEO_PASSWORD`, and credential-bearing connections are rejected by schema construction.
- [ ] Active operations cannot be evicted by terminal-history bounds from `Decide: operation history and idempotency retention`.
- [ ] Defaults produce an initialized version 1 document.

Files: `shared/settings.ts`, `shared/operations.ts`, `server/settings.ts`, `tests/server/control-settings.test.ts`

### 3.3 Implement revision-checked control reads and writes

Add read, save, and compare-and-swap helpers with conflict results and current-state rereads.

Acceptance:

- [ ] Two concurrent saves produce one success and one conflict.
- [ ] Name allocation and operation creation commit atomically.
- [ ] No update is lost after conflict and no settings error is treated as an empty inventory.
- [ ] Create, update, conflict, reset, and read-after-conflict tests pass.

Files: `server/settings.ts`, `shared/errors.ts`, `tests/server/settings.test.ts`

### 3.4 Implement monotonic naming and managed-label creation

Generate `sandbox-N`, the frozen `<parent>/sandbox-N` label, ownership labels, and autoStart value using the identity and numbering decisions.

Acceptance:

- [ ] Numbers increase monotonically and are not reused after failed create or delete.
- [ ] Counter recovery follows `Decide: sandbox name numbering after control settings loss`.
- [ ] Duplicate names are rejected before side effects and SDK name conflicts remain terminal for that attempt.
- [ ] Labels follow `Decide: parent identity used in registration labels`.
- [ ] Create input has no user-authored sandbox name.

Files: `server/records.ts`, `shared/labels.ts`, `tests/server/records.test.ts`

### 3.5 Build the resolved-state join

Build a pure join of managed sandboxes, parent registrations, control operations, and optional metrics. Represent each unavailable input explicitly.

Acceptance:

- [ ] Runtime state comes from microsandbox, registration state from the parent, and progress from operations.
- [ ] No settings VM inventory or last-known runtime state is introduced.
- [ ] Stopped registrations are not unreachable findings.
- [ ] Unready and in-flight sandboxes are ineligible for automatic start or registration.
- [ ] Failed list APIs produce unavailable partial views, never empty-inventory drift.

Files: `shared/state.ts`, `server/observed.ts`, `tests/server/state.test.ts`

### 3.6 Add control migration and reset handling

Handle older control versions, missing documents, reset, and unknown future versions without modifying microsandbox state.

Acceptance:

- [ ] Supported older versions migrate once and unknown future versions remain untouched.
- [ ] Reset reinitializes only counter and operations, never VM config or labels.
- [ ] Existing managed VMs still list after reset or reinstall.
- [ ] Orphaned unfinished operations become recovery findings rather than VM deletion requests.

Files: `server/settings.ts`, `shared/settings.ts`, `tests/server/settings-migration.test.ts`

## 4. Microsandbox primitives

### 4.1 Implement loopback port allocation

Probe loopback ports and exclude ports already present in managed sandbox configs. Use `Decide: loopback port range and reservation policy`.

Acceptance:

- [ ] Bind-probe collisions and managed-config collisions retry within a bounded range.
- [ ] Concurrent allocation is serialized with name reservation.
- [ ] Released ports may be reused without reusing sandbox names.
- [ ] Runtime bind conflicts return to allocation without creating a second operation or sandbox name.
- [ ] Exhaustion returns an actionable error before sandbox creation.

Files: `server/ports.ts`, `server/sandbox-config.ts`, `tests/server/ports.test.ts`
blocked by: 5

### 4.2 Implement the sandbox builder

Build from validated create input with the image from `Decide: initial guest image digest and update policy`, resources, loopback binding, managed labels, password env, `init("auto")`, and `detached(true)`. Accept Pi script and secrets as inputs wired by later sections.

Acceptance:

- [ ] Builder arguments match validated input exactly.
- [ ] Labels and stable ID are captured without duplicating config into settings.
- [ ] Builder is strict-name-create, never `replace`, and never adopts an existing same-name sandbox.
- [ ] Raw builder config and errors are sanitized at the boundary.
- [ ] Fake SDK tests cover creation success, pull failure, and name/port conflicts.

Files: `server/sandbox.ts`, `shared/types.ts`, `tests/server/sandbox.test.ts`
blocked by: 2

### 4.3 Implement stable-handle lifecycle primitives

Wrap `Sandbox.get`, detached start, stop, restart, status waits, and exact-identity destruction without registration orchestration.

Acceptance:

- [ ] All actions validate expected stable sandbox ID and managed ownership.
- [ ] Start does not recreate a missing sandbox and start of a running sandbox is idempotent.
- [ ] Stop leaves registration untouched and restart uses bounded waits.
- [ ] Same-name replacements are rejected.
- [ ] Missing sandbox and already-stopped outcomes are explicit and retry-safe.

Files: `server/lifecycle.ts`, `server/sandbox.ts`, `tests/server/lifecycle-primitives.test.ts`
blocked by: 6

### 4.4 Extend the fake microsandbox runtime

Model persistent config, stable IDs, labels, statuses, ports, detached jobs, job logs, and same-name replacement checks.

Acceptance:

- [ ] State persists across simulated plugin reloads and control settings resets.
- [ ] Detached jobs continue independently and can be inspected by ID.
- [ ] Inventory calls can be failed independently for partial-availability tests.
- [ ] The fake enforces stable identity and strict name conflicts.

Files: `tests/lifecycle/fake-runtime.ts`, `tests/server/harness.ts`

## 5. Pi install and readiness

### 5.1 Implement Pi installation as a detached microsandbox job

Generate the install script and run it with `execDetachedWith` as `paseo`, persist the job ID, and inspect rather than launching a duplicate after reload.

Acceptance:

- [ ] Command is exactly `npm install -g --ignore-scripts @earendil-works/pi-coding-agent`.
- [ ] Execution user and environment match the daemon user.
- [ ] Job ID is persisted before the operation waits for completion.
- [ ] Stdout and stderr remain available through job logs.
- [ ] Non-zero exit maps to `phase=failed` with error code `install`, and the ready label is absent.

Files: `server/pi-install.ts`, `scripts/guest/install-pi.sh`, `tests/server/pi-install.test.ts`
blocked by: 1, 6

### 5.2 Verify Pi on the daemon user's PATH

Check `pi` using the same non-interactive environment as the guest daemon and record only the resolved path and versions.

Acceptance:

- [ ] Check runs as `paseo` without a root or interactive-profile dependency.
- [ ] Missing Pi maps to `phase=failed` with error code `install`.
- [ ] Success is required before `paseo-msb-ready=true` is written.
- [ ] Ready-label update is idempotent and preserves all other labels.

Files: `server/pi-install.ts`, `scripts/guest/verify-pi.sh`, `tests/server/pi-install.test.ts`
blocked by: 1

### 5.3 Preserve bounded create and install diagnostics

Combine host-side operation events, microsandbox system logs, and persisted install-job logs. Bound each source and redact at the read boundary.

Acceptance:

- [ ] Image pull and early boot failures have host-side diagnostics even without sandbox logs.
- [ ] Install output remains available after plugin reload and stopped/failed jobs.
- [ ] Pull, npm, PATH, permission, and interrupted errors have distinct safe codes.
- [ ] Install-failed sandboxes are never automatically registered or autoStarted.

Files: `server/logs.ts`, `server/pi-install.ts`, `shared/errors.ts`, `tests/server/logs.test.ts`

### 5.4 Refresh Pi through the routed client

After online, refresh providers and confirm Pi appears. Record a warning without tearing down a working host.

Acceptance:

- [ ] Refresh runs only after routed online.
- [ ] Pi presence and safe refresh warning appear in operation results.
- [ ] Refresh failure does not clear readiness or remove registration.
- [ ] Fake routed-client tests cover success, error, and missing Pi.

Files: `server/providers.ts`, `shared/operations.ts`, `tests/server/providers.test.ts`
blocked by: 3, 4

## 6. Host registration

### 6.1 Implement authenticated idempotent registration

Build the credential-bearing loopback connection inside the server and register with frozen label, stable sandbox ID as `sourceKey`, and documented metadata.

Acceptance:

- [ ] Exact grammar from spike 1.3 is used and no credential appears in settings, DTOs, logs, or errors.
- [ ] Repeated unchanged add returns the existing registration without enabling a user-disabled host.
- [ ] Changed input is not silently overwritten; it becomes a conflict finding.
- [ ] Registration ID is stored only as operation recovery state and otherwise read from the parent.
- [ ] `vm.connection` returns routed identity and redacted parent-local details with a loopback warning.

Files: `server/registration.ts`, `server/connection.ts`, `tests/server/registration.test.ts`
blocked by: 3

### 6.2 Wait for online and surface parent errors

Poll the matching parent registration until online or the timeout from `Decide: boot, install, online, and lifecycle timeouts` expires.

Acceptance:

- [ ] Detection uses routed host state, not only a TCP probe.
- [ ] Timeout produces `phase=failed` with error code `unreachable` and retains the ready sandbox and registration.
- [ ] Parent error text is sanitized and available to detail and operation responses.
- [ ] Stopped VMs do not produce online waits or unreachable findings.
- [ ] Waits abort cleanly on teardown and can be resumed from parent state.

Files: `server/registration.ts`, `shared/state.ts`, `tests/server/registration.test.ts`
blocked by: 3

### 6.3 Implement ownership-checked registration removal

Wrap the removal path proven in spike 1.3. Removal is idempotent and refuses foreign or mismatched registrations.

Acceptance:

- [ ] Missing registration succeeds without error.
- [ ] Removal checks source, source key, metadata, and expected stable sandbox identity.
- [ ] Duplicate or ambiguous matches refuse automatic removal.
- [ ] Delete and stale-registration repair share this helper.

Files: `server/registration.ts`, `tests/server/registration.test.ts`
blocked by: 3

### 6.4 Match registrations and detect conflicts

Match parent hosts to sandboxes by stable source key and metadata without mirroring registration state into settings.

Acceptance:

- [ ] Matching registration supplies current IDs and status directly to the resolved view.
- [ ] Duplicate source keys and metadata mismatches become `registration-conflict`.
- [ ] Changed connection or label is detected rather than silently updated.
- [ ] Registration list failure blocks registration repairs but not sandbox listing.

Files: `server/registration.ts`, `server/observed.ts`, `tests/server/registration-matching.test.ts`
blocked by: 3

## 7. Pi credential bindings

### 7.1 Define the fixed Pi binding catalog and validation

Implement the fixed source-key mapping from `Decide: Pi credential source keys and allowed host defaults` and `Decide: Pi secret substitution defaults`. No arbitrary provider IDs or user-authored secret values are accepted.

Acceptance:

- [ ] Duplicate guest env vars and empty allowed hosts are rejected.
- [ ] Unknown or unsupported Pi sources fail before side effects.
- [ ] Header, query, body, TLS identity, placeholder, and violation defaults match the decisions.
- [ ] Schemas and constants are shared with the create options and form.

Files: `shared/secrets.ts`, `server/secrets.ts`, `tests/server/secrets.test.ts`

### 7.2 Implement `vm.createOptions`

Return resource bounds/defaults and autoStart default from `Decide: CPU, memory, and autoStart defaults`, plus availability of the fixed Pi credential sources, without returning credentials.

Acceptance:

- [ ] Only fixed Pi catalog entries are returned.
- [ ] Availability follows `Decide: how the plugin reads parent Pi credentials`.
- [ ] Missing credentials produce actionable per-binding status, not a generic provider framework.
- [ ] Responses contain no values, placeholders, raw environment, or parent config.

Files: `server/create-options.ts`, `shared/rpc.ts`, `shared/secrets.ts`, `tests/server/create-options.test.ts`

### 7.3 Build microsandbox secrets from Pi bindings

Resolve parent credentials immediately before creation, preferring supported host environment references. Apply allowed hosts and substitution policy exactly.

Acceptance:

- [ ] No credential value is written to control settings or create RPC input.
- [ ] Each binding maps to exactly one guest env var.
- [ ] Inline values exist only in server memory and protected microsandbox config.
- [ ] Missing sources fail before any sandbox is created.

Files: `server/secrets.ts`, `shared/secrets.ts`, `tests/server/secrets.test.ts`

### 7.4 Bind Pi secrets into sandbox creation

Wire the validated secrets and generated `PASEO_PASSWORD` into the builder without exposing raw config afterward.

Acceptance:

- [ ] All sources resolve before the create side effect.
- [ ] Builder receives exactly the requested Pi bindings and password env.
- [ ] Retry does not reuse persisted plaintext from settings because none exists there.
- [ ] Fake builder assertions use fake credentials and sanitized snapshots.

Files: `server/sandbox.ts`, `server/secrets.ts`, `tests/server/sandbox.test.ts`

### 7.5 Redact credentials from logs, errors, and public reads

Redact Pi values, daemon password, credential-bearing connections, and secret placeholders at every logging and RPC boundary.

Acceptance:

- [ ] Nested SDK and parent errors are sanitized without losing safe source keys.
- [ ] Raw sandbox config, job output, host errors, and operation logs pass through the same boundary.
- [ ] Public config uses an allowlist even if redaction misses an unknown field.
- [ ] Tests include fake values in nested errors, URLs, env, and log chunks.

Files: `server/logger.ts`, `server/logs.ts`, `shared/errors.ts`, `tests/server/redaction.test.ts`

## 8. Background operations and lifecycle integration

### 8.1 Implement the durable background-operation coordinator

Run create work outside the RPC request lifetime with per-name create locks, per-sandbox lifecycle locks, idempotency keys, abortable waits, and bounded terminal history.

Acceptance:

- [ ] `vm.create` persists name and operation, starts host work, and returns the operation ID immediately.
- [ ] Repeated idempotency key returns the existing operation and never allocates another name.
- [ ] Navigation and polling have no ownership of the runner.
- [ ] Per-VM start, stop, restart, delete, reconcile, and create conflicts are serialized or rejected safely.
- [ ] Concurrent create tests prove unique names, ports, operations, and sandboxes.

Files: `server/operations.ts`, `server/create.ts`, `server/rpc.ts`, `tests/server/operations.test.ts`

### 8.2 Wire the complete create state machine

Connect preflight, allocation, sandbox creation, detached Pi install, ready label, authenticated registration, online wait, and provider refresh with persisted transitions.

Acceptance:

- [ ] Every side effect records enough identity to inspect before repeating it.
- [ ] `vm.operation`, `vm.list`, and `vm.detail` expose active and recent progress.
- [ ] Unready sandboxes are never registered and readiness does not mean online.
- [ ] Refresh warning leaves a ready operation and working host; earlier failures keep exact safe failure codes.
- [ ] No failure path silently deletes a sandbox, registration, job, or operation.

Files: `server/create.ts`, `server/operations.ts`, `shared/operations.ts`, `tests/server/create.test.ts`
blocked by: 1, 2, 3, 4, 5, 6

### 8.3 Implement reload and crash recovery

On init, inspect each unfinished operation against stable sandbox ID, detached job ID, and parent registration before resuming or failing it.

Acceptance:

- [ ] Existing detached install work is observed, never launched twice.
- [ ] Existing registration is reused and a lost response does not cause another sandbox or registration.
- [ ] Uncertain pre-create work becomes `phase=failed` with error code `interrupted`; later uncertain work preserves all resources for inspection.
- [ ] Same-name replacement, missing ID, or ambiguous state blocks automatic resume.
- [ ] Recovery tests cover interruption after every persisted transition.

Files: `server/recovery.ts`, `server/operations.ts`, `server/init.ts`, `tests/server/recovery.test.ts`
blocked by: 3, 6

### 8.4 Implement `vm.retryCreate` eligibility

Retry only a failed operation proved to have no sandbox, reusing its operation and sandbox name.

Acceptance:

- [ ] Image-pull and eligible interrupted pre-create failures can retry.
- [ ] Install, registration, online, and refresh failures cannot use pre-create retry.
- [ ] Retry may generate fresh secrets and port but never a second operation, name, or sandbox.
- [ ] Repeated failures do not leak operations or side effects.

Files: `server/create.ts`, `server/recovery.ts`, `shared/rpc.ts`, `tests/server/create-retry.test.ts`

### 8.5 Implement `vm.delete` with exact identity and registration cleanup

Destroy the confirmed sandbox, remove its matching registration, then resolve operation history. Treat already-missing resources as idempotent outcomes.

Acceptance:

- [ ] Delete requires confirmation and the expected stable sandbox ID.
- [ ] It never destroys a same-name replacement or removes a foreign registration.
- [ ] Partial failure after destruction leaves a retryable stale registration, not a fabricated missing-VM record.
- [ ] Delete of an already-missing sandbox can clean only its confirmed plugin-owned registration and operation history.
- [ ] Reconcile never invokes delete.

Files: `server/delete.ts`, `server/registration.ts`, `tests/server/delete.test.ts`
blocked by: 3, 6

### 8.6 Wire lifecycle RPCs, init recovery, and ready-only autoStart

Connect `vm.start`, `vm.stop`, and `vm.restart` to the stable-handle primitives.

Recover operations before starting stopped VMs with both ready and autoStart labels. Start and restart also register when needed and wait for online.

Acceptance:

- [ ] Running detached VMs are reattached without a start call.
- [ ] Failed install, incompatible, active, and foreign sandboxes never autoStart.
- [ ] Failed autoStart appears in status without duplicating registration or operation state.
- [ ] Manual start requires readiness and restart follows the same registration path.
- [ ] Two consecutive init runs are idempotent.

Files: `server/init.ts`, `server/lifecycle.ts`, `server/recovery.ts`, `tests/server/init.test.ts`
blocked by: 3, 6

### 8.7 Add full fake-runtime lifecycle tests

Cover create, recovery, retry, start, stop, restart, delete, autoStart, and concurrent operations with one fake runtime and fake parent.

Acceptance:

- [ ] Each action has success and failure coverage.
- [ ] Plugin reload preserves sandboxes, jobs, registrations, and operations.
- [ ] Tests assert no duplicate name, port, sandbox, job, or registration.
- [ ] Failed inventory APIs never produce repairs or deletion.
- [ ] Suite runs without a real microVM.

Files: `tests/lifecycle/lifecycle.test.ts`, `tests/lifecycle/fake-runtime.ts`

## 9. Metrics and status

### 9.1 Implement the on-demand metrics sampler

Coalesce concurrent `allSandboxMetrics()` calls inside the chosen poll window and cache only the whole map. Run no background timer.

Acceptance:

- [ ] Concurrent status calls inside one window share one SDK call.
- [ ] Missing keys return no metrics and do not alter sandbox state.
- [ ] No SDK call occurs without a status request.
- [ ] Fake-clock tests follow `Decide: status poll interval and metrics cache window`.

Files: `server/metrics.ts`, `shared/metrics.ts`, `tests/server/metrics.test.ts`

### 9.2 Return metrics and operations in list and detail

Map metrics and progress onto resolved sandboxes and include active creates before their sandbox exists.

Acceptance:

- [ ] Running VMs include CPU, memory, disk, network, and uptime.
- [ ] Stopped VMs show no metrics and their actual microsandbox status.
- [ ] Active/recent operations reconnect by ID after navigation.
- [ ] List and detail coalesce metrics calls and validate against shared schemas.

Files: `server/status.ts`, `shared/rpc.ts`, `shared/metrics.ts`, `tests/server/status.test.ts`

### 9.3 Isolate metrics failures

Treat metrics collection as best effort without hiding inventory or operation errors.

Acceptance:

- [ ] Metrics failure returns `metricsUnavailable`, not an empty or failed VM inventory.
- [ ] List still renders when metrics throw.
- [ ] Error is logged once per poll window without credentials.
- [ ] Runtime missing and SDK throw cases are covered.

Files: `server/metrics.ts`, `server/status.ts`, `tests/server/metrics.test.ts`

## 10. Reconcile

### 10.1 Detect the current drift classes

Implement `unregistered`, `stale-registration`, `registration-conflict`, `host-unreachable`, `provisioning-incomplete`, `interrupted-operation`, and `incompatible` findings.

Acceptance:

- [ ] Fixtures cover every finding and normal stopped/offline state.
- [ ] Only ready, idle sandboxes are eligible for missing-registration repair.
- [ ] Findings include stable sandbox, registration, or operation identity for action.
- [ ] Detection performs no mutations.

Files: `server/reconcile.ts`, `shared/drift.ts`, `tests/server/reconcile.test.ts`

### 10.2 Repair only unambiguous registration drift

Register eligible ready sandboxes and remove confirmed stale plugin-owned registrations. Never repair by changing a sandbox.

Acceptance:

- [ ] Missing registration is recreated only for an eligible ready VM.
- [ ] Stale registration removal uses the ownership-checked helper.
- [ ] Conflicts, incomplete provisioning, incompatible config, and unavailable inventories block related repairs.
- [ ] Reconcile never starts, stops, creates, or deletes sandboxes.
- [ ] A second successful pass produces no duplicate registration.

Files: `server/reconcile.ts`, `server/registration.ts`, `tests/server/reconcile.test.ts`
blocked by: 3

### 10.3 Wire read-only detection and explicit repair RPC

Run detection on status reads and repairs only on `vm.reconcile`, returning findings and changes.

Acceptance:

- [ ] `vm.list` and `vm.detail` never mutate registrations or operations.
- [ ] `vm.reconcile` returns findings before and after repair.
- [ ] Every added or removed registration is listed by safe identity.
- [ ] Partial inventory failure returns unavailable findings without mutation.

Files: `server/rpc.ts`, `server/reconcile.ts`, `shared/rpc.ts`, `tests/server/reconcile-rpc.test.ts`
blocked by: 3

### 10.4 Add reconcile idempotency and failure-safety tests

Exercise repeated runs, partial SDK failures, duplicate source keys, control reset, active creates, and install failures.

Acceptance:

- [ ] Failed removal leaves its finding for the next pass.
- [ ] No SDK list failure is interpreted as empty inventory.
- [ ] Control reset does not create unmanaged findings or adoption work.
- [ ] Unready and in-flight sandboxes are untouched.
- [ ] Destructive actions still require their own explicit RPC.

Files: `tests/server/reconcile.test.ts`, `tests/server/fixtures/reconcile/`

## 11. Management screen

### 11.1 Replace the shell with the real management route

Connect sidebar and commands to the real screen, with create opening a sheet and operation selection opening existing progress.

Acceptance:

- [ ] Entry points use the same screen and route parameters survive navigation.
- [ ] Create and reconnect-to-progress are distinct actions.
- [ ] Screen uses only approved primitives and `theme.colors`.

Files: `client/screen.tsx`, `client/commands.ts`, `index.client.tsx`, `client/components/Shell.tsx`

### 11.2 Implement managed VM and operation list

Render microsandbox status, resources, uptime, active creates, recent failures, and inline drift warnings. Poll only while mounted.

Acceptance:

- [ ] Every managed sandbox appears once without a settings VM record.
- [ ] Active creates appear before sandbox creation and remain visible after returning to the screen.
- [ ] Loading, empty, partial-unavailable, and error states are distinct.
- [ ] Polling stops on unmount without stopping host work.

Files: `client/VmList.tsx`, `client/hooks/useVmStatus.ts`, `client/components/StatusRow.tsx`

### 11.3 Implement detail identity and metrics

Show sanitized identity, resources, actual state, latest operation, registration error, and live metrics.

Acceptance:

- [ ] Detail shows label, name, stable ID, image, CPUs, memory, and parent-local port.
- [ ] Running, stopped, incompatible, and metrics-unavailable states are clear.
- [ ] No raw env, secrets, password, or credential-bearing connection is rendered.
- [ ] Detail updates from the shared status poll.

Files: `client/VmDetail.tsx`, `client/components/MetricGrid.tsx`, `client/hooks/useVmStatus.ts`

### 11.4 Implement the read-only combined log tail

Show bounded host operation events, sandbox logs, and install-job logs using `Decide: log tail line count and refresh behavior`.

Acceptance:

- [ ] Tail respects per-source and total line/byte bounds.
- [ ] Early failure, empty, unavailable, running, and stopped states are clear.
- [ ] Viewer has no input, exec, or shell action.
- [ ] Secret redaction is covered by renderer fixtures.

Files: `client/LogTail.tsx`, `client/hooks/useVmLogs.ts`, `server/logs.ts`

### 11.5 Implement detail actions and confirmations

Add start, stop, restart, delete, open host, and copy connection details. Delete names the exact VM and states the destructive scope.

Acceptance:

- [ ] Actions send stable sandbox ID and show conflict/pending states.
- [ ] Start is unavailable for unready or incompatible sandboxes.
- [ ] Copy contains routed identity and redacted parent-local details with a loopback-only explanation.
- [ ] Open host follows `Decide: how Open host in Paseo navigates to a routed host`.

Files: `client/VmActions.tsx`, `client/clipboard.ts`, `client/hooks/useVmActions.ts`

### 11.6 Implement the Pi-only create sheet

Use `vm.createOptions` for resources, autoStart, and fixed Pi bindings. Do not include a name field or generic provider selector.

Acceptance:

- [ ] Resource and Pi binding validation occurs before submit.
- [ ] Only available fixed Pi sources can be selected and no secret value is accepted.
- [ ] Internet and blocked-destination warning is always visible.
- [ ] No network, generic provider, image-selection, or sandbox-name controls exist.

Files: `client/CreateVmSheet.tsx`, `client/components/SecretBindingEditor.tsx`, `shared/secrets.ts`

### 11.7 Implement reconnectable background progress

Submit create, immediately open the returned operation ID, and allow dismissal without cancellation. Render active and recent operations after any navigation.

Acceptance:

- [ ] Progress covers creating, installing, registering, waiting-online, refreshing, ready, and failed.
- [ ] App navigation and screen unmount do not affect the operation.
- [ ] Reloaded status reconnects by operation ID without creating another operation.
- [ ] Retry appears only for eligible pre-create failures; other failures offer logs and lifecycle actions where valid.

Files: `client/CreateVmProgress.tsx`, `client/CreateVmSheet.tsx`, `client/hooks/useCreateVm.ts`, `client/hooks/useVmOperation.ts`

### 11.8 Implement the reconcile banner

List findings and offer only safe registration repairs, with explicit statements about what remains untouched.

Acceptance:

- [ ] Safe repairs call `vm.reconcile` and refresh status.
- [ ] Conflicts, incomplete provisioning, and incompatible config have no automatic repair button.
- [ ] Banner states that reconcile never starts, stops, or deletes VMs.
- [ ] No adoption or unmanaged-removal action appears.

Files: `client/ReconcileBanner.tsx`, `client/hooks/useReconcile.ts`, `shared/drift.ts`

### 11.9 Add renderer tests

Cover list, detail, create progress, and banner with mocked RPC responses.

Acceptance:

- [ ] Tests include active create without sandbox, reconnected progress, stopped, running, partial unavailable, and failed states.
- [ ] Detail tests assert sensitive fields are absent.
- [ ] Banner tests cover safe and blocked repairs.
- [ ] Tests run without network or a real microVM.

Files: `client/__tests__/VmList.test.tsx`, `client/__tests__/VmDetail.test.tsx`, `client/__tests__/CreateVmProgress.test.tsx`, `client/__tests__/ReconcileBanner.test.tsx`

## 12. Failure handling and doctor

### 12.1 Implement `meta.doctor`

Report SDK/runtime, pinned image, connected hosts, routed clients, registration removal, and settings support using `Decide: minimum microsandbox SDK and runtime version` and `Decide: minimum parent daemon version and requirements.paseo value`.

Acceptance:

- [ ] Each check has a structured status and actionable safe message.
- [ ] Doctor works when the microsandbox SDK cannot load.
- [ ] Image pin and version floors each have one source of truth.
- [ ] Doctor failure never converts an available inventory to an empty one.

Files: `server/doctor.ts`, `shared/doctor.ts`, `shared/rpc.ts`, `tests/server/doctor.test.ts`

### 12.2 Gate create on preflight results

Disable create when runtime, feature, image, settings, or required Pi credential checks fail. Existing status remains available where possible.

Acceptance:

- [ ] Client and server enforce the same preflight before side effects.
- [ ] Reason names the failed check and next action.
- [ ] Existing sandbox detail and logs remain available during unrelated doctor failures.
- [ ] Credential errors never include raw parent config or values.

Files: `client/CreateVmSheet.tsx`, `server/create.ts`, `shared/doctor.ts`

### 12.3 Normalize operation and lifecycle failures

Map pull, boot, install, registration, online, port, runtime, feature, interruption, and conflict errors to safe codes and documented behavior.

Acceptance:

- [ ] Every DESIGN.md section 10 row has a mapping and user action.
- [ ] Port collisions retry without becoming terminal by themselves.
- [ ] Raw stacks, config, env, and credential-bearing connections never reach the UI.
- [ ] Failure leaves enough authoritative identity for recovery rather than a duplicated VM status field.

Files: `server/errors.ts`, `shared/errors.ts`, `server/create.ts`, `tests/server/failure-mapping.test.ts`

### 12.4 Add failure-path integration tests

Exercise pull, install, online timeout, missing feature, collisions, reload at every create phase, plugin removal, and inventory failures.

Acceptance:

- [ ] No failure silently deletes a sandbox, job, registration, or operation.
- [ ] Plugin removal leaves detached VMs and jobs running.
- [ ] Early boot and install failures retain documented diagnostics.
- [ ] Inventory failure blocks repairs and preserves partial status.
- [ ] Install-failed and in-flight VMs are never autoStarted or auto-registered.

Files: `tests/failure/failure-paths.test.ts`, `tests/failure/fake-runtime.ts`
blocked by: 1, 2, 3, 5, 6

## 13. Release verification and docs

### 13.1 Add the full runtime-dependent release test

Drive the actual RPC surface from create through Pi readiness, secret use, status, logs, restart, reconcile, and delete cleanup.

Acceptance:

- [ ] `vm.create` returns immediately and progress remains available through independent status calls.
- [ ] Routed host reaches online and lists Pi after refresh.
- [ ] A fake Pi credential exercises configured substitution without appearing in RPC, logs, or settings.
- [ ] Reload during install observes one detached job and produces one sandbox and registration.
- [ ] Delete removes only the expected sandbox and registration.
- [ ] Test is mandatory in release checks when the supported runtime is available.

Files: `tests/integration/pi-host.test.ts`, `tests/integration/fixtures/`, `docs/RELEASE.md`
blocked by: 1, 2, 3, 4, 5, 6

### 13.2 Write the user-facing overview

Explain VM-backed routed hosts, background creation, Pi-only support, lifecycle, network limits, and v1 non-goals.

Acceptance:

- [ ] Routed hosts and one-hop limit are explained plainly.
- [ ] Navigation away from create is documented as safe.
- [ ] Pi-only provider scope and all non-goals are listed.
- [ ] Outbound internet and blocked destinations are stated.

Files: `OVERVIEW.md`

### 13.3 Write install and operations guides

Document parent requirements, installation, doctor, first create, operation recovery, autoStart, delete, reset, and removal with running VMs.

Acceptance:

- [ ] Requirements and image/version pins match the decisions and doctor.
- [ ] Microsandbox, parent registration, and control-settings ownership are explained.
- [ ] Plugin reload and removal warnings are accurate, including that a removed plugin cannot render its own warning.
- [ ] Parent trust boundary and sensitive runtime/host config are documented without presenting child passwords as daily management work.
- [ ] Commands are copy-pasteable and contain no real credentials.

Files: `docs/INSTALL.md`, `docs/OPERATIONS.md`

### 13.4 Write the troubleshooting guide

Map failures and drift findings to symptoms, logs, doctor output, recovery, retry, and explicit destructive actions.

Acceptance:

- [ ] Every failure and drift row has a next action.
- [ ] Interrupted operations and detached-job diagnostics are covered.
- [ ] Secret substitution failures distinguish bad credentials from interception failures.
- [ ] Unavailable inventory is distinguished from missing resources.

Files: `docs/TROUBLESHOOTING.md`

### 13.5 Write RPC and control-settings references

Generate or verify field documentation from schemas, including operation reconnect, idempotency, conflicts, retention, and public DTO exclusions.

Acceptance:

- [ ] Every RPC has request and response fields.
- [ ] Control settings contain only counter and operations, not VM inventory or credentials.
- [ ] Revision conflicts, migration, reset, and recovery behavior are explained.
- [ ] Shared schemas are linked as source of truth.

Files: `docs/RPC.md`, `docs/SETTINGS.md`

### 13.6 Write the architecture map

Map modules to state ownership, background operations, microsandbox jobs, routed hosts, polling, and recovery.

Acceptance:

- [ ] Each module has one responsibility and a DESIGN.md reference.
- [ ] Polling is described as observing, not owning, host work.
- [ ] Microsandbox is identified as VM authority and settings are not a second inventory.
- [ ] Sensitive config flow and public DTO allowlists are shown.

Files: `docs/ARCHITECTURE.md`

## Needs decision

Record each answer in a short note under `docs/decisions/` before starting a dependent task. Do not implement a guessed answer.

### Decide: parent identity used in registration labels

Choose the stable, unique, human-readable parent part of `<parent>/sandbox-N`.

Acceptance:

- [ ] Names the source, normalization, empty fallback, and cross-parent collision behavior.
- [ ] Defines the matching `paseo-msb-parent` ownership value.
- [ ] Note is linked from tasks 3.4 and 6.1.

Files: `docs/decisions/parent-identity.md`

### Decide: Pi credential source keys and allowed host defaults

Choose the fixed Pi-only source map and supported bindings.

Acceptance:

- [ ] Defines source keys, guest env vars, and default allowed hosts.
- [ ] Defines unsupported-source behavior without a generic provider framework.
- [ ] Does not put credentials in UI or settings.

Files: `docs/decisions/pi-sources.md`

### Decide: Pi secret substitution defaults

Choose per-binding substitution and placeholder policy for the fixed Pi catalog.

Acceptance:

- [ ] Defines header fields, query/body defaults, TLS identity, and placeholder allowances.
- [ ] Defines blocked-placeholder violation action.
- [ ] Records HTTP/2 body substitution as unsupported.

Files: `docs/decisions/pi-substitution.md`

### Decide: how the plugin reads parent Pi credentials

Choose the supported parent credential/environment read path and precedence.

Acceptance:

- [ ] Names APIs or environment sources and their precedence.
- [ ] Defines availability reporting and missing-source errors.
- [ ] Defines when host env references can avoid inline values.
- [ ] Confirms values never enter control settings or RPC responses.

Files: `docs/decisions/pi-credential-read.md`

### Decide: log tail line count and refresh behavior

The sources are settled as bounded host operation events, microsandbox sandbox logs, and detached-job logs. Choose limits and polling behavior.

Acceptance:

- [ ] Defines per-source line and byte limits and total response bound.
- [ ] Defines ordering and source labels.
- [ ] Defines refresh with status polling without unbounded follow streams.
- [ ] Keeps output read-only and redacted.

Files: `docs/decisions/log-tail.md`

### Decide: status poll interval and metrics cache window

Choose screen polling, server coalescing window, and error backoff.

Acceptance:

- [ ] Defines one mounted-screen interval and whole-map cache window.
- [ ] Defines concurrent-call behavior and repeated-error backoff.
- [ ] Requires no background metrics timer.

Files: `docs/decisions/polling.md`

### Decide: sandbox name numbering after control settings loss

Choose counter recovery while preserving monotonic names and preventing observed-name reuse.

Acceptance:

- [ ] Defines next number from surviving control state and observed managed names.
- [ ] Defines malformed-label behavior and collision handling.
- [ ] Addresses whether historical names after a complete settings reset can be reused; if not, chooses an additional durable non-VM counter source.

Files: `docs/decisions/name-recovery.md`

### Decide: loopback port range and reservation policy

Choose range, exclusions, probe, retries, and behavior after settings reset.

Acceptance:

- [ ] Defines range, retry limit, and exhaustion error.
- [ ] Uses managed microsandbox configs as persisted port reservations.
- [ ] Defines runtime bind-conflict recovery and concurrent allocation ownership.

Files: `docs/decisions/port-allocation.md`

### Decide: operation history and idempotency retention

Choose bounded terminal operation history and idempotency-key retention without evicting active work.

Acceptance:

- [ ] Defines count/age bounds and which diagnostics survive pruning.
- [ ] Defines idempotency-key retention and conflicting-request reuse behavior.
- [ ] Defines reset behavior for unfinished and terminal operations.
- [ ] Keeps active operations until terminal or explicitly resolved.

Files: `docs/decisions/operation-retention.md`

### Decide: minimum parent daemon version and requirements.paseo value

Choose the exact parent floor and feature checks.

Acceptance:

- [ ] Maps connected hosts, routed clients, authenticated registration, removal, and settings CAS to the version that introduced them.
- [ ] Defines update messages and manifest value.
- [ ] Uses one value in manifest, spikes, doctor, and install guide.

Files: `docs/decisions/parent-version.md`

### Decide: minimum microsandbox SDK and runtime version

Choose exact floors for the persistent state and job APIs, not only the original builder methods.

Acceptance:

- [ ] Covers stable IDs, persisted config, label-filtered pagination, detached jobs/logs, modify, secrets, ports, and metrics.
- [ ] Defines SDK/runtime compatibility detection and doctor checks.
- [ ] Records Linux/macOS verification and Windows preview status.

Files: `docs/decisions/microsandbox-version.md`

### Decide: initial guest image digest and update policy

Choose the initial pin and how digest changes ship.

Acceptance:

- [ ] Records full digest reference and one source of truth for create and doctor.
- [ ] Defines user override policy, defaulting to no override in v1.
- [ ] Defines Pi toolchain and end-to-end verification for pin updates.

Files: `docs/decisions/image-pin.md`

### Decide: CPU, memory, and autoStart defaults

Choose runtime-accepted resource bounds and defaults plus the initial autoStart default.

Acceptance:

- [ ] Defines minimum, maximum, default, and validation messages for CPU and memory.
- [ ] Defines autoStart default used by create options and labels.
- [ ] Uses the same constants in schemas and create sheet.

Files: `docs/decisions/vm-size.md`

### Decide: boot, install, online, and lifecycle timeouts

Choose per-step timeouts and whether each result is retryable.

Acceptance:

- [ ] Covers boot, detached Pi install, routed online, stop, restart, and recovery inspection.
- [ ] Defines failure codes and safe user behavior on timeout.
- [ ] Distinguishes operation timeout from proof that side effects stopped.

Files: `docs/decisions/timeouts.md`

### Decide: Node provisioning fallback if assumption 1 fails

Take this decision only if spike 1.1 fails.

Acceptance:

- [ ] Defines Node source, checksum, non-root install location, and daemon PATH.
- [ ] Does not require changing the pinned image.
- [ ] Verifies Pi resolution after fallback installation.

Files: `docs/decisions/node-fallback.md`

### Decide: how Open host in Paseo navigates to a routed host

Choose a supported route or hide the action.

Acceptance:

- [ ] Names navigation API and offline behavior.
- [ ] Does not require a second parent connection.
- [ ] Uses redacted connection copy as fallback.

Files: `docs/decisions/open-host.md`

### Decide: fallback when the parent has no registration removal API

Take this decision only if spike 1.3 finds no supported removal path.

Acceptance:

- [ ] Defines supported removal or blocks delete and stale-registration repair.
- [ ] Never edits parent host state through unsupported private formats.
- [ ] Records user-visible limitations and revises the design if required.

Files: `docs/decisions/registration-removal.md`

# Implementation tasks

Derived from [DESIGN.md](./DESIGN.md). DESIGN.md is the authoritative spec and is not changed by this plan.

Working rules:

- One task per PR. Split a task if it grows beyond about one day.
- Sections are in dependency order. Complete the verification spikes before feature code that relies on them.
- `blocked by: N` refers to assumption N in DESIGN.md section 12. Do not treat the assumption as settled until its spike passes.
- A task that refers to a `Decide:` item is not ready until that decision is recorded under "Needs decision".
- Tasks may be reordered inside a section, but later sections should not assume an earlier section is complete.

## 1. Verification spikes

### 1.1 Verify the guest image ships Node 22.19 or newer and npm for Pi

Boot the pinned Paseo image and inspect the guest toolchain as the `paseo` user. Record the image digest, Node version, npm version, user ids, and absolute paths. This spike decides whether the Pi install can run as designed or needs the Node fallback decision.

Command: `node scripts/spikes/verify-guest-toolchain.mjs --image "$PASEO_IMAGE_PIN"`

Pass: Node is 22.19 or newer, `npm` is on the `paseo` user PATH, and the `paseo` user exists.
Fail: Any condition is false. Open `Decide: Node provisioning fallback if assumption 1 fails`.

Acceptance:

- [ ] Script exits 0 only when every pass condition holds.
- [ ] Output records image digest, Node version, npm version, and user identity.
- [ ] Result is captured in `docs/spikes/01-guest-toolchain.md`.

Files: `scripts/spikes/verify-guest-toolchain.mjs`, `docs/spikes/01-guest-toolchain.md`

### 1.2 Verify init auto supervises the guest daemon and keeps it reachable

Boot a sandbox with `.init("auto")` and a published loopback port. Inspect PID 1, wait for the guest daemon port, and confirm the daemon remains reachable after the entrypoint drops privileges to `paseo`.

Command: `node scripts/spikes/verify-init-auto.mjs --image "$PASEO_IMAGE_PIN" --timeout 180`

Pass: PID 1 is the image entrypoint or its supervisor, the guest daemon accepts TCP connections on port 6767, and the daemon process runs as `paseo`.
Fail: PID 1 exits, the daemon is not supervised, or the port closes after the privilege drop.

Acceptance:

- [ ] Script records PID 1 command, daemon owner, and first successful connection time.
- [ ] Script fails on a closed port after a successful initial connection.
- [ ] Result is captured in `docs/spikes/02-init-auto.md`.

Files: `scripts/spikes/verify-init-auto.mjs`, `docs/spikes/02-init-auto.md`

### 1.3 Verify hosts.add from a plugin server handler and routed host online

Run a scratch plugin handler on the deployed parent daemon and register a loopback child. Poll `hosts.list()` from the plugin and confirm the routed host reaches `online` without an app restart.

Command: `node scripts/spikes/verify-host-registration.mjs --parent "$PASEO_PARENT_URL" --child-port "$CHILD_PORT"`

Pass: `hosts.add()` resolves from the plugin handler, the registration is visible on the parent, and the routed host reports `online` within 60 seconds.
Fail: The call is unavailable, permission is denied, the routed host stays offline, or an app restart is required.

Acceptance:

- [ ] Script prints the registration id, label, metadata, and online timing.
- [ ] Script covers the exact parent daemon version named in `requirements.paseo`.
- [ ] Result is captured in `docs/spikes/03-host-registration.md`.

Files: `scripts/spikes/verify-host-registration.mjs`, `scripts/spikes/fixtures/rpc-plugin/`, `docs/spikes/03-host-registration.md`

### 1.4 Verify providers.refresh through a routed client detects Pi

Boot a VM, install Pi, register it as a routed host, and call `providers.refresh()` through `paseo.hosts.client(childId)`. Then read the child agent list and check for Pi.

Command: `node scripts/spikes/verify-provider-refresh.mjs --image "$PASEO_IMAGE_PIN" --timeout 300`

Pass: The agent list includes Pi immediately after refresh, without restarting the guest daemon.
Fail: Pi is absent, refresh errors, or the guest daemon must restart.

Acceptance:

- [ ] Script prints the agent list before and after refresh.
- [ ] Script fails if Pi appears only after a guest daemon restart.
- [ ] Result is captured in `docs/spikes/04-provider-refresh.md`.

Files: `scripts/spikes/verify-provider-refresh.mjs`, `docs/spikes/04-provider-refresh.md`

### 1.5 Verify concurrent published loopback ports and prompt release

Start several VMs with distinct published loopback ports, then stop one and try to rebind its port. Repeat enough times to expose port leaks or races.

Command: `node scripts/spikes/verify-port-lifecycle.mjs --count 5 --release-timeout 15`

Pass: Every VM gets a unique working port, the stopped VM releases its port within the timeout, and the released port can be bound again.
Fail: A port collides, remains bound after stop, or cannot be reused.

Acceptance:

- [ ] Script reports per VM port, bind result, stop time, and release time.
- [ ] Script runs the rebind check for every stopped VM.
- [ ] Result is captured in `docs/spikes/05-port-lifecycle.md`.

Files: `scripts/spikes/verify-port-lifecycle.mjs`, `docs/spikes/05-port-lifecycle.md`

### 1.6 Verify detached VMs survive plugin reload and daemon restart

Start a detached VM, reload or disable and re-enable the plugin, restart the parent daemon, and reattach with `Sandbox.get(name)`. Check that the guest daemon is still reachable after each step.

Command: `node scripts/spikes/verify-detached-survival.mjs --image "$PASEO_IMAGE_PIN" --parent "$PASEO_PARENT_URL"`

Pass: The VM remains running through plugin reload and daemon restart, `Sandbox.get(name)` returns a usable handle, and the guest daemon is reachable.
Fail: The VM stops, the handle is lost, or the guest daemon becomes unreachable.

Acceptance:

- [ ] Script records sandbox state before and after each reload and restart.
- [ ] Script asserts `Sandbox.get(name)` returns the same sandbox name.
- [ ] Result is captured in `docs/spikes/06-detached-survival.md`.

Files: `scripts/spikes/verify-detached-survival.mjs`, `docs/spikes/06-detached-survival.md`

## 2. Plugin scaffold and RPC skeleton

### 2.1 Create the plugin package and Paseo manifest

Scaffold the plugin package with client, server, and shared entry points. Declare the parent feature floor from DESIGN.md section 11 in `paseo-plugin.json`, using the version chosen in `Decide: minimum parent daemon version and requirements.paseo value`. Keep the screen empty except for a placeholder.

Acceptance:

- [ ] The plugin loads on a development parent without errors.
- [ ] `requirements.paseo` includes connected hosts and the plugin settings API.
- [ ] Typecheck and build scripts pass on a clean checkout.
- [ ] Client code imports only React Native primitives and `theme.colors`.

Files: `paseo-plugin.json`, `package.json`, `tsconfig.json`, `index.client.tsx`, `index.server.tsx`, `client/screen.tsx`, `server/index.ts`, `shared/index.ts`

### 2.2 Define shared RPC contracts for the section 9 surface

Add Zod request and response schemas for every RPC in DESIGN.md section 9. Include a shared error envelope and explicit result types so client and server cannot drift.

Acceptance:

- [ ] Every RPC name in DESIGN.md section 9 has a request and response schema.
- [ ] Schemas parse representative fixtures in both client and server tests.
- [ ] The error envelope distinguishes validation, conflict, and runtime errors.
- [ ] No RPC imports client or server modules.

Files: `shared/rpc.ts`, `shared/errors.ts`, `shared/types.ts`

### 2.3 Register RPC handler skeletons and a typed client transport

Register stub handlers on the server and a typed client wrapper with timeout and error normalization. Stubs return a not-implemented error rather than silently succeeding.

Acceptance:

- [ ] Every contract has a registered handler.
- [ ] The client surfaces timeout, validation, and runtime errors distinctly.
- [ ] An unknown RPC returns a stable error code.
- [ ] Handler registration is covered by a test.

Files: `server/rpc.ts`, `server/index.ts`, `client/rpc.ts`, `shared/rpc.ts`

### 2.4 Add server lifecycle, structured logging, and a test harness

Wire plugin init and teardown, structured logs, and dependency injection for the microsandbox SDK. The harness must allow server handlers to run in tests without a live microVM.

Acceptance:

- [ ] Plugin init and teardown complete cleanly on load and unload.
- [ ] Logs include task, VM id, and lifecycle step without credentials.
- [ ] Tests can replace the SDK with a fake through the harness.
- [ ] A failing handler does not crash the plugin subprocess.

Files: `server/index.ts`, `server/context.ts`, `server/logger.ts`, `tests/server/harness.ts`

### 2.5 Add the client screen shell and navigation entry points

Register the management screen with `addScreen`, add the sidebar header item, and add Command Center items for opening the screen and creating a VM. Keep the shell free of data fetching until the RPC layer exists.

Acceptance:

- [ ] The screen opens from the sidebar and from both Command Center items.
- [ ] The shell renders on desktop and mobile widths.
- [ ] The screen shows a loading or empty placeholder, not an error.
- [ ] Navigation registration is isolated from the list and detail components.

Files: `client/screen.tsx`, `client/commands.ts`, `index.client.tsx`, `client/components/Shell.tsx`

## 3. Settings document and record model

### 3.1 Define the VmRecord schema and the `vms` settings document

Implement the `VmRecord` shape from DESIGN.md section 4 as a Zod schema and wrap it in the host scoped settings document. Validate ids, labels, ports, cpu and memory bounds, and secret binding fields. Use the bounds from `Decide: CPU and memory bounds and defaults`.

Acceptance:

- [ ] A valid record round-trips without field loss.
- [ ] Invalid ports, memory values, ids, and labels are rejected with field errors.
- [ ] The settings document has an explicit version and defaults for a new host.
- [ ] The schema is shared and has no server only imports.

Files: `shared/settings.ts`, `shared/types.ts`, `server/settings.ts`

### 3.2 Implement revision-checked settings reads and writes

Add read, save, and compare-and-swap helpers for the `vms` document. A save must fail with a conflict when the supplied revision is stale.

Acceptance:

- [ ] A new host gets an initialized document at version 1.
- [ ] Two concurrent saves produce one success and one conflict.
- [ ] No update is lost after a conflict, and the caller receives the current revision.
- [ ] Tests cover create, update, conflict, and read after conflict.

Files: `server/settings.ts`, `shared/errors.ts`, `tests/server/settings.test.ts`

### 3.3 Implement the record factory and monotonic sandbox naming

Add a factory that creates a record id, sandbox name, label, and creation time. Names use the `sandbox-N` form and must never be reused for the parent. Use the identity and numbering decisions for the label and counter source.

Acceptance:

- [ ] New records get monotonically increasing names within a parent.
- [ ] A name is not reused after delete or failed create.
- [ ] Duplicate record ids are rejected.
- [ ] The label uses the format chosen in `Decide: parent identity used in registration labels`.

Files: `server/records.ts`, `shared/settings.ts`, `tests/server/records.test.ts`

### 3.4 Implement the desired and observed state model

Build a pure model that joins settings records, `Sandbox.list()`, and `hosts.list()` into one resolved view. Keep the join free of SDK calls so it can be tested with fixtures and reused by list, detail, and reconcile.

Acceptance:

- [ ] The model identifies missing sandboxes, unmanaged sandboxes, missing registrations, and stale registrations.
- [ ] Metrics are optional and do not change existence or registration state.
- [ ] The join is covered by fixtures for every drift class in DESIGN.md section 4.
- [ ] No React or screen code imports this model.

Files: `shared/state.ts`, `server/observed.ts`, `tests/server/state.test.ts`

### 3.5 Add settings migration and reset handling

Add explicit handling for older document versions and a missing or reset document. Unknown future versions must be rejected rather than overwritten.

Acceptance:

- [ ] Version 0 or the initial shape migrates to version 1.
- [ ] A future unknown version returns a clear error and is not saved.
- [ ] A missing document initializes without deleting observed sandboxes.
- [ ] Migration tests cover empty, valid, and unknown version inputs.

Files: `server/settings.ts`, `shared/settings.ts`, `tests/server/settings-migration.test.ts`

## 4. VM lifecycle

### 4.1 Implement loopback port allocation and reservation

Add an allocator that probes a loopback port by binding and releasing it, then reserves the port in the record before use. Retry with the next free port on collision and never hand the same port to two records.

Acceptance:

- [ ] Collisions retry without failing create.
- [ ] Allocated ports are unique across records.
- [ ] A released port can be allocated again.
- [ ] Allocation uses the range chosen in `Decide: loopback port range and reservation policy`.

Files: `server/ports.ts`, `shared/settings.ts`, `tests/server/ports.test.ts`
blocked by: 5

### 4.2 Build the sandbox from a record

Implement the create builder for the sandbox settings in DESIGN.md section 5 steps 3 and 4: pinned image, cpu and memory, loopback port bind, label, `init("auto")`, and `detached(true)`. Use the image digest from `Decide: initial guest image digest and update policy`. Leave Pi install, secrets, and registration to later tasks.

Acceptance:

- [ ] Builder arguments match the record fields exactly.
- [ ] The sandbox carries the `paseo-msb=<id>` label.
- [ ] The sandbox starts detached with the pinned image digest.
- [ ] Tests assert the builder arguments with a fake SDK.

Files: `server/sandbox.ts`, `shared/types.ts`, `tests/server/sandbox.test.ts`
blocked by: 2

### 4.3 Implement the create state machine and progress persistence

Add the create sequence as an explicit state machine with `booting`, `installing`, `registering`, `online`, and `failed:<reason>` states. Persist progress according to the chosen record timing so polling can show the current step without guessing.

Acceptance:

- [ ] Every create step has an explicit transition and failure transition.
- [ ] A failed step leaves a record in a named state and keeps the log tail available.
- [ ] No failure path silently deletes the record or the sandbox.
- [ ] State transitions are covered by tests with a fake SDK.

Files: `server/create.ts`, `shared/rpc.ts`, `shared/state.ts`, `tests/server/create.test.ts`
blocked by: 2

### 4.4 Implement start, stop, and restart actions

Implement the lifecycle actions from DESIGN.md section 5. Stop keeps the record and registration. Start and restart wait for the guest to become usable and re-register when a registration was lost.

Acceptance:

- [ ] Stop leaves the record and registration intact.
- [ ] Start handles an already running VM without error.
- [ ] Restart waits for the same online condition as create.
- [ ] A missing sandbox returns an actionable error instead of recreating it.

Files: `server/lifecycle.ts`, `shared/rpc.ts`, `tests/server/lifecycle.test.ts`

### 4.5 Implement the delete workflow

Implement delete as stop, remove sandbox, remove registration, then delete the record. Use the registration removal helper delivered by task 6.3, so land this after that task. Require an explicit confirmation token or equivalent guard so delete cannot run from a read path.

Acceptance:

- [ ] Delete runs the steps in the documented order.
- [ ] A partial failure leaves a record with enough state to retry the remaining steps.
- [ ] Delete does not remove a registration that belongs to another VM.
- [ ] The record is removed only after sandbox and registration removal succeed.

Files: `server/delete.ts`, `shared/rpc.ts`, `tests/server/delete.test.ts`

### 4.6 Reattach to running VMs and apply autoStart on plugin init

On plugin init, reattach to detached sandboxes with `Sandbox.get(name)` and start records marked `autoStart` that are not running. Reattachment must not duplicate records, ports, or registrations.

Acceptance:

- [ ] A running detached VM is reattached without a start call.
- [ ] Only stopped records with `autoStart` are started.
- [ ] A failed autoStart is marked on the record and remains visible in the list.
- [ ] Init is idempotent across two consecutive loads.

Files: `server/init.ts`, `server/sandbox.ts`, `tests/server/init.test.ts`
blocked by: 6

### 4.7 Add lifecycle integration tests with a fake microsandbox runtime

Cover create, start, stop, restart, delete, reattach, and the documented failure states using one fake runtime. The fake must model detached sandboxes and published ports so tests exercise the orchestration, not only individual helpers.

Acceptance:

- [ ] Each lifecycle action has a success test and at least one failure test.
- [ ] The fake preserves sandboxes across simulated plugin reloads.
- [ ] Tests assert no duplicate registration or port allocation.
- [ ] The suite runs without a real microVM.

Files: `tests/lifecycle/fake-runtime.ts`, `tests/lifecycle/lifecycle.test.ts`
blocked by: 6

## 5. Pi install and provider readiness

### 5.1 Implement the guest Pi install script

Generate and run the install script from DESIGN.md section 5 step 5 as the image's non-root `paseo` user. Use `npm install -g --ignore-scripts @earendil-works/pi-coding-agent` with the daemon user's environment and capture output for the log tail.

Acceptance:

- [ ] The install runs as `paseo`, not root.
- [ ] The command is exactly the v1 package and flags from DESIGN.md.
- [ ] Stdout and stderr are captured in the sandbox log path used by the detail view.
- [ ] A non-zero install exits the step and maps to `failed:install`.

Files: `server/pi-install.ts`, `scripts/guest/install-pi.sh`, `tests/server/pi-install.test.ts`
blocked by: 1

### 5.2 Verify Pi resolves on the daemon user PATH

After install, check `pi` from the same environment the guest daemon uses. A successful npm install that is invisible to the daemon must be treated as a failure, not as ready.

Acceptance:

- [ ] The check runs as the `paseo` user with the daemon environment.
- [ ] The resolved path is recorded in the VM log tail.
- [ ] A missing `pi` maps to `failed:install`.
- [ ] The check does not depend on a root shell or interactive profile.

Files: `server/pi-install.ts`, `scripts/guest/verify-pi.sh`, `tests/server/pi-install.test.ts`
blocked by: 1

### 5.3 Map install failures to `failed:install` and keep diagnostics

Connect Pi install errors to the create state machine and the detail view. Preserve the last install output and distinguish image pull, npm, PATH, and permission failures in the error text.

Acceptance:

- [ ] Install failures produce `failed:install` with a short reason code.
- [ ] The log tail remains available after failure.
- [ ] The host is not registered after an install failure.
- [ ] Error text is safe to show in the UI and contains no credentials.

Files: `server/pi-install.ts`, `shared/errors.ts`, `server/create.ts`, `tests/server/pi-install.test.ts`
blocked by: 1

### 5.4 Refresh providers through the routed client after registration

Call `providers.refresh()` through `paseo.hosts.client(childId)` after a VM reaches online and confirm the child agent list includes Pi. A refresh failure is reported on the VM but does not tear down a working host.

Acceptance:

- [ ] Refresh runs after the routed host reports online.
- [ ] The result records whether Pi was seen in the agent list.
- [ ] A refresh error is surfaced without deleting the registration.
- [ ] The call is covered by a test with a fake routed client.

Files: `server/providers.ts`, `shared/state.ts`, `tests/server/providers.test.ts`
blocked by: 3, 4

## 6. Host registration and routed-host verification

### 6.1 Implement host registration with metadata and sourceKey

Register a VM on the parent with the loopback connection, frozen label, `{ source: "paseo-msb", vm: <id> }` metadata, and the record id as `sourceKey`. Store the returned registration id on the record.

Acceptance:

- [ ] The registration uses `127.0.0.1:<record hostPort>`.
- [ ] Metadata and `sourceKey` match DESIGN.md section 4.
- [ ] A repeated registration call is idempotent for one record.
- [ ] The returned registration id is persisted before the VM is marked ready.

Files: `server/registration.ts`, `shared/settings.ts`, `tests/server/registration.test.ts`
blocked by: 3

### 6.2 Wait for online and surface registration errors

Poll the parent host list until the routed host reports online or the timeout expires. Use the timeout from `Decide: boot, install, and online timeouts`. On timeout, keep the registration and store the registration error text for the UI.

Acceptance:

- [ ] Online detection uses the routed host record, not only the TCP port.
- [ ] A timeout maps to `failed:unreachable` and keeps the registration.
- [ ] The registration error text is available to `vm.detail`.
- [ ] The wait is cancellable when the plugin unloads.

Files: `server/registration.ts`, `shared/state.ts`, `tests/server/registration.test.ts`
blocked by: 3

### 6.3 Verify and implement registration removal

Probe the parent host API for registration removal before using it in delete and reconcile. Wrap removal in one helper that is idempotent and checks that the registration belongs to the expected VM.

Acceptance:

- [ ] A probe script or integration test proves removal on the supported parent version.
- [ ] Removing a missing registration succeeds without error.
- [ ] Removal refuses a registration whose metadata does not match the VM.
- [ ] Delete and stale-registration repair both use the helper.

Files: `server/registration.ts`, `tests/server/registration.test.ts`, `scripts/spikes/verify-registration-removal.mjs`
blocked by: 3

### 6.4 Reconcile registrations back to records

Match `hosts.list()` entries to records by `sourceKey` and metadata, then update `registeredHostId` when it is missing or changed. Detect duplicate or foreign registrations that claim the same source key.

Acceptance:

- [ ] A matching registration updates the record without a new registration.
- [ ] A duplicate source key is reported as drift, not silently chosen.
- [ ] A registration without matching metadata is ignored.
- [ ] Matching is covered by fixtures.

Files: `server/registration.ts`, `server/observed.ts`, `tests/server/registration.test.ts`
blocked by: 3

### 6.5 Wire registration into create, start, and autoStart

Connect the registration helper to create, start, restart, and autoStart flows. A VM is marked online only after registration and the online wait both succeed.

Acceptance:

- [ ] Create registers after boot and install, then waits for online.
- [ ] Start re-registers only when the registration is missing.
- [ ] AutoStart uses the same registration path as a manual start.
- [ ] No flow marks a VM online before the routed host is online.

Files: `server/create.ts`, `server/lifecycle.ts`, `server/init.ts`, `tests/server/registration.test.ts`
blocked by: 3

### 6.6 Add a routed-host end-to-end test

Exercise the full path from a registered loopback sandbox to a routed host that reports online and can be opened by a parent client. The test may be skipped when no microsandbox runtime is available, but it must run in the release check.

Acceptance:

- [ ] The test creates or reuses a sandbox, registers it, and waits for online.
- [ ] The test opens a parent client to the routed host and reads a basic status.
- [ ] The test asserts the label and registration metadata visible to the app.
- [ ] The test is documented as runtime dependent.

Files: `tests/integration/routed-host.test.ts`, `tests/integration/fixtures/`
blocked by: 3

## 7. Secrets binding

### 7.1 Define the secret binding schema and validation

Implement the `secretBindings` item from DESIGN.md section 4 with `envVar`, `source`, `allowedHosts`, and substitution flags. Validate that an env var is unique per VM and that a binding names an existing parent credential source.

Acceptance:

- [ ] Duplicate `envVar` values are rejected.
- [ ] Empty `allowedHosts` is rejected.
- [ ] An unknown `source` is rejected before create starts.
- [ ] The schema is shared with the create sheet and the server.

Files: `shared/secrets.ts`, `shared/settings.ts`, `tests/server/secrets.test.ts`

### 7.2 Add a microsandbox secret substitution smoke test

This is not one of the section 12 assumptions. It checks the section 13 credential risk before create depends on it. Run a local echo endpoint, pass a placeholder into the guest, and confirm the upstream request receives the real value only where configured.

Command: `node scripts/spikes/verify-secret-substitution.mjs --echo-url "$ECHO_URL"`

Pass: Header substitution works, query and body substitution follow the flags, `allowPlaceholderFor` receives the placeholder, and a blocked destination is refused.
Fail: A configured location is not substituted, an unconfigured location leaks the real value, or TLS interception cannot be enabled.

Acceptance:

- [ ] Script covers header, query, body, HTTP/2 body, and blocked destination cases.
- [ ] Output never prints the real credential value.
- [ ] Result is captured in `docs/spikes/07-secret-substitution.md`.

Files: `scripts/spikes/verify-secret-substitution.mjs`, `docs/spikes/07-secret-substitution.md`

### 7.3 Build microsandbox secrets from VM bindings

Translate validated bindings into microsandbox secret objects using only values from the parent credential store. Apply `allowPlaceholderFor` and the substitution flags, and rely on automatic TLS interception setup.

Acceptance:

- [ ] Secret values come from the parent store, never from settings or UI input.
- [ ] Each binding maps to exactly one guest env var.
- [ ] Placeholder allowances and substitution flags match the record.
- [ ] Tests use fake credentials and assert no credential is written to settings.

Files: `server/secrets.ts`, `shared/secrets.ts`, `tests/server/secrets.test.ts`

### 7.4 Bind secrets into the create builder

Add the built secrets to the sandbox builder from the create sequence. If a source cannot be resolved, fail before any sandbox is created so no half configured VM is left behind.

Acceptance:

- [ ] Create resolves all secrets before building the sandbox.
- [ ] A missing source returns a clear validation error and creates nothing.
- [ ] The sandbox receives exactly the bindings in the record.
- [ ] The builder test asserts the secret arguments.

Files: `server/sandbox.ts`, `server/secrets.ts`, `tests/server/sandbox.test.ts`

### 7.5 Redact secrets from logs and RPC errors

Add redaction at the logging and error boundary for credential values and placeholders. The UI and log tail must never receive a real secret.

Acceptance:

- [ ] Log output redacts known secret values and placeholder forms.
- [ ] RPC errors never include secret values or inline credential fields.
- [ ] Redaction is tested with a fake secret in a nested error.
- [ ] Redaction does not hide the credential source name.

Files: `server/logger.ts`, `shared/errors.ts`, `tests/server/redaction.test.ts`

## 8. Metrics polling

### 8.1 Implement the metrics sampler with a poll window

Sample `allSandboxMetrics()` at most once per poll window while a client is watching, and return the raw map keyed by sandbox name. Do not cache per VM values.

Acceptance:

- [ ] Concurrent status calls inside one window share one SDK call.
- [ ] A missing sandbox key returns no metrics, not an error.
- [ ] The sampler does not run when no client is watching.
- [ ] Tests use a fake clock and count SDK calls.

Files: `server/metrics.ts`, `shared/metrics.ts`, `tests/server/metrics.test.ts`

### 8.2 Return metrics in list and detail responses

Map the metrics map onto records for `vm.list` and `vm.detail`. Stopped VMs return a null metrics field and keep their last known record state.

Acceptance:

- [ ] Running VMs include cpu, memory, disk, network, and uptime.
- [ ] Stopped VMs return no metrics without an error.
- [ ] List and detail use the same sampler and do not trigger duplicate SDK calls.
- [ ] Responses validate against the shared schemas.

Files: `server/status.ts`, `shared/rpc.ts`, `shared/metrics.ts`, `tests/server/status.test.ts`

### 8.3 Isolate metrics failures from list and detail

Treat metrics collection as best effort. If the runtime or metrics call fails, list and detail still return records and observed state with metrics unavailable.

Acceptance:

- [ ] A metrics error is reported as unavailable, not as a VM failure.
- [ ] List still renders when the metrics call throws.
- [ ] The error is logged once per poll window.
- [ ] Tests cover runtime missing and SDK throw cases.

Files: `server/metrics.ts`, `server/status.ts`, `tests/server/metrics.test.ts`

## 9. Reconcile pass

### 9.1 Detect the five drift classes

Compare records, `Sandbox.list()`, and `hosts.list()` to detect the classes in DESIGN.md section 4: VM missing, unmanaged VM, unregistered, stale host, and host unreachable. Return a typed finding per class with repairability.

Acceptance:

- [ ] Fixtures cover each of the five classes.
- [ ] Unmanaged sandboxes are found by the `paseo-msb` label.
- [ ] Findings include the record id or sandbox name needed for action.
- [ ] Detection makes no mutations.

Files: `server/reconcile.ts`, `shared/drift.ts`, `tests/server/reconcile.test.ts`

### 9.2 Repair missing registrations and stale host registrations

Implement the safe repairs from DESIGN.md section 4: re-register an unregistered VM and remove a registration whose sandbox is gone. The pass must never start, stop, or delete a VM.

Acceptance:

- [ ] A missing registration is recreated from the record.
- [ ] A stale registration is removed through the registration removal helper.
- [ ] Missing VM and unmanaged VM findings are reported but not modified.
- [ ] A second pass after repair reports no remaining repairable drift.

Files: `server/reconcile.ts`, `server/registration.ts`, `tests/server/reconcile.test.ts`
blocked by: 3

### 9.3 Report missing VMs and unmanaged VMs with user actions

Expose the non-automatic findings with the actions the user may take. Missing VM records may be deleted by the user. Unmanaged sandboxes may be adopted or removed only if the adoption decision allows it.

Acceptance:

- [ ] Missing VM findings identify the record and offer record deletion only.
- [ ] Unmanaged findings identify the sandbox and label.
- [ ] The response states which actions are not automatic.
- [ ] No action runs during detection or status polling.

Files: `server/reconcile.ts`, `shared/drift.ts`, `tests/server/reconcile.test.ts`

### 9.4 Wire `vm.reconcile` and status polling

Run detection on status reads and repairs only on the `vm.reconcile` mutation. Return both findings and the list of changes made in the same response.

Acceptance:

- [ ] `vm.list` and `vm.detail` never mutate registrations.
- [ ] `vm.reconcile` returns findings before and after repair.
- [ ] The response lists each registration added or removed.
- [ ] The handler is covered by a test that asserts no unexpected mutation.

Files: `server/rpc.ts`, `server/reconcile.ts`, `shared/rpc.ts`, `tests/server/reconcile.test.ts`
blocked by: 3

### 9.5 Add reconcile idempotency and safety tests

Exercise repeated reconcile runs, partial SDK failures, and a settings document that lost records while sandboxes still exist. The tests must prove that destructive actions require a user action.

Acceptance:

- [ ] Two consecutive reconcile calls produce no duplicate registration.
- [ ] A failed removal leaves the finding for the next pass.
- [ ] Sandboxes and records are not started, stopped, or deleted by reconcile.
- [ ] Lost settings records surface as unmanaged sandboxes.

Files: `tests/server/reconcile.test.ts`, `tests/server/fixtures/reconcile/`
blocked by: 3

## 10. Management screen

### 10.1 Register the screen, sidebar item, and Command Center items

Replace the shell placeholder with the real management screen route and entry points. The sidebar item and Command Center items should open the same screen, with the create command opening the create sheet.

Acceptance:

- [ ] The sidebar item opens the management screen.
- [ ] Command Center has items for open screen and create VM.
- [ ] The create command opens the sheet without a separate route.
- [ ] The screen uses only `theme.colors` and React Native primitives.

Files: `client/screen.tsx`, `client/commands.ts`, `index.client.tsx`, `client/components/Shell.tsx`

### 10.2 Implement the VM list view

Render one row per record with label, state, cpu, memory, and uptime. Add an inline warning marker when the sandbox is missing or the registration is stale, and poll the status RPC while the screen is mounted.

Acceptance:

- [ ] Each record appears once, even when observed state is missing.
- [ ] Missing sandbox and stale registration rows show a warning marker.
- [ ] Loading, empty, and error states are distinct.
- [ ] Polling stops when the screen unmounts.

Files: `client/VmList.tsx`, `client/hooks/useVmStatus.ts`, `client/components/StatusRow.tsx`

### 10.3 Implement the detail identity and live metrics pane

Show the record identity from DESIGN.md section 8 and the live metrics from the status response. Keep the pane useful when metrics are unavailable or the VM is stopped.

Acceptance:

- [ ] The pane shows label, sandbox name, image pin, cpus, memory, and published port.
- [ ] Running metrics show cpu, memory, disk, network, and uptime.
- [ ] Stopped or unavailable metrics show a clear no metrics state.
- [ ] The pane updates from the same poll as the list.

Files: `client/VmDetail.tsx`, `client/components/MetricGrid.tsx`, `client/hooks/useVmStatus.ts`

### 10.4 Implement the read-only log tail

Add a read-only log tail for the last N lines using the source chosen in `Decide: log tail source and line count`. Refresh it with the status poll or a bounded follow mode, and never expose a shell or write action.

Acceptance:

- [ ] The tail shows at most the chosen line count.
- [ ] Loading, empty, and unavailable states are clear.
- [ ] The viewer has no input field and no exec or shell action.
- [ ] Long lines wrap or scroll without breaking the detail layout.

Files: `client/LogTail.tsx`, `client/hooks/useVmLogs.ts`, `server/logs.ts`

### 10.5 Implement detail actions and confirmations

Add start, stop, restart, delete, open host in Paseo, and copy connection details. Delete requires a confirmation that names the VM and states that the sandbox and registration are removed.

Acceptance:

- [ ] Start, stop, and restart show pending state and refresh after completion.
- [ ] Delete is disabled until the confirmation is accepted.
- [ ] Copy puts the loopback connection and host identity on the clipboard.
- [ ] Open host uses the navigation chosen in `Decide: how Open host in Paseo navigates to a routed host`.

Files: `client/VmActions.tsx`, `client/clipboard.ts`, `client/hooks/useVmActions.ts`

### 10.6 Implement the create sheet fields and validation

Build the create form for name, cpus, memory, providers, and per provider secret bindings. Use the bounds from `Decide: CPU and memory bounds and defaults` and the source keys from `Decide: provider credential source keys and allowed host defaults`. Show the standing outbound internet and blocked destination warning from DESIGN.md section 8, and expose no network settings.

Acceptance:

- [ ] Required fields validate before submit.
- [ ] The internet and blocked destination warning is always visible.
- [ ] Provider bindings come from the parent credential set, not free text secrets.
- [ ] The sheet has no network policy controls.

Files: `client/CreateVmSheet.tsx`, `client/components/SecretBindingEditor.tsx`, `shared/secrets.ts`

### 10.7 Implement create progress and failure presentation

Poll the create status and show the current named step instead of a spinner that looks hung. On failure, show the state, reason, and log tail, with retry only for the image pull case in DESIGN.md section 10.

Acceptance:

- [ ] Progress shows booting, installing, registering, and online stages.
- [ ] A failed create shows the failure state and log tail.
- [ ] Image pull failure offers retry; install and unreachable failure do not claim to retry.
- [ ] The sheet can be dismissed without losing a running create.

Files: `client/CreateVmProgress.tsx`, `client/CreateVmSheet.tsx`, `client/hooks/useCreateVm.ts`

### 10.8 Implement the reconcile banner

Show the banner when drift exists, list findings in plain language, and offer only the repairs that are safe. State clearly which items will not be touched.

Acceptance:

- [ ] The banner appears only when findings exist.
- [ ] Safe repairs call `vm.reconcile` and refresh the list.
- [ ] Missing VM and unmanaged VM findings are described as user actions, not automatic repairs.
- [ ] The banner states that reconcile does not start, stop, or delete VMs.

Files: `client/ReconcileBanner.tsx`, `client/hooks/useReconcile.ts`, `shared/drift.ts`

### 10.9 Add renderer tests for list, detail, and banner

Cover the screen states with mocked RPC responses. Include loading, empty, drift, stopped, running, and failure cases without a live daemon.

Acceptance:

- [ ] List tests cover warning markers and empty state.
- [ ] Detail tests cover stopped metrics and unavailable metrics.
- [ ] Banner tests cover safe and non-automatic findings.
- [ ] Tests run without network or a real microVM.

Files: `client/__tests__/VmList.test.tsx`, `client/__tests__/VmDetail.test.tsx`, `client/__tests__/ReconcileBanner.test.tsx`

## 11. Failure-mode handling and doctor

### 11.1 Implement `meta.doctor`

Report microsandbox runtime and SDK availability, the pinned image, parent connected-host support, and parent plugin settings support. Use the version floors from `Decide: minimum microsandbox version` and `Decide: minimum parent daemon version and requirements.paseo value`. Return structured checks with an actionable message instead of throwing.

Acceptance:

- [ ] Doctor returns one structured result per check.
- [ ] Missing runtime and missing `features.connectedHosts` are reported distinctly.
- [ ] The image pin is read from one source shared with create.
- [ ] Doctor works when the microsandbox SDK cannot be loaded.

Files: `server/doctor.ts`, `shared/doctor.ts`, `shared/rpc.ts`, `tests/server/doctor.test.ts`

### 11.2 Gate create on doctor results

Disable create when the runtime, feature floor, or image check fails, and show the actionable doctor message. Existing records must still list and open.

Acceptance:

- [ ] Create is disabled with a reason when doctor fails.
- [ ] Existing VM list and detail remain available during doctor failure.
- [ ] The reason names the failed check and the next action.
- [ ] The gate is covered by client and server tests.

Files: `client/CreateVmSheet.tsx`, `server/create.ts`, `shared/doctor.ts`

### 11.3 Normalize runtime failures into named VM states

Map image pull, boot, install, registration, online timeout, port collision, missing runtime, and missing parent feature errors to the behavior table in DESIGN.md section 10. Keep raw stack traces out of the UI and preserve a short reason code.

Acceptance:

- [ ] Every row in DESIGN.md section 10 has a mapped state and message.
- [ ] Port collision retries and does not become a terminal failure by itself.
- [ ] Missing `features.connectedHosts` refuses registration with an update message.
- [ ] Tests cover each mapping with realistic SDK errors.

Files: `server/errors.ts`, `shared/errors.ts`, `server/create.ts`, `tests/server/failure-mapping.test.ts`

### 11.4 Handle a parent that lacks connected-host support

Detect the missing feature before registration and refuse to register. The message must name the parent daemon update, and the plugin must not create a false online state.

Acceptance:

- [ ] Registration is skipped when the feature is absent.
- [ ] The VM record keeps a failure state with the feature message.
- [ ] The doctor and create sheet show the same message.
- [ ] No host registration is attempted after the refusal.

Files: `server/registration.ts`, `server/doctor.ts`, `shared/errors.ts`, `tests/server/registration.test.ts`

### 11.5 Add retry for image pull failure

Allow retry only when the create failed before any sandbox was created. Retry reuses the record and port reservation, and does not create a second record for the same attempt.

Acceptance:

- [ ] Retry is offered only for image pull failure.
- [ ] Retry uses the same record and does not allocate a second name.
- [ ] A successful retry reaches the normal create sequence.
- [ ] Repeated failures do not leak sandboxes or records.

Files: `server/create.ts`, `client/CreateVmProgress.tsx`, `tests/server/create.test.ts`

### 11.6 Add failure-path integration tests

Exercise image pull failure, install failure, online timeout, missing feature, port collision, and plugin removal with running VMs. The tests must assert user-visible messages and the absence of silent cleanup.

Acceptance:

- [ ] Each failure path leaves the documented record state.
- [ ] No failure path silently deletes a sandbox or registration.
- [ ] Plugin removal with running VMs leaves the detached VMs running.
- [ ] Tests assert log tail availability for boot and install failures.

Files: `tests/failure/failure-paths.test.ts`, `tests/failure/fake-runtime.ts`
blocked by: 1, 2, 3

## 12. Docs and OVERVIEW.md

### 12.1 Write the user facing OVERVIEW.md

Write a short overview of what the plugin does, how a VM becomes a host, the create and lifecycle flow, the network limits, and the v1 non-goals. Link to DESIGN.md sections for detail instead of restating the design.

Acceptance:

- [ ] The overview explains routed hosts and the one-hop limit in plain language.
- [ ] It lists the v1 non-goals from DESIGN.md section 2.
- [ ] It states the outbound internet requirement and blocked destinations.
- [ ] It does not change README.md or DESIGN.md.

Files: `OVERVIEW.md`

### 12.2 Write the install and operations guide

Document parent requirements, plugin installation, runtime checks, first VM creation, autoStart, stop and delete behaviour, and plugin removal with running VMs. Use the version floors and image digest from the decisions. Include the doctor checks and the expected failure states.

Acceptance:

- [ ] The guide lists parent daemon features, microsandbox requirements, and image pinning.
- [ ] It explains what survives plugin reload, disable, and daemon restart.
- [ ] It explains the destructive scope of delete and plugin removal.
- [ ] Commands are copy-pasteable and contain no real credentials.

Files: `docs/INSTALL.md`, `docs/OPERATIONS.md`

### 12.3 Write the troubleshooting guide

Map the DESIGN.md section 10 failure table to symptoms, log locations, doctor output, and user actions. Include secret substitution failures and the difference between a bad credential and an interception failure.

Acceptance:

- [ ] Every failure row has a symptom and a next action.
- [ ] The guide points to the log tail as the first debugging surface.
- [ ] Reconcile drift classes and safe repairs are documented.
- [ ] Secret redaction limits and placeholder diagnostics are documented.

Files: `docs/TROUBLESHOOTING.md`

### 12.4 Write the RPC and settings reference

Document the shared RPC contracts and the `vms` settings document from the schemas, including versioning and conflict behaviour. Note that the settings document is not a credential vault.

Acceptance:

- [ ] Every RPC in DESIGN.md section 9 is listed with request and response fields.
- [ ] The `VmRecord` fields and secret binding fields are listed.
- [ ] Revision conflicts and migration behaviour are explained.
- [ ] The document links to the shared schema files as the source of truth.

Files: `docs/RPC.md`, `docs/SETTINGS.md`

### 12.5 Write the architecture map

Add a short module map that connects `client/`, `server/`, and `shared/` to DESIGN.md sections 3 through 9. This is for contributors and should not duplicate the full design.

Acceptance:

- [ ] Each module has one responsibility and a DESIGN.md section reference.
- [ ] The document explains why there is no server to client push.
- [ ] It names the routed host path and the parent as the only network path.
- [ ] It links to OVERVIEW.md and DESIGN.md.

Files: `docs/ARCHITECTURE.md`

## Needs decision

These decisions are not settled by DESIGN.md. Record each answer in a short note under `docs/decisions/` before starting a task that depends on it. Do not implement a guessed answer.

### Decide: parent identity used in registration labels

DESIGN.md section 4 requires `<parent>/<sandbox-N>`, but the source of the parent part is not specified. Choose a stable, unique, human readable value and define collision handling.

Acceptance:

- [ ] The decision names the source, for example hostname, daemon id, or user alias.
- [ ] It defines normalization and a fallback when the source is empty.
- [ ] It defines what happens when two parents produce the same label.
- [ ] The note is linked from the record factory task.

Files: `docs/decisions/parent-identity.md`

### Decide: when the VmRecord is persisted during create

DESIGN.md section 5 writes the record at step 10 but also requires a named state after any failed step. Choose whether the record is persisted before boot, in memory until ready, or in a separate in-flight structure.

Acceptance:

- [ ] The decision defines when the record first appears in `vm.list`.
- [ ] It defines which states are visible to the screen.
- [ ] It defines cleanup rules for a failed create.
- [ ] It keeps names and ports from being reused after failure.

Files: `docs/decisions/create-record-timing.md`

### Decide: provider credential source keys and allowed host defaults

The create sheet selects providers and DESIGN.md section 6 uses a `source` key, but the key format and the default allowed hosts per provider are not defined. Choose a mapping or require explicit values for every binding.

Acceptance:

- [ ] The decision defines the `source` key format.
- [ ] It defines default allowed hosts per supported provider.
- [ ] It defines how an unsupported provider is handled.
- [ ] It does not put credentials in the plugin UI.

Files: `docs/decisions/provider-sources.md`

### Decide: secret substitution defaults per provider

DESIGN.md section 6 allows header substitution by default and query or body only when enabled. Choose the per provider defaults and the placeholder allowance policy.

Acceptance:

- [ ] The decision defines query and body defaults per provider.
- [ ] It defines which destinations receive the untouched placeholder.
- [ ] It defines the violation action for a blocked placeholder.
- [ ] It records the HTTP/2 body limitation as a known constraint.

Files: `docs/decisions/substitution-defaults.md`

### Decide: how the plugin reads parent provider credentials

DESIGN.md section 6 says credentials come from the parent's provider credentials and environment but does not name the read path. Choose the supported source and the error behaviour when it is absent.

Acceptance:

- [ ] The decision names the API, environment source, or both.
- [ ] It defines precedence when both exist.
- [ ] It defines the error shown when a source is missing.
- [ ] It confirms values are never written to the settings document.

Files: `docs/decisions/provider-credential-read.md`

### Decide: log tail source and line count

DESIGN.md section 8 allows `sandbox.logs()` or a bounded `logStream()` and leaves the line count open. Choose one source, one line count, and the refresh behaviour.

Acceptance:

- [ ] The decision names the source API and fallback.
- [ ] It sets the maximum lines per request.
- [ ] It defines refresh with the status poll or a bounded follow mode.
- [ ] It keeps the viewer read only.

Files: `docs/decisions/log-tail.md`

### Decide: status poll interval and metrics cache window

DESIGN.md section 7 samples metrics at most once per poll window, but the interval is not set. Choose the screen poll interval and the matching server cache window.

Acceptance:

- [ ] The decision sets one interval for the mounted screen.
- [ ] It sets the server cache window and behaviour under concurrent callers.
- [ ] It defines backoff after repeated errors.
- [ ] It keeps polling scoped to a watching client.

Files: `docs/decisions/polling.md`

### Decide: sandbox name numbering after settings document loss

DESIGN.md section 10 says numbers are not reused, but a lost settings document also loses the counter. Choose a recovery source, such as the highest observed label or a separate durable counter.

Acceptance:

- [ ] The decision defines how the next name is chosen after a reset.
- [ ] It prevents reusing a name seen in any observed sandbox.
- [ ] It defines behaviour when observed labels are malformed.
- [ ] It keeps labels unique per parent.

Files: `docs/decisions/name-recovery.md`

### Decide: adoption semantics for unmanaged sandboxes

DESIGN.md section 4 offers adopt or remove for an unmanaged sandbox, but an adopted sandbox has no record fields such as password, port, or bindings. Choose what adoption means in v1 or defer adoption explicitly.

Acceptance:

- [ ] The decision either defines the adopted record fields or removes adoption from v1.
- [ ] It states how an adopted VM is verified before it is registered.
- [ ] It defines what happens when required fields cannot be recovered.
- [ ] It keeps remove as an explicit user action.

Files: `docs/decisions/adoption.md`

### Decide: loopback port range and reservation policy

DESIGN.md section 5 requires a free loopback port but does not set a range or reservation policy. Choose the range, the probe method, and whether reservations survive a plugin reload or settings reset.

Acceptance:

- [ ] The decision defines the port range and exclusions.
- [ ] It defines retry limits and collision behaviour.
- [ ] It defines reservation ownership across reload and reset.
- [ ] It defines the error when no port is free.

Files: `docs/decisions/port-allocation.md`

### Decide: minimum parent daemon version and requirements.paseo value

DESIGN.md section 11 makes connected hosts and the plugin settings API the parent floor but does not name a version. Choose the exact `requirements.paseo` value and the feature checks that enforce it.

Acceptance:

- [ ] The decision names the minimum parent daemon version.
- [ ] It maps each required feature to the version that introduced it.
- [ ] It defines the message shown when the parent is too old.
- [ ] The value is used by the manifest, doctor, and install guide.

Files: `docs/decisions/parent-version.md`

### Decide: minimum microsandbox version

DESIGN.md section 11 requires the microsandbox version that introduced `.script`, `.secret`, `.portBind`, `.detached`, and `allSandboxMetrics` but does not name it. Choose the exact minimum and how the plugin detects it.

Acceptance:

- [ ] The decision names the minimum runtime and SDK version.
- [ ] It defines the doctor check for the version.
- [ ] It defines behaviour when the runtime is present but too old.
- [ ] It records the platform support limits from DESIGN.md section 11.

Files: `docs/decisions/microsandbox-version.md`

### Decide: initial guest image digest and update policy

DESIGN.md section 11 requires the official image pinned by digest but does not provide the digest or an update policy. Choose the initial pin and how a digest change ships in v1.

Acceptance:

- [ ] The decision records the full image reference with digest.
- [ ] It defines the single source of truth used by create and doctor.
- [ ] It defines whether users can change the pin in v1.
- [ ] It records how a pin update is verified against the Pi install.

Files: `docs/decisions/image-pin.md`

### Decide: CPU and memory bounds and defaults

The create sheet needs cpu and memory inputs, but DESIGN.md does not set allowed ranges or defaults. Choose bounds that the runtime accepts and defaults that fit the supported platforms.

Acceptance:

- [ ] The decision defines minimum, maximum, and default cpu and memory values.
- [ ] It defines validation messages for out of range values.
- [ ] It keeps values representable in `VmRecord`.
- [ ] The schema and create sheet use the same constants.

Files: `docs/decisions/vm-size.md`

### Decide: boot, install, and online timeouts

DESIGN.md section 5 waits for boot, install, and online, but does not set timeouts. Choose per step timeouts and the user-visible behaviour when one expires.

Acceptance:

- [ ] The decision defines a timeout for boot, Pi install, and routed online.
- [ ] It defines whether a timeout is retryable.
- [ ] It defines the failure state for each timeout.
- [ ] The create state machine and registration wait use the same values.

Files: `docs/decisions/timeouts.md`

### Decide: Node provisioning fallback if assumption 1 fails

DESIGN.md section 12 says the install script must provide Node if the image lacks a suitable version. Choose the source, install location, and verification for that fallback.

Acceptance:

- [ ] The decision is taken only after spike 1.1 fails.
- [ ] It defines the Node source and checksum.
- [ ] It installs for the `paseo` user without changing the image.
- [ ] It defines the check that Pi resolves after the fallback install.

Files: `docs/decisions/node-fallback.md`

### Decide: how Open host in Paseo navigates to a routed host

DESIGN.md section 8 lists an open host action, but the app navigation and deep link surface are not specified. Choose a supported route or hide the action when no route is available.

Acceptance:

- [ ] The decision names the navigation API or route.
- [ ] It defines behaviour when the routed host is offline.
- [ ] It defines a fallback action, such as copy connection details.
- [ ] It does not require a second parent connection.

Files: `docs/decisions/open-host.md`

### Decide: fallback when the parent has no registration removal API

Delete and stale-registration repair both need to remove a registration. If the probe in task 6.3 finds no supported removal API, choose the fallback or stop and revise the design.

Acceptance:

- [ ] The decision is taken after the removal probe.
- [ ] It defines the supported removal path or blocks delete and repair.
- [ ] It never edits parent host state through an unsupported private format.
- [ ] It records the user-visible limitation if removal is unavailable.

Files: `docs/decisions/registration-removal.md`

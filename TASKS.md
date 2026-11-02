# Implementation tasks

Tasks for the v1 design in DESIGN.md, in dependency order. Each task is sized to land as one PR; anything bigger is split.

Conventions:

- Section numbers in parentheses, like (section 5), refer to DESIGN.md.
- "blocked by: N" means the task depends on assumption N from DESIGN.md section 12. Do not start it until the matching spike in section 1 below records an outcome, and do not assume the answer.
- "Depends on:" points to a task in this file that should land first.
- File paths are proposals, not a fixed layout. Plugin code lives under `client/`, `server/`, and `shared/`.

## 1. Verification spikes

Each spike is a throwaway script under `scripts/spike/` that records its outcome in `docs/spikes/NN-<slug>.md`. A pass records the evidence: versions, timings, log excerpts. A fail records what was observed and what it changes for the tasks below. Spikes 1.3 to 1.6 need a parent daemon with connected host support and a dev-build plugin (tasks 2.1 and 2.2) or a throwaway plugin.

### 1.1 Verify the image ships Node >= 22.19 and npm

Scope: create a short-lived detached sandbox from the pinned official image with a script that prints `node --version`, `npm --version`, and `which node`, and read the output from `sandbox.logs()`. This checks assumption 1 of section 12.

Acceptance:

- The log shows a Node version >= 22.19 and an npm version, captured in the outcome note.
- If Node or npm is missing or older than 22.19, the outcome note records what the Pi install script must provide first.

Files: `scripts/spike/01-node-in-image.mjs`, `docs/spikes/01-node-in-image.md`.

### 1.2 Verify init("auto") keeps the guest daemon alive

Scope: create a sandbox from the pinned image with `init("auto")`, `detached(true)`, and a published loopback port, then probe the guest daemon on that port every 30 seconds for 5 minutes. This checks assumption 2 of section 12: that PID 1 is the image entrypoint and the daemon stays reachable after the entrypoint drops privileges to `paseo`.

Acceptance:

- The daemon answers on the published port on every probe across the 5 minute window, including after the entrypoint privilege drop.
- The sandbox log shows no daemon restart and the daemon process running as the non-root user.
- If it fails, the outcome note records what PID 1 actually is and what keeps (or fails to keep) the daemon alive.

Files: `scripts/spike/02-init-auto.mjs`, `docs/spikes/02-init-auto.md`.

### 1.3 Verify hosts.add() from a plugin server handler

Scope: add a temporary test RPC to the dev-build plugin that creates a VM with a running guest daemon (reusing the 1.2 setup), calls `hosts.add({ connection: "127.0.0.1:<port>", label, metadata, sourceKey })`, then polls `hosts.list()` for 2 minutes. This checks both halves of assumption 3 of section 12: callability from a plugin server handler, and reaching online without an app restart.

Depends on: 2.1, 2.2

Acceptance:

- The registration appears in `hosts.list()` and reaches online within the poll window.
- An app connected to the parent lists the child without an app or daemon restart.
- If either half fails, the outcome note records the exact error or the stuck status.

Files: `scripts/spike/03-hosts-add.mjs`, a temporary test RPC under `server/`, `docs/spikes/03-hosts-add.md`.

### 1.4 Verify providers.refresh() picks up a freshly installed Pi

Scope: extend the 1.3 VM by installing Pi as the `paseo` user (`npm install -g --ignore-scripts @earendil-works/pi-coding-agent`), confirm `pi --version` from the install log, then call `providers.refresh()` through `paseo.hosts.client(childId)` and fetch the child's provider and agent list. This checks assumption 4 of section 12.

Depends on: 1.3

Acceptance:

- After refresh, the agent list includes pi with no guest daemon restart.
- If pi only appears after a restart, or refresh is not callable, the outcome note records which.

Files: `scripts/spike/04-providers-refresh.mjs`, `docs/spikes/04-providers-refresh.md`.

### 1.5 Verify concurrent published loopback ports

Scope: on a single parent, create 4 detached VMs, each with its own published loopback port allocated the way the allocator will do it (bind check, release, reserve). Probe all 4 ports concurrently, stop one, measure how long the host takes to rebind the freed port, then restart the VM on the same port. This checks assumption 5 of section 12.

Acceptance:

- All 4 ports are reachable at the same time.
- The freed port is rebindable on the host within 10 seconds of stop, with the actual timing recorded.
- The restarted VM is reachable on its original port.
- If it fails, the outcome note records which port misbehaved and how long the port stayed held.

Files: `scripts/spike/05-ports-concurrent.mjs`, `docs/spikes/05-ports-concurrent.md`.

### 1.6 Verify detached survival and reattach

Scope: create a detached VM and register it on the parent (reusing 1.3), then restart the parent Paseo daemon. After the restart, call `Sandbox.get(name)`, check the sandbox state, probe the guest daemon port, and check the registration in `hosts.list()`. This checks assumption 6 of section 12.

Depends on: 1.3

Acceptance:

- `Sandbox.get(name)` returns the running sandbox after the daemon restart.
- The guest daemon still answers and the registration still resolves.
- Anything that did not survive is recorded in the outcome note.

Files: `scripts/spike/06-reattach.mjs`, `docs/spikes/06-reattach.md`.

## 2. Plugin scaffold and RPC skeleton

### 2.1 Scaffold the plugin package

Scope: create `paseo-plugin.json` with the entry points and the `requirements.paseo` floor: connected host support (`features.connectedHosts`) plus the plugin settings API, per section 11. Add `index.client.tsx` and `index.server.ts` that load with no user-visible surface yet. Verify the plugin loads in a dev parent daemon.

Acceptance:

- The plugin loads without errors on a parent that has both floor features.
- `paseo-plugin.json` names both floor requirements.
- Both entry points export the modules the plugin API expects.

Files: `paseo-plugin.json`, `index.client.tsx`, `index.server.ts`.

### 2.2 Define the shared RPC contracts and register handlers

Scope: define all nine RPCs from section 9 as Zod schemas in `shared/`, with request and result types, including the record state values `booting`, `installing`, `registering`, `online`, and `failed:<reason>` from section 5. Register a handler for each RPC in the server entry point that returns a typed "not implemented" result.

Acceptance:

- Every RPC in section 9 has a contract and a registered handler.
- Calling any RPC returns the typed not-implemented result, not an exception.
- The contracts compile from both entry points.

Files: `shared/rpc.ts`, `index.server.ts`.

## 3. Settings document and record model

### 3.1 Define the record and settings schemas

Scope: add the Zod schema for the versioned host-scoped settings document with id `vms`, and the `VmRecord` type from section 4, including `secretBindings`, `registeredHostId`, `autoStart`, and `createdAt`. The schema validates the full document shape.

Acceptance:

- A malformed record is rejected with a readable error, verified against a bad fixture.
- The `VmRecord` fields match section 4 field for field.
- The schemas import cleanly from both entry points.

Files: `shared/settings.ts`.

### 3.2 Implement the server settings store

Scope: load, read, and save the settings document through `defineSettings` with revision-checked atomic writes, per section 4. Expose a small module API for later tasks: list records, upsert a record, remove a record, where each save carries the revision from the read.

Acceptance:

- A save with a stale revision fails without writing.
- Two sequential saves do not lose a record.
- A missing document loads as an empty record list, not an error.

Files: `server/settings.ts`.

## 4. VM lifecycle (create, start, stop, restart, delete)

### 4.1 Allocate and reserve loopback ports

Scope: implement port allocation on the server: pick a candidate loopback port, verify it is free by binding and releasing it, and keep it reserved in the record until the VM owns it. Retry with the next candidate on a bind failure. The retry and wait behavior follows the release timing recorded by spike 1.5.

blocked by: 5

Acceptance:

- Every allocated port was bound-checked before it was returned.
- Two sequential allocations do not return the same port while the first is reserved.
- A deliberately occupied port is skipped, not returned.

Files: `server/ports.ts`.

### 4.2 Build and boot a sandbox

Scope: wrap the builder call from step 3 of section 5: pinned image, cpus, memory, `portBind` on the allocated port, label `paseo-msb=<id>`, `init("auto")`, `detached(true)`. Write the record in state `booting` at the start of the sequence, wait for boot with a timeout, and store the image pin in the record.

blocked by: 2

Acceptance:

- A created sandbox appears in `Sandbox.list()` with the `paseo-msb` label.
- A boot timeout lands the record in a named failed state with the log tail available, not a hang.
- The state moves through `booting` observably.

Files: `server/sandbox.ts`, `server/settings.ts`.

### 4.3 Implement start, stop, and restart

Scope: implement the three actions from section 5. Start is SDK start, then re-register if the registration was lost, then wait for online. Stop is SDK stop, and the registration stays. Restart is SDK restart, wait for online. Each action updates the record state and is idempotent against an already running or already stopped sandbox. The re-register call lands with task 6.1; until then the start path reports a lost registration as drift instead.

Depends on: 3.2, 6.1 (re-register part)

Acceptance:

- Starting a running VM is a no-op that returns the current state.
- Stopping a VM leaves its registration in place and the host offline.
- Restart ends online or in a named failed state.

Files: `server/lifecycle.ts`.

### 4.4 Implement delete

Scope: implement the delete sequence from section 5: stop, remove the sandbox, remove the registration (no-op if absent), remove the record. Destructive and always explicit; the confirmation UI is task 10.3.

Depends on: 3.2, 6.1

Acceptance:

- After delete, the record, sandbox, and registration are all gone.
- Deleting a record whose sandbox is missing still clears the record and the registration.
- The port is no longer reserved.

Files: `server/lifecycle.ts`, `server/ports.ts`.

### 4.5 AutoStart and reattach on plugin load

Scope: on server init, attach to existing sandboxes with `Sandbox.get(name)` for records whose sandbox still exists, and start records with `autoStart` that are not running, per section 5. The behavior follows the outcome of spike 1.6 on what survives a daemon restart.

blocked by: 6

Acceptance:

- After a daemon restart, a running autoStart VM is detected as already running, not started twice.
- A stopped autoStart VM is started on load.
- A missing sandbox is left alone here; the reconcile pass (section 9) reports it.

Files: `server/lifecycle.ts`, `index.server.ts`.

### 4.6 Wire the vm.create sequence

Scope: implement the `vm.create` handler that runs the steps of section 5 in order: allocate port, write the record in state `booting`, build and boot, install Pi, register, wait for online, refresh providers, update the record to ready. The handler updates the record state at each step, so a failure at any step leaves the record in a named state with the log tail available. Progress reporting follows decision 13.4.

Depends on: 4.1, 4.2, 5.1, 6.1, 6.2, 5.2

Acceptance:

- A successful create ends with the record in `online`, the registration stored, and the port reserved.
- A failure at each step lands the record in the named state for that step, with the log tail available.
- The state sequence `booting`, `installing`, `registering`, `online` is observable while create runs.

Files: `server/lifecycle.ts`, `shared/rpc.ts`.

## 5. Pi install and provider readiness

### 5.1 Run the Pi install in the guest

Scope: implement steps 5 and 6 of section 5: run `npm install -g --ignore-scripts @earendil-works/pi-coding-agent` as the image's non-root `paseo` user through the `install-pi` builder script, and confirm Pi resolves on the daemon user's PATH before registration proceeds. How the install runs as `paseo` follows spike 1.2, and any Node provisioning follows spike 1.1.

blocked by: 1, 2

Acceptance:

- After the install, `pi` resolves from the `paseo` user's PATH, verified from the guest log.
- The npm global prefix is not under `/root`.
- A failed install lands the record in `failed:install` with the log tail, and no registration is attempted.

Files: `server/pi-install.ts`, `server/sandbox.ts`.

### 5.2 Make the provider list pick up the new Pi

Scope: implement step 9 of section 5: after the routed host is online, call `providers.refresh()` through `paseo.hosts.client(childId)` so the new host's agent list includes Pi immediately. Follow the behavior recorded by spike 1.4, including whether a refresh is needed at all.

blocked by: 3, 4

Depends on: 6.1, 6.2

Acceptance:

- After create completes, the child's agent list includes pi with no guest daemon restart.
- A refresh failure does not fail create; it is surfaced in the record state or the log.

Files: `server/register.ts`.

## 6. Host registration and routed-host verification

### 6.1 Register the VM host on the parent

Scope: implement step 7 of section 5: call `hosts.add` with connection `127.0.0.1:<published port>`, the frozen label, metadata `{ source: "paseo-msb", vm: <id> }`, and `sourceKey` set to the record id, per sections 3 and 4. Store the returned registration id in the record's `registeredHostId`. Follow the outcome of spike 1.3.

blocked by: 3

Acceptance:

- After register, the record has a non-null `registeredHostId`.
- The registration on the parent carries the metadata and sourceKey exactly as specified.
- A failed `hosts.add` lands the record in a named failed state, not a silent miss.

Files: `server/register.ts`.

### 6.2 Verify the routed host comes online

Scope: implement step 8 of section 5 and the "Host unreachable" drift class from section 4: poll for the routed host to report online after register, with a timeout, and surface the registration error text on timeout. Expose the connection string and registration identity for the `vm.connection` RPC.

blocked by: 3

Depends on: 6.1

Acceptance:

- Create proceeds to ready only when the host reports online, or a timeout lands the record in `failed:unreachable`.
- On failure, the registration error text is available in the record state or the detail RPC.
- `vm.connection` returns the connection string and registration identity for an online VM.

Files: `server/register.ts`, `shared/rpc.ts`.

## 7. Secrets binding

### 7.1 Build microsandbox secrets from bindings

Scope: construct the secret configuration from a record's `secretBindings` per section 6: env var name, allowed hosts, substitution locations, and `.allowPlaceholderFor(...)` for destinations that receive the untouched placeholder. Values come from the parent's provider credentials, never from a UI field. The parent credential API is an open item, see 13.6.

Acceptance:

- For a given binding, the generated secret config matches the binding field for field.
- No real value is written to host side sandbox configuration from a UI field.
- The configuration enables TLS interception, per section 6.

Files: `server/secrets.ts`.

### 7.2 Verify substitution end to end

Scope: a scripted check that a provider request through a running VM is substituted with the real value, that a non-allowed host gets no substitution, and that the microsandbox CA is in the guest trust store. This is the least proven area of the design (section 13), so it lands as its own PR.

Depends on: 7.1, 5.2

Acceptance:

- A request to an allowed host carries the real credential; a request to a non-allowed host does not.
- The guest environment shows a placeholder, and the real value appears only in transit.
- The microsandbox CA is present in the guest trust store.

Files: `scripts/spike/secrets-e2e.mjs`, `server/secrets.ts`.

## 8. Metrics polling

### 8.1 Sample metrics and merge them into status responses

Scope: sample `allSandboxMetrics()` at most once per poll window on the server while a client is watching, and merge the map with the records and `Sandbox.list()` in the `vm.list` and `vm.detail` responses, per section 7. A missing key means the sandbox is not running and renders as "no metrics" with the record's last known state. Nothing per VM is cached.

Depends on: 3.2, 4.3

Acceptance:

- `vm.list` returns one row per record with merged observed state and metrics.
- A stopped VM shows "no metrics", not an error.
- Two polls in one window do not call `allSandboxMetrics()` twice.

Files: `server/metrics.ts`, `server/status.ts`.

## 9. Reconcile pass

### 9.1 Detect drift across the five classes

Scope: compare the records, `Sandbox.list()` filtered by the `paseo-msb` label, and `hosts.list()` filtered by the plugin metadata, to produce the five drift findings from the section 4 table. Detection is read-only.

Depends on: 3.2, 6.1

Acceptance:

- Each of the five drift classes has a fixture that produces exactly that finding.
- A healthy record/sandbox/registration triple produces no finding.
- Matching uses the sandbox label and the registration metadata, not the settings document alone.

Files: `server/reconcile.ts`.

### 9.2 Implement the automatic repairs

Scope: implement the two automatic repairs from section 4: re-register for "Unregistered", remove the registration for "Stale host". Repairs run inside a reconcile call and report what changed. Destructive outcomes (record deletion, unmanaged VM removal) are never automatic; they stay explicit user actions for the screen.

Depends on: 9.1, 6.1

Acceptance:

- An "Unregistered" finding is repaired by a reconcile call, and the record's `registeredHostId` is updated.
- A "Stale host" finding removes the registration and leaves the record untouched.
- No repair starts, stops, or deletes a VM.

Files: `server/reconcile.ts`, `server/register.ts`.

### 9.3 Expose reconcile through the RPC and the poll

Scope: wire `vm.reconcile` and include findings in the status that `vm.list` and `vm.detail` return while the screen polls, per sections 5 and 9. Adopting an unmanaged VM (recording it) is a user action that fills the record from observed state; which fields an adopted record fills is open, see 13.7.

Depends on: 9.2

Acceptance:

- `vm.reconcile` returns the findings and the repairs it applied.
- Findings appear in the poll response while the screen is mounted.
- Adoption writes a record from the observed sandbox state.

Files: `server/reconcile.ts`, `server/settings.ts`, `shared/rpc.ts`.

## 10. Management screen (list, detail, log tail, create sheet, reconcile banner)

### 10.1 Register the screen and shell

Scope: register the single master/detail screen with `addScreen`, the sidebar header item, and the Command Center items, per section 8. Set up the status poll loop that runs while the screen is mounted; the interval is open, see 13.1. No workspace panel.

Depends on: 2.1, 2.2

Acceptance:

- The screen is reachable from the sidebar header and from Command Center.
- The poll starts on mount and stops on unmount.
- The screen renders an empty record list without an error.

Files: `client/screen.tsx`, `index.client.tsx`.

### 10.2 Build the list view

Scope: one row per record with label, state, cpu, memory, and uptime from the merged `vm.list` response. Rows whose sandbox is missing or whose registration is stale carry an inline warning marker, per section 8. Row selection loads the detail pane.

Depends on: 8.1, 9.3

Acceptance:

- Each record renders exactly one row with the five fields.
- A missing sandbox and a stale registration each show a warning marker.
- Selecting a row loads the detail.

Files: `client/list.tsx`.

### 10.3 Build the detail pane

Scope: identity fields (label, sandbox name, image pin, cpus, memory, published port), live metrics (cpu, memory, disk and network rates, uptime), and the actions start, stop, restart, delete, open host in Paseo, copy connection details, per section 8. The "open host in Paseo" mechanism is open, see 13.5. No Pi install or refresh button in v1.

Depends on: 10.1, 8.1

Acceptance:

- All identity and metric fields render from `vm.detail`.
- Each action calls its RPC and the list and detail reflect the new state.
- Delete asks for explicit confirmation and shows the removal notice from section 10 before it completes.

Files: `client/detail.tsx`.

### 10.4 Build the log tail

Scope: a read-only last N lines view from `sandbox.logs()` or a bounded `logStream()` in the detail pane, per section 8. N is open, see 13.2. This is the only debugging surface for boot, npm, bind, and provider failures, so it must work for `failed:*` states without the VM being online.

Depends on: 10.3

Acceptance:

- The log tail renders for an online VM and for a `failed:install` VM.
- The view is bounded and read-only.
- The `vm.detail` contract carries the log tail lines.

Files: `client/logs.tsx`, `shared/rpc.ts`.

### 10.5 Build the create sheet

Scope: form fields for name, cpus, memory, providers, and per provider secret bindings, plus the standing warning that the Pi install needs outbound internet and that microsandbox blocks private, loopback, link-local, and cloud metadata destinations, per section 8. On submit, call `vm.create` and track progress per decision 13.4.

Depends on: 10.1

Acceptance:

- Submitting a valid form calls `vm.create` with the full record draft.
- The warning text is always visible in the sheet.
- A failed create shows the named failed state and the path to the log tail.

Files: `client/create-sheet.tsx`.

### 10.6 Build the reconcile banner

Scope: a banner at the top of the screen when drift exists, listing the findings, offering the safe repairs, and stating plainly what will not be touched, per section 8. User-action repairs (record deletion, adoption, unmanaged removal) call their RPCs from the banner.

Depends on: 10.1, 9.3

Acceptance:

- The banner is visible exactly when findings exist.
- Each safe repair offered maps to a reconcile repair, and each user action maps to an explicit RPC.
- The banner states which findings are not repaired automatically.

Files: `client/banner.tsx`.

## 11. Failure-mode handling and doctor

### 11.1 Implement meta.doctor

Scope: check microsandbox runtime availability and version, including the features `.script`, `.secret`, `.portBind`, `.detached`, and `allSandboxMetrics` (section 11), the image pin, and parent feature support including `features.connectedHosts`, and return a structured report.

Depends on: 2.2

Acceptance:

- Each check returns pass or fail with an actionable message.
- A missing or too old runtime names what is missing.
- The feature floor is checked against the parent daemon, not the app.

Files: `server/doctor.ts`, `shared/rpc.ts`.

### 11.2 Enforce the create failure states

Scope: enforce the create rows of the section 10 failure table in the create flow. An image pull failure fails with the pull error and a retry action, per that table. A boot-time npm failure lands in `failed:install` with the host unregistered. A daemon that never reaches online keeps the registration and lands in `failed:unreachable` with the registration error text. Every named state keeps the log tail available.

Depends on: 4.2, 5.1, 6.2

Acceptance:

- An image pull failure surfaces the pull error and a retry action, per the failure table.
- A boot-time install failure lands in `failed:install`, leaves the host unregistered, and keeps the log tail.
- A daemon that never reaches online keeps the registration and lands in `failed:unreachable` with the registration error text surfaced.

Files: `server/lifecycle.ts`, `server/pi-install.ts`, `server/register.ts`.

### 11.3 Surface runtime and feature failures in the screen

Scope: with the microsandbox runtime missing or too old, disable create with an actionable `meta.doctor` message and keep existing records listing (first row of the section 10 table). If the parent lacks `features.connectedHosts`, the plugin refuses to register and says the parent daemon needs updating (fifth row of the section 10 table).

Depends on: 11.1, 10.2

Acceptance:

- Without a runtime, create is disabled with the doctor message, and the list still renders records.
- Without `features.connectedHosts`, no registration is attempted, and the message names the missing feature.

Files: `client/screen.tsx`, `client/detail.tsx`, `server/doctor.ts`.

## 12. Docs and OVERVIEW.md

### 12.1 Write OVERVIEW.md

Scope: user-facing docs: what the plugin does, the prerequisites (parent daemon features, microsandbox runtime and version floor, pinned image, per section 11), how to use the screen, the create flow, what the reconcile banner means, and the v1 non-goals from section 2. Land near the end of the sequence, once the screen and failure handling are in place.

Depends on: 10.6, 11.3

Acceptance:

- Every prerequisite in section 11 is listed with its feature or version floor.
- The screen walkthrough matches the shipped screen: list, detail, log tail, create sheet, banner.
- The non-goals list matches section 2.

Files: `OVERVIEW.md`.

## 13. Needs decision

These are left undecided in DESIGN.md and a task needs the answer. Each is a small PR that records the decision in `docs/decisions.md` and adjusts the affected task if the answer changes its scope.

### 13.1 Decide: what is the status poll interval for the management screen

Scope: settle the interval at which the management screen polls the status RPC while mounted, and the matching "at most once per poll window" metrics sampling window from section 7. Needed by tasks 8.1 and 10.1.

Acceptance:

- The interval is written down with a one line rationale (latency versus load on the parent).
- The decision note references section 5 of DESIGN.md.

Files: `docs/decisions.md`.

### 13.2 Decide: how many lines does the log tail keep

Scope: settle N, the line count for the read-only log tail in the detail pane (section 8 says "last N lines" without a value). Needed by task 10.4.

Acceptance:

- N is written down with a rationale (usefulness versus RPC payload size).
- The decision note references section 8 of DESIGN.md.

Files: `docs/decisions.md`.

### 13.3 Decide: which digest to pin for the official image

Scope: settle the exact digest of `ghcr.io/getpaseo/paseo` to pin (sections 5 and 11 require a digest pin without naming one). Needed by tasks 4.2, 11.1, and 7.2, and by all spikes that build a sandbox.

Acceptance:

- The pinned digest is written down, including how it was chosen or re-verified.
- The decision note references section 11 of DESIGN.md.

Files: `docs/decisions.md`.

### 13.4 Decide: does vm.create block until the sequence finishes, or return immediately

Scope: section 9 says create progress is "reported by polling" but does not say whether `vm.create` returns immediately with progress visible in `vm.detail`, or stays open until the sequence completes. The answer shapes the contract in task 2.2 and the create sheet progress UI in task 10.5. Needed by tasks 2.2 and 10.5.

Acceptance:

- The chosen behavior is written down, including what the client polls while create runs.
- The decision note references section 9 of DESIGN.md.

Files: `docs/decisions.md`.

### 13.5 Decide: how does "open host in Paseo" work from a plugin

Scope: the detail action "open host in Paseo" (section 8) has no defined mechanism for switching the app to the child host. Needed by task 10.3.

Acceptance:

- The mechanism (or its absence in v1, with the action dropped or replaced) is written down.
- The decision note references section 8 of DESIGN.md.

Files: `docs/decisions.md`.

### 13.6 Decide: which API exposes the parent provider credentials

Scope: section 6 says credentials come from the parent's configured provider credentials and environment, but does not name the plugin API or its shape. Needed by task 7.1.

Acceptance:

- The API, its shape, and how a binding `source` key maps into it are written down.
- The decision note references section 6 of DESIGN.md.

Files: `docs/decisions.md`.

### 13.7 Decide: what does an adopted record fill in

Scope: adopting an unmanaged VM (section 4) has no defined fields, including how a record handles the daemon password it did not generate and how its name continues the monotonic numbering. Needed by task 9.3.

Acceptance:

- The adopted record's fields, including password and naming behavior, are written down.
- The decision note references section 4 of DESIGN.md.

Files: `docs/decisions.md`.

### 13.8 Decide: how is the plugin removal notice surfaced

Scope: the last row of the section 10 failure table says the screen should state that detached VMs keep running when the plugin is removed, but a plugin cannot speak while its own removal completes. Needed by task 11.3.

Acceptance:

- The chosen surface (screen text, docs, or core plugin removal flow) is written down.
- The decision note references section 10 of DESIGN.md.

Files: `docs/decisions.md`.

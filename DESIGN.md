# paseo-msb: VM-backed Paseo hosts

A Paseo parent-daemon plugin that creates, names, sizes, lists, inspects, repairs, and deletes microsandbox VMs running Paseo with the selected agent providers. Children appear in Paseo's normal host picker under the name chosen at creation. All lifecycle management happens through the plugin's Paseo UI, not the `msb` CLI.

## 1. V1.1 scope

V1.1 has seven user flows:

1. **Manage credentials**: add, replace, or remove values for six fixed names in the plugin's shared store. The UI never displays a stored value.
2. **Create**: optionally name the VM, select CPU, RAM, and root-disk size, select providers and integrations, and confirm a fixed image. Secrets decide which options are selectable; the selection decides which credentials enter the child. An omitted name keeps the generated `paseo-<requestId>` identity.
3. **Use**: watch creation and provisioning progress, then open the child through Paseo's normal host UI under its chosen name.
4. **Inspect**: watch live CPU, memory, root-disk data, and network metrics in the child detail, refreshed every 3 seconds while the detail is visible.
5. **Resize**: inspect and change RAM and root-disk size for an existing child. Root disks only grow. A change the runtime cannot apply live reports that a restart is required; the user may then confirm one restart-and-apply action.
6. **Repair**: resume interrupted setup, restore a missing registration, or remove a confirmed stale plugin-owned registration.
7. **Delete**: confirm in Paseo, destroy the exact sandbox generation, and remove its registration.

Everything else is out of scope: CPU-count changes after create, renaming an existing child, disk shrink, image selection, general stop/start/restart controls (restart exists only as an explicit resize confirmation), autoStart, metrics history or alerting, adoption of unlabelled sandboxes, other agents, generic provider mappings, settings migration, operation history, Command Center items, shell/exec, volumes, snapshots, and network controls.

## 2. Architecture and ownership

| Component | Owns |
| --- | --- |
| Plugin client | One sidebar screen, create confirmation including name and resources, list, progress/logs, live metrics, resize confirmation, Repair, and Delete. |
| Plugin server | One reconciler and one resize lane per VM name, background work, microsandbox SDK calls, registration, recovery, metrics reads, and redaction. |
| Microsandbox | Authoritative sandbox inventory, generation IDs, config, resources, runtime state, labels, logs, metrics, and detached jobs. |
| Parent daemon | Authoritative host registrations, routed connections, and online state. |

There is **no Paseo settings document**. Volatile plugin state is limited to pending creates and in-flight per-name lifecycle lanes. The only durable plugin-owned state is the credential store in section 5. Pending creates retain the request ID, chosen name, canonical provider/integration plan, and requested resources, never values.

The app polls `vm.list` and `vm.detail` only while the screen is mounted. While a running sandbox's detail is visible, the client also polls `vm.metrics` every 3 seconds; `vm.list` and `vm.detail` keep their normal cadence. Polling observes host work; it does not drive it. Detached VMs and provisioning jobs continue without the UI.

```text
Paseo app -> parent daemon -> plugin subprocess -> microsandbox
             |                                      |
             |                                      +-> detached VM, Paseo daemon :6767
             |                                      +-> detached provisioning job
             +-> routed registration -> 127.0.0.1:<published port>
```

Routing is one hop. The parent is the child's only network path required by the app.

There is no atomic transaction spanning microsandbox and the parent daemon. Lifecycle correctness instead comes from per-name serialization, idempotent steps, exact identity checks, and explicit recovery after uncertain results.

## 3. Identity and state

The client generates a UUID `requestId`. The VM name is optional:

- When omitted, the sandbox name is `paseo-<requestId>` as in V1.
- When supplied, the sandbox name is the supplied name. It must be 1–63 characters, lowercase ASCII letters, digits, and internal hyphens, starting and ending with an alphanumeric character. It must not contain `/`, whitespace, or path/URL punctuation.

The sandbox name is the logical identifier used by the UI, lookup, ownership, and Paseo registration. Strict name-create prevents duplicate allocation. There is no rename operation: changing a child's name would require replacing its sandbox and is not part of V1.1. Pending attempts are keyed by request ID, and rows and detail selection use that token when two attempts briefly share a name. A live sandbox supersedes the pending attempt with the same request marker, or—when the sandbox has no marker—the pending attempt whose generated name equals the sandbox name. A losing attempt stays visible until dismissed.

Reusing a live request ID joins the same reconciliation. A repeated request must use the original name, provider/integration plan, resources, and whether resources were explicitly supplied. Before allocating, Create scans managed inventory for `PASEO_MSB_REQUEST`; a generation under a different name or with a different plan/resources is rejected as `invalid_request`, never duplicated. A markerless legacy generation rejects an explicitly supplied resource selection because V1 Create had no resource choice; only an omitted-resources request may join its fixed shape. Once the generation no longer exists, reuse is a new attempt; a leftover registration-only child is not adopted and stays actionable.

New managed sandboxes persist the request and desired resources in guest environment variables alongside the canonical plan:

```text
PASEO_MSB_REQUEST=<requestId>
PASEO_MSB_PLAN=<canonical plan JSON>
PASEO_MSB_RESOURCES=<canonical { cpus, memoryMib, diskMib } JSON>
PASEO_MSB_RESOURCES_SPECIFIED=0|1
```

These variables are configuration, not ownership proof. They let a repeated Create distinguish its own generation from a different attempt that happens to use the same name. `PASEO_MSB_RESOURCES_SPECIFIED` records whether the original request supplied a resource selection; it is not changed by resize. A managed sandbox created by V1 has no request or resources variable; the generated-name rule below keeps those children recoverable without adopting them into a new request.

The name owns the current managed generation. Microsandbox `handle.id` is the generation token, not a second identity duplicated into sandbox labels. Delete retains the token so a stale client cannot destroy a replacement. Every guest operation, resize, and destroy uses the exact loaded handle and verifies its generation; an unverified fresh name lookup is not a valid reconnect.

New managed sandboxes have only these labels:

```text
paseo-msb=v1
paseo-msb-parent=<parent serverId>
paseo-msb-phase=creating|installing|registering|ready|deleting
paseo-msb-error=<short safe code, optional>
paseo-msb-error-detail=<bounded redacted detail, optional>
```

The `paseo-msb=v1` marker stays unchanged in V1.1. It is an inventory-schema marker, not a release version; changing it would hide existing children from listing and recovery. Labels remain progress and ownership hints, not proof of an external side effect. An error produces a failed presentation without discarding the next actionable phase. `deleting` is cleanup-only. Legacy `failed` and `paseo-msb-id` labels may be read while existing children are migrated; a present mismatched legacy ID quarantines the VM rather than allowing adoption.

Registration identity is exactly:

```text
source.id   = plugin:paseo-msb
source.key  = <current handle.id>
metadata    = { source: "paseo-msb", name: <name> }
label       = <name>
```

The label is display/configuration only; `(source.id, source.key)` proves ownership. V1 registrations used `<parent serverId>/<name>` as the label. Recovery and Repair update an enabled registration to the canonical name label and metadata; a user-disabled registration is preserved and never re-enabled. The release check confirms that the parent host directory exposes the chosen name. If Paseo's host picker derives its display name from a source other than the registration label/metadata, that source is outside the plugin's control.

The parent deduplicates unchanged adds by `(source.id, source.key)`. Changed configuration requires explicit `hosts.update`; a conflict is inspected, not blindly retried. Repair does not implicitly enable a registration the user disabled.

`vm.list` merges pending creates, managed sandboxes, and registrations, including registration-only children. A sandbox replaces the pending attempt it owns by request marker, or the legacy pending attempt whose generated name matches; losing same-name attempts remain visible until dismissed. Unavailable APIs produce explicit errors or partial results, never authoritative empty inventory. Raw microsandbox config, environment, and secret values never enter public DTOs. Resource values are exposed as bounded integers or `null` for unreported legacy fields; metrics are exposed as bounded numeric samples.

### Generation-exact mutations (pinned SDK limitation)

The pinned `microsandbox@0.7.14` `modify()` does not bind a captured generation: a same-name replacement can receive a stale handle's label, environment, or resource write, as the integration identity contract asserts. V1.1 therefore does not claim atomic mutations. It

- refreshes and compares `handle.id` before every label, environment, or resource write;
- does not treat a `bounded()` timeout or lifecycle abort as settlement: the native call may continue after the wrapper rejects;
- registers every native `modify()` promise in a per-name mutation registry, including phase, error, environment, resource, and `deleting` tombstone labels, and holds the lifecycle lane until it settles or a short settlement bound expires;
- makes Delete and same-name allocation check that registry. While a mutation is still registered, they do not destroy or allocate and return `mutation_pending`;
- registers the Delete tombstone itself and waits for its settlement before destruction; if the tombstone cannot settle within the bound, Delete does not destroy;
- treats phase, error, request, and resources values as best-effort configuration hints, never as authorization for destruction; and
- destroys only through `destroy()` on the exact handle after a refresh/compare, which the SDK rejects for a replaced generation.

The residual window is a concurrent external replacement created between the refresh and a mutation write. The plugin's own Delete and same-name allocation are serialized behind the mutation registry, but an external replacement can still inherit the write and be acted on by a later recovery. Eliminating that window requires an SDK conditional-mutation primitive; it must not be described as closed without one.

## 4. Create, reconciliation, and readiness

`vm.create({ requestId, name?, plan, resources? })` validates the input, records a pending attempt with the derived name, canonical resources, and whether resources were supplied, starts host-side work, and returns `{ name }` immediately. `resources` is either omitted for the defaults or a selection of `cpus`, `memoryMib`, and `diskMib`; `cpus` may be omitted and defaults to 2, and the other two are required, with defaults 4096 MiB RAM and 10240 MiB root disk. The plan contains provider and LLM identifiers plus integrations; it never contains values. Background Create, startup recovery, and manual Repair all call the same idempotent reconciler. At most one operation advances a name at a time; plugin cleanup aborts further side effects promptly, and runners revalidate their generation/tombstone after uncertain awaits.

The reconciler observes actual resources and advances only unambiguous steps:

1. Reject an unsettled native mutation for the name with `mutation_pending`. Scan managed inventory for the request marker. If this request already owns a generation, require the same name, plan, resources, and resources-specified flag, and advance that exact generation; a different name or selection is `invalid_request`, never a second VM. Then locate the current named sandbox. The manifest declares the parent floor, the package pins the SDK, and the release suite verifies the supported parent/SDK/runtime combination. A different live request under the same name is `name_conflict` and is never adopted or relabeled. A legacy generated name without a request marker is joinable only when it equals `paseo-<requestId>` and resources were not explicitly supplied. Only when initial creation is needed, resolve the plan's required credential values from the store, then the parent environment. Recovery of an existing sandbox needs only the persisted plan, never old values.
2. If the sandbox is absent, strictly create the pinned image, detached, with the requested CPU count, the requested RAM, `maxMemory` set to the allowed maximum so later growth can use live hotplug where supported, the requested managed root disk, a 2-second metrics sample interval, managed labels, `PASEO_MSB_REQUEST`, `PASEO_MSB_PLAN`, `PASEO_MSB_RESOURCES`, `PASEO_MSB_RESOURCES_SPECIFIED`, only the selected header-only secrets, and a loopback-only published port for guest 6767. The verified image requires explicit `/usr/bin/tini -- /usr/local/bin/paseo-docker-entrypoint`; host port `0` is unsupported, so probe and retry internally. If create fails but the named managed sandbox appeared, continue through that exact handle.
3. Materialize the content-addressed `/home/paseo/.paseo-msb/provision-<planHash>.sh` and run it as one detached job. The status file is the success proof; each step probes first, so a retry skips completed work. Await one active matching job, never start another because inventory or inspection failed, and preserve uncertain `JobError.jobId` values when available.
4. After a successful status, move to `registering`.
5. Ensure the exact producer/source-key registration with idempotent `hosts.add` or deliberate `hosts.update`, wait for routed online, call `providers.refresh({ providers: selected })`, and confirm every selected provider in a provider snapshot before moving to `ready`.

The child daemon binds only to parent loopback and runs without `PASEO_PASSWORD`; the authenticated parent is the security boundary.

Provisioning failures are fatal and preserve the sandbox, jobs, and registration for inspection and retry. Running jobs, timeouts, inspection failures, registration failures/timeouts, and provider unavailability keep the actionable phase and a safe error; Retry create or Repair re-runs the idempotent script. Retrying an empty pre-create failure uses the same request ID, name, and resources; once a sandbox exists, repeated Create joins reconciliation rather than replaying side effects. After `ready`, the plugin does not observe tool health, repair drift, or re-provision.

Detached VMs normally remain running across plugin and parent-daemon restarts. V1.1 neither starts a stopped VM as a general control nor provides separate lifecycle controls. The only restart the plugin performs is the explicit resize confirmation in section 7.

## 5. Credential passthrough

V1.1 supports only these six credential names:

| Guest environment variable | Allowed upstream hosts |
| --- | --- |
| `ANTHROPIC_API_KEY` | `api.anthropic.com` |
| `CLAUDE_CODE_OAUTH_TOKEN` | `api.anthropic.com` |
| `OPENAI_API_KEY` | `api.openai.com` |
| `GEMINI_API_KEY` | `generativelanguage.googleapis.com` |
| `NEURALWATT_API_KEY` | `api.neuralwatt.com` |
| `GH_TOKEN` | `api.github.com`, `github.com`, `uploads.github.com` |

Values come from the plugin's shared store first, then the parent process environment. The store lives at `<PASEO_HOME>/plugin-data/paseo-msb/secrets.json` (plugin directory `0700`, file `0600`) and may be relocated with `PASEO_MSB_SECRETS_FILE`. New directories are `0700`; an existing override parent keeps its permissions. The store accepts only the six fixed names; unknown keys are ignored on read and rejected on write.

`vm.list` reports available names and stored names. Create selects providers and integrations; every selected provider has at least one selected LLM option, and only the credentials those options require are sent to the child. Claude takes exactly one auth option (Anthropic API key or Claude subscription). Pi takes one or more of Anthropic, OpenAI, Gemini, and NeuralWatt. The GitHub CLI integration requires `GH_TOKEN` and is independent of providers. The confirmation never displays or accepts a value.

`secrets.list` returns names and sources only, `secrets.set` is the only write path, and `secrets.delete` removes a stored value. No RPC returns a value or host-local store path.

The server reads the plan's required values immediately before initial sandbox creation and builds microsandbox secrets with header substitution only. Guests receive placeholders; raw values remain in parent-controlled state and microsandbox config. TLS interception and guest CA setup are microsandbox responsibilities. Query/body substitution, placeholder passthrough configuration, interactive OAuth stores, custom base URLs, and providers not in the catalog are unsupported.

Public DTOs use allowlists and structured safe errors. Any intentionally exposed diagnostic or log is bounded and centrally redacted against current environment/store values plus relevant persisted values from managed VM config—the selected VM for detail and all relevant VMs for inventory-wide errors. Removing or replacing a credential must not disable redaction for an existing VM. Redaction protects RPC output; separate raw-sink verification is still required because it cannot erase values already written elsewhere. Metrics and resource integers bypass text redaction because they are constructed from numeric SDK fields, never raw text.

## 6. Repair and deletion

`vm.reconcile` is the single Repair mutation and uses the reconciler in section 4. It resumes unambiguous provisioning/registration work, restores missing registrations, repairs registration display drift, and removes confirmed stale plugin-owned registrations. It does not create sandboxes, start stopped VMs, adopt unlabelled sandboxes, or guess through ambiguous, foreign, duplicate, or confirmed provisioning-failure state. It does not initiate deletion; completing an existing `deleting` tombstone is Delete cleanup, not a new Repair deletion.

Absence from managed, decoded, label-filtered inventory is not proof of deletion. Stale-registration removal requires either:

- exact `Sandbox.get(metadata.name)` plus comparison of `handle.id` with `registration.source.key`; or
- a complete, unfiltered runtime ID inventory with checked pagination.

A different live ID proves only the old generation is stale. Lookup, decode, or pagination errors block destructive cleanup. The runtime absence is revalidated at the moment of removal, so a generation created between an earlier observation and the removal keeps its live registration.

`vm.delete({ name, id, confirmName })` requires the exact logical name, confirmation, and current generation token. In the same per-name lifecycle lane it:

1. If the per-name mutation registry still has an unsettled native `modify()`, returns `mutation_pending` without destroying. Otherwise persists `deleting` as a registered mutation, waits for its settlement before destruction, and invalidates active work; if the tombstone cannot settle, returns `mutation_pending` and does not destroy the VM. The only exception is the SDK's explicit incomplete-create state, which cannot be refreshed or labelled and is destroyed through the exact generation-checked handle instead.
2. Re-reads and validates the exact handle, then destroys it through that handle.
3. After old work settles, re-reads runtime/registrations and removes only the exact `(plugin:paseo-msb, id)` registration.

If no sandbox exists, Delete skips tombstoning/destruction and removes a registration only when its authenticated producer, `source.key = id`, and `metadata.name = name` all match; otherwise it leaves the registration untouched. No matching sandbox or registration is already-missing success.

A failure after destruction leaves a visible, actionable registration-only child for Delete or Repair. Reload during deletion resumes cleanup, never setup. While registration-only cleanup remains, same-request Create joins that cleanup instead of creating a replacement. An old Delete ID cannot destroy a newer same-name generation. Failed and incomplete children require no CLI cleanup.

## 7. Resource changes and live metrics

### 7.1 Reading resources

Every pending or sandbox child exposes `resources`:

```text
{ cpus, memoryMib, diskMib }
```

`cpus` is a bounded integer chosen at Create: 1–16, default 2, set only at create. `memoryMib` and `diskMib` are bounded integers or `null` when the pinned runtime does not report that field for a legacy sandbox. For a pending child all three are the requested values, and `resourcesSpecified` records whether the original Create supplied a resources object so Retry can preserve the omission. Sandbox rows do not expose that flag. For an existing sandbox, observed values come from the microsandbox config only; `PASEO_MSB_RESOURCES` is the desired value and never substitutes for an observation. A sandbox exposes `requestedResources` when the persisted desired values differ from the observed values, so a pending restart is visible instead of being reported as applied. An observed `diskMib: null` disables disk resizing because grow-only has no safe baseline. A memory target with `memoryMib: null` is rejected until Repair can report the effective value. The plugin never guesses a missing value.

### 7.2 Resizing an existing child

`vm.resize({ name, id, memoryMib?, diskMib?, restart? })` is the only resource mutation. At least one target is required. RAM is 1024–32768 MiB in 256 MiB steps; the root disk is 1024–262144 MiB in 1024 MiB steps and is grow-only. CPU is chosen at Create (1–16, default 2); resize rejects a CPU change because `vm.resize` has no CPU target.

Resize runs in the same per-name lifecycle lane as Create, Repair, and Delete:

1. Reject an unsettled native mutation with `mutation_pending`. Re-read the exact handle and compare `handle.id` with `id`.
2. Compare the target with the observed and previously requested resources. A target equal to both is `unchanged` with no `modify()` call. A target equal to observed but different from requested clears the pending desired value without changing resources. A disk target below observed is `invalid_request`; a disk change with an observed `null` baseline is `invalid_request`. A memory target with an observed `null` baseline is also `invalid_request`.
3. For RAM growth above a legacy VM's observed `maxMemory` cap, or when that cap is unreported, a `no_restart` request returns `restart_required` before calling `modify()` and never includes `maxMemory`. A `restart: true` call may include `maxMemory = MAX_MEMORY_MIB`. If the pinned runtime refuses the cap change, the result is `resize_failed`.
4. Call the exact handle's `modify()` with the resource targets, any required `maxMemory`, and a canonical `PASEO_MSB_RESOURCES` desired value. Register the native promise in the per-name mutation registry; the lane is held until it settles or the settlement bound expires. The refresh/compare guard from section 3 applies.
5. With `restart` omitted or false, use the SDK's `no_restart` policy. With `restart: true`, use the SDK's `restart` policy only when the exact generation is currently `running`. A `created`, `stopped`, `crashed`, or `paused` generation is `invalid_request` for a restart and is never started. The registration and published port are expected to survive a restart; the release test verifies the routed host returns online.
6. Re-read the effective resources. Aggregate the outcome per resource, then pick the most severe result in this order:

| Condition, in evaluation order | Result |
| --- | --- |
| Target matches observed and requested | `unchanged` |
| Conflicts, unsupported changes, or apply failure | `resize_failed` |
| `restart: true` and any `requires restart`/`guest-refused`, or any target unconfirmed after restart | `resize_failed` |
| `restart: false` and any `requires restart`/`guest-refused` | `restart_required` |
| Any `accepted`, `converging`, or `next start`, or any target unconfirmed without a failure/restart signal | `converging` |
| All targets confirmed and no failure/restart/converging signal | `applied` |

A request mixing one converging resource with one restart-required resource is `restart_required`, not `converging`. A restart-required state that survives `restart: true` is `resize_failed`. `applied` is never claimed when any effective field is unreported or still differs. A stopped VM is not started by resize: a `no_restart` config/disk update may still take effect on its next start; if the pinned runtime refuses that path, the result is `resize_failed`. A failed or refused resize leaves the previous resources visible and actionable. It never destroys the sandbox or removes its registration. Delete aborts the logical resize, then checks the mutation registry before tombstoning or destroying; an unsettled native call blocks destruction with `mutation_pending`.

### 7.3 Live metrics

`vm.metrics({ name, id })` returns a metrics snapshot. It resolves the exact named handle, compares `handle.id`, verifies the managed and parent labels, and reads `metrics()` only while the generation is running. It does not read inventory, jobs, or logs. A missing handle is `no_sandbox`; a different generation is the `id_mismatch` RPC error; foreign or malformed labels are `unavailable`. The parent ID comes from a small cache refreshed by `vm.list`/`vm.detail`, with one bounded directory read when the cache is empty.

The server coalesces metrics reads per `(name, id)`: one raw `metrics()` promise is shared, and a bounded RPC timeout returns an unavailable reason without starting another native read. Later polls join the same unsettled read; the entry clears only when the raw promise actually settles. This keeps multiple clients and repeated timeouts from accumulating native calls. A metrics failure returns a fixed unavailable reason and never fails detail or log loading.

The client polls `vm.metrics` every 3 seconds only while a running sandbox's detail is visible. Polling is single-flight and schedules the next request only after the previous one completes; it stops on unmount or selection change. New VMs sample every 2 seconds so a 3-second poll normally observes a fresh sample rather than a duplicate.

A sample contains only numeric SDK fields and an ISO timestamp:

```text
cpuPercent
memoryBytes, memoryLimitBytes, memoryAvailableBytes?
diskReadBytes, diskWriteBytes
netRxBytes, netTxBytes
upperUsedBytes?, upperFreeBytes?
uptimeMs
```

The client displays `cpuPercent` directly, derives memory use from the absolute sample, and derives disk I/O and network rates from consecutive samples. The first sample shows absolute values and no rates. Rates reset on a different generation ID, a non-increasing timestamp, an uptime regression, or any cumulative counter regression. A sample is stale when its SDK timestamp is more than `STALE_SAMPLE_MS` (10 seconds) behind receipt time or more than 5 seconds ahead of receipt time; stale or future samples update absolute values but do not compute rates and reset the baseline. Duplicate samples update absolute values without recomputing rates. A sample is unavailable with a fixed reason when there is no sandbox, the VM is not running, metrics sampling is disabled in the VM config, or the runtime cannot read metrics. No raw SDK error text crosses the RPC boundary. Metrics are display-only: they never trigger lifecycle work, repair, or deletion.

## 8. Minimal RPC and UI

| RPC | Purpose |
| --- | --- |
| `vm.list` | Pending, sandbox, and registration-only children; available/stored credential names; each child's name, plan, resources, progress, and safe errors. |
| `vm.detail` | One child, its plan, resources, requested resources, registration state, and bounded sandbox/provision-job logs when a sandbox exists. Accepts an optional `requestId` to disambiguate same-name pending attempts. |
| `vm.create` | Start or join one idempotent background create from an optional name, resources, and provider/integration plan; return the derived name. |
| `vm.dismiss` | Remove a failed pending create that has not become the user's desired attempt. It does not destroy a sandbox or registration. |
| `vm.metrics` | One exact generation's live metrics snapshot or a fixed unavailable reason. It does not read inventory, jobs, or logs. |
| `vm.resize` | Change RAM and/or grow the root disk of the exact generation, optionally restarting a running VM after explicit confirmation. |
| `vm.delete` | Destroy the exact generation and remove its registration. |
| `vm.reconcile` | Resume provisioning and repair missing, drifted, or confirmed stale registrations. |
| `secrets.list` | The six names with `stored` and `environment` sources. No values or store path. |
| `secrets.set` | Write one fixed-name value. The value is never returned. |
| `secrets.delete` | Remove one stored value. |

The single Paseo screen contains:

- Manage secrets, with add/replace/remove controls that never display values.
- Create confirmation with an optional name (the generated name is the placeholder), fixed image, editable CPU with default 2 and bounds 1–16, editable RAM and root disk with defaults and bounds, settings-style **Providers** and **Integrations** sections, availability reasons, per-provider nested LLM options, and the derived credential names.
- Rows for pending, sandbox, and registration-only children showing the name, setup health, VM status, and known RAM/disk when available; pending rows show requested resources. Pending rows are disambiguated by request ID when names briefly collide. Raw phase, runtime, and registration status stay in the detail sheet; the row keeps its safe error text.
- Detail with the plan, current and requested resources, an **Edit resources** action, a live metrics panel fed by `vm.metrics`, one bounded read-only log as a collapsible monospace block (chronological sandbox/provisioning entries with exact duplicates removed, line count in the header, timestamps in a separate column), Repair, and Delete.
- Resize confirmation with the target RAM/disk, the disk grow-only rule, and an explicit warning that applying a restart-required change disconnects active sessions before the user confirms the restart. The restart action is offered only for a running VM; a stopped or crashed VM shows why it cannot be restarted.
- Create closes after accepting the request. Synchronous validation and credential errors stay in the modal; an asynchronous `name_conflict` appears on the new pending child and can be dismissed.
- Retry of a failed pending create with its original request ID, name, resources, and plan; Dismiss for an unwanted failed attempt; and working Repair/Delete for registration-only children. Create checks credential-store availability before opening or submitting and reports failure with a toast.
- Clear loading, genuinely empty, partial-unavailable, and failed states. Unavailable inventory is never presented as empty or confirmed missing.

There are no general metrics screens or history, connection-copy controls, custom provider forms, or plugin-specific Open Host action. The registered child is used through Paseo's normal host picker.

## 9. Required verification and release bar

The release test must drive all lifecycle RPCs through Create, background progress, selected-provider readiness, reload during provisioning and after a deletion tombstone, Repair, Dismiss, and Delete. It must also cover:

- generated and custom names, duplicate-name rejection, two same-name pending attempts, the different-request collision, and legacy generated-name recovery without adoption;
- repeated request IDs after readiness, including a different name/selection/resources-specified flag being rejected instead of creating a second VM, and a markerless legacy VM rejecting an explicit resource selection;
- the registration label and metadata presenting the chosen name in the parent host directory;
- create-time RAM/root-disk values and resource decoding for new and legacy V1 sandboxes, including nullable legacy fields;
- RAM growth and shrink, legacy `maxMemory` growth, live or restart-required convergence, mixed converging-plus-restart-required severity, root-disk growth, root-disk-shrink rejection, legacy-null disk rejection, stopped/created/crashed/paused restart rejection, exact-generation resize, and Delete waiting on an unsettled native mutation or tombstone;
- the routed host returning online after a confirmed restart;
- live metrics values through `vm.metrics`, server-side coalescing of unresolved native reads, the 3-second poll with single-flight and stale/future/duplicate handling, and unavailable reasons for stopped, disabled, and failed metrics reads.

Deterministic barriers and fault cases cover foreign-name create conflicts, conflicting active provision jobs, registration configuration drift, stale-generation destroy, stale-handle label/env/resource writes, conflicting resize, an unsettled label write or tombstone blocking Delete, metrics-read coalescing under repeated timeouts, and concurrent Create/recovery/Repair/Resize/Delete. Every interruption has a UI recovery path and produces at most one current VM, one active provision job, and one current registration per logical attempt. Unit suites cover transport-level call failures, malformed config, malformed metrics, invalid resource bounds, and pagination failures; these conditions must never delete registrations.

The credential store uses only the six fixed names, writes its file `0600`, and creates or tightens the plugin-owned default directory to `0700` without changing an existing override parent. Canary credentials, including removed/replaced creation-time values and injected upstream errors, never appear in RPC output, plugin logs, raw microsandbox sandbox/job/system logs, pending state, labels, or test artifacts outside approved secret config and intended upstream substitution. Store and environment paths are both covered.

`npm run typecheck`, `npm run lint`, `npm test`, and `npm run test:release` must pass on the verified pins; changing a pin requires re-running the release verification.

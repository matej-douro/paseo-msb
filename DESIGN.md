# paseo-msb: minimal VM-backed Paseo hosts

Status: minimal v1 target design. Completed implementation is recorded in [CHANGELOG.md](./CHANGELOG.md); remaining verification is tracked in [TASKS.md](./TASKS.md).

A Paseo parent-daemon plugin that creates, lists, repairs, and deletes microsandbox VMs running Paseo with Pi. Children appear in Paseo's normal host picker. All lifecycle management happens through the plugin's Paseo UI, not the `msb` CLI.

## 1. V1 scope

V1 has exactly five user flows:

1. **Manage credentials**: add, replace, or remove values for five fixed names in the plugin's shared store. The UI never displays a stored value.
2. **Create**: select available Pi credentials by name and confirm a fixed image, 2 CPUs, and 2048 MiB memory. The VM name is generated.
3. **Use**: watch creation and Pi installation progress, then open the child through Paseo's normal host UI.
4. **Repair**: resume interrupted setup, restore a missing registration, or remove a confirmed stale plugin-owned registration.
5. **Delete**: confirm in Paseo, destroy the exact sandbox generation, and remove its registration.

Everything else is out of scope: custom names or sizes, image selection, stop/start/restart controls, autoStart, metrics, adoption of unlabelled sandboxes, other agents, generic provider mappings, settings migration, operation history, Command Center items, shell/exec, volumes, snapshots, and network controls.

## 2. Architecture and ownership

| Component | Owns |
| --- | --- |
| Plugin client | One sidebar screen, create confirmation, list, progress/logs, Repair, and Delete. |
| Plugin server | One reconciler per VM name, background work, microsandbox SDK calls, registration, recovery, and redaction. |
| Microsandbox | Authoritative sandbox inventory, generation IDs, config, runtime state, labels, logs, and detached jobs. |
| Parent daemon | Authoritative host registrations, routed connections, and online state. |

There is **no Paseo settings document**. Volatile plugin state is limited to pending creates and in-flight per-name lifecycle lanes. The only durable plugin-owned state is the credential store in section 5. Pending creates retain the request ID and selected credential **names**, never values.

The app polls `vm.list` and `vm.detail` only while the screen is mounted. Polling observes host work; it does not drive it. Detached VMs and Pi install jobs continue without the UI.

```text
Paseo app -> parent daemon -> plugin subprocess -> microsandbox
             |                                      |
             |                                      +-> detached VM, Paseo daemon :6767
             |                                      +-> detached Pi install job
             +-> routed registration -> 127.0.0.1:<published port>
```

Routing is one hop. The parent is the child's only network path required by the app.

There is no atomic transaction spanning microsandbox and the parent daemon. Lifecycle correctness instead comes from per-name serialization, idempotent steps, exact identity checks, and explicit recovery after uncertain results.

## 3. Identity and state

The client generates a UUID `requestId`. The sandbox name is `paseo-<requestId>` and is the logical identifier used by the UI, lookup, and ownership. Strict name-create prevents duplicate allocation. Reusing a live request ID joins the same reconciliation; once Delete leaves neither sandbox nor registration, reuse creates a new generation. A repeated request must use the original credential names, recovered from pending state or sandbox config; different names are rejected.

The name owns the current managed generation. Microsandbox `handle.id` is the generation token, not a second identity duplicated into sandbox labels. Delete retains the token so a stale client cannot destroy a replacement. Every guest operation and destroy uses the exact loaded handle and verifies its generation; an unverified fresh name lookup is not a valid reconnect.

New managed sandboxes have only these labels:

```text
paseo-msb=v1
paseo-msb-parent=<parent serverId>
paseo-msb-phase=creating|installing|registering|ready|deleting
paseo-msb-error=<short safe code, optional>
paseo-msb-error-detail=<bounded redacted detail, optional>
```

Phase is a progress hint, not proof that an external side effect occurred. An error produces a failed presentation without discarding the next actionable phase. `deleting` is cleanup-only. Legacy `failed`, `paseo-msb-id`, and `paseo-msb-job` labels may be read while existing children are migrated; a present mismatched legacy ID quarantines the VM rather than allowing adoption.

Registration identity is exactly:

```text
source.id   = plugin:paseo-msb
source.key  = <current handle.id>
metadata    = { source: "paseo-msb", name: <sandbox name> }
label       = <parent serverId>/<sandbox name>
```

The parent deduplicates unchanged adds by `(source.id, source.key)`. Changed configuration requires explicit `hosts.update`; a conflict is inspected, not blindly retried. Labels and metadata are configuration, not ownership proof. Repair does not implicitly enable a registration the user disabled.

`vm.list` merges pending creates, managed sandboxes, and registrations, including registration-only children. A sandbox replaces a pending row with the same name. Unavailable APIs produce explicit errors or partial results, never authoritative empty inventory. Raw microsandbox config, environment, and secret values never enter public DTOs.

### Generation-exact label writes (pinned SDK limitation)

The pinned `microsandbox@0.7.14` `modify()` does not bind a captured generation: a
same-name replacement can receive a stale handle's label write, as the identity
spike asserts. V1 therefore does not claim atomic label writes. It

- refreshes and compares `handle.id` before every label write;
- treats phase and error labels as best-effort progress hints, never as
authorization for destruction; and
- destroys only through `destroy()` on the exact handle after a refresh/compare,
which the SDK rejects for a replaced generation.

The residual window is a concurrent external replacement created between the
refresh and a `deleting` tombstone write. That replacement can inherit the
tombstone and be completed by a later recovery. Eliminating the window requires
an SDK conditional-mutation primitive; it must not be described as closed
without one.

## 4. Create, reconciliation, and readiness

`vm.create({ requestId, secretEnvVars })` validates the fixed input, records a pending attempt, starts host-side work, and returns `{ name }` immediately. Background Create, startup recovery, and manual Repair all call the same idempotent reconciler. At most one operation advances a name at a time; plugin cleanup aborts further side effects promptly, and runners revalidate their generation/tombstone after uncertain awaits.

The reconciler observes actual resources and advances only unambiguous steps:

1. Check parent/runtime feature floors and locate the current named sandbox. Only when initial creation is needed, resolve selected credential values from the store, then the parent environment. Recovery of an existing sandbox needs only the original credential names from pending state or config, never their old values.
2. If the sandbox is absent, strictly create the pinned, fixed-size, detached sandbox with managed labels and a loopback-only published port for guest 6767. The verified image requires explicit `/usr/bin/tini -- /usr/local/bin/paseo-docker-entrypoint`; host port `0` is unsupported, so probe and retry internally. If create fails but the named managed sandbox appeared, continue through that exact handle.
3. Check the exact daemon-user Pi path/version. If installation is needed, rediscover the detached job through complete job inventory and exact pinned argv: await one active match, start only when no match exists, and reject ambiguous active duplicates. Never start another job because inventory or inspection failed. Preserve uncertain `JobError.jobId` values when available.
4. After a confirmed successful install, verify `pi` resolves at the pinned path/version as `paseo`, then move to `registering`.
5. Ensure the exact producer/source-key registration with idempotent `hosts.add` or deliberate `hosts.update`, wait for routed online, call `providers.refresh()`, and confirm Pi is ready in a provider snapshot before moving to `ready`.

The child daemon binds only to parent loopback and runs without `PASEO_PASSWORD`; the authenticated parent is the security boundary.

Failures preserve sandboxes, jobs, and registrations for inspection. Running jobs, timeouts, inspection failures, registration failures/timeouts, and provider unavailability are retryable or unknown—not automatic terminal failures. Only a confirmed unsuccessful install is a terminal failed-install state. Actual Pi readiness wins over missing historical job state. Retrying an empty pre-create failure uses the same request ID; once a sandbox exists, repeated Create joins reconciliation rather than replaying side effects.

Detached VMs normally remain running across plugin and parent-daemon restarts. V1 neither starts a stopped VM nor provides separate lifecycle controls.

## 5. Pi secret passthrough

V1 supports only these five credential names:

| Guest environment variable | Allowed upstream hosts |
| --- | --- |
| `ANTHROPIC_API_KEY` | `api.anthropic.com` |
| `OPENAI_API_KEY` | `api.openai.com` |
| `GEMINI_API_KEY` | `generativelanguage.googleapis.com` |
| `NEURALWATT_API_KEY` | `api.neuralwatt.com` |
| `GH_TOKEN` | `api.github.com`, `github.com`, `uploads.github.com` |

Values come from the plugin's shared store first, then the parent process environment. The store lives at `<PASEO_HOME>/plugin-data/paseo-msb/secrets.json` (directory `0700`, file `0600`) and may be relocated with `PASEO_MSB_SECRETS_FILE`. It accepts only the five fixed names; unknown keys are ignored on read and rejected on write.

`vm.list` reports available names and stored names. Create requires at least one and never displays or accepts values in its confirmation. `secrets.list` returns names and sources only, `secrets.set` is the only write path, and `secrets.delete` removes a stored value. No RPC returns a value or host-local store path.

The server reads selected values immediately before initial sandbox creation and builds microsandbox secrets with header substitution only. Guests receive placeholders; raw values remain in parent-controlled state and microsandbox config. TLS interception and guest CA setup are microsandbox responsibilities. Query/body substitution, placeholder passthrough configuration, OAuth stores, custom base URLs, and other providers are unsupported.

Public DTOs use allowlists and structured safe errors. Any intentionally exposed diagnostic or log is bounded and centrally redacted against current environment/store values plus relevant persisted values from managed VM config—the selected VM for detail and all relevant VMs for inventory-wide errors. Removing or replacing a credential must not disable redaction for an existing VM. Redaction protects RPC output; separate raw-sink verification is still required because it cannot erase values already written elsewhere.

## 6. Repair and deletion

`vm.reconcile` is the single Repair mutation and uses the reconciler in section 4. It resumes unambiguous install/registration work, restores missing registrations, and removes confirmed stale plugin-owned registrations. It does not create sandboxes, start stopped VMs, adopt unlabelled sandboxes, or guess through ambiguous, foreign, duplicate, or confirmed failed-install state. It does not initiate deletion; completing an existing `deleting` tombstone is Delete cleanup, not a new Repair deletion.

Absence from managed, decoded, label-filtered inventory is not proof of deletion. Stale-registration removal requires either:

- exact `Sandbox.get(metadata.name)` plus comparison of `handle.id` with `registration.source.key`; or
- a complete, unfiltered runtime ID inventory with checked pagination.

A different live ID proves only the old generation is stale. Lookup, decode, or pagination errors block destructive cleanup. The runtime absence is revalidated at the moment of removal, so a generation created between an earlier observation and the removal keeps its live registration.

`vm.delete({ name, id, confirmName })` requires the exact logical name, confirmation, and current generation token. In the same per-name lifecycle lane it:

1. Persists `deleting` before destruction and invalidates active work; if that marker cannot be written, it does not destroy the VM.
2. Re-reads and validates the exact handle, then destroys it through that handle.
3. After old work settles, re-reads runtime/registrations and removes only the exact `(plugin:paseo-msb, id)` registration.

If no sandbox exists, Delete skips tombstoning/destruction and removes a registration only when its authenticated producer, `source.key = id`, and `metadata.name = name` all match; otherwise it leaves the registration untouched. No matching sandbox or registration is already-missing success.

A failure after destruction leaves a visible, actionable registration-only child for Delete or Repair. Reload during deletion resumes cleanup, never setup. While registration-only cleanup remains, same-request Create joins that cleanup instead of creating a replacement. An old Delete ID cannot destroy a newer same-name generation. Failed and incomplete children require no CLI cleanup.

## 7. Minimal RPC and UI

| RPC | Purpose |
| --- | --- |
| `vm.list` | Pending, sandbox, and registration-only children; available/stored credential names; progress, status, and safe errors. |
| `vm.detail` | One child, its registration state, and bounded sandbox/job logs when a sandbox exists. |
| `vm.create` | Start or join one idempotent background create and return its generated name. |
| `vm.delete` | Destroy the exact generation and remove its registration. |
| `vm.reconcile` | Resume setup and repair missing or confirmed stale registrations. |
| `secrets.list` | The five names with `stored` and `environment` sources. No values or store path. |
| `secrets.set` | Write one fixed-name value. The value is never returned. |
| `secrets.delete` | Remove one stored value. |

The single Paseo screen contains:

- Manage secrets, with add/replace/remove controls that never display values.
- Create confirmation with fixed resources and available credential checkboxes marked Stored or Environment.
- Rows for pending, sandbox, and registration-only children with two pills: setup health (the pipeline stage, or the stored safe error that names the stage that stalls it) and VM status (runtime, folded with registration reachability while running). Raw phase, runtime, and registration status stay in the detail sheet; the row keeps its safe error text.
- Detail with bounded read-only logs as collapsible monospace blocks (line count in each header, timestamps in a separate column), Repair, and Delete.
- Retry of a failed pending create with its original request ID and credential names, and working Repair/Delete for registration-only children.
- Clear loading, genuinely empty, partial-unavailable, and failed states. Unavailable inventory is never presented as empty or confirmed missing.

There are no metrics, connection-copy controls, custom provider forms, or plugin-specific Open Host action. The registered child is used through Paseo's normal host picker.

## 8. Required verification and release bar

The vertical spike must prove the exact pinned parent daemon, microsandbox SDK/runtime, guest image, and Pi package, including:

- Guest Node >= 22.19, npm, non-root Pi install, daemon-user PATH, explicit tini fallback, loopback port publish/release, detached survival, config, and logs.
- Exact-handle `refresh`, `connect`, `modify`, job listing, and destroy under same-name replacement.
- Complete paginated job recovery, exact argv, running/exited/failed/lost states, and uncertain `JobError.jobId` handling across reload.
- Real-plugin producer identity, unchanged-add idempotency, disabled-state preservation, changed-configuration updates, registration removal, routed online, and provider refresh.
- Header-only substitution for all five credentials without exposing values to the guest, from both store and environment.

The release test drives all lifecycle RPCs through Create, background progress, Pi readiness, reload during install and deletion, Repair, and Delete. Barriers/fault injection cover create, job launch, registration response, and destroy, plus concurrent Create/recovery/Repair/Delete. Every interruption has a UI recovery path and produces at most one current VM, one active install, and one current registration per logical attempt. Malformed config and pagination failures never delete registrations.

The credential store persists with owner-only permissions and fixed names only. Canary credentials, including removed/replaced creation-time values and injected upstream errors, never appear in RPC output, plugin logs, raw microsandbox sandbox/job/system logs, pending state, labels, or test artifacts outside approved secret config and intended upstream substitution. Store and environment paths are both covered.

`npm run typecheck`, `npm run lint`, `npm test`, and `npm run test:release` must pass on the verified pins.

## 9. V2 shopping list

Ideas intentionally deferred from v1:

- See used VM disk capacity and quickly enlarge/shrink it.

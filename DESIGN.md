# paseo-msb: minimal VM-backed Paseo hosts

Status: minimal v1 design. Implementation not started.

A Paseo parent-daemon plugin that creates, lists, repairs, and deletes microsandbox VMs running Paseo with Pi. Children appear in Paseo's normal host picker. All lifecycle management happens through the plugin's Paseo UI, not the `msb` CLI.

## 1. V1 scope

V1 has exactly five user flows:

1. **Manage credentials**: add, replace, or remove values for the five fixed names in the plugin's shared store. The UI never displays a stored value.
2. **Create**: click Create child, select available Pi credentials by name, and confirm. The VM uses a pinned image, 2 CPUs, and 2048 MiB memory. Its name is generated.
3. **Use**: watch creation and Pi installation progress in the plugin, then open the child through Paseo's normal host UI.
4. **Repair**: resume interrupted setup, restore a missing registration, or remove a stale plugin-owned registration.
5. **Delete**: confirm in Paseo, destroy the exact sandbox, and remove its registration.

Everything else is out of scope: custom names or sizes, image selection, stop/start/restart controls, autoStart, metrics, adoption, other agents, generic provider mappings, settings migration, operation history, Command Center items, shell/exec, volumes, snapshots, and network controls.

## 2. Architecture and ownership

| Component | Owns |
| --- | --- |
| Plugin client | One sidebar screen, create confirmation, list, progress/logs, Repair, and Delete. |
| Plugin server | Background creation, microsandbox SDK calls, Pi install jobs, parent registration, recovery, and redaction. |
| Microsandbox | Authoritative sandbox inventory, stable IDs, config, runtime state, labels, logs, and detached jobs. |
| Parent daemon | Authoritative host registrations, routed connections, and online state. |

There is **no Paseo settings document**. The only plugin-owned volatile state is a map of creates that have not yet produced a sandbox. The only durable plugin state is the credential store described in section 5.

The app polls `vm.list` and `vm.detail` only while the screen is mounted. Polling observes host work; it does not drive it. Detached VMs and Pi install jobs continue without the UI.

```text
Paseo app -> parent daemon -> plugin subprocess -> microsandbox
             |                                      |
             |                                      +-> detached VM, Paseo daemon :6767
             |                                      +-> detached Pi install job
             +-> routed registration -> 127.0.0.1:<published port>
```

Routing is one hop. The parent is the child's only network path required by the app.

## 3. Identity and state

The client generates a UUID `requestId` for each create attempt. The sandbox name is `paseo-<requestId>` and `vm.create` returns that name immediately. Reusing the request ID therefore retries the same logical create; strict name-create and stable-ID checks prevent duplicate lifecycle ownership.

Managed sandboxes have only these labels:

```text
paseo-msb=v1
paseo-msb-parent=<parent serverId>
paseo-msb-id=<stable sandbox id>
paseo-msb-phase=creating|installing|registering|ready|failed
paseo-msb-job=<Pi install job id, when started>
paseo-msb-error=<short safe code, when failed>
```

The registration uses the stable sandbox ID as `sourceKey`, metadata `{ source: "paseo-msb", vm: <sandbox id>, name: <sandbox name> }`, and label `<parent label>/<sandbox name>`.

`vm.list` merges the pending-create map, label-filtered microsandbox inventory, and parent registrations. An unavailable API returns an explicit error or partial result, never an empty inventory. Raw microsandbox config, environment, and secret values never enter public DTOs.

After a plugin reload, labelled sandboxes and detached jobs are rediscovered. Setup resumes only when its persisted phase and IDs make the next step unambiguous; otherwise it remains failed and can be deleted. A reload before a sandbox exists may discard the empty pending attempt, which is safe to retry. There is no terminal operation history.

## 4. Create and readiness

`vm.create({ requestId, secretEnvVars })` validates the fixed input, adds a pending entry, starts host-side work, and returns `{ name }` immediately.

The background runner:

1. Checks the parent and runtime feature floors and resolves selected credentials from the parent process environment.
2. Creates the pinned, fixed-size, detached sandbox with managed labels, `.init("auto")`, and a loopback-only published port for guest 6767. Use host port `0` if supported; otherwise probe and retry internally.
3. Records the stable sandbox ID and phase in microsandbox labels.
4. Installs the verified Pi package version as `paseo` using `execDetachedWith`, records the job ID label, and checks that `pi` resolves on the daemon user's PATH.
5. Moves to `registering`, calls `hosts.add`, and waits for routed online.
6. Calls `providers.refresh()` through the routed client, confirms Pi is listed, and moves to `ready`.

The child daemon binds only to parent loopback and runs without `PASEO_PASSWORD`; the authenticated parent is the security boundary. If the vertical spike proves that the image requires a password, it is generated internally and stored only in microsandbox config and the parent's protected registration, with no additional UI or settings.

A failure preserves any sandbox, job, and registration for inspection. It sets `phase=failed` with a safe error code. Retrying an empty pre-create failure uses the same request ID. Later failures use Repair or Delete, not blind create replay.

Detached VMs normally remain running across plugin and parent-daemon restarts. V1 does not autoStart a stopped VM or provide separate lifecycle controls.

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

`vm.list` reports which names are available and which come from the store. The create confirmation offers checkboxes for those names and requires at least one. It never displays or accepts values. `secrets.list` returns names and sources only, `secrets.set` is the only write path, and `secrets.delete` removes a stored value. No RPC returns a stored value.

The server reads selected values immediately before creation and builds microsandbox secrets with header substitution only. TLS interception and guest CA setup are microsandbox responsibilities. Query/body substitution, placeholder passthrough configuration, OAuth stores, custom base URLs, and other providers are not supported in v1.

Inline values remain inside parent-controlled microsandbox state. Public DTOs use allowlists, and logs and errors are redacted against both stored and environment values.

## 6. Repair and deletion

`vm.reconcile` is the single Repair mutation. It:

- Resumes an unambiguous pending install or registration using the persisted sandbox and job IDs.
- Registers a Pi-ready sandbox whose registration is missing.
- Removes a plugin-owned registration whose sandbox no longer exists after ownership checks.
- Leaves ambiguous, foreign, duplicate, or failed-install state untouched and returns an actionable error.

It does not create or delete sandboxes, start stopped VMs, or adopt unlabelled sandboxes.

`vm.delete({ name, id, confirmName })` requires the exact sandbox name and stable ID. It destroys that sandbox through its stable handle, removes the matching registration, and treats already-missing resources as success. A failure after destruction leaves the stale registration for Repair. Delete works for failed and incomplete children so no CLI cleanup is needed.

## 7. Minimal RPC and UI

| RPC | Purpose |
| --- | --- |
| `vm.list` | Pending creates, managed children, available Pi credential names and stored names, progress, status, and safe errors. |
| `vm.detail` | One pending child or sandbox, its registration state, and bounded sandbox/job logs. |
| `vm.create` | Start one idempotent background create and return its generated name. |
| `vm.delete` | Destroy the exact sandbox and remove its registration. |
| `vm.reconcile` | Resume setup and repair missing or stale registrations. |
| `secrets.list` | The five names with `stored` and `environment` sources. No values. |
| `secrets.set` | Write one fixed-name value. The value is never returned. |
| `secrets.delete` | Remove one stored value. |

The single Paseo screen contains:

- A Manage secrets action that adds, replaces, or removes values for the five fixed names without displaying them.
- A Create child button and confirmation with fixed resources and available credential checkboxes marked Stored or Environment.
- Rows for pending creates and managed children with phase, runtime status, and error.
- A detail pane with bounded read-only logs, Repair, and Delete.
- Clear loading, empty, partial-unavailable, and failed states.

There are no metrics, connection-copy controls, custom provider forms, or plugin-specific Open Host action. The registered child is used through Paseo's normal host picker.

## 8. Required verification and release bar

Before feature code, one vertical spike must prove the exact pinned combination of parent daemon, microsandbox SDK/runtime, guest image, and Pi package:

- Guest Node >= 22.19, npm, non-root Pi install, and daemon-user PATH.
- `.init("auto")`, loopback port publish/release, detached survival, stable IDs, config, logs, and job recovery.
- Child registration, routed online, registration removal, and Pi provider refresh.
- Header-only substitution for the five fixed credentials without exposing values, from both stored and parent environment values.

After feature code, the plugin-owned credential store must be verified to persist with owner-only permissions, accept only the five fixed names, and never return a value through an RPC, log, DTO, pending state, or label.

The release test drives the five lifecycle RPCs through create, background progress, Pi readiness, reload during install, Repair, and Delete. It also sets a fake stored credential and verifies it reaches only the allowed substitution path and never appears in RPC output, logs, or persisted plugin state outside microsandbox and protected parent registration state. It verifies one sandbox/job/registration per request ID.

## 9. V2 shopping list

Some ideas for V2 features that would be interesting, just so we don't forget. Can be ignored for now:

- ability to see used VM disk capacity and quick way to enlarge/shrink it

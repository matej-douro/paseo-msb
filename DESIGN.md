# paseo-msb: VM-backed Paseo hosts

Status: design for v1. Implementation not started.

A Paseo plugin that turns microsandbox microVMs into first-class Paseo hosts: create a VM from a form, and it shows up in the host picker like any other machine, with workspaces, Pi agents, terminals, and diffs.

## 1. What it is

A plugin installed on a **parent** daemon. The parent's plugin subprocess owns a swarm of microsandbox microVMs through the `microsandbox` Node SDK. Each VM boots the official Paseo image, gets Pi and its provider credentials, runs a Paseo daemon, and is registered on the parent as a connected host. Paseo materialises that registration as a **routed** host, so every Paseo app that can reach the parent can use the VM as a normal host.

The plugin is the control plane for those VMs. Day to day work happens in Paseo's own host UI, not in the plugin.

## 2. Non-goals for v1

- Relay connections for children. Reachability is through the parent only.
- SSH transport, `msb` CLI wrapping, YAML or `--conf` materialisation.
- Fork and snapshot workflows, templates, prepare-one-fork-many.
- Volumes, host bind mounts, network policy UI, image selection.
- Interactive shell or `exec` into the VM from the plugin UI.
- Agents other than Pi, generic provider-plugin discovery, or user-defined provider mappings.
- Adopting arbitrary or partially configured sandboxes.
- Multiple parents aggregated in one screen, cross-parent migration.
- Per-VM metric history or sparklines.
- Publishing to the plugin registry or npm.

## 3. Architecture

| Module | Runtime | Responsibility |
| --- | --- | --- |
| `index.client.tsx`, `client/` | Paseo app | Screen, sidebar item, Command Center items. React Native primitives only, colors from `theme.colors`. Talks to the daemon over RPC only. |
| `index.server.ts`, `server/` | Daemon subprocess | Owns background operations and the swarm: SDK calls, Pi install jobs, port allocation, secrets, host registration, reconcile, metrics sampling, log tails. |
| `shared/` | Both | Zod RPC contracts, public projections, operation schemas, and the settings schema. |

Live UI updates use client polling in v1. This is a product choice, not a limitation of the plugin API. Polling observes host-side operations; it does not own or drive them.

### Topology

```
Paseo app (desktop / mobile)
  |
  | one connection
  v
parent daemon  ---- plugin subprocess ---- microsandbox runtime
  |                  (SDK)                     |
  |                                            +-- VM sandbox-1  -> guest paseo daemon :6767
  |                                            +-- VM sandbox-2  -> guest paseo daemon :6767
  |
  | routed host registration (hosts.add, authenticated connection to 127.0.0.1:<published port>)
  v
child host  =  VM sandbox-N
```

### Why routed hosts

`client.hosts.add()` writes a registration on the parent daemon. The app observes that directory and mirrors each registration into its own host profiles as a connection of type `routed` (`packages/app/src/runtime/host-runtime.ts`, `syncHostDiscovery`). Traffic to the child is proxied by the parent daemon, so:

- The app never needs a network path to the VM. The parent dials `127.0.0.1:<port>` on its own machine.
- A phone connected to the parent sees the VM host with no pairing, relay, or port forwarding.
- Children need no plugin installed and no Paseo awareness beyond a running daemon.

Two limits come with it. Routing is one hop, so a child cannot expose children of its own through Paseo. The registration `label` is the only human-readable field the app shows for a child, so naming has to carry parent and VM identity.

## 4. State ownership and data model

### Microsandbox owns VMs

Microsandbox's persistent sandbox database is the authoritative VM inventory and configuration store. The plugin does not maintain a second `VmRecord` inventory in Paseo settings.

A resolved VM is projected from `SandboxHandle` and its validated config:

```ts
type ResolvedVm = {
  id: string;               // SandboxHandle.id; rejects same-name replacement
  name: string;             // SandboxHandle.name, "sandbox-N"
  status: SandboxStatus;    // created, starting, running, stopped, crashed, etc.
  label: string;            // managed label, "<parent>/sandbox-N"
  autoStart: boolean;       // managed label
  createdAt: string | null; // SandboxHandle.createdAt
  imagePin: string;         // validated sandbox config
  cpus: number;             // validated sandbox config
  memoryMiB: number;        // validated sandbox config
  hostPort: number;         // validated loopback published-port config
  piBindings: PublicPiBinding[]; // sanitized secret policy, never values
};
```

The SDK exposes config as unknown JSON. The server must decode it into a strict internal schema, derive only the fields it owns, and return an allowlisted public projection. Raw config, environment, connection strings, and secret entries never cross the RPC boundary.

Managed sandboxes carry these labels:

- `paseo-msb=v1`: inventory marker and schema version.
- `paseo-msb-parent=<stable parent id>`: ownership scope.
- `paseo-msb-label=<frozen display label>`.
- `paseo-msb-auto-start=true|false`.
- `paseo-msb-ready=true`: Pi installation and PATH verification completed. This is provisioning readiness, not host online status.

All sandboxes with the plugin marker and current parent label are listed directly from microsandbox, including after settings reset or plugin reinstall. Sandboxes belonging to another parent are ignored. Malformed or unsupported managed config produces an `incompatible` finding; it is never silently adopted, repaired, started, or registered.

The stable microsandbox sandbox ID is also the registration `sourceKey`. Registration metadata is `{ source: "paseo-msb", vm: <sandbox id>, name: <sandbox name> }`.

### Parent daemon owns registrations

`hosts.list()` is authoritative for registration ID, routed server ID, online state, last-online time, and registration errors. The plugin does not mirror those values into a VM record. Registration credentials remain in the parent's protected host configuration and are never returned by host list APIs.

### Paseo settings own only control-plane state

One host-scoped settings document, id `control`, is versioned and uses atomic revision-checked saves. It contains the monotonic name counter and create operations, not a duplicate VM inventory:

```ts
type ControlDocument = {
  nextSandboxNumber: number;
  operations: Record<string, CreateOperation>;
};

type CreateOperation = {
  id: string;
  idempotencyKey: string;
  sandboxName: string;
  phase: "creating" | "installing" | "registering" | "waiting-online" |
    "refreshing" | "ready" | "failed";
  sandboxId: string | null;
  installJobId: string | null;
  registrationId: string | null;
  request: CreateVmRequest; // resource inputs and credential source keys, no secret values
  error: { code: string; message: string } | null;
  createdAt: string;
  updatedAt: string;
};
```

The document is ordinary host JSON and contains no credentials. Terminal operations are retained in a bounded recent history so users can return to results and diagnostics. Active operations always remain until they reach a terminal state or are explicitly resolved.

### Availability and failure safety

A failed microsandbox list, config read, or parent host list means **unavailable**, not empty. Status responses still return whichever authoritative projections are available. Reconcile makes no mutations when an inventory needed for a decision is unavailable or ambiguous.

### Drift model

Because microsandbox is the VM inventory, settings loss does not create unmanaged VMs or missing VM records.

| Finding | Meaning | Explicit reconcile repair |
| --- | --- | --- |
| `unregistered` | Ready sandbox has no matching registration and no active create | Register it |
| `stale-registration` | Plugin-owned registration has no matching sandbox | Remove it after ownership checks |
| `registration-conflict` | Duplicate, foreign, or mismatched registration claims a sandbox | Report only |
| `host-unreachable` | Ready, running VM has a registration error or remains offline unexpectedly | Report only |
| `provisioning-incomplete` | Sandbox lacks the ready label or has an active/failed create | Never auto-register or autoStart |
| `interrupted-operation` | Persisted operation cannot be resumed safely | Report with retry or dismiss action when valid |
| `incompatible` | Managed sandbox labels or config cannot be decoded safely | Report only |

Stopped VMs are expected to have offline registrations and are not unreachable findings. Reconcile never starts, stops, creates, or deletes a sandbox. Adoption and unmanaged-sandbox removal are outside v1.

## 5. Background operations and lifecycle

### Operation contract

`vm.create` validates input, reserves an operation ID and monotonic sandbox name in one settings save, starts host-side work, and returns the operation ID immediately. The full create does not run in the RPC request lifetime.

The operation runs independently of app navigation, screen mounting, and polling. `vm.list`, `vm.detail`, and `vm.operation` expose current and recent progress whenever the user returns. The screen lists active creates separately or inline with their target sandbox name once it exists.

A per-name create lock and per-sandbox lifecycle lock prevent concurrent mutations. Settings compare-and-swap protects the counter and operation transitions. RPC retries with the same idempotency key return the existing operation instead of creating another VM.

### Create

The background runner performs these steps, persisting the phase and relevant IDs after each commit:

1. Resolve and validate Pi credential sources and parent feature support before side effects.
2. Allocate a free loopback host port. Check both a bind probe and ports already present in managed sandbox configs.
3. Generate the child daemon password. It remains within the parent trust boundary and is never written to plugin settings or RPC responses.
4. Create the detached sandbox with the pinned image, resources, loopback `portBind`, managed labels, Pi secrets, `PASEO_PASSWORD`, `script("install-pi", ...)`, and `init("auto")`. Persist `SandboxHandle.id`.
5. Start Pi installation as the `paseo` user with `execDetachedWith(...)`, persist the microsandbox job ID, and inspect the job until it exits. Use `npm install -g --ignore-scripts @earendil-works/pi-coding-agent`.
6. Confirm Pi resolves on the daemon user's PATH. Only then set `paseo-msb-ready=true`.
7. Register an authenticated loopback connection with `hosts.add({ connection, label, metadata, sourceKey })`. The exact credential-bearing connection grammar is verified by spike; credentials are redacted from all logs and errors.
8. Wait for the routed host to report online.
9. Refresh providers through `paseo.hosts.client(childId)` and confirm Pi appears. A refresh failure leaves a working registration and produces a warning, not a rollback.
10. Mark the operation ready. Online state remains derived from the parent, not copied into the ready label.

Failure leaves the sandbox, registration, operation, and available logs for inspection. Nothing is silently removed. A retry is allowed only when the failure is known to have occurred before sandbox creation, or when recovery has proved that no sandbox exists. Retry reuses the operation and name but may generate a fresh password and port reservation.

### Reload and crash recovery

Detached sandboxes and detached microsandbox jobs outlive the plugin subprocess. On init, the runner reconciles each unfinished operation with microsandbox and the parent before doing any new work:

- An existing sandbox ID must match the persisted name and operation identity.
- An existing install job is inspected by ID, and its persisted output remains available through the job API.
- When registration needs the child password, the server rereads it from raw managed config inside the parent trust boundary.
- An existing registration is found by `sourceKey` before considering another add.
- A resumable operation continues from its last committed step.
- An uncertain pre-create step becomes `phase=failed` with error code `interrupted` and may be retried only after proving no sandbox exists.
- An uncertain later step becomes `phase=failed` with error code `interrupted` and diagnostics. It never blindly repeats creation, installation, registration, or deletion.

Plugin teardown stops waiting and releases handles, but does not stop detached sandboxes or install jobs.

### Start, stop, restart, delete

- Start requires the ready label. Use the persisted handle or `Sandbox.get(name)`, start detached when needed, re-register if missing, and wait for online. Never recreate a missing sandbox.
- Stop uses the stable handle and leaves registration intact.
- Restart uses the stable handle and the same online wait as start.
- Delete requires explicit confirmation, destroys the exact sandbox by stable identity, removes its matching registration, then resolves any operation history. Missing sandboxes and registrations are idempotent outcomes. A failure after sandbox destruction leaves a stale registration for explicit retry or reconcile.

### Plugin load and autoStart

On server init, recover operations first. Then reattach to managed sandboxes and start only stopped sandboxes with both `autoStart=true` and `ready=true`, unless an active operation holds their lock. A failed autoStart is surfaced through status without creating a duplicate VM or registration.

### Reconcile cadence

The management screen polls status while mounted. Reads detect drift but never repair it. Only the explicit `vm.reconcile` mutation performs the registration repairs listed in section 4 and returns findings before and after repair.

## 6. Pi credentials and secrets

V1 installs and refreshes Pi only. It does not implement a generic provider framework.

A fixed, versioned Pi binding catalog maps supported parent credential source keys to guest environment variables, allowed hosts, substitution locations, and placeholder policy. The create form offers only these Pi bindings. The server reports which fixed sources are available through `vm.createOptions`; no credential values are returned.

Provider credentials come from the parent's configured Pi provider credentials and environment. They are never typed into the plugin UI. Host environment references are preferred when the supported source and microsandbox API allow them; otherwise inline values are resolved immediately before sandbox creation.

Microsandbox persists sandbox configuration, including inline secret values and `PASEO_PASSWORD`, on the parent. This is intentional. Access to the parent daemon machine and its plugin/runtime state is the trust boundary. The child password provides defense in depth, not a separate management or credential-vault boundary.

The same rule applies to the authenticated child connection stored in the parent's protected host configuration. The password must not add day-to-day child management complexity. No plugin settings document, public VM projection, log tail, clipboard action, or RPC error may expose it or a Pi credential.

Secret substitution retains microsandbox's documented limits: headers by default, query and body only when enabled, HTTP/2 body substitution unsupported, and blocked placeholders follow the configured violation action. Secret configuration automatically enables TLS interception and installs its CA into the guest trust store.

## 7. Metrics

`allSandboxMetrics()` takes no arguments and returns one map of running sandboxes keyed by name. The server samples on demand, coalesces concurrent calls inside one poll window, and caches only the whole map for that window. It runs no background metrics timer.

A missing key means the sandbox is not running, not an error. Stopped VMs render as "no metrics" with their actual state from microsandbox. Metrics failure is reported as unavailable and never changes VM or registration state.

The list merges the managed sandbox inventory, parent registrations, active operations, and the optional metrics map. Any unavailable input is represented explicitly rather than treated as empty.

## 8. Screen

One screen, master/detail, registered with `addScreen` and exposed through a sidebar header item plus Command Center items. No workspace panel: workspace panels are workspace-scoped and VM hosts belong to no workspace.

**List**

- One row per managed microsandbox: label, runtime state, operation state, CPU, memory, and uptime.
- Active creates appear even before their sandbox exists.
- Incompatible config, registration conflicts, stale registrations, and interrupted operations carry inline warnings.
- Selecting a row loads the detail or operation pane.

**Detail**

- Identity: label, sandbox name and ID, image pin, CPUs, memory, published port.
- Live metrics: CPU, memory, disk and network rates, uptime.
- Log tail: read-only, bounded output from microsandbox sandbox logs and the persisted Pi install job. Early create failures use the bounded host-side operation log.
- Actions: start, stop, restart, delete, open host in Paseo, copy routed host identity and parent-local connection details. The copy text states that loopback is reachable only from the parent.
- No Pi install, refresh, shell, adoption, or unmanaged-removal button in v1.

**Create sheet and progress**

- CPUs, memory, autoStart, and fixed Pi credential bindings. The sandbox name is generated, not entered.
- A standing warning that Pi installation needs outbound internet and microsandbox blocks private, loopback, link-local, and cloud metadata destinations.
- Submit returns immediately and opens progress by operation ID. Dismissing or navigating away never cancels the operation.
- Active and recent operations are available when returning to the screen. Retry is shown only when the recovery rules allow it.

**Reconcile banner**

Lists findings and offers only safe registration repairs. It states that reconcile never starts, stops, or deletes VMs. Incompatible sandboxes and registration conflicts remain manual diagnostic items in v1.

## 9. RPC surface

All contracts are Zod schemas in `shared/`. Public VM DTOs are allowlisted and contain no raw microsandbox config or credentials.

| RPC | Direction | Purpose |
| --- | --- | --- |
| `vm.list` | read | Managed sandboxes, observed registration state, active/recent operations, metrics, drift |
| `vm.detail` | read | One sandbox's public config, state, metrics, latest operation, log tail |
| `vm.createOptions` | read | Resource defaults/bounds and available fixed Pi credential bindings |
| `vm.create` | mutation | Persist and start a background create, returning its operation ID immediately |
| `vm.operation` | read | Reconnect to one active or recent create operation |
| `vm.retryCreate` | mutation | Retry an eligible failed pre-create operation without a second name or VM |
| `vm.start`, `vm.stop`, `vm.restart` | mutation | Lifecycle actions on a stable sandbox identity |
| `vm.delete` | mutation | Destroy exact sandbox and remove its registration |
| `vm.reconcile` | mutation | Repair safe registration drift only |
| `vm.connection` | read | Routed host identity and redacted parent-local connection details |
| `meta.doctor` | read | SDK/runtime availability, image pin, parent features, settings support |

## 10. Failure modes

| Failure | Behaviour |
| --- | --- |
| Microsandbox runtime missing or too old | Create is disabled with an actionable doctor message. Existing sandboxes list when their inventory remains readable. |
| Image pull fails | Operation is `phase=failed` with a safe error, logs, and retry only if no sandbox was created. |
| Boot succeeds, npm install fails | Operation is `phase=failed` with error code `install`, job output remains available, sandbox is not marked ready or registered. |
| Daemon never reaches online | Registration and ready sandbox remain, operation is `phase=failed` with error code `unreachable`, parent registration error is surfaced. |
| Parent lacks connected-host support | Refuse registration before sandbox creation where possible and request a parent update. |
| Port collision | Check managed configs and bind probes, retry within a bounded range; runtime bind conflicts return to allocation without a second operation. |
| Plugin reload during create | Recover from the operation, stable sandbox ID, detached job ID, and parent registration. Never blindly repeat a side effect. |
| Plugin removed while VMs run | Detached VMs and registrations remain. Operations guide warns before removal; the removed plugin cannot render its own warning. |
| Control settings lost or reset | Managed VMs, readiness, autoStart, config, jobs, and registrations remain discoverable. Recover the name counter without reusing observed names; unfinished operations may require explicit resolution. |
| Inventory API unavailable | Return partial status with an explicit unavailable input. Never generate empty-inventory drift or repair registrations. |

## 11. Requirements and compatibility

- Parent daemon must support connected hosts, host registration removal, routed clients, and the plugin settings API. These are the floor for `requirements.paseo` in `paseo-plugin.json`.
- Parent machine needs a working microsandbox local runtime and an SDK/runtime floor supporting stable sandbox IDs, persisted config, paginated label-filtered list, detached jobs and job logs, `.script`, `.secret`, `.portBind`, `.modify`, `.detached`, and `allSandboxMetrics`.
- Guest image: official `ghcr.io/getpaseo/paseo`, pinned by digest. No derived image is built.
- The state model uses APIs present in the inspected `microsandbox` 0.7.14 package. The exact runtime/SDK floor and deployed behavior still require the verification spikes.

## 12. Assumptions to verify before writing feature code

1. The Paseo image ships `npm` and Node new enough for Pi (>= 22.19). If not, the install script has to provide Node first.
2. `.init("auto")` hands PID 1 to the image entrypoint so the guest daemon is supervised, and the daemon stays reachable after the entrypoint drops privileges to `paseo`.
3. A password-protected loopback child can be registered from a plugin handler using the supported authenticated connection grammar, removed through `hosts.remove`, and reach `online` without an app restart.
4. `providers.refresh()` through a routed client picks up newly installed Pi without restarting the guest daemon.
5. Published loopback ports behave under concurrent VMs and release promptly after stop.
6. Detached sandboxes, stable IDs, labels, config, logs, and detached jobs survive plugin reload and daemon restart; `Sandbox.get(name)` and job lookup reattach without replaying work.

## 13. Risks

- **Create latency and recovery**: boot plus npm install can take minutes. Durable operations, detached jobs, and explicit recovery must make progress inspectable without repeating side effects.
- **Sensitive parent state**: microsandbox config and parent host registration contain credentials. Parent access is the trust boundary, so strict RPC allowlists and log redaction remain essential.
- **Credential plumbing**: secret substitution and TLS interception can fail in ways that resemble a bad Pi credential.
- **Config compatibility**: SDK config is unknown JSON and must be versioned and validated rather than trusted structurally.
- **Cross-platform**: Linux and macOS are the initial verification targets; Windows remains unverified in v1.

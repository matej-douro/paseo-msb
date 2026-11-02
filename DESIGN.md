# paseo-msb: VM-backed Paseo hosts

Status: design for v1. Decisions settled by interview; implementation not started.

A Paseo plugin that turns microsandbox microVMs into first-class Paseo hosts: create a VM from a form, and it shows up in the host picker like any other machine, with workspaces, agents, terminals, and diffs.

## 1. What it is

A plugin installed on a **parent** daemon. The parent's plugin subprocess owns a swarm of microsandbox microVMs through the `microsandbox` Node SDK. Each VM boots the official Paseo image, gets Pi and provider credentials, runs a Paseo daemon, and is registered on the parent as a connected host. Paseo materialises that registration as a **routed** host, so every Paseo app that can reach the parent can use the VM as a normal host.

The plugin is the control plane for those VMs. Day to day work happens in Paseo's own host UI, not in the plugin.

## 2. Non-goals for v1

- Relay connections for children. Reachability is through the parent only.
- SSH transport, `msb` CLI wrapping, YAML or `--conf` materialisation.
- Fork and snapshot workflows, templates, prepare-one-fork-many.
- Volumes, host bind mounts, network policy UI, image selection.
- Interactive shell or `exec` into the VM from the plugin UI.
- Multiple parents aggregated in one screen, cross parent migration.
- Per VM metric history or sparklines.
- Publishing to the plugin registry or npm.

## 3. Architecture

| Module | Runtime | Responsibility |
| --- | --- | --- |
| `index.client.tsx`, `client/` | Paseo app | Screen, sidebar item, Command Center items. React Native primitives only, colors from `theme.colors`. Talks to the daemon over RPC only. |
| `index.server.ts`, `server/` | Daemon subprocess | Owns the swarm: SDK calls, Pi install, port allocation, secrets, host registration, reconcile, metrics sampling, log tails. |
| `shared/` | Both | Zod RPC contracts and the settings schema. |

There is no server to client push in the plugin API. Everything live is a client poll over a request/response RPC.

### Topology

```
Paseo app (desktop / mobile)
  |
  | one connection
  v
parent daemon  ---- plugin subprocess ---- microsandbox runtime
  |                  (SDK)                     |
  |                                            +-- VM  sandbox-1  -> guest paseo daemon :6767
  |                                            +-- VM  sandbox-2  -> guest paseo daemon :6767
  |
  | routed host registration (hosts.add, connection 127.0.0.1:<published port>)
  v
child host  =  VM sandbox-N
```

### Why routed hosts

`client.hosts.add()` writes a registration on the parent daemon. The app observes that directory and mirrors each registration into its own host profiles as a connection of type `routed` (`packages/app/src/runtime/host-runtime.ts`, `syncHostDiscovery`). Traffic to the child is proxied by the parent daemon, so:

- The app never needs a network path to the VM. The parent dials `127.0.0.1:<port>` on its own machine.
- A phone connected to the parent sees the VM host with no pairing, relay, or port forwarding.
- Children need no plugin installed and no Paseo awareness beyond a running daemon.

Two limits come with it. Routing is one hop, so a child cannot expose children of its own through Paseo. The registration `label` is the only human readable field the app shows for a child, so naming has to carry parent and VM identity.

## 4. Data model

One host-scoped settings document, id `vms`, versioned, with atomic revision-checked saves (`defineSettings`). The document is ordinary host JSON and is explicitly not a credential vault.

```ts
type VmRecord = {
  id: string;              // stable plugin id, also the sandbox label value
  name: string;            // "sandbox-3", monotonic per parent, never reused
  label: string;           // "<parent>/sandbox-3", frozen at creation
  cpus: number;
  memoryMiB: number;
  imagePin: string;        // digest pinned image reference
  hostPort: number;        // published loopback port on the parent
  daemonPassword: string;  // generated, exported as PASEO_PASSWORD in the guest
  secretBindings: Array<{
    envVar: string;        // guest env var name
    source: string;        // key into the parent provider credential set
    allowedHosts: string[];
    substituteInQuery: boolean;
    substituteInBody: boolean;
  }>;
  registeredHostId: string | null; // registration.registrationId on the parent
  autoStart: boolean;
  createdAt: string;
};
```

Authority model:

- **Desired state**: the settings document.
- **Observed state**: `Sandbox.list()` plus `hosts.list()` on the parent.
- The reconcile pass **repairs registrations only**. It never starts, stops, or deletes a VM on its own. Destructive repair is an explicit user action from the screen.

Reconcile reports these classes of drift:

| Drift | Report | Repairable |
| --- | --- | --- |
| Record exists, sandbox missing | "VM missing" | User may delete the record |
| Sandbox exists with our label, no record | "Unmanaged VM" | User may adopt or remove it |
| Record exists, registration missing | "Unregistered" | Re-register automatically |
| Registration exists, sandbox gone | "Stale host" | Remove registration automatically |
| Registered but never reached online | "Host unreachable" | Surface registration error text |

Sandboxes created by the plugin carry labels `paseo-msb=<id>` so observed state can be matched back to records without trusting the settings document alone. Registrations carry metadata `{ source: "paseo-msb", vm: <id> }` and `sourceKey` set to the record id.

## 5. Lifecycle

### Create

1. Allocate a free loopback host port on the parent. Verify by binding and releasing, then keep it reserved in the record.
2. Generate the daemon password.
3. Build the sandbox: `Sandbox.builder(name)`, pinned image, `cpus`, `memory`, `portBind` for the loopback port, `label("paseo-msb", id)`, secrets from the bindings, `script("install-pi", ...)`, `init("auto")`, `detached(true)`.
4. Boot and wait for the guest.
5. Run the Pi install as the image's non-root `paseo` user: `npm install -g --ignore-scripts @earendil-works/pi-coding-agent`. Installing as root would put Pi in `/root` where the daemon never looks.
6. Confirm Pi resolves on the daemon user's PATH.
7. `hosts.add({ connection: "127.0.0.1:<port>", label, metadata, sourceKey })`.
8. Wait for the routed host to report online.
9. `providers.refresh()` through `paseo.hosts.client(childId)` so the new host's agent list includes Pi immediately.
10. Write the record, mark the VM ready.

Failure at any step leaves the record in a named state (`booting`, `installing`, `registering`, `online`, `failed:<reason>`) and keeps the log tail available. Nothing is silently removed.

### Start, stop, restart, delete

- Start: SDK start, then re-register if the registration was lost, then wait for online.
- Stop: SDK stop. The registration stays, and the host shows offline.
- Restart: SDK restart, wait for online.
- Delete: stop, remove the sandbox, remove the registration, delete the record. Destructive and always explicit.

### Plugin load and autoStart

On server init, records with `autoStart` that are not running are started. VMs run detached, so they survive plugin reload, plugin disable, and daemon restarts, and the plugin reattaches with `Sandbox.get(name)`.

### Reconcile cadence

The management screen polls a status RPC on an interval while it is mounted. Each poll returns VM state, current metrics, and drift findings. A reconcile that mutates registrations runs in the same call and reports what it changed.

## 6. Secrets

Provider credentials come from the parent's configured provider credentials and environment. They are never typed into the plugin UI in v1.

Each VM record carries bindings that control how a credential is presented inside the guest: env var name, allowed hosts, and substitution locations. The server builds microsandbox secrets from those bindings, so the guest holds a placeholder and microsandbox substitutes the real value outside the guest. `.allowPlaceholderFor(...)` covers destinations that should receive the untouched placeholder. Secret configuration automatically enables TLS interception, and microsandbox installs its CA into the guest trust store.

Two documented properties to respect:

- A value supplied inline to the SDK is stored in host side sandbox configuration and survives a stop. Values should therefore come from the parent's credential store, not from a UI field.
- Substitution is limited per secret: headers by default, query and body only when enabled, HTTP/2 body substitution unsupported, and blocked placeholders follow a violation action.

## 7. Metrics

`allSandboxMetrics()` takes no arguments and returns one map of running sandboxes keyed by name. The server samples it at most once per poll window while a client is watching, and returns the map directly. Nothing per VM is cached.

A missing key means the sandbox is not running, not an error. Stopped VMs render as "no metrics" with their last known state from the record.

Because the metrics call covers running sandboxes only, the list view merges three inputs: the settings records, `Sandbox.list()` for existence and state, and the metrics map for live numbers.

## 8. Screen

One screen, master/detail, registered with `addScreen` and exposed through a sidebar header item plus Command Center items. No workspace panel: workspace panels are workspace scoped and VM hosts belong to no workspace.

**List**

- One row per record: label, state, cpu, memory, uptime.
- Rows whose sandbox is missing or whose registration is stale carry an inline warning marker.
- Selecting a row loads the detail pane.

**Detail**

- Identity: label, sandbox name, image pin, cpus, memory, published port.
- Live metrics: cpu, memory, disk and network rates, uptime.
- Log tail: read only, last N lines from `sandbox.logs()` or a bounded `logStream()`. This is the only debugging surface for boot, npm, bind, and provider scan failures, so it is in v1.
- Actions: start, stop, restart, delete, open host in Paseo, copy connection details.
- No Pi install or refresh button in v1. Pi is installed as part of create.

**Create sheet**

- Name, cpus, memory, providers, and per provider secret bindings.
- A standing warning: the Pi install needs outbound internet, and microsandbox blocks private, loopback, link-local, and cloud metadata destinations. No network settings are exposed in v1.

**Reconcile banner**

- Appears at the top of the screen when drift exists. Lists findings, offers the repairs that are safe, and states plainly what will not be touched.

## 9. RPC surface (draft)

All contracts are Zod schemas in `shared/`.

| RPC | Direction | Purpose |
| --- | --- | --- |
| `vm.list` | read | Records plus observed state plus metrics, for the list view |
| `vm.detail` | read | One VM's resolved config, metrics, log tail |
| `vm.create` | mutation | Full create sequence, progress reported by polling |
| `vm.start`, `vm.stop`, `vm.restart` | mutation | Lifecycle |
| `vm.delete` | mutation | Stop, remove sandbox, remove registration, remove record |
| `vm.reconcile` | mutation | Repair safe drift, return findings |
| `vm.connection` | read | Connection string and registration identity for copy |
| `meta.doctor` | read | `msb`/SDK availability, image pin, parent feature support |

## 10. Failure modes

| Failure | Behaviour |
| --- | --- |
| microsandbox runtime missing or too old | Create is disabled with an actionable `meta.doctor` message. Existing records still list. |
| Image pull fails | Create fails with the pull error and a retry action. No record is left half written. |
| Boot succeeds, npm install fails | State `failed:install`, log tail available, host is not registered. |
| Daemon never reaches online | Registration kept, state `failed:unreachable`, registration error text surfaced. |
| Parent lacks `features.connectedHosts` | The plugin refuses to register and says the parent daemon needs updating. |
| Port collision | Allocation verifies the port before use and retries with the next free port. |
| Plugin removed while VMs run | Detached VMs keep running. Registrations stay until removed, and the screen says so before removal completes. |
| Settings doc lost or reset | Reconcile finds unmanaged sandboxes by label and offers adoption. Numbers are not reused, so labels stay unique. |

## 11. Requirements and compatibility

- Parent daemon must support connected hosts (`features.connectedHosts`) and the plugin settings API; both are the floor for `requirements.paseo` in `paseo-plugin.json`.
- Parent machine needs a working microsandbox local runtime (KVM on Linux, Apple Silicon on macOS, WHP on Windows) and the microsandbox version that introduced `.script`, `.secret`, `.portBind`, `.detached`, and `allSandboxMetrics`.
- Guest image: official `ghcr.io/getpaseo/paseo`, pinned by digest. It is published as is; no derived image is built.

## 12. Assumptions to verify before writing feature code

1. The Paseo image ships `npm` and a Node new enough for Pi (>= 22.19). If not, the install script has to provide Node first.
2. `.init("auto")` hands PID 1 to the image entrypoint so the guest daemon is supervised, and the daemon stays reachable after the entrypoint drops privileges to `paseo`.
3. `hosts.add()` is callable from a plugin server handler on the deployed daemon version, and a routed registration reaches `online` without an app restart.
4. `providers.refresh()` through a routed client picks up a newly installed Pi without restarting the guest daemon.
5. Published loopback ports behave under several concurrent VMs, and port release is prompt after a VM stop.
6. Detached VMs survive a plugin reload and a daemon restart, and `Sandbox.get(name)` reattaches cleanly.

## 13. Risks

- **Create latency**: boot plus npm install is minutes, not seconds, and the UI has to be honest about progress rather than appearing hung.
- **Credential plumbing**: msb secret binding is the least proven part. A provider whose traffic does not tolerate interception will fail in a way that looks like a bad key.
- **Silent drift**: registrations and records can diverge in ways only the reconcile pass notices, which is why reconcile lives in the screen rather than in a background job.
- **Cross platform**: the parent machine may be a Mac where nested virtualization behaviour differs from Linux, and v1 does not test Windows.

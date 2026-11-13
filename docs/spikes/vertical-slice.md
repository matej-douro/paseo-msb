# Vertical slice results

Task 1 of the v1 plan, recorded in [CHANGELOG.md](../../CHANGELOG.md). Verified on 2026-11-13 on macOS arm64
(Apple silicon), using the real microsandbox runtime, the official Paseo image,
and a real parent daemon.

Command:

```sh
npm run spike:vertical
```

The script is [`scripts/spikes/verify-vertical-slice.mjs`](../../scripts/spikes/verify-vertical-slice.mjs).
It creates one fixed detached sandbox, installs Pi as the non-root `paseo`
user, registers the child with the parent daemon, refreshes providers through
the routed client, restarts the parent daemon, removes the registration, stops
the sandbox, verifies host-port release, and destroys the sandbox. It prints a
JSON summary and exits non-zero on the first failed check.

## Pins used by the remaining tasks

| Item | Pin |
| --- | --- |
| Parent daemon | Paseo `0.15.4` |
| Microsandbox runtime | `msb 0.7.14` |
| Microsandbox TypeScript SDK | `microsandbox@0.7.14` |
| Guest image | `ghcr.io/getpaseo/paseo:0.15.4` |
| Guest image manifest digest | `sha256:9a67fa9cc06e4a2f9d763f21ae7334af2a633580cb8d81cb7deed184020975f5` |
| Guest image config digest | `sha256:2ccf4bcedf02782107e24e08ee13d34598edfb3d6fb563fcd14b37459032f17a` |
| Guest Node | `22.23.4` |
| Guest npm | `10.9.9` |
| Pi package | `@earendil-works/pi-coding-agent@1.1.0` |
| Parent used for the run | isolated home, `127.0.0.1:6780`, serverId `srv_fJT-7cVv-nq_` |

The parent daemon for a reproduction run must be reachable before the script
starts. One isolated setup is:

```sh
npm install
paseo daemon config set daemon.listen 127.0.0.1:6780 --home "$PWD/.scratch/paseo-home"
paseo daemon start --home "$PWD/.scratch/paseo-home"
PASEO_HOME="$PWD/.scratch/paseo-home" PASEO_PARENT_URL=ws://127.0.0.1:6780/ws \
  npm run spike:vertical
```

`SPIKE_KEEP=1` leaves the sandbox running for inspection. `SPIKE_SANDBOX`,
`SPIKE_IMAGE`, `SPIKE_PI_VERSION`, and `SPIKE_PORT` override the defaults.

## Acceptance results

### Pins recorded

The script records the values in the table above from `msb --version`,
`msb image inspect --format json`, the installed `microsandbox` package, and
`paseo --version` at run time.

### Guest Node, npm, `.init`, and non-root Pi

- Guest Node is `v22.23.4` (floor is 22.19) and npm is `10.9.9`.
- Commands run as `uid=1000(paseo)`.
- `.init("auto")` **does not work with this image**. The image entrypoint is
  `/usr/bin/tini -- /usr/local/bin/paseo-docker-entrypoint`; `auto` probes
  `/sbin/init`, `/lib/systemd/systemd`, and `/usr/lib/systemd/systemd`, finds
  none, and fails the handoff.
- Required narrow fallback: `.init("/usr/bin/tini", ["--",
  "/usr/local/bin/paseo-docker-entrypoint"])`.
- Pi installs non-root with
  `npm install -g --ignore-scripts --prefix /home/paseo/.local
  @earendil-works/pi-coding-agent@1.1.0` as `paseo`.
- The sandbox is created with
  `PATH=/home/paseo/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`
  so the child daemon, not just an interactive exec, sees `pi`.
  `paseo --host <child> provider diagnostic pi --json` reports
  `Resolved path: /home/paseo/.local/bin/pi`, `Version: 1.1.0`, `Status: Ready`.

### Loopback publishing

- `.port(0, 6767)` is **not supported**. The sandbox config records
  `host_port: 0` and `msb status` shows `127.0.0.1:0->6767/tcp`; the runtime
  does not allocate an ephemeral host port.
- Required narrow fallback: probe a free loopback port on the host by binding
  `127.0.0.1:0`, close it, create the sandbox with that explicit host port, and
  retry on a bind failure.
- An explicit port publishes correctly and the child serves the Paseo web UI
  with HTTP 200. After `stop()`, the same host port binds again promptly.

### Detached survival, labels, config, logs, and jobs

- The detached VM stays `running` across a parent-daemon restart.
- Labels survive: `paseo-msb=v1`, `paseo-msb-parent=<parent serverId>`,
  `paseo-msb-id=<stable sandbox id>`, `paseo-msb-phase=registering`, and
  `paseo-msb-job=<job id>`. The stable ID and job ID were written with
  `SandboxHandle.modify({ labels })` after creation.
- Sandbox config and captured logs are readable after the restart.
- `SandboxHandle.getJob(jobId)` is async and the detached job (state `exited`,
  exit code `0`) remains inspectable after the restart.
- A same-name replacement gets a different stable ID, and a stale handle's
  `destroy()` refuses to destroy the replacement.
- The spike simulated a plugin reload by disposing and recreating the Paseo
  client. The VM, job, and registration are host-side state and are unaffected.
  A real plugin-subprocess reload is exercised by task 4/6 once the plugin
  exists.

### Loopback child without `PASEO_PASSWORD`

- The child daemon starts with no `PASEO_PASSWORD` and answers HTTP 200 on the
  loopback-published port.
- `hosts.add({ connection: "127.0.0.1:<port>", label:
  "<parent serverId>/<sandbox name>", metadata: { source: "paseo-msb", vm:
  <stable id>, name: <name> }, sourceKey: <stable id> })` reaches
  `status: "online"` with a child `serverId`.
- `hosts.remove(registrationId)` removes it.
- Through the routed client, `providers.refresh({ providers: ["pi"] })` returns
  `{ acknowledged: true }` and `providers.snapshot({})` reports `pi` with
  `status: "ready"`.

### Secrets

- All five fixed guest variables are placeholders in the guest environment:
  `$MSB_ANTHROPIC_API_KEY`, `$MSB_OPENAI_API_KEY`, `$MSB_GEMINI_API_KEY`,
  `$MSB_NEURALWATT_API_KEY`, and `$MSB_GH_TOKEN`. No fake value appeared in the
  guest environment.
- Config entries have `placeholder: "$MSB_<name>"`,
  `substitution: { headers: true, query: false, body: false }`, and the exact
  allowed-host mappings from the design. `GH_TOKEN` has all three hosts.
- Header-only substitution was proven against a controlled HTTPS endpoint at
  `host.microsandbox.internal` with a local CA and a leaf certificate. The
  guest sent the placeholder in `Authorization` and another header:
  - both headers arrived upstream as the real fake value;
  - the query string and request body still contained the placeholder;
  - the upstream received exactly one request for the allowed call.
- Blocked-destination behavior was proven with a second secret allowed only for
  `api.anthropic.com`. Sending its placeholder to the controlled endpoint
  returned HTTP 403 and the upstream received no request.

## Notes for the plugin implementation

- The SDK's `SandboxHandle.config()` returns **camelCase** (`envVar`,
  `allowedHosts`, `substitution.headers`, `memoryMib`). `msb inspect --format
  json` returns snake_case. Task 2's strict config decoder must not assume the
  CLI shape.
- Secrets configured with `.value(...)` persist the value in the durable
  sandbox config (`value` is non-empty). That is inside
  parent-controlled microsandbox state, as the design allows, but task 2 must
  keep `value` out of every public DTO and log.
- `Sandbox.get(name)` returns a `SandboxHandle`; `getJob()` is async.
  `destroy({ force: true, timeoutMs })` bounds teardown.
- `providers.refresh()` only acknowledges the request. Confirm availability
  with `providers.snapshot()` (or `provider diagnostic`) as the script does.
- Set the daemon-user `PATH` on the sandbox at creation. `msb exec` uses a
  different default `PATH` than the daemon process, so an interactive
  `command -v pi` is not sufficient evidence.
- The child `serverId` changes if the sandbox is recreated. Persist and compare
  the stable sandbox ID, not the child `serverId`, for ownership checks.
- A parent-daemon restart reconnects the saved registration automatically; the
  plugin does not need to re-add it on startup.
- Paseo compiles plugin server code to CommonJS, which turns `import.meta.url`
  into `undefined`. The `microsandbox` ESM SDK uses `import.meta.url` to resolve
  its native binding, so a static import fails plugin load with
  `The argument 'filename' must be a file URL object... Received undefined`.
  Load the installed package at runtime from the plugin directory (readable via
  `paseo.config.get()`) instead of bundling it.

## Scope

No product scope was added. The fallbacks are limited to the pinned image:
explicit tini init, host-port probing, and a test-only local CA for the
controlled HTTPS fixture. The production secret configuration remains
header-only substitution to the fixed upstream hosts.

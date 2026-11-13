# paseo-msb

A Paseo plugin that turns microsandbox microVMs into first-class Paseo hosts.

Create a fixed-size child VM with selected Pi credentials and it appears in the
Paseo host picker like any other machine, with its own workspaces, Pi agents,
terminals, and diffs. Creation, repair, and deletion happen in the plugin's
Paseo UI; day-to-day work happens in Paseo's normal host UI.

Design: [DESIGN.md](./DESIGN.md).
Implementation plan: [TASKS.md](./TASKS.md).

## Requirements

- Paseo parent daemon `0.15.4` or newer (verified on `0.15.4`).
- microsandbox runtime `msb 0.7.14` and TypeScript SDK `microsandbox@0.7.14`
  on the parent host.
- A host with microVM support (verified on macOS arm64 / Apple silicon).
- Guest image `ghcr.io/getpaseo/paseo:0.15.4`
  (manifest `sha256:9a67fa9cc06e4a2f9d763f21ae7334af2a633580cb8d81cb7deed184020975f5`,
  config `sha256:2ccf4bcedf02782107e24e08ee13d34598edfb3d6fb563fcd14b37459032f17a`).
- Guest Node `>= 22.19` (the pinned image has `22.23.4`) and npm.
- Pi package `@earendil-works/pi-coding-agent@1.1.0`, installed inside the child
  by the plugin.
- A parent daemon user that can run the microsandbox runtime and bind loopback
  ports.
- Plugins globally enabled in the parent daemon
  (`paseo daemon config set pluginsEnabled true`).

The plugin is installed as a directory plugin from this checkout. Use an
isolated `PASEO_HOME` when developing so test children and credentials do not
mix with your normal Paseo state.

## Credentials

The plugin accepts exactly five fixed credential names:

`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `NEURALWATT_API_KEY`, `GH_TOKEN`.

Each name maps to a fixed set of upstream hosts:

| Guest environment variable | Allowed upstream hosts |
| --- | --- |
| `ANTHROPIC_API_KEY` | `api.anthropic.com` |
| `OPENAI_API_KEY` | `api.openai.com` |
| `GEMINI_API_KEY` | `generativelanguage.googleapis.com` |
| `NEURALWATT_API_KEY` | `api.neuralwatt.com` |
| `GH_TOKEN` | `api.github.com`, `github.com`, `uploads.github.com` |

Values come from the plugin store first, then the parent daemon environment.
The store lives at `<PASEO_HOME>/plugin-data/paseo-msb/secrets.json`
(directory `0700`, file `0600`) and can be relocated with
`PASEO_MSB_SECRETS_FILE`. Existing VMs keep the values they were created with.

Open **Manage secrets** in the plugin screen to add, replace, or remove values.
Only names and sources are ever shown or returned by an RPC. A value is sent to
microsandbox once at creation, appears only in parent-controlled microsandbox
config, and is redacted from logs and safe errors. Create requires at least one
available credential name.

## Operation

### Create

The create confirmation shows the fixed image and resources and lists available
credential names as **Stored** or **Environment**. It requires at least one
name and never accepts or displays a value.

The child name is generated from one UUID per logical create attempt. The RPC
returns immediately; the plugin then:

1. creates a detached, fixed `2 CPU` / `2048 MiB` sandbox from the pinned image
   with a loopback-only published child port;
2. installs Pi as the non-root `paseo` user in a detached job;
3. registers the child with the parent and waits for routed online;
4. refreshes Pi in the child and marks the child `ready`.

Progress is read from sandbox labels, so list/detail polling can observe it and
can be stopped without stopping host work.

### Repair

Repair (`vm.reconcile`) resumes an unambiguous interrupted install or
registration using the persisted sandbox and job IDs, restores a missing
registration for a Pi-ready sandbox, and removes a plugin-owned registration
whose sandbox is gone. It never creates, starts, adopts, or deletes a sandbox,
and it reports ambiguous or foreign state instead of guessing.

### Delete

Delete requires the exact generated name and stable sandbox ID, destroys that
sandbox, and removes its matching registration. Already-missing resources count
as success, so repeated deletes are safe. Failed or incomplete children can be
deleted without CLI cleanup. If removal fails after the sandbox is destroyed,
the leftover registration can be removed by Repair.

### Use

Open a ready child through Paseo's normal host picker. There are no
plugin-specific copy, shell, metrics, start/stop, or custom provider controls.

### Failure diagnostics

List and detail show the fixed safe code plus a bounded, redacted reason when
the plugin has one, for example an image pull, Pi install, registration, or
native-runtime error. The same text is stored on failed sandboxes as the
`paseo-msb-error-detail` label. Credential values are redacted before the text
enters pending state, a label, an RPC response, or a log, and control
characters are stripped and the length is capped.

## Trust boundary

The child daemon is published only on parent loopback and runs without
`PASEO_PASSWORD`. The authenticated parent daemon is the security boundary; the
child is not exposed to the network. Credential substitution is header-only and
limited to the fixed hosts above. TLS interception and guest CA setup are
microsandbox responsibilities.

## Reload and recovery limitations

Labelled sandboxes, detached Pi install jobs, and parent registrations survive
plugin and parent-daemon restarts. On first use after a plugin reload, recovery
rediscovers labelled sandboxes and resumes only setup whose persisted IDs make
the next step unambiguous.

A reload before a sandbox exists can lose the empty pending create; retrying
that request ID is safe. A stopped VM is not started automatically, and there is
no operation history. Uncertain interrupted setup remains failed until Repair or
Delete.

## Development

```sh
npm install
npm run typecheck
npm test
```

`npm test` runs the unit and contract tests. The real-runtime integration test is
skipped unless `PASEO_PARENT_URL` is set (or `PASEO_MSB_RELEASE_TEST=1`).

## Release test

The mandatory vertical release test runs against a real parent daemon, the
verified microsandbox runtime, the pinned guest image, and the pinned Pi
package. It installs (or reloads) this checkout as a directory plugin, then
drives `vm.create`, `vm.list`, `vm.detail`, `vm.reconcile`, and `vm.delete`
through the plugin RPCs. It also:

- reloads the plugin during the Pi installation and verifies one sandbox, one
  detached job, and one registration remain;
- stores one fake fixed credential, verifies it reaches only the allowed
  microsandbox secret entry with header-only substitution, and verifies it never
  appears in RPC output, plugin logs, sandbox logs, pending state, or test
  artifacts;
- restores a missing registration and removes a stale one without creating a
  second VM;
- deletes the exact sandbox and registration, then repeats delete and Repair
  safely.

Start a parent daemon on the verified pins first. One isolated setup:

```sh
# terminal 1
export PASEO_HOME="$PWD/.scratch/release-home"
npx -y @getpaseo/cli@0.15.4 daemon config set daemon.listen 127.0.0.1:6792 --home "$PASEO_HOME"
npx -y @getpaseo/cli@0.15.4 daemon config set pluginsEnabled true --home "$PASEO_HOME"
npx -y @getpaseo/cli@0.15.4 daemon start --home "$PASEO_HOME"

# terminal 2
PASEO_PARENT_URL=ws://127.0.0.1:6792/ws npm run test:release
```

The parent must be able to load the microsandbox native addon from the plugin
process. On macOS, the signed Paseo app runs plugin processes with the hardened
runtime, which can reject microsandbox's ad-hoc-signed addon even though the
same code works from `node`. The command above uses the published
`@getpaseo/cli@0.15.4` under system Node for that reason; use any other parent
that can load the addon for the release check.

The test requires at least one of the five credential names to be unused in the
plugin store, because it stores a fake value under that name and removes it
afterwards. An isolated `PASEO_HOME` satisfies this. Set `PASEO_PASSWORD` when
the parent daemon requires authentication. Set `PASEO_MSB_SECRETS_FILE` on the
**parent daemon process** to relocate the plugin store; the test discovers the
active path through `secrets.list`.

Spike results and the original pin verification:
[docs/spikes/vertical-slice.md](./docs/spikes/vertical-slice.md).

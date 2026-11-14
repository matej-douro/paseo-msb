# paseo-msb

A Paseo plugin that turns microsandbox microVMs into first-class Paseo hosts.

Create a fixed-size child VM with selected agent providers and integrations and it appears in the
Paseo host picker like any other machine, with its own workspaces, agents, terminals, and diffs.
Creation, repair, and deletion happen in the plugin's Paseo UI; day-to-day work happens in Paseo's
normal host UI.

Design: [DESIGN.md](./DESIGN.md).
Provisioning design, including the prepared shared layer and the remaining wiring: [docs/provisioning.md](./docs/provisioning.md).
Open tasks: [TASKS.md](./TASKS.md).
Change history: [CHANGELOG.md](./CHANGELOG.md).

## Requirements

- Paseo parent daemon `0.15.4` or newer (verified on `0.15.4`).
- microsandbox runtime `msb 0.7.14` and TypeScript SDK `microsandbox@0.7.14`
  on the parent host.
- A host with microVM support (verified on macOS arm64 / Apple silicon).
- Guest image `ghcr.io/getpaseo/paseo:0.15.4`
  (manifest `sha256:9a67fa9cc06e4a2f9d763f21ae7334af2a633580cb8d81cb7deed184020975f5`,
  config `sha256:2ccf4bcedf02782107e24e08ee13d34598edfb3d6fb563fcd14b37459032f17a`).
- Guest Node `>= 22.19` (the pinned image has `22.23.4`) and npm.
- Pi package `@earendil-works/pi-coding-agent@1.5.2`, installed inside the child
  by the plugin.
- NeuralWatt Pi extension `@aliou/pi-neuralwatt@0.19.3`, installed when
  NeuralWatt is selected for Pi.
- Claude Code `2.1.323`, installed when Claude is selected.
- GitHub CLI `2.104.0`, installed when the GitHub CLI integration is selected.
- A parent daemon user that can run the microsandbox runtime and bind loopback
  ports.
- Plugins globally enabled in the parent daemon
  (`paseo daemon config set pluginsEnabled true`).

The plugin is installed as a directory plugin from this checkout. Use an
isolated `PASEO_HOME` when developing so test children and credentials do not
mix with your normal Paseo state.

## Credentials

The plugin accepts exactly six fixed credential names:

`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `OPENAI_API_KEY`, `GEMINI_API_KEY`,
`NEURALWATT_API_KEY`, `GH_TOKEN`.

Each name maps to a fixed set of upstream hosts:

| Guest environment variable | Allowed upstream hosts |
| --- | --- |
| `ANTHROPIC_API_KEY` | `api.anthropic.com` |
| `CLAUDE_CODE_OAUTH_TOKEN` | `api.anthropic.com` |
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
provider, and only the credentials required by the selected providers and
integrations are sent to the child.

## Operation

### Create

The create confirmation shows the fixed image and resources, a **Providers**
section, and an **Integrations** section. Secrets decide which options are
available; selecting an option decides which credentials enter the sandbox.
Claude takes exactly one auth option (Anthropic API key or Claude subscription);
Pi takes one or more LLM options (Anthropic, OpenAI, Gemini, NeuralWatt). The
GitHub CLI integration is independent and unchecked by default.

The child name is generated from one UUID per logical create attempt
(`paseo-<requestId>`). The name is the logical identity; the current microsandbox
generation is its exact `handle.id`. The RPC returns immediately; one idempotent
reconciler per name then:

1. creates a detached, fixed `2 CPU` / `4096 MiB` sandbox from the pinned image
   with a loopback-only published child port, the canonical plan in
   `PASEO_MSB_PLAN`, and only the selected header-only secrets;
2. writes a content-addressed `/home/paseo/.paseo-msb/provision-<planHash>.sh`
   and runs it as one detached job; each step probes first, so retries skip
   already-satisfied work;
3. registers the exact generation with the parent, waits for routed online, and
   confirms every selected provider in Paseo's provider snapshot;
4. marks the child `ready`.

Progress is a phase label (`creating`, `installing`, `registering`, `ready`,
`deleting`), so list/detail polling can observe it and can be stopped without
stopping host work. Phase is a hint, not proof that a side effect happened.
`installing` now means provisioning the selected providers and integrations.

New sandboxes do not write stable-ID or job-ID labels. A repeated create for the
same request joins the same reconciliation and must use the original plan;
legacy children without `PASEO_MSB_PLAN` are treated as Pi-only. Reusing a
request after a fully confirmed Delete creates a new generation. All
provisioning failures are fatal and keep the sandbox for inspection and retry; a
failed pending create can be retried from its detail with the original request
ID and plan.

### Repair

Repair (`vm.reconcile`) runs the same reconciler. It resumes an unambiguous
interrupted provisioning or registration, restores a missing registration for a
provisioned sandbox, and removes a confirmed stale plugin-owned registration. It
never creates, starts, adopts, or initiates deletion and reports ambiguous or
foreign state instead of guessing. A child already carrying a `deleting`
tombstone has that Delete cleanup completed.

Provision recovery reads `/home/paseo/.paseo-msb/status.json` first; a successful
status for the plan hash is the only success proof. Active matching jobs are
awaited, job-inventory failures never launch another job, and a retry re-runs the
idempotent script so completed steps are skipped. Registration identity is the
authenticated producer `plugin:paseo-msb` plus the exact generation id; metadata
and labels are configuration, not ownership proof. A user-disabled registration
is preserved, not re-enabled.

Registration-only children remain visible and actionable. A same-request Create
first removes only registrations whose generation is proven gone, re-checks the
runtime, then either advances the generation that appeared or creates one; it
never leaves a permanent pending row behind.

### Delete

Delete requires the exact generated name and current generation id. In the same
per-name lane it persists `deleting` before destruction, re-reads the exact
handle, destroys that generation, and removes only the matching
`(plugin:paseo-msb, id)` registration. A stale id cannot destroy a newer
same-name generation. If the tombstone cannot be written, the VM is not
destroyed.

Already-missing resources count as success, so repeated deletes are safe. Failed
and incomplete children can be deleted without CLI cleanup. If removal fails
after the sandbox is destroyed, a registration-only child remains for Repair or
Delete. Reload during deletion resumes cleanup, never setup.

### Use

Open a ready child through Paseo's normal host picker. There are no
plugin-specific copy, shell, metrics, start/stop, or custom provider controls.

### Failure diagnostics

List and detail show the fixed safe code plus a bounded, redacted reason when
the plugin has one, for example an image pull, provisioning step, registration,
or native-runtime error. Setup errors keep the actionable phase and store the
same text as the `paseo-msb-error-detail` label.

Redaction is centralized and covers current environment and store values plus
relevant values from managed VM config, so removing or replacing a stored value
does not disable redaction for an existing VM. Credential values are redacted
before text enters pending state, a label, an RPC response, or a log; control
characters are stripped and the length is capped. Provisioning failures are
fatal but retryable through Repair or Retry create. Retryable codes include
`provision_pending`, `provision_conflict`, `job_inventory_unavailable`,
`registration_failed`, `registration_timeout`, and `provider_unavailable`.

## Native addon troubleshooting

If `vm.list` reports `Microsandbox inventory is unavailable` with
`Cannot find native binding. npm has a bug related to optional dependencies…`,
the npm hint is usually misleading. Run:

```sh
npm run check:native
```

It loads the pinned addon under system Node and, when present, under the signed
`/Applications/Paseo.app` runtime, printing the actual cause chain. Each line is
only the last error napi-rs saw; the loader hides the real reason.

On macOS the observed failure is a `dlopen` error such as:

```text
mapping process and mapped file (non-platform) have different Team IDs
```

The published addon is ad-hoc signed (no Team ID), while `Paseo.app` runs with
the hardened runtime and does not carry
`com.apple.security.cs.disable-library-validation`. macOS therefore refuses to
map the addon into the app's plugin process. Reinstalling `node_modules` cannot
change that, and the addon itself is fine under system Node.

Use a parent daemon that runs under system Node for this plugin (for example
`@getpaseo/cli`, as in the release instructions below), or a Paseo build that is
signed/permitted to load the addon. Inventory and detail errors include the full
cause chain, so the dlopen reason is visible in the UI rather than only the npm
hint.

## Trust boundary

The child daemon is published only on parent loopback and runs without
`PASEO_PASSWORD`. The authenticated parent daemon is the security boundary; the
child is not exposed to the network. Credential substitution is header-only and
limited to the fixed hosts above. TLS interception and guest CA setup are
microsandbox responsibilities.

## Reload and recovery limitations

Labelled sandboxes, detached Pi install jobs, and parent registrations survive
plugin and parent-daemon restarts. On first use after a plugin reload, recovery
rediscovers labelled sandboxes and plugin-owned registrations and feeds each
name to the same reconciler. It does not create, start, or adopt a VM. The only
destroy it performs is completing an explicit `deleting` tombstone.

Plugin cleanup permanently closes every lane before it waits, so no in-flight or
queued Create, recovery, Repair target, or Delete can start a side effect during
or after teardown. Job, guest, label, log, and parent-directory calls are bounded
and carry the lane's abort signal. A reload before a sandbox exists removes the
cancelled pending attempt; retrying that request ID is safe. A stopped VM is not
started automatically, and there is no operation history. Uncertain setup keeps
its actionable phase and a safe error until Repair or Delete.

Legacy `paseo-msb-id` and `paseo-msb-job` labels are read only for migration. A
matching legacy ID is tolerated; a mismatched legacy ID quarantines the VM as
`id_mismatch` instead of adopting it. A legacy `failed` phase is reclassified
from the complete job inventory: an active install is awaited, a successful job
wins, a confirmed failed job stays terminal, and no job history permits one
idempotent install. Existing registrations are updated to the current metadata
shape on their next successful reconciliation.

The pinned SDK's `modify()` is not generation-bound: a same-name replacement can
receive a stale handle's label write. Label writes therefore refresh and compare
the exact id first and are never used as destructive authority. Stale-
registration cleanup re-reads the runtime at removal time. The remaining window,
and why it is not claimed closed, is documented in [DESIGN.md](./DESIGN.md).

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
verified microsandbox runtime, the pinned guest image, and the pinned provider
toolchain. It installs (or reloads) this checkout as a directory plugin, then
drives `vm.create`, `vm.list`, `vm.detail`, `vm.reconcile`, and `vm.delete`
through the plugin RPCs. It also:

- creates a provider plan from one unused model credential and verifies the
  content-addressed provision job and `status.json` are the ones for that plan;
- reloads the plugin during provisioning and verifies one sandbox, one relevant
  detached job, and one registration remain;
- asserts the pinned parent daemon, microsandbox SDK, guest image, and the
  selected provider's version;
- verifies Paseo's provider snapshot reports every selected provider ready;
- stores or reads each selected fixed credential, verifies it reaches only the
  allowed microsandbox secret entry with header-only substitution, and verifies
  it never appears in RPC output, plugin logs, raw sandbox/job/system logs,
  pending state, labels, or test artifacts;
- replaces and then removes every selected value and re-checks detail redaction
  of the creation-time value persisted in the VM config;
- injects a real provisioning failure, asserts it is fatal and keeps the
  sandbox, then retries Repair and verifies completed steps are skipped;
- restores a missing registration, then removes an orphaned plugin-owned
  registration by creating a second child, destroying its sandbox behind the
  plugin, and confirming Repair removes only the registration;
- deletes the exact sandbox and registration, then repeats delete and Repair
  safely.

The test selects one model credential per run by default. The full matrix has
passed on the pinned daemon:

```shell
# Claude-only, store canary, exercises the live provisioning failure
PASEO_MSB_RELEASE_CREDENTIALS=CLAUDE_CODE_OAUTH_TOKEN npm run test:release

# Pi + NeuralWatt + GitHub CLI, with OpenAI supplied by the daemon environment
# and NeuralWatt/GH_TOKEN written to the plugin store
PASEO_MSB_RELEASE_CREDENTIALS=OPENAI_API_KEY,NEURALWATT_API_KEY \
PASEO_MSB_RELEASE_ENV_CREDENTIAL=OPENAI_API_KEY \
PASEO_MSB_RELEASE_ENV_VALUE=paseo-msb-env-canary-1b2c3d4e-5f60-4718-9a2b-3c4d5e6f7081 \
PASEO_MSB_RELEASE_GITHUB_CLI=1 npm run test:release
```

The second run starts the daemon with the same
`OPENAI_API_KEY=paseo-msb-env-canary-...` value. When
`PASEO_MSB_RELEASE_ENV_CREDENTIAL` is set, the test verifies `secrets.list`
reports the value as `environment: true`, `stored: false`, and that redaction
survives store replacement and removal. `PASEO_MSB_RELEASE_GITHUB_CLI=1` adds
the GitHub CLI integration and its `GH_TOKEN` canary.

The failure injection runs whenever the plan includes Claude or the GitHub CLI.
It corrupts the Claude settings file or removes `gh` and makes its install
directory read-only, discards `status.json`, and forces Repair to re-provision.
The test asserts the non-zero job is `provision_failed`, the sandbox and
registration are kept, and a later Repair reports every previously completed
step as `skipped` while the failed step becomes `ok`.

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
**parent daemon process** to relocate the plugin store; no RPC exposes the store
path.

Spike results and the original pin verification:
[docs/spikes/vertical-slice.md](./docs/spikes/vertical-slice.md).

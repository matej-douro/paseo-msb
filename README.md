# paseo-msb

A Paseo plugin that turns microsandbox microVMs into first-class Paseo hosts. A
child VM with selected providers and integrations appears in Paseo's normal host
picker with its own workspaces, agents, terminals, and diffs. Create, Repair,
and Delete happen in the plugin screen; day-to-day work uses Paseo's host UI.

Docs: [DESIGN.md](./DESIGN.md) · [provisioning](./docs/provisioning.md) ·
[release test](./docs/release-test.md) · [CHANGELOG.md](./CHANGELOG.md).

## Requirements

- Paseo parent daemon `0.15.4` or newer (verified on `0.15.4`) with plugins
  enabled: `paseo daemon config set pluginsEnabled true`.
- microsandbox runtime `msb 0.7.14` and SDK `microsandbox@0.7.14` on a
  microVM-capable parent host (verified on macOS arm64 / Apple silicon), runnable
  by the daemon user, which must bind loopback ports.
- Guest image tag `ghcr.io/getpaseo/paseo:0.15.4`, Node `>= 22.19` (pinned:
  `22.23.4`), and npm.
- When selected: Pi `1.5.2`, NeuralWatt Pi extension `0.19.3`, Claude Code
  `2.1.323`, GitHub CLI `2.104.0`. The Paseo tools integration uses the child
  daemon's bundled orchestration skills and adds no guest package or credential.
  Every child also receives the plugin's `paseo-msb-vm` setup skill under
  `~/.agents/skills` and `~/.claude/skills`.

Install this checkout as a directory plugin from the parent daemon. Use an
isolated `PASEO_HOME` while developing. A directory install does not run the
manifest's preparation step, so run `npm install` in the checkout first.

Git and registry installs stage a bare checkout instead, so `paseo-plugin.json`
runs `npm ci --omit=dev --ignore-scripts` to install the runtime dependencies
(`microsandbox`, `zod`, `@getpaseo/client`) that the plugin compiler resolves and
the runtime loader imports. Keep `package-lock.json` in sync with
`package.json`; `npm ci` fails when they disagree.

## Credentials

Exactly six fixed names are accepted: `ANTHROPIC_API_KEY`,
`CLAUDE_CODE_OAUTH_TOKEN`, `OPENAI_API_KEY`, `GEMINI_API_KEY`,
`NEURALWATT_API_KEY`, `GH_TOKEN`. Each maps to fixed upstream hosts:

| Guest variable | Allowed upstream hosts |
| --- | --- |
| `ANTHROPIC_API_KEY` | `api.anthropic.com` |
| `CLAUDE_CODE_OAUTH_TOKEN` | `api.anthropic.com` |
| `OPENAI_API_KEY` | `api.openai.com` |
| `GEMINI_API_KEY` | `generativelanguage.googleapis.com` |
| `NEURALWATT_API_KEY` | `api.neuralwatt.com` |
| `GH_TOKEN` | `api.github.com`, `github.com`, `uploads.github.com` |

Values come from the plugin store first, then the parent environment. The store
is `<PASEO_HOME>/plugin-data/paseo-msb/secrets.json` (`0700` plugin directory,
`0600` file), relocatable with `PASEO_MSB_SECRETS_FILE`. New directories are
`0700`; an existing override parent keeps its permissions. Existing VMs keep
their creation-time values.

**Manage secrets** adds, replaces, or removes values. RPCs return names and
sources only. Values reach microsandbox once at creation, stay in
parent-controlled config, and are redacted from logs and safe errors. Create
checks the store before opening or submitting; an unreadable store fails the
action with an error instead of presenting stale credential availability.

## Create

The confirmation shows the fixed image and editable CPU/RAM/root-disk fields plus
**Providers** and **Integrations** sections. Secrets gate availability; the selection decides which
credentials enter the sandbox. Claude takes one auth option (Anthropic API key or
Claude subscription); Pi takes one or more LLM options (Anthropic, OpenAI,
Gemini, NeuralWatt). GitHub CLI requires `GH_TOKEN`. **Paseo tools** needs no
credential: it enables Paseo tools for the selected providers and installs the
bundled orchestration skills after the child daemon is online. Both integrations
are independent and unchecked by default.

The name is the create identity; the form generates `paseo-<token>` with a
short random token when it is left blank, and the current generation is the
exact microsandbox `handle.id`.
`vm.create` returns immediately, then one idempotent reconciler per name creates
the detached sandbox with the requested CPUs
and RAM (defaults `2 CPU` / `4096 MiB`) and the requested root disk,
with a loopback-only port, `PASEO_MSB_PLAN`, and only the selected header-only
secrets; runs the content-addressed provisioning script as one detached job;
registers the exact generation, waits for routed online, confirms selected
providers, applies the **Paseo tools** integration when selected, then marks it
`ready`.

Phase (`creating`, `installing`, `registering`, `ready`) is a hint,
not proof of a side effect. A repeated Create under the same name joins the same
reconciliation and must use the original plan and resource shape. Provisioning
or **Paseo tools** setup failures are fatal; Retry or Repair re-runs the
idempotent steps and skips completed ones. A failed attempt that has not
produced a sandbox can also be dismissed from its detail.

## Use

Open a ready child through Paseo's normal host picker. There are no
plugin-specific copy, shell, or start/stop controls. A running child's detail
shows a bounded live resource chart for CPU, memory, disk I/O, network, and
root-disk usage; samples exist only while the detail is open and are never
persisted.

## Repair

`vm.reconcile` resumes an unambiguous interrupted provisioning or registration,
restores a missing registration, and removes a confirmed stale plugin-owned
registration. It never creates, starts, adopts, or initiates deletion, and
reports ambiguous or foreign state instead of guessing.

`status.json` for the plan hash is the only provisioning success proof. Active
matching jobs are awaited, and inventory failures never launch another job. A
user-disabled registration is preserved, not re-enabled.

## Delete

Delete requires the exact name and current generation id. It destroys that
generation and then removes every plugin-owned host row for the name. A
replacement VM that happens to reuse the name keeps its own row, and a stale id
cannot destroy it. An unsettled native resize blocks destruction with
`mutation_pending`.

The plugin keeps no deletion tombstone. If it is interrupted between destroying
the VM and removing the host row, the sweep described below removes the leftover
row. Already-missing resources count as success, and failed or incomplete
children need no CLI cleanup.

A VM destroyed outside the plugin (for example with `msb`) leaves a
registration-only child, which is a transient cleanup state. A lightweight
background sweep, also triggerable by `vm.list`, removes any plugin-owned row
whose child name no longer resolves to that row's generation id. While the
lookup is unavailable the row says `VM state unknown`, not `Missing`, and Repair
and Delete remain available. The sweep never blocks the list response, at most
one pass runs at a time, and a name that could not be verified is retried after
a short cooldown.

### Desktop app host entries

Delete removes the child's registration from the parent daemon; the plugin list
and the parent directory are the source of truth for that. The Paseo desktop app
also keeps its own saved-host registry. Once the app has used a child, it stores
a discovered `via:<parent>` route there and does not remove that entry when the
parent stops listing it. A deleted child can therefore remain in the app's host
picker or settings as **Offline** even though `paseo host ls`, the parent
`hosts.json`, and the plugin list are clean. Remove that entry in the app's host
settings; a plugin has no API to edit the app's client-side registry. This is a
known Paseo app limitation, not residual plugin state.

## Failure diagnostics

List and detail show a fixed safe code plus a bounded, redacted reason where
available; setup errors keep the actionable phase in the
`paseo-msb-error-detail` label. Redaction covers current environment and store
values plus relevant managed-VM config values.

## Native addon troubleshooting

If `vm.list` reports `Microsandbox inventory is unavailable` with `Cannot find
native binding...`, the npm hint is usually misleading. Run
`npm run check:native`; it loads the pinned addon under system Node and, when
present, under `/Applications/Paseo.app`, printing the real cause chain.

On macOS the usual cause is `mapping process and mapped file (non-platform) have
different Team IDs`: the addon is ad-hoc signed, while `Paseo.app` uses the
hardened runtime without `com.apple.security.cs.disable-library-validation`.
Reinstalling `node_modules` cannot fix that. Use a parent daemon under system
Node (for example `@getpaseo/cli`, as in the [release test](./docs/release-test.md)),
or a Paseo build signed to load the addon.

## Trust boundary and limits

The child daemon listens only on parent loopback and runs without
`PASEO_PASSWORD`; the authenticated parent daemon is the user-facing security
boundary. The optional **Paseo tools** setup also uses the child’s loopback port
directly to apply its daemon config and orchestration skills. Credential
substitution is header-only and limited to the fixed hosts above; TLS
interception and guest CA setup are microsandbox responsibilities.

The image is fixed; CPU, RAM, and root disk are chosen at Create within the
documented bounds (2 CPUs, 4096 MiB RAM, and 10240 MiB root disk by default).
**Edit resources** changes RAM and grows the root disk, but never the CPU.
There are no general start/stop/restart controls: the only restart is the
explicit confirmation after a resize needs one, and it is offered only for a
running VM. There is no image selection, volumes, snapshots, unlabelled-sandbox
adoption, operation history, or plugin-specific shell. After `ready`, the plugin
does not monitor tool health, repair drift, or re-provision; stopped VMs are not
started automatically.

Detached sandboxes, jobs, and registrations survive restarts; recovery
reconciles them without creating, starting, or adopting a VM. A sandbox this
build cannot decode — for example one created by an older plugin version — is
never resumed or repaired: it lists as a quarantined child and only Delete
removes it. The pinned SDK's `modify()` is not
generation-bound, so label writes are best-effort hints; [DESIGN.md](./DESIGN.md)
documents the residual window.

## Development

```sh
npm install
npm run typecheck   # or npm run build
npm run lint
npm test
```

`npm test` runs unit and contract tests. The real-runtime integration suite is
skipped unless `PASEO_PARENT_URL` is set or `PASEO_MSB_RELEASE_TEST=1`; see the
[release test](./docs/release-test.md). `npm run check:plugin` checks plugin load
state and `vm.list` against a running daemon.

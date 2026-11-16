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
  `2.1.323`, GitHub CLI `2.104.0`.

Install this checkout as a directory plugin from the parent daemon. Use an
isolated `PASEO_HOME` while developing.

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
Gemini, NeuralWatt). GitHub CLI is independent and unchecked by default.

The generated name (`paseo-<requestId>`) is the identity; the current generation
is its exact microsandbox `handle.id`. `vm.create` returns immediately, then one
idempotent reconciler per name creates the detached sandbox with the requested CPUs
and RAM (defaults `2 CPU` / `4096 MiB`) and the requested root disk,
with a loopback-only port, `PASEO_MSB_PLAN`, and only the selected header-only
secrets; runs the content-addressed provisioning script as one detached job;
registers the exact generation, waits for routed online, and confirms selected
providers; then marks it `ready`.

Phase (`creating`, `installing`, `registering`, `ready`, `deleting`) is a hint,
not proof of a side effect. A repeated Create joins the same reconciliation and
must use the original plan. Provisioning failures are fatal; Retry or Repair
re-runs the idempotent steps and skips completed ones. A failed attempt that has
not produced a sandbox can also be dismissed from its detail.

## Use

Open a ready child through Paseo's normal host picker. There are no
plugin-specific copy, shell, metrics, or start/stop controls.

## Repair

`vm.reconcile` resumes an unambiguous interrupted provisioning or registration,
restores a missing registration, and removes a confirmed stale plugin-owned
registration. It never creates, starts, adopts, or initiates deletion, and
reports ambiguous or foreign state instead of guessing.

`status.json` for the plan hash is the only provisioning success proof. Active
matching jobs are awaited, and inventory failures never launch another job. A
user-disabled registration is preserved, not re-enabled.

## Delete

Delete requires the exact name and current generation id. It persists
`deleting`, re-reads the exact handle, destroys that generation, and removes
only the matching `(plugin:paseo-msb, id)` registration. A stale id cannot
destroy a newer generation. An unwritable tombstone prevents destruction except
for microsandbox's specific interrupted-create state, which cannot be refreshed
or labelled and is destroyed through its generation-checked handle instead.

Already-missing resources count as success, and failed or incomplete children
need no CLI cleanup. Reload during deletion resumes cleanup, never setup; a
failed registration removal leaves a registration-only child for Repair or Delete.

A VM destroyed outside the plugin (for example with `msb`) shows as a
registration-only child. `vm.list` starts a conservative cleanup sweep for those
rows: an exact runtime lookup must show the generation gone or replaced before
its registration is removed. The sweep never blocks the list response, at most
one sweep runs at a time, and a name that could not be verified is retried after
a short cooldown.

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
`PASEO_PASSWORD`; the authenticated parent daemon is the security boundary.
Credential substitution is header-only and limited to the fixed hosts above;
TLS interception and guest CA setup are microsandbox responsibilities.

The image is fixed; CPU, RAM, and root disk are chosen at Create within the
documented bounds (2 CPUs, 4096 MiB RAM, and 10240 MiB root disk by default).
There is no CPU resize, image selection, start/stop/restart, volumes, snapshots,
unlabelled-sandbox adoption, operation history, or plugin-specific shell. After
`ready`, the plugin does not monitor tool health, repair drift, or re-provision;
stopped VMs are not started automatically.

Detached sandboxes, jobs, and registrations survive restarts; recovery
reconciles them without creating, starting, or adopting a VM and only completes
an explicit `deleting` tombstone. The pinned SDK's `modify()` is not
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

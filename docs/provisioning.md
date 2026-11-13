# Provisioning harnesses and tools

Status: **shared layer implemented, live wiring pending.** The catalog, planner,
script renderer, and status contract exist in `shared/provisioning/` with unit
tests. `vm.create`, the reconciler, registration, and the client still use the
v1 `secretEnvVars` path and the pinned Pi-only install.

This document is the agreed target design for the wiring slices.

## Selection model

Create selects **providers** and **integrations**. Secrets gate what can be
selected, and the selection determines which secrets are injected into the
sandbox. A credential that is stored but not required by the plan is never
injected.

- At least one provider is required. Claude-only is valid. An
  integration-only VM is invalid.
- Every selected provider must have at least one selected LLM option.
- Claude takes exactly one auth option: **Anthropic API key** or **Claude
  subscription** (`CLAUDE_CODE_OAUTH_TOKEN`). Claude uses official Anthropic
  models only; no custom base URL or provider config.
- Pi takes one or more LLM options: **Anthropic API key**, **OpenAI API key**,
  **Google Gemini API key**, and **NeuralWatt**.
- The GitHub CLI integration is independent of providers, unchecked by
  default, and requires `GH_TOKEN`.

| Provider | Paseo provider id | Nested options | Install |
| --- | --- | --- | --- |
| Claude | `claude` | Anthropic API key, Claude subscription | Claude Code `2.1.323` via the native installer |
| Pi | `pi` | Anthropic, OpenAI, Gemini, NeuralWatt | Pi `1.5.2`; NeuralWatt adds `@aliou/pi-neuralwatt@0.19.3` |

| Integration | Requires | Install |
| --- | --- | --- |
| GitHub CLI | `GH_TOKEN` | `gh` `2.104.0` from the pinned linux arm64/amd64 release tarball |

### Availability

- Claude is available when either `ANTHROPIC_API_KEY` or
  `CLAUDE_CODE_OAUTH_TOKEN` exists. Each nested auth option is greyed
  independently.
- Pi is always addable because it has no credential of its own. Its nested LLM
  options are greyed independently; submit stays blocked until at least one is
  available and selected.
- GitHub CLI is available when `GH_TOKEN` exists.
- The UI shows a reason on an unavailable option, for example
  `Set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN to enable Claude.`
- The server re-validates availability. A credential removed between screen
  load and submit fails with `missing_credentials`; it never falls back to a
  different stored secret.

## Plan

The canonical plan contains identifiers only:

```json
{
  "providers": [
    { "provider": "claude", "llms": ["anthropic-api-key"] },
    { "provider": "pi", "llms": ["neuralwatt"] }
  ],
  "integrations": ["github-cli"]
}
```

- Providers, LLMs, and integrations are sorted into catalog order before
  hashing, so selection order does not change identity.
- The plan hash mixes the canonical plan with a fingerprint of the pins.
  Changing a pin changes the hash and therefore the provision job identity.
- The plan is persisted in pending state and in the sandbox env as
  `PASEO_MSB_PLAN`. Values never appear there.
- Pre-existing VMs without a plan are treated as Pi-only.
- Repair only re-provisions when phase is not `ready`.

## Provisioning

One content-addressed script runs as the single detached job:

```text
/home/paseo/.paseo-msb/provision-<planHash>.sh
```

The exact argv is `/bin/sh <path> <planHash>`. The script verifies that its
argument matches the hash baked into its content, so a stale path cannot run a
different plan.

- Steps are composed as: provider base steps, then selected LLM steps, then
  integrations.
- Each step has a **probe** and an **action**. A passing probe records
  `skipped`, which makes retries idempotent. A failing action records `failed`
  and aborts the script.
- The script writes `/home/paseo/.paseo-msb/status.json` on exit:

```json
{
  "planHash": "0123456789abcdef",
  "ok": true,
  "steps": [
    { "id": "pi-install", "status": "ok", "exitCode": 0 },
    { "id": "pi-neuralwatt-install", "status": "skipped", "exitCode": 0 }
  ],
  "failedStep": null,
  "error": null
}
```

- Invalid or partially written status is unknown, never success.
- All provisioning failures are fatal. A failed step keeps the sandbox for
  inspection and retry; it does not advance to `ready`.
- `ready` requires every step to succeed and Paseo’s provider snapshot to report
  ready for each selected provider.
- Paseo’s snapshot only proves the provider binary launches; the provisioner’s
  probes are the real configuration check.
- After `ready`, the plugin does not observe tool health, repair drift, or
  re-provision. User mutations through a terminal are out of scope.

## Step catalog

| Step id | Probe | Action |
| --- | --- | --- |
| `claude-install` | `claude --version` matches `2.1.323` | `curl -fsSL https://claude.ai/install.sh \| bash -s 2.1.323` |
| `claude-settings` | `~/.claude/settings.json` has `env.DISABLE_AUTOUPDATER=1` | Merge that key into the existing settings file |
| `pi-install` | `pi --version` matches `1.5.2` | `npm install -g --ignore-scripts --prefix ~/.local @earendil-works/pi-coding-agent@1.5.2` |
| `pi-neuralwatt-install` | Pi settings declare `npm:@aliou/pi-neuralwatt@0.19.3` | `pi install npm:@aliou/pi-neuralwatt@0.19.3` |
| `github-cli-install` | `gh --version` matches `2.104.0` | Download, SHA-256 verify, and install the arch-matched tarball |

The GitHub CLI integration installs `gh` only. It does not configure a git
credential helper: git over HTTPS base64-encodes Basic credentials, so the
microsandbox placeholder is no longer a raw header value and cannot be
substituted. `gh` works because it sends the placeholder as a raw
`Authorization: Bearer` header to an already-allowed GitHub host.

## Security invariants

- The catalog and plan contain credential **names**, never values.
- The provision script contains no credential values and no `$MSB_`
  placeholders. Harnesses read the placeholders from the sandbox environment;
  microsandbox substitutes them only in headers for the fixed allowed hosts.
- Steps run as the non-root `paseo` user. Root is not required.
- Install downloads use general egress, not secret substitution. Claude Code
  pins a version and the native installer verifies its published checksum; `gh`
  pins both the tarball and its SHA-256.

## Pins

| Component | Pin |
| --- | --- |
| Pi | `1.5.2` |
| `@aliou/pi-neuralwatt` | `0.19.3` |
| Claude Code | `2.1.323` |
| `gh` | `2.104.0` |

The NeuralWatt extension declares an exact `@earendil-works/pi-ai@1.5.0` peer
while Pi `1.5.2` ships `1.5.2`. The mismatch is accepted deliberately; the live
release test is the gate.

## Wiring slices

1. **Shared layer** (done): catalog, plan resolution, script rendering, status
   parsing, and unit tests.
2. **Contracts and create**: replace `secretEnvVars` with the plan, persist
   `PASEO_MSB_PLAN`, derive the injected credential names, add
   `CLAUDE_CODE_OAUTH_TOKEN`, and change the default VM memory to 4096 MiB.
3. **Reconciler and registration**: materialize the script, launch the generic
   provision job, parse status, refresh and confirm the selected Paseo
   providers, and keep fatal failure semantics.
4. **Client**: collapsible Providers and Integrations sections, availability
   reasons, nested options, derived-credential confirmation, and plan detail.
5. **Verification**: fake-runtime contracts for the new job and status path,
   plus the real-runtime release test for Pi + NeuralWatt, Claude Code, and
   `gh`, including an injected step failure and retry.

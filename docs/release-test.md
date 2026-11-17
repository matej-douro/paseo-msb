# Release test

The release test is the mandatory verification gate for this plugin. It runs
against a real parent daemon, the verified microsandbox runtime, the pinned guest
image, and the pinned provider toolchain. It installs (or reloads) this checkout
as a directory plugin, then drives `vm.create`, `vm.dismiss`, `vm.list`,
`vm.detail`, `vm.reconcile`, and `vm.delete` through the plugin RPCs.

## Coverage

- Creates a provider plan from one unused model credential and verifies the
  content-addressed provision job and `status.json` are the ones for that plan.
- Reloads the plugin during provisioning and verifies one sandbox, one relevant
  detached job, and one registration remain.
- Asserts the pinned parent daemon, microsandbox SDK, guest image, and the
  selected provider's version.
- Verifies Paseo's provider snapshot reports every selected provider ready.
- Stores or reads each selected fixed credential, verifies it reaches only the
  allowed microsandbox secret entry with header-only substitution, and verifies
  it never appears in RPC output, plugin logs, raw sandbox/job/system logs,
  pending state, labels, or test artifacts.
- Replaces and then removes every selected value and re-checks detail redaction
  of the creation-time value persisted in the VM config.
- Injects a real provisioning failure, asserts it is fatal and keeps the
  sandbox, then retries Repair and verifies completed steps are skipped.
- Restores a missing registration, then removes an orphaned plugin-owned
  registration by creating a second child, destroying its sandbox behind the
  plugin, and confirming Repair removes only the registration.
- Deletes the exact sandbox and registration, then repeats delete and Repair
  safely.
- Joins concurrent identical Create calls, rejects a conflicting plan for the
  same request, queues Repair without duplicating work, and repairs registration
  configuration drift without changing the registration ID.
- Reloads after an injected `deleting` tombstone and verifies recovery destroys
  the tombstoned generation and removes its registration without resuming setup.
- Aborts an in-flight Create with Delete, recovers a replacement generation,
  rejects the stale generation token, and preserves the replacement.
- Rejects a foreign same-name sandbox without relabelling or destroying it, then
  dismisses the failed pending attempt.
- Refuses to launch a third provision job when two matching jobs are already
  active.

`tests/integration/identity-contract.test.ts` uses the raw SDK to verify that a
stale handle rejects refresh, connect, job reads, and destroy after a same-name
replacement, while the pinned SDK's stale `modify()` still reaches the
replacement. This is the executable contract for the residual window described
in [DESIGN](../DESIGN.md#24-generation-exact-mutations-and-the-pinned-sdk-limitation).

## Credential matrix

The test selects one model credential per run by default. Use these commands to
run the provider matrix on the pinned daemon:

```shell
# Claude-only, store canary, exercises the live provisioning failure
PASEO_MSB_RELEASE_CREDENTIALS=CLAUDE_CODE_OAUTH_TOKEN npm run test:release

# Pi + NeuralWatt + GitHub CLI, with OpenAI supplied by the daemon environment
# and NeuralWatt/GH_TOKEN written to the plugin store
PASEO_MSB_RELEASE_CREDENTIALS=OPENAI_API_KEY,NEURALWATT_API_KEY \
PASEO_MSB_RELEASE_ENV_CREDENTIAL=OPENAI_API_KEY \
PASEO_MSB_RELEASE_ENV_VALUE=paseo-msb-env-canary-1b2c3d4e-5f60-4718-9a2b-3c4d5e6f7081 \
PASEO_MSB_RELEASE_GITHUB_CLI=1 \
PASEO_MSB_RELEASE_PASEO_TOOLS=1 npm run test:release
```

The second run starts the daemon with the same
`OPENAI_API_KEY=paseo-msb-env-canary-...` value. When
`PASEO_MSB_RELEASE_ENV_CREDENTIAL` is set, the test verifies `secrets.list`
reports the value as `environment: true`, `stored: false`, and that redaction
survives store replacement and removal. `PASEO_MSB_RELEASE_GITHUB_CLI=1` adds
the GitHub CLI integration and its `GH_TOKEN` canary.
`PASEO_MSB_RELEASE_PASEO_TOOLS=1` adds the Paseo tools integration and asserts
that the child config has `mcp.injectIntoAgents`, each selected provider has
`paseoTools.enabled`, and `~/.agents/skills/paseo/SKILL.md` exists.

## Failure injection

Every selected plan exercises failure injection. It corrupts the Claude settings
file or removes `gh`/`pi` and makes the relevant install directory read-only,
discards `status.json`, and forces Repair to re-provision.
The test asserts Repair reports `provision_failed`, `status.json` names the
failed step, the sandbox and registration are kept, and a later Repair reports
every previously completed step as `skipped` while the failed step becomes `ok`.

Transport-level lost responses, malformed configuration, and pagination failures
are exercised in the fake-runtime unit suites. The live suite uses deterministic
state barriers rather than claiming to cover every network race or concurrent
operation ordering.

## Setup

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
that can load the addon for the release check. See the
[README's native addon troubleshooting](../README.md#native-addon-troubleshooting).

## Prerequisites

Every plan-required, store-backed credential name must be unused in both the
plugin store and parent environment, because the test writes a fake value and
removes it afterwards. An isolated `PASEO_HOME` satisfies this. Set
`PASEO_PASSWORD` when the parent daemon requires authentication. Set
`PASEO_MSB_SECRETS_FILE` on the
**parent daemon process** to relocate the plugin store; no RPC exposes the store
path.

`npm run test:release` sets `PASEO_MSB_RELEASE_TEST=1` before running
`tests/integration`, including the raw-SDK identity contract. The ordinary
`npm test` run skips the real-runtime integration suite unless
`PASEO_PARENT_URL` is set. The closeout cases create several real VMs, so use an
isolated environment and allow for multiple provisioning generations.

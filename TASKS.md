# Open tasks

Remaining work for the minimal v1. [DESIGN.md](./DESIGN.md) is the authoritative spec; completed
work is recorded in [CHANGELOG.md](./CHANGELOG.md). Keep this file limited to work that is still
open.

## 1. Verify the live release matrix on the documented pins

Task 8 implemented the release matrix (see
[CHANGELOG.md](./CHANGELOG.md#resolved-audit-findings-task-8)), but the live run has not been
executed.

- [ ] Verify store and environment canaries, removed/replaced creation-time values, and injected
  upstream errors against RPC output, plugin logs, raw sandbox/job/system logs, pending state,
  labels, and test artifacts.
- [ ] Run `npm run test:release` on a reachable parent daemon with the documented pins, and confirm
  `npm run typecheck`, `npm run lint`, and `npm test` pass, with affected documentation updated.

The live test needs a parent daemon that can load the microsandbox native addon; see the README
workstation note about the macOS hardened-runtime Team ID failure.

## 2. Verify the remaining provisioning matrix

The shared layer, live wiring, and the Pi/Anthropic release path are verified. The disposable-VM
smoke test installed and probed Claude Code, Pi, the NeuralWatt extension, and `gh`, and reran the
script to confirm probe-based idempotency.

- [x] `npm run test:release` passes on Paseo `0.15.4`, microsandbox `0.7.14`, and the pinned guest
  image for the Pi + Anthropic plan.
- [x] Pi `1.5.2` is drivable by Paseo `0.15.4`; `@aliou/pi-neuralwatt@0.19.3` installs and is
  declared in Pi settings with the accepted `pi-ai` peer mismatch.
- [x] Claude Code `2.1.323`, NeuralWatt, and `gh` `2.104.0` install and probe successfully in a
  disposable VM, including auto-update being disabled.
- [ ] Run the full release test with `CLAUDE_CODE_OAUTH_TOKEN` (Claude-only) and with
  `NEURALWATT_API_KEY` plus the GitHub CLI integration.
- [ ] Inject a failing provisioning step and confirm the failure is fatal, the sandbox is kept, and
  Retry create / Repair re-runs the idempotent script without repeating completed steps.

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

## 2. Verify the provisioning release matrix

The shared layer and live wiring are implemented (see [docs/provisioning.md](./docs/provisioning.md))
and the unit/contract suite passes. The real-runtime matrix has not been executed.

- [ ] Run `npm run test:release` on a reachable parent daemon. The test now creates a provider plan,
  waits for the content-addressed provision job and `status.json`, and asserts the selected provider
  in the child's Paseo snapshot.
- [ ] Verify Pi `1.5.2` is drivable by Paseo `0.15.4` and that `@aliou/pi-neuralwatt@0.19.3` loads with
  the accepted `pi-ai` peer mismatch.
- [ ] Exercise the Claude Code and GitHub CLI paths live, not just the unit/fake-runtime paths.
- [ ] Inject a failing provisioning step and confirm the failure is fatal, the sandbox is kept, and
  Retry create / Repair re-runs the idempotent script without repeating completed steps.
- [ ] Re-check store and environment canaries, replaced/removed creation-time values, and secret
  non-leakage across RPC output, plugin logs, raw sandbox/job/system logs, pending state, labels, and
  test artifacts.

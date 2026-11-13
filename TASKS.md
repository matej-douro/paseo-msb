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

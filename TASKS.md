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

## 2. Wire the provisioning shared layer

`shared/provisioning/` now holds the agreed catalog, planner, script renderer, and status contract
(see [docs/provisioning.md](./docs/provisioning.md)). Live behavior still uses `secretEnvVars` and
the Pi-only install path.

- [ ] Replace the create input with the provider/integration plan, persist `PASEO_MSB_PLAN`, derive
  only the injected credential names, add `CLAUDE_CODE_OAUTH_TOKEN`, and change the default memory to
  4096 MiB.
- [ ] Materialize the content-addressed provision script, launch it as the single detached job, parse
  `status.json`, refresh and confirm the selected Paseo providers, and keep fatal failure semantics.
- [ ] Rebuild the Create screen around collapsible Providers and Integrations sections with nested
  LLM options, availability reasons, and a derived-credential confirmation.
- [ ] Run the fake-runtime contracts and the real-runtime release test for Pi + NeuralWatt, Claude
  Code, and `gh`, including an injected step failure and retry.

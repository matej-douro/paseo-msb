# Minimal v1 implementation tasks

Derived from [DESIGN.md](./DESIGN.md), which is the authoritative spec.

Working rules:

- One task per PR, in order. Do not start feature code until task 1 passes.
- Keep the fixed v1 scope. Add no settings document, provider abstraction, lifecycle options, or decision framework.
- The runtime-dependent release test is mandatory on a supported parent.

## 1. Prove the pinned vertical slice

Create one scratch plugin/script that boots the official Paseo image, installs Pi, registers the child, refreshes Pi, and removes it. Verify the complete external API contract before building the plugin.

Acceptance:

- [ ] Record the full guest image digest, parent daemon version, microsandbox SDK/runtime versions, and exact Pi package version used by the remaining tasks.
- [ ] Verify guest Node >= 22.19, npm, `.init("auto")`, non-root global Pi installation, and `pi` on the daemon user's PATH.
- [ ] Verify loopback publishing with host port `0`; if unsupported, prove a minimal bind-probe/retry alternative and prompt release after stop.
- [ ] Verify detached survival, stable-ID replacement checks, persisted labels/config/logs, and detached-job inspection after plugin and parent-daemon restart.
- [ ] Verify a loopback child without `PASEO_PASSWORD`, or the minimal internal-password fallback, plus routed online, `hosts.remove`, and Pi detection after `providers.refresh()`.
- [ ] Verify header-only secret substitution and blocked-destination behavior with a controlled HTTPS endpoint and fake values. Verify all three fixed guest variables contain placeholders rather than raw values.
- [ ] Record results and any required narrow fallback in `docs/spikes/vertical-slice.md`; do not expand the product scope.

Files: `package.json`, `package-lock.json`, `scripts/spikes/verify-vertical-slice.mjs`, `scripts/spikes/fixtures/`, `docs/spikes/vertical-slice.md`

## 2. Scaffold the plugin and read-only RPCs

Create the parent plugin, fixed constants, five RPC contracts, and read-side projection. The client entry may render only a placeholder in this task.

Acceptance:

- [ ] Manifest matches the verified parent floor and client/server/shared import boundaries.
- [ ] `shared/constants.ts` contains the image/Pi pins, 2 CPUs, 2048 MiB, guest port, labels, and three fixed credential-to-host mappings.
- [ ] Zod contracts implement exactly `vm.list`, `vm.detail`, `vm.create`, `vm.delete`, and `vm.reconcile` with safe errors and no secret values.
- [ ] Server lists label-filtered sandboxes for the current parent and joins them with parent registrations and an initially empty pending-create map.
- [ ] Strict config decoding returns only stable ID, name, labels, runtime status, registration identity/status, and available credential names. Raw config and env never cross RPC.
- [ ] `vm.detail` returns bounded, redacted sandbox/job logs and distinguishes unavailable inventory from empty inventory.
- [ ] Typecheck, build, and focused config/RPC tests pass.

Files: `paseo-plugin.json`, `tsconfig.json`, `index.client.tsx`, `index.server.ts`, `shared/`, `server/index.ts`, `server/rpc.ts`, `server/sandbox.ts`, `server/status.ts`, `server/logs.ts`, `client/screen.tsx`, `tests/server/`

## 3. Implement idempotent background creation with Pi and secrets

Add `vm.create` and the host-side runner through Pi readiness, leaving registration wiring to task 4.

Acceptance:

- [ ] The client request ID produces `paseo-<requestId>`; strict create and repeated requests cannot allocate a second name or own a same-name replacement.
- [ ] `vm.create` validates selected fixed credential names, resolves their values from parent env, adds a pending entry, starts background work, and returns `{ name }` immediately.
- [ ] The runner creates the fixed detached VM with labels, `.init("auto")`, loopback port, and header-only microsandbox secrets. No secret value is written to the pending map, RPC, or logs.
- [ ] Stable sandbox and job IDs are persisted in labels; Pi installs as `paseo` with the verified package and flags through `execDetachedWith`, and daemon-user PATH is verified.
- [ ] Phase and short safe error codes are observable through list/detail. Pending creates remain visible after UI navigation without terminal history.
- [ ] Fake-runtime tests cover success, duplicate request ID, pull/boot/install failure, missing credentials, port retry, and redaction.

Files: `server/create.ts`, `server/pending.ts`, `server/pi-install.ts`, `server/secrets.ts`, `server/sandbox.ts`, `shared/`, `tests/server/create.test.ts`, `tests/server/fake-runtime.ts`

## 4. Implement registration, recovery, Repair, and Delete

Complete the create workflow and all remaining server mutations.

Acceptance:

- [ ] Pi-ready sandboxes move to `registering`, use stable sandbox ID as `sourceKey`, wait for routed online, refresh providers, confirm Pi, and become `ready`.
- [ ] Plugin init rediscovers labelled sandboxes and resumes only unambiguous install/registration work by persisted IDs; uncertain state remains failed without replaying side effects.
- [ ] `vm.reconcile` resumes valid setup, restores missing registrations, and removes confirmed stale registrations. It never creates, starts, adopts, or deletes a sandbox and refuses ambiguous/foreign duplicates.
- [ ] `vm.delete` requires matching name, stable ID, and confirmation; destroys that exact sandbox, removes its registration, and treats missing resources as success.
- [ ] Failed and incomplete children can be deleted entirely through Paseo UI. A post-destroy registration failure remains repairable.
- [ ] Tests cover interruption at each phase, reload with one detached job, stale registration, duplicate/foreign registration, missing resources, and unavailable inventory without destructive fallback.

Files: `server/registration.ts`, `server/recovery.ts`, `server/reconcile.ts`, `server/delete.ts`, `server/create.ts`, `server/index.ts`, `tests/server/`

## 5. Build the single Paseo management screen

Implement all v1 UI in one sidebar screen with no additional management surfaces.

Acceptance:

- [ ] Create child confirmation shows fixed image/resources and available credential checkboxes by name only, requires at least one, and generates one request ID per logical attempt.
- [ ] List shows pending creates and managed children with phase, runtime status, registration state, and safe errors. Polling stops on unmount without stopping host work.
- [ ] Detail reconnects by sandbox name after navigation and shows bounded read-only logs, Repair, and Delete.
- [ ] Delete confirmation names the child and states that its sandbox and registration are removed.
- [ ] Loading, empty, partial-unavailable, failed, and repair-error states are usable on desktop and mobile and use approved primitives/theme colors.
- [ ] Children are opened only through Paseo's normal host picker. No metrics, custom resource/provider fields, shell, copy, start/stop, or extra navigation actions are added.

Files: `index.client.tsx`, `client/screen.tsx`, `client/CreateChild.tsx`, `client/ChildList.tsx`, `client/ChildDetail.tsx`, `client/hooks/`, `client/__tests__/`

## 6. Pass the vertical release test and document operation

Add one real-runtime test through the plugin RPCs and replace contributor speculation in README with concise operating instructions.

Acceptance:

- [ ] Test drives all five RPCs: create returns immediately, independent list/detail calls observe progress, routed host reaches online, and Pi appears after refresh.
- [ ] Reload during installation produces one sandbox, detached job, and registration; Repair restores a missing/stale registration without another VM.
- [ ] A fake fixed credential reaches only the allowed substitution path and never appears in RPC output, logs, pending state, or test artifacts.
- [ ] Delete cleans the exact sandbox and registration; repeated delete and Repair are safe.
- [ ] Test runs in the release check on the verified parent/runtime/image/Pi pins.
- [ ] README records requirements, pins, the three parent env credentials, Create/Repair/Delete behavior, loopback trust boundary, reload limitations, and release-test command.

Files: `tests/integration/vertical.test.ts`, `tests/integration/fixtures/`, `README.md`

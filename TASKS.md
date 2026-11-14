# Open tasks

1. **Runtime version floor.** DESIGN §4 step 1 calls for a parent/runtime
   feature-floor check before lifecycle work. The server never compares
   `PARENT_DAEMON_VERSION` or `MICROSANDBOX_VERSION`; only the release test
   asserts the pins. Add the check, or remove the requirement from DESIGN if the
   release bar is sufficient.

2. **Release test: reload during deletion.** DESIGN §8 requires the release test
   to reload during deletion. The test currently reloads only during
   provisioning; `tests/server/reconcile.test.ts` covers tombstone completion,
   but `tests/integration/vertical.test.ts` has no end-to-end
   reload-during-delete case.

3. **Repeated Create after credential removal.** `createInLane`
   (`server/create.ts`) validates current credential availability before the
   reconciler locates an existing sandbox, so a repeated Create/Retry fails with
   `missing_credentials` even though recovery needs only the persisted plan. Let
   a repeated Create join an existing sandbox without resolving values.

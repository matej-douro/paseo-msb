# Release-test fixtures

`harness.ts` holds the helpers shared by the real-runtime release test:
parent/plugin lifecycle, label-filtered microsandbox inventory, guest probes,
and checks for the fixed credential policy.

`vertical.test.ts` is the single plugin-driven release suite. Its closeout cases
run in the same file as the original vertical path so they cannot race a plugin
reload or the shared credential store: concurrent Create/Repair joining,
registration configuration repair, reload after an injected Delete tombstone, Delete
aborting an in-flight Create, stale-generation Delete rejection, a foreign
same-name sandbox, two active matching provision jobs, and dismissing a failed
pending attempt. `identity-contract.test.ts` checks the stale-handle
`modify()`/`destroy()` matrix with the raw microsandbox SDK and can run alongside
the plugin suite because it never touches the plugin.
Both files are self-skipped unless `PASEO_MSB_RELEASE_TEST=1` (or
`PASEO_PARENT_URL` is set, matching the original gating).

No HTTPS echo server is checked in. The release test verifies credential wiring
at the microsandbox configuration boundary: the fake stored value appears only
in the fixed secret entry, that entry allows only the design's upstream hosts
with header-only substitution, and the guest sees the `$MSB_<NAME>` placeholder.
Controlled-endpoint interception behavior is outside this suite because the
plugin cannot add test-only hosts or interception settings.

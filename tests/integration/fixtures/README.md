# Release-test fixtures

`harness.ts` holds the helpers shared by the real-runtime release test:
parent/plugin lifecycle, label-filtered microsandbox inventory, guest probes,
and checks for the fixed credential policy.

No HTTPS echo server is checked in for task 6. The release test verifies the
credential wiring at the microsandbox configuration boundary: the fake stored
value appears only in the fixed secret entry, that entry allows only the
design's upstream hosts with header-only substitution, and the guest sees the
`$MSB_<NAME>` placeholder. Live header substitution and blocked-destination
behavior were proven against a controlled TLS endpoint in the task 1 vertical
slice and are not repeated here because the plugin cannot add test-only hosts
or interception settings.

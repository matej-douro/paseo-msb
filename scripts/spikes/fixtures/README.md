# Spike fixtures

`https-echo.mjs` is a test-only HTTPS server used by
`scripts/spikes/verify-vertical-slice.mjs` to prove microsandbox header-only
secret substitution and blocked-destination behavior.

The script generates a short-lived local CA and a leaf certificate for
`host.microsandbox.internal` at run time, passes the leaf to this server, and
passes the CA to microsandbox as the TLS-interception upstream trust root. No
certificate or private key is checked in.

The server binds only to `127.0.0.1` and is removed when the spike finishes.

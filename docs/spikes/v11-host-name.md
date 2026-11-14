# V1.1 host-name spike results

Verified on 2026-11-14 on macOS arm64 (Apple silicon) against a live parent
daemon with `microsandbox@0.7.14`, parent daemon `0.15.4`, and
`ghcr.io/getpaseo/paseo:0.15.4`.

Command:

```sh
node scripts/spikes/verify-v11-host-name.mjs \
  --parent ws://127.0.0.1:6780/ws \
  --name paseo-v11-name-probe \
  --timeout 90
```

The script is
[`scripts/spikes/verify-v11-host-name.mjs`](../../scripts/spikes/verify-v11-host-name.mjs).
It creates one named sandbox, registers it, repeats the strict create, probes the
runtime and parent name rules, and removes every registration and sandbox in
`finally`.

## Environment

| Item | Value |
| --- | --- |
| Parent directory server | `srv_eEqi6IkB9VVN` (`Matej’s MacBook Pro`) |
| Initial registrations | 1 |
| Requested name | `paseo-v11-name-probe` |
| Sandbox generation | `local:219` |
| Published port | `127.0.0.1:64848` → guest `6767` |
| Guest OS hostname | `paseo-v11-name-probe` |
| Guest daemon directory self | `srv_N1Lc5R8ABvoe`, label `paseo-v11-name-probe` |

## Sandbox and registration

The strict create accepted the chosen name and returned the same generation that
`Sandbox.get(name)` loaded.

Registration input:

```json
{
  "connection": "127.0.0.1:64848",
  "label": "paseo-v11-name-probe",
  "metadata": { "source": "paseo-msb", "name": "paseo-v11-name-probe" },
  "sourceKey": "local:219"
}
```

Parent directory row:

```json
{
  "registrationId": "hst_3496fcf1-bb3c-45a4-9a8b-4dff45d3bff5",
  "serverId": "srv_N1Lc5R8ABvoe",
  "label": "paseo-v11-name-probe",
  "metadata": { "source": "paseo-msb", "name": "paseo-v11-name-probe" },
  "source": { "id": "owner", "key": "local:219" },
  "enabled": true,
  "status": "online",
  "targetDescription": "tcp://127.0.0.1:64848"
}
```

The parent preserved the label and both metadata fields exactly and routed the
registration online. A plain `createPaseoClient` connection registers under
producer `owner`; the production plugin registers the same display fields under
`plugin:paseo-msb`. The picker path below reads only the directory row's label,
so the producer does not affect the displayed name.

## Duplicate strict create

A second `Sandbox.builder(name).create()` with the same name rejected:

```text
SandboxAlreadyExistsError (code: sandboxAlreadyExists)
sandbox 'paseo-v11-name-probe' already exists; remove it, start the stopped
sandbox, or recreate with .replace()
```

The original generation remained `local:219`; `Sandbox.get(name)` and
`handle.refresh()` both returned the same id, and the registration row still
carried the chosen label and metadata.

## Host picker display

The installed Paseo `0.15.4` desktop bundle was inspected statically:

- `HostPicker` projects every host-directory row with
  `{ id: t.serverId, label: t.label }` and renders that `label` as the
  `ComboboxItem` label.
- The picker trigger resolves the selected host with
  `allHosts.find(host => host.serverId === selectedServerId)?.label ?? "Host"`.
- No picker path reads `metadata.name`, the sandbox name, or the guest daemon's
  directory label.

Source:

```text
/Applications/Paseo.app/Contents/Resources/app-dist/_expo/static/js/web/index-bac8e372abac3143f9c5cfcc54f448e4.js
```

Because the parent directory exposes the registration label as the chosen name,
the picker displays `paseo-v11-name-probe`. This is a written note rather than a
screenshot: the spike verifies the live directory row and the installed bundle's
display path, but does not automate the desktop UI. DESIGN §3 does not need to be
amended.

The guest daemon's own directory label happened to equal the sandbox name in
this run, so that comparison alone would not distinguish the two sources. The
static picker path is what proves the registration label is authoritative.

## Name rule

The V1.1 rule is 1–63 characters, lowercase ASCII letters, digits, and internal
hyphens, starting and ending alphanumeric.

| Candidate | Plugin rule | Runtime `build()` |
| --- | --- | --- |
| `a` | accept | accept |
| 63 × `a` | accept | accept |
| 64 × `a` | reject | **accept** |
| `Mixed-Case` | reject | **accept** |
| `has_underscore` | reject | **accept** |
| `has.dot` | reject | **accept** |
| `trailing-` | reject | **accept** |
| `-leading` | reject | reject (`InvalidConfigError`) |
| `has/slash` | reject | reject (`InvalidConfigError`) |
| `has space` | reject | reject (`InvalidConfigError`) |
| `é` | reject | reject (`InvalidConfigError`) |

A 64-character name was created successfully, confirming that the runtime does
not enforce the 63-character bound at create time. The parent accepted a
64-character registration label and rejected a 257-character label at the
protocol schema boundary (`label` maximum is 256).

Conclusion: neither the pinned runtime nor the parent enforces the V1.1 slug
rule. Task 2.5 must validate the 1–63 lowercase-slug rule in the plugin before
any create or registration.

## Cleanup

Both temporary registrations and both sandboxes were removed in `finally`.
Post-cleanup checks reported no remaining registrations and no remaining
sandboxes.

## Outcome

PASS. The parent exposes the chosen name in `label` and `metadata.name`, the
installed picker renders the directory label, and a duplicate strict create
fails without replacing the first sandbox. The runtime/parent are more permissive
than the V1.1 name rule, so plugin-side validation is mandatory.

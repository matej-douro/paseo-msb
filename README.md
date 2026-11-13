# paseo-msb

A Paseo plugin that turns microsandbox microVMs into first-class Paseo hosts.

Create a fixed-size child VM with selected Pi credentials and it appears in the Paseo host picker like any other machine, with its own workspaces, Pi agents, terminals, and diffs. Creation, repair, and deletion happen in the plugin's Paseo UI; day-to-day work happens in Paseo's normal host UI.

Design: [DESIGN.md](./DESIGN.md).
Implementation plan: [TASKS.md](./TASKS.md).

## Credentials

The plugin accepts exactly five credential names:

`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `NEURALWATT_API_KEY`, `GH_TOKEN`.

Open **Manage secrets** in the plugin screen to add, replace, or remove values. Values are written to `<PASEO_HOME>/plugin-data/paseo-msb/secrets.json` (directory `0700`, file `0600`) and can be relocated with `PASEO_MSB_SECRETS_FILE`. The parent daemon environment is also supported; a stored value takes precedence for new VMs. Existing VMs keep the credentials they were created with.

Only names and sources are ever shown or returned by an RPC. A stored value is sent to microsandbox once at creation and is redacted from logs.

## Status

v1 implementation through the management screen and the plugin credential store. The real-runtime release test is task 6.

Spike results: [docs/spikes/vertical-slice.md](./docs/spikes/vertical-slice.md).

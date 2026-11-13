# paseo-msb

A Paseo plugin that turns microsandbox microVMs into first-class Paseo hosts.

Create a fixed-size child VM with selected Pi credentials and it appears in the Paseo host picker like any other machine, with its own workspaces, Pi agents, terminals, and diffs. Creation, repair, and deletion happen in the plugin's Paseo UI; day-to-day work happens in Paseo's normal host UI.

Design: [DESIGN.md](./DESIGN.md).
Implementation plan: [TASKS.md](./TASKS.md).

Status: design for v1; Task 1 vertical slice verified, implementation not started.
Spike results: [docs/spikes/vertical-slice.md](./docs/spikes/vertical-slice.md).

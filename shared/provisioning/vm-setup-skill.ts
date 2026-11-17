import { GUEST_HOME, PLAN_ENV_VAR, RESOURCES_ENV_VAR } from "../constants";
import { stableHash } from "./hash";

/**
 * A plugin-provided skill that teaches agents running inside a managed VM how
 * that VM was created and provisioned.
 *
 * This module is data only and imported by both plugin runtimes, so it must
 * stay runtime-neutral. The content is embedded in the content-addressed
 * provision script, which makes the file deterministic for a given skill
 * payload.
 */

/** Directory name under each skill root. Must match the frontmatter `name`. */
export const VM_SETUP_SKILL_NAME = "paseo-msb-vm";

/**
 * The child daemon installs bundled skills into both roots. Writing to both
 * keeps the plugin skill visible to Claude and Pi agents alike. Paths are
 * relative to the guest home so the step can be exercised against a temp home.
 */
export const VM_SETUP_SKILL_SUBDIRS = [
  `.agents/skills/${VM_SETUP_SKILL_NAME}`,
  `.claude/skills/${VM_SETUP_SKILL_NAME}`,
] as const;

export const VM_SETUP_SKILL_DIRS = VM_SETUP_SKILL_SUBDIRS.map(
  (subdir) => `${GUEST_HOME}/${subdir}`,
);

/**
 * The marker line is derived from the payload, so any content edit changes the
 * line and makes a previously written file fail the provision probe. The
 * placeholder is part of the hashed payload and is replaced afterwards.
 */
const SKILL_PAYLOAD = `---
name: ${VM_SETUP_SKILL_NAME}
description: Describes how this microsandbox VM was created and provisioned by the paseo-msb plugin, including the guest user, paths, tool pins, and provisioning status. Use when you need to understand or troubleshoot the VM environment.
---

# paseo-msb VM setup

This machine is a microsandbox microVM managed by the \`paseo-msb\` Paseo plugin.
It runs a Paseo daemon that the parent Paseo app uses as a host.

<!-- PASEO_MSB_SKILL_MARKER -->

## Creation and provisioning

- The parent plugin creates the sandbox from the pinned Paseo guest image.
- Setup runs as the non-root \`paseo\` user from one content-addressed script:
  \`${GUEST_HOME}/.paseo-msb/provision-<planHash>.sh\`.
- The plugin launches that script as a single detached job. Do not edit or rerun
  it by hand; the parent owns it. A non-ready child can be repaired; a ready
  child is not re-provisioned.

## Discover the selected plan

The sandbox environment records the canonical plan and the desired resources:

\`\`\`sh
printenv ${PLAN_ENV_VAR}
printenv ${RESOURCES_ENV_VAR}
\`\`\`

The plan contains option identifiers only, never credential values. A sandbox
without \`${PLAN_ENV_VAR}\` predates plans and is Pi-only.

## Provisioning status

- Status file: \`${GUEST_HOME}/.paseo-msb/status.json\`
- It records the \`planHash\`, the overall \`ok\` flag, and one entry per step with
  \`id\`, \`status\` (\`ok\`, \`skipped\`, or \`failed\`), and exit code, plus
  \`failedStep\` and \`error\`.
- A missing or unparseable status file means provisioning did not complete.

## Environment

- User: \`paseo\`; home: \`${GUEST_HOME}\`
- \`PATH\` starts with \`${GUEST_HOME}/.local/bin\`.
- Selected tools are installed on that PATH: \`claude\` (Claude provider),
  \`pi\` (Pi provider), and \`gh\` (GitHub CLI integration).
- The Paseo tools integration enables Paseo tools in the child daemon and
  installs bundled orchestration skills into \`~/.agents/skills\` and
  \`~/.claude/skills\`.

## Boundaries

- The parent plugin owns creation, resize, and deletion; this VM is not a
  general-purpose host to manage by hand.
`;

export const VM_SETUP_SKILL_DIGEST = stableHash(SKILL_PAYLOAD);

/** Full marker line; the provision probe matches this line exactly. */
export const VM_SETUP_SKILL_MARKER = `<!-- paseo-msb-skill: ${VM_SETUP_SKILL_DIGEST} -->`;

export const VM_SETUP_SKILL_CONTENT = SKILL_PAYLOAD.replace(
  "<!-- PASEO_MSB_SKILL_MARKER -->",
  VM_SETUP_SKILL_MARKER,
);

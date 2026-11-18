import { CREDENTIAL_NAMES, GUEST_HOME, GUEST_PATH, PI_PACKAGE, PI_PREFIX } from "../constants";
import { shellQuote } from "./shell";
import {
  VM_SETUP_SKILL_CONTENT,
  VM_SETUP_SKILL_MARKER,
  VM_SETUP_SKILL_SUBDIRS,
} from "./vm-setup-skill";

/**
 * Shared, data-only provisioning catalog.
 *
 * This module is imported by both plugin runtimes, so it must stay
 * runtime-neutral: no Node APIs, React, or SDK imports. Entries never contain
 * credential values; they describe which fixed credential names an option
 * requires and which guest-side steps make it usable.
 */

/**
 * Provisioning uses the same fixed credential set as the live create path.
 * Values never appear here; entries only declare the names they require.
 */
export const PROVISIONING_CREDENTIAL_NAMES = CREDENTIAL_NAMES;
export type ProvisioningCredential = (typeof PROVISIONING_CREDENTIAL_NAMES)[number];

export const PROVIDER_IDS = ["claude", "pi"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export const LLM_IDS = [
  "anthropic-api-key",
  "anthropic-oauth",
  "openai-api-key",
  "gemini-api-key",
  "neuralwatt",
] as const;
export type LlmId = (typeof LLM_IDS)[number];

export const INTEGRATION_IDS = ["github-cli", "paseo-tools"] as const;
export type IntegrationId = (typeof INTEGRATION_IDS)[number];

/** Bump when the catalog shape changes in a way the planner must reject. */
export const PROVISIONING_VERSION = 1;

/** Current provisioning pins. */
export const PROVISIONING_PI_VERSION = "1.5.2";
export const PI_NEURALWATT_SOURCE = "npm:@aliou/pi-neuralwatt";
export const PI_NEURALWATT_VERSION = "0.19.3";
export const CLAUDE_CODE_VERSION = "2.1.323";
export const GH_VERSION = "2.104.0";
export const GH_LINUX_ARM64_SHA256 =
  "cb34cefc6f4e77b90731374a2b737516bb8f3033c6ca46aa949e5344f68069e3";
export const GH_LINUX_AMD64_SHA256 =
  "98cb101ad87dbbd3f6b2f2bfcbd43197ccd07643140121d8a9cfaa91eadbc24e";

export const PROVISIONING_STATE_DIR = `${GUEST_HOME}/.paseo-msb`;

export interface ProvisionStep {
  /** Stable identifier used in the status file and safe errors. */
  readonly id: string;
  readonly label: string;
  /** Exit 0 means the step's desired state already holds. */
  readonly probe: string;
  /** Runs only when the probe fails. Output is captured in the job log. */
  readonly action: string;
}

export interface LlmCatalogEntry {
  readonly id: LlmId;
  readonly label: string;
  readonly description: string;
  readonly requiredCredentials: readonly ProvisioningCredential[];
  readonly steps: readonly ProvisionStep[];
}

export interface ProviderCatalogEntry {
  readonly id: ProviderId;
  readonly label: string;
  readonly description: string;
  /** The provider id Paseo uses for `providers.refresh` and snapshots. */
  readonly paseoProviderId: string;
  readonly llms: readonly LlmCatalogEntry[];
  readonly steps: readonly ProvisionStep[];
}

export interface IntegrationCatalogEntry {
  readonly id: IntegrationId;
  readonly label: string;
  readonly description: string;
  readonly requiredCredentials: readonly ProvisioningCredential[];
  readonly steps: readonly ProvisionStep[];
}

function versionProbe(command: string, version: string): string {
  const escaped = version.replace(/\./g, "\\.");
  return `command -v ${command} >/dev/null 2>&1 && ${command} --version 2>/dev/null | grep -q '${escaped}'`;
}

const CLAUDE_INSTALL: ProvisionStep = {
  id: "claude-install",
  label: "Install Claude Code",
  probe: versionProbe("claude", CLAUDE_CODE_VERSION),
  action: `curl -fsSL https://claude.ai/install.sh | bash -s ${CLAUDE_CODE_VERSION}`,
};

const CLAUDE_SETTINGS: ProvisionStep = {
  id: "claude-settings",
  label: "Disable Claude Code auto-update",
  probe:
    "node -e \"const fs=require('node:fs');const p=process.env.HOME+'/.claude/settings.json';try{const s=JSON.parse(fs.readFileSync(p,'utf8'));process.exit(s&&s.env&&s.env.DISABLE_AUTOUPDATER==='1'?0:1)}catch{process.exit(1)}\"",
  action:
    "node -e \"const fs=require('node:fs');const path=require('node:path');const dir=process.env.HOME+'/.claude';const file=path.join(dir,'settings.json');fs.mkdirSync(dir,{recursive:true});let s={};try{s=JSON.parse(fs.readFileSync(file,'utf8'))}catch(e){if(!e||e.code!=='ENOENT')throw e};if(!s||typeof s!=='object'||Array.isArray(s))s={};const env=(s.env&&typeof s.env==='object')?s.env:{};s.env={...env,DISABLE_AUTOUPDATER:'1'};fs.writeFileSync(file,JSON.stringify(s,null,2)+'\\n',{mode:0o600});fs.chmodSync(file,0o600)\"",
};

const PI_INSTALL: ProvisionStep = {
  id: "pi-install",
  label: "Install Pi",
  probe: versionProbe("pi", PROVISIONING_PI_VERSION),
  action: `npm install -g --ignore-scripts --prefix ${PI_PREFIX} ${PI_PACKAGE}@${PROVISIONING_PI_VERSION}`,
};

const PI_NEURALWATT_DECLARATION = `${PI_NEURALWATT_SOURCE}@${PI_NEURALWATT_VERSION}`;

const PI_NEURALWATT_INSTALL: ProvisionStep = {
  id: "pi-neuralwatt-install",
  label: "Install the NeuralWatt Pi extension",
  probe:
    `node -e "const fs=require('node:fs');const p=process.env.HOME+'/.pi/agent/settings.json';try{const s=JSON.parse(fs.readFileSync(p,'utf8'));const pkgs=Array.isArray(s.packages)?s.packages:[];const want='${PI_NEURALWATT_DECLARATION}';const ok=pkgs.some((x)=>typeof x==='string'?x.includes(want):!!x&&typeof x.source==='string'&&x.source.includes(want));process.exit(ok?0:1)}catch{process.exit(1)}"`,
  action: `pi install ${PI_NEURALWATT_DECLARATION}`,
};

const GH_INSTALL: ProvisionStep = {
  id: "github-cli-install",
  label: "Install the GitHub CLI",
  probe: versionProbe("gh", GH_VERSION),
  action: [
    "set -eu",
    "arch=$(uname -m)",
    'case "$arch" in',
    `  aarch64|arm64) asset=gh_${GH_VERSION}_linux_arm64.tar.gz; sha=${GH_LINUX_ARM64_SHA256} ;;`,
    `  x86_64|amd64) asset=gh_${GH_VERSION}_linux_amd64.tar.gz; sha=${GH_LINUX_AMD64_SHA256} ;;`,
    '  *) echo "unsupported architecture: $arch" >&2; exit 1 ;;',
    "esac",
    'tmp=$(mktemp -d)',
    'trap \'rm -rf "$tmp"\' EXIT',
    `curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/$asset" -o "$tmp/$asset"`,
    "printf '%s  %s\\n' \"$sha\" \"$tmp/$asset\" | sha256sum -c -",
    'tar -xzf "$tmp/$asset" -C "$tmp"',
    `mkdir -p "${PI_PREFIX}/bin"`,
    `install -m 0755 "$tmp/\${asset%.tar.gz}/bin/gh" "${PI_PREFIX}/bin/gh"`,
  ].join("\n"),
};

/**
 * Installs the plugin-provided VM setup skill into both skill roots. The probe
 * matches the content-derived marker line, so editing the payload rewrites the
 * file while unchanged content stays a no-op.
 */
const VM_SETUP_SKILL_ACTION = [
  "set -eu",
  "umask 077",
  `for d in ${VM_SETUP_SKILL_SUBDIRS.map((subdir) => `"$HOME/${subdir}"`).join(" ")}; do`,
  '  mkdir -p "$d"',
  "  cat > \"$d/SKILL.md.tmp\" <<'PASEO_MSB_VM_SETUP_SKILL'",
  VM_SETUP_SKILL_CONTENT.replace(/\n$/, ""),
  "PASEO_MSB_VM_SETUP_SKILL",
  '  chmod 600 "$d/SKILL.md.tmp"',
  '  mv -f "$d/SKILL.md.tmp" "$d/SKILL.md"',
  "done",
].join("\n");

const VM_SETUP_SKILL_PROBE = VM_SETUP_SKILL_SUBDIRS.map(
  (subdir) =>
    `test -f "$HOME/${subdir}/SKILL.md" && grep -qxF ${shellQuote(VM_SETUP_SKILL_MARKER)} "$HOME/${subdir}/SKILL.md"`,
).join(" && ");

const VM_SETUP_SKILL_STEP: ProvisionStep = {
  id: "vm-setup-skill",
  label: "Install the paseo-msb VM setup skill",
  probe: VM_SETUP_SKILL_PROBE,
  action: VM_SETUP_SKILL_ACTION,
};

/**
 * Steps every plan runs before providers, LLM options, and integrations. They
 * describe the VM itself rather than a selected tool.
 */
export const BASE_STEPS: readonly ProvisionStep[] = [VM_SETUP_SKILL_STEP];

const ANTHROPIC_API_KEY_LLM: LlmCatalogEntry = {
  id: "anthropic-api-key",
  label: "Anthropic API key",
  description: "Use an Anthropic Console API key with official Anthropic models.",
  requiredCredentials: ["ANTHROPIC_API_KEY"],
  steps: [],
};

const ANTHROPIC_OAUTH_LLM: LlmCatalogEntry = {
  id: "anthropic-oauth",
  label: "Claude subscription",
  description: "Use a Claude Pro, Max, or Team OAuth token with official Anthropic models.",
  requiredCredentials: ["CLAUDE_CODE_OAUTH_TOKEN"],
  steps: [],
};

const OPENAI_API_KEY_LLM: LlmCatalogEntry = {
  id: "openai-api-key",
  label: "OpenAI API key",
  description: "Use an OpenAI API key through Pi's built-in provider.",
  requiredCredentials: ["OPENAI_API_KEY"],
  steps: [],
};

const GEMINI_API_KEY_LLM: LlmCatalogEntry = {
  id: "gemini-api-key",
  label: "Google Gemini API key",
  description: "Use a Google Gemini API key through Pi's built-in provider.",
  requiredCredentials: ["GEMINI_API_KEY"],
  steps: [],
};

const NEURALWATT_LLM: LlmCatalogEntry = {
  id: "neuralwatt",
  label: "NeuralWatt",
  description: "Use NeuralWatt models through the @aliou/pi-neuralwatt extension.",
  requiredCredentials: ["NEURALWATT_API_KEY"],
  steps: [PI_NEURALWATT_INSTALL],
};

const CLAUDE_PROVIDER: ProviderCatalogEntry = {
  id: "claude",
  label: "Claude",
  description: "Anthropic's Claude Code CLI, using official Anthropic models only.",
  paseoProviderId: "claude",
  llms: [ANTHROPIC_API_KEY_LLM, ANTHROPIC_OAUTH_LLM],
  steps: [CLAUDE_INSTALL, CLAUDE_SETTINGS],
};

const PI_PROVIDER: ProviderCatalogEntry = {
  id: "pi",
  label: "Pi",
  description: "Pi coding agent with multi-provider model access.",
  paseoProviderId: "pi",
  llms: [
    ANTHROPIC_API_KEY_LLM,
    OPENAI_API_KEY_LLM,
    GEMINI_API_KEY_LLM,
    NEURALWATT_LLM,
  ],
  steps: [PI_INSTALL],
};

export const PROVIDER_CATALOG: readonly ProviderCatalogEntry[] = [
  CLAUDE_PROVIDER,
  PI_PROVIDER,
];

const GITHUB_CLI_INTEGRATION: IntegrationCatalogEntry = {
  id: "github-cli",
  label: "GitHub CLI",
  description: "Install the GitHub CLI (gh) and make GH_TOKEN available to it.",
  requiredCredentials: ["GH_TOKEN"],
  steps: [GH_INSTALL],
};

const PASEO_TOOLS_INTEGRATION: IntegrationCatalogEntry = {
  id: "paseo-tools",
  label: "Paseo tools",
  description:
    "Enable Paseo tools for the selected providers and install the bundled orchestration skills.",
  requiredCredentials: [],
  // This is a host-level setup step after registration, not a provisioning script
  // step: the child daemon must be online before it can patch its own config and
  // install skills.
  steps: [],
};

export const INTEGRATION_CATALOG: readonly IntegrationCatalogEntry[] = [
  GITHUB_CLI_INTEGRATION,
  PASEO_TOOLS_INTEGRATION,
];

const PROVIDERS_BY_ID: Readonly<Record<ProviderId, ProviderCatalogEntry>> = {
  claude: CLAUDE_PROVIDER,
  pi: PI_PROVIDER,
};

const INTEGRATIONS_BY_ID: Readonly<Record<IntegrationId, IntegrationCatalogEntry>> = {
  "github-cli": GITHUB_CLI_INTEGRATION,
  "paseo-tools": PASEO_TOOLS_INTEGRATION,
};

export function providerEntry(id: ProviderId): ProviderCatalogEntry {
  return PROVIDERS_BY_ID[id];
}

export function integrationEntry(id: IntegrationId): IntegrationCatalogEntry {
  return INTEGRATIONS_BY_ID[id];
}

export function llmEntry(provider: ProviderId, id: LlmId): LlmCatalogEntry {
  const entry = providerEntry(provider).llms.find((candidate) => candidate.id === id);
  if (!entry) {
    throw new Error(`Provider "${provider}" does not offer LLM option "${id}".`);
  }
  return entry;
}

/** The guest PATH and home used by every generated step. */
export const PROVISIONING_GUEST_HOME = GUEST_HOME;
export const PROVISIONING_GUEST_PATH = GUEST_PATH;

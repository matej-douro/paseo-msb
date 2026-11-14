/**
 * Fixed V1 values verified by the real-runtime release suite.
 *
 * This module is imported by both plugin runtimes, so it must stay
 * runtime-neutral: no Node APIs, React, or SDK imports.
 */

export const PLUGIN_ID = "paseo-msb";
export const PLUGIN_VERSION = "v1";

/** Verified parent daemon and microsandbox versions. */
export const PARENT_DAEMON_VERSION = "0.15.4";
export const MICROSANDBOX_VERSION = "0.7.14";

/** Verified guest image tag and Pi package pins. */
export const GUEST_IMAGE = "ghcr.io/getpaseo/paseo:0.15.4";
export const PI_PACKAGE = "@earendil-works/pi-coding-agent";
export const PI_VERSION = "1.1.0";

/** Fixed child shape. */
export const CPUS = 2;
export const MEMORY_MIB = 4096;
export const GUEST_PORT = 6767;

/** Verified guest user, paths, and the image's explicit tini init. */
export const GUEST_USER = "paseo";
export const GUEST_HOME = "/home/paseo";
export const GUEST_PATH =
  "/home/paseo/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
export const PI_PREFIX = "/home/paseo/.local";
export const GUEST_INIT_COMMAND = "/usr/bin/tini";
export const GUEST_INIT_ARGS = ["--", "/usr/local/bin/paseo-docker-entrypoint"] as const;

/** Managed sandbox labels. */
export const MANAGED_LABEL = "paseo-msb";
export const PARENT_LABEL = "paseo-msb-parent";
export const PHASE_LABEL = "paseo-msb-phase";
export const ERROR_LABEL = "paseo-msb-error";

/**
 * Legacy labels from the initial implementation. They are read only to migrate
 * existing children; new sandboxes never write them. A present legacy ID that
 * does not match the live handle quarantines the sandbox instead of adopting it.
 */
export const SANDBOX_ID_LABEL = "paseo-msb-id";
/** Bounded, redacted diagnostic text. Never contains a credential value. */
export const ERROR_DETAIL_LABEL = "paseo-msb-error-detail";

/** Sandbox environment variable holding the canonical provisioning plan. */
export const PLAN_ENV_VAR = "PASEO_MSB_PLAN";

/** Upper bound for diagnostic text exposed in DTOs, pending state, and labels. */
export const MAX_ERROR_DETAIL_CHARS = 1_000;

/**
 * Phase is a progress hint, not proof of an external side effect. `deleting` is
 * cleanup-only. `failed` is legacy-only; new failures keep the actionable phase
 * and carry an error code.
 */
export const PHASES = [
  "creating",
  "installing",
  "registering",
  "ready",
  "deleting",
  "failed",
] as const;
export type Phase = (typeof PHASES)[number];

export const RUNTIME_STATUSES = [
  "created",
  "starting",
  "running",
  "draining",
  "paused",
  "stopped",
  "crashed",
  "unknown",
] as const;
export type RuntimeStatus = (typeof RUNTIME_STATUSES)[number];

export const REGISTRATION_STATUSES = [
  "online",
  "offline",
  "connecting",
  "error",
  "disabled",
  "unknown",
] as const;
export type RegistrationStatus = (typeof REGISTRATION_STATUSES)[number];

/** The only parent environment credentials v1 passes through. */
export const CREDENTIAL_NAMES = [
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "NEURALWATT_API_KEY",
  "GH_TOKEN",
] as const;
export type CredentialName = (typeof CREDENTIAL_NAMES)[number];

export const CREDENTIAL_ALLOWED_HOSTS: Record<CredentialName, readonly string[]> = {
  ANTHROPIC_API_KEY: ["api.anthropic.com"],
  CLAUDE_CODE_OAUTH_TOKEN: ["api.anthropic.com"],
  OPENAI_API_KEY: ["api.openai.com"],
  GEMINI_API_KEY: ["generativelanguage.googleapis.com"],
  NEURALWATT_API_KEY: ["api.neuralwatt.com"],
  GH_TOKEN: ["api.github.com", "github.com", "uploads.github.com"],
};


/** Registration metadata used to join sandboxes with parent registrations. */
export const REGISTRATION_SOURCE = PLUGIN_ID;

/**
 * The authenticated producer id Paseo assigns to this plugin. Registration
 * identity is `(REGISTRATION_PRODUCER_ID, handle.id)`; metadata is display and
 * configuration only.
 */
export const REGISTRATION_PRODUCER_ID = `plugin:${PLUGIN_ID}`;

/**
 * Child sandbox names are `paseo-<requestId>`, per DESIGN.md. This is
 * deliberately shorter than the plugin ID; ownership is proven by the managed
 * and parent labels, and the current generation is the exact handle id.
 */
export const MANAGED_NAME_PREFIX = "paseo-";

export function sandboxName(requestId: string): string {
  return `${MANAGED_NAME_PREFIX}${requestId}`;
}

export function registrationLabel(parentId: string, name: string): string {
  return `${parentId}/${name}`;
}

/** Read-side size bounds. */
export const MAX_JOB_PAGES = 100;
export const MAX_LOG_ENTRIES = 100;
export const MAX_LOG_LINE_BYTES = 2_000;
export const MAX_LOG_TOTAL_BYTES = 32_768;
export const MAX_SANDBOX_PAGE_SIZE = 100;
export const MAX_JOB_PAGE_SIZE = 100;

/** How long plugin cleanup waits for in-flight lifecycle work to settle. */
export const CLEANUP_SETTLE_MS = 1_500;

// Pins proven by the vertical slice spike. Change these only with a new spike run.

export const PARENT_DAEMON_VERSION = "0.15.0";

export const IMAGE = {
  repository: "ghcr.io/getpaseo/paseo",
  tag: "0.15.0",
  indexDigest: "sha256:b2ea682ad520518f027bf6e6ed2e1c94f2de4a60b23ef31098a60dd64c09c7f8",
  ref: "ghcr.io/getpaseo/paseo@sha256:b2ea682ad520518f027bf6e6ed2e1c94f2de4a60b23ef31098a60dd64c09c7f8",
  platforms: {
    "linux/amd64": "sha256:012e62d54de93f3f3e846d7fe1aa12c5472c8f00bc5290acb6b0076442aa8bce",
    "linux/arm64": "sha256:93646309f75c4201afd79c1c04049f7ec7df228d2a9de09556d0b35f014fed1b",
  },
  nodeVersion: "22.23.4",
  npmVersion: "10.9.9",
} as const;

export const PI = {
  package: "@earendil-works/pi-coding-agent",
  version: "1.5.0",
  integrity:
    "sha512-xNDZ5kqowO6Z03FS2gwAkPEGk1ssxVcYKQ6qZId84mFEvwACvvyc2l0vAMOS+c5zvxLRMLBE9r4y44IGYkMJaQ==",
  enginesNode: ">=22.19.0",
  installPrefix: "/home/paseo/.npm-global",
  pathEntry: "/home/paseo/.npm-global/bin",
} as const;

export const FIXED_RESOURCES = {
  cpus: 2,
  memoryMiB: 2048,
  guestPort: 6767,
} as const;

export const CHILD = {
  listen: "0.0.0.0:6767",
  healthPath: "/api/health",
} as const;

export const LABELS = {
  managed: "paseo-msb",
  version: "v1",
  parent: "paseo-msb-parent",
  id: "paseo-msb-id",
  phase: "paseo-msb-phase",
  job: "paseo-msb-job",
  error: "paseo-msb-error",
} as const;

export const MANAGED_LABEL_KEYS = [
  LABELS.managed,
  LABELS.parent,
  LABELS.id,
  LABELS.phase,
  LABELS.job,
  LABELS.error,
] as const;

export const REGISTRATION = {
  source: "paseo-msb",
  vmKey: "vm",
  nameKey: "name",
} as const;

export const CREDENTIALS = [
  { env: "ANTHROPIC_API_KEY", hosts: ["api.anthropic.com"] },
  { env: "OPENAI_API_KEY", hosts: ["api.openai.com"] },
  { env: "GEMINI_API_KEY", hosts: ["generativelanguage.googleapis.com"] },
  { env: "NEURALWATT_API_KEY", hosts: ["api.neuralwatt.com"] },
  { env: "GH_TOKEN", hosts: ["api.github.com", "github.com", "uploads.github.com"] },
] as const;

export const LOG_ENTRY_LIMIT = 40;
export const LOG_SOURCE_LIMIT = 20;
export const LOG_TEXT_LIMIT = 2000;
export const LOG_TOTAL_LIMIT = 16000;

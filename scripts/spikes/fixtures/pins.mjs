// Pins proven by the vertical slice. Change these only with a new spike run.

export const PINS = {
  parentDaemon: {
    version: "0.15.0",
    localUrl: "http://127.0.0.1:6767",
  },
  microsandbox: {
    sdk: "0.7.14",
    runtime: "0.7.14",
    libkrunfw: "5.6.1",
  },
  image: {
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
  },
  pi: {
    package: "@earendil-works/pi-coding-agent",
    version: "1.5.0",
    integrity:
      "sha512-xNDZ5kqowO6Z03FS2gwAkPEGk1ssxVcYKQ6qZId84mFEvwACvvyc2l0vAMOS+c5zvxLRMLBE9r4y44IGYkMJaQ==",
    enginesNode: ">=22.19.0",
    installPrefix: "/home/paseo/.npm-global",
    pathEntry: "/home/paseo/.npm-global/bin",
  },
  resources: {
    cpus: 2,
    memoryMiB: 2048,
    guestPort: 6767,
  },
  labels: {
    managed: "paseo-msb",
    version: "v1",
    parent: "paseo-msb-parent",
    id: "paseo-msb-id",
    phase: "paseo-msb-phase",
    job: "paseo-msb-job",
    error: "paseo-msb-error",
  },
  init: {
    autoCandidates: ["/sbin/init", "/lib/systemd/systemd", "/usr/lib/systemd/systemd"],
    fallback: {
      cmd: "/usr/bin/tini",
      args: ["--", "/usr/local/bin/paseo-docker-entrypoint"],
      reason:
        "The official Paseo image is node:22-bookworm-slim with tini as ENTRYPOINT. It contains none of the init binaries probed by microsandbox init auto.",
    },
  },
  child: {
    // The published host socket is loopback-only. The guest daemon binds all
    // guest interfaces so the microsandbox port forwarder can reach it.
    listen: "0.0.0.0:6767",
    healthPath: "/api/health",
  },
};

export const CREDENTIALS = [
  { env: "ANTHROPIC_API_KEY", hosts: ["api.anthropic.com"] },
  { env: "OPENAI_API_KEY", hosts: ["api.openai.com"] },
  { env: "GEMINI_API_KEY", hosts: ["generativelanguage.googleapis.com"] },
  { env: "NEURALWATT_API_KEY", hosts: ["api.neuralwatt.com"] },
  { env: "GH_TOKEN", hosts: ["api.github.com", "github.com", "uploads.github.com"] },
];

export const CONTROLLED_SECRET_ENV = "SPIKE_CONTROLLED_SECRET";
export const CONTROLLED_HOST = "host.microsandbox.internal";
// Resolves to the host gateway at runtime via a guest /etc/hosts alias.
export const BLOCKED_HOST = "blocked.paseo-msb.invalid";

export function platformKey() {
  const arch = process.arch === "x64" ? "amd64" : process.arch;
  return `linux/${arch}`;
}

export function expectedImageDigest() {
  const key = platformKey();
  const digest = PINS.image.platforms[key];
  if (!digest) {
    throw new Error(`no pinned image digest for ${key}`);
  }
  return digest;
}

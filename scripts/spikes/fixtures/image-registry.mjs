import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const OCI_INDEX = "application/vnd.oci.image.index.v1+json";
const DOCKER_INDEX = "application/vnd.docker.distribution.manifest.list.v2+json";
const OCI_MANIFEST = "application/vnd.oci.image.manifest.v1+json";
const DOCKER_MANIFEST = "application/vnd.docker.distribution.manifest.v2+json";

function splitRepository(repository) {
  const [host, ...rest] = repository.split("/");
  return { host, name: rest.join("/") };
}

async function registryToken(repository) {
  const { host, name } = splitRepository(repository);
  const url = `https://${host}/token?scope=repository:${name}:pull&service=${host}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`registry token request failed: ${response.status}`);
  }
  const body = await response.json();
  if (!body.token) {
    throw new Error("registry token response did not include a token");
  }
  return body.token;
}

async function registryFetch(repository, reference, options = {}) {
  const { host, name } = splitRepository(repository);
  const token = await registryToken(repository);
  const url = `https://${host}/v2/${name}/${reference}`;
  const response = await fetch(url, {
    method: options.method ?? "GET",
    headers: {
      authorization: `Bearer ${token}`,
      ...(options.accept ? { accept: options.accept } : {}),
    },
    redirect: "follow",
  });
  if (!response.ok) {
    throw new Error(`registry request failed: ${response.status} ${url}`);
  }
  return response;
}

async function resolveDigest(repository, tag) {
  const response = await registryFetch(repository, `manifests/${tag}`, {
    method: "HEAD",
    accept: [OCI_INDEX, DOCKER_INDEX, OCI_MANIFEST, DOCKER_MANIFEST].join(", "),
  });
  const digest = response.headers.get("docker-content-digest");
  if (!digest) {
    throw new Error("registry did not return docker-content-digest");
  }
  return digest;
}

async function fetchManifest(repository, reference) {
  const response = await registryFetch(repository, `manifests/${reference}`, {
    accept: [OCI_INDEX, DOCKER_INDEX, OCI_MANIFEST, DOCKER_MANIFEST].join(", "),
  });
  return response.json();
}

async function fetchBlob(repository, digest) {
  const response = await registryFetch(repository, `blobs/${digest}`);
  return response;
}

function normalizeEntry(entry) {
  return entry.replace(/^\.\//, "").replace(/^\//, "").replace(/\/$/, "");
}

function cacheRoot() {
  return path.join(os.tmpdir(), "paseo-msb-spike-image-cache");
}

function layerCachePath(digest) {
  return path.join(cacheRoot(), digest.replaceAll(":", "-"));
}

async function downloadLayer(repository, layer, refresh) {
  const target = layerCachePath(layer.digest);
  if (!refresh && fs.existsSync(target) && fs.statSync(target).size === layer.size) {
    return target;
  }
  fs.mkdirSync(cacheRoot(), { recursive: true });
  const part = `${target}.part`;
  const response = await fetchBlob(repository, layer.digest);
  if (!response.body) {
    throw new Error(`empty blob body for ${layer.digest}`);
  }
  const file = fs.createWriteStream(part);
  await new Promise(async (resolve, reject) => {
    try {
      for await (const chunk of response.body) {
        if (!file.write(chunk)) {
          await new Promise((next) => file.once("drain", next));
        }
      }
      file.end(resolve);
    } catch (error) {
      file.destroy();
      reject(error);
    }
  });
  const actual = createHash("sha256").update(fs.readFileSync(part)).digest("hex");
  if (`sha256:${actual}` !== layer.digest) {
    fs.rmSync(part, { force: true });
    throw new Error(`layer digest mismatch for ${layer.digest}`);
  }
  fs.renameSync(part, target);
  return target;
}

async function scanLayer(file, wanted) {
  const found = new Set();
  const child = spawn("tar", ["-tzf", file], { stdio: ["ignore", "pipe", "pipe"] });
  const lines = readline.createInterface({ input: child.stdout });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  for await (const raw of lines) {
    const entry = raw.replace(/^\.\//, "").replace(/^\//, "").replace(/\/$/, "");
    if (wanted.has(entry)) {
      found.add(entry);
    }
  }
  const code = await new Promise((resolve) => child.on("close", resolve));
  if (code !== 0) {
    throw new Error(`tar listing failed for ${path.basename(file)}: ${stderr.trim()}`);
  }
  return found;
}

function extractFile(file, entry) {
  return execFileSync("tar", ["-xzf", file, "-O", entry], { maxBuffer: 20 * 1024 * 1024 }).toString();
}

function parseNodeVersion(config) {
  const env = config?.config?.Env ?? [];
  const value = env.find((entry) => entry.startsWith("NODE_VERSION="));
  return value ? value.slice("NODE_VERSION=".length) : null;
}

function compareVersions(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export async function inspectImage(pins, options = {}) {
  const { repository, tag, indexDigest, platforms } = pins.image;
  const platform = `${process.platform}/${process.arch === "x64" ? "amd64" : process.arch}`;
  const expectedPlatformDigest = platforms[platform];
  if (!expectedPlatformDigest) {
    throw new Error(`no pinned image digest for ${platform}`);
  }

  const tagDigest = await resolveDigest(repository, tag);
  const index = await fetchManifest(repository, indexDigest);
  const manifests = index.manifests ?? [];
  const platformManifest = manifests.find(
    (entry) => `linux/${entry.platform?.architecture}` === platform && entry.platform?.os === "linux",
  );
  if (!platformManifest) {
    throw new Error(`pinned image index does not contain ${platform}`);
  }
  if (platformManifest.digest !== expectedPlatformDigest) {
    throw new Error(`platform manifest digest changed: ${platformManifest.digest}`);
  }

  const manifest = await fetchManifest(repository, platformManifest.digest);
  const configResponse = await fetchBlob(repository, manifest.config.digest);
  const config = await configResponse.json();
  const nodeVersion = parseNodeVersion(config);
  if (!nodeVersion || compareVersions(nodeVersion, "22.19.0") < 0) {
    throw new Error(`guest Node version is below 22.19: ${nodeVersion}`);
  }

  const result = {
    platform,
    tagDigest,
    indexDigest,
    platformDigest: platformManifest.digest,
    configDigest: manifest.config.digest,
    layers: manifest.layers,
    entrypoint: config.config?.Entrypoint ?? [],
    user: config.config?.User ?? null,
    nodeVersion,
    npmVersion: null,
    initCandidates: Object.fromEntries(pins.init.autoCandidates.map((candidate) => [candidate, false])),
    tini: false,
    entrypointScript: false,
    layersScanned: 0,
  };

  if (options.downloadLayers === false) {
    return result;
  }

  const wanted = new Set([
    ...pins.init.autoCandidates,
    "/usr/bin/tini",
    "/usr/local/bin/paseo-docker-entrypoint",
    "/usr/local/lib/node_modules/npm/package.json",
  ].map(normalizeEntry));
  const cache = new Map();
  for (const layer of manifest.layers) {
    const file = await downloadLayer(repository, layer, options.refresh);
    cache.set(layer.digest, file);
    const found = await scanLayer(file, wanted);
    for (const entry of found) {
      cache.set(entry, file);
    }
    for (const candidate of pins.init.autoCandidates) {
      if (found.has(normalizeEntry(candidate))) result.initCandidates[candidate] = true;
    }
    if (found.has("usr/bin/tini")) result.tini = true;
    if (found.has("usr/local/bin/paseo-docker-entrypoint")) result.entrypointScript = true;
    result.layersScanned += 1;
  }

  const npmLayer = cache.get("usr/local/lib/node_modules/npm/package.json");
  if (npmLayer) {
    const npmPackage = JSON.parse(extractFile(npmLayer, "usr/local/lib/node_modules/npm/package.json"));
    result.npmVersion = npmPackage.version ?? null;
  }

  return result;
}

export function npmRegistryMetadata(pins) {
  return {
    name: pins.pi.package,
    version: pins.pi.version,
    integrity: pins.pi.integrity,
    enginesNode: pins.pi.enginesNode,
  };
}

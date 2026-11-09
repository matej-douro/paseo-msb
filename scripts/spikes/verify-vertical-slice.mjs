#!/usr/bin/env node

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Sandbox,
  defaultBackendKind,
  isRuntimeInstalled,
  resolveRuntime,
  resolveRuntimeVersion,
} from "microsandbox";
import { startControlledHttps } from "./fixtures/controlled-https.mjs";
import { FAKE_SECRETS } from "./fixtures/fake-secrets.mjs";
import { inspectImage } from "./fixtures/image-registry.mjs";
import { connectParent, restartIsolatedParent, startIsolatedParent, stopIsolatedParent, waitForHost, waitForProvider } from "./fixtures/paseo-daemon.mjs";
import { runParentContract } from "./fixtures/parent-contract.mjs";
import { CONTROLLED_HOST, CONTROLLED_SECRET_ENV, CREDENTIALS, PINS, expectedImageDigest, platformKey } from "./fixtures/pins.mjs";
import { Report } from "./fixtures/report.mjs";
import {
  GUEST_PATH,
  assertConfigContract,
  buildSandboxBuilder,
  buildSandboxConfig,
  inspectConfig,
  placeholderFor,
} from "./fixtures/sandbox-config.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "../..");
const KVM_PATH = "/dev/kvm";
const PLACEHOLDER_PATTERN = new RegExp("\\$" + "MSB" + "_[A-Z0-9_]+", "g");

const args = parseArgs(process.argv.slice(2));
const report = new Report(safeMeta());

main().catch((error) => {
  report.fail("spike.unhandled", "Vertical slice runner completed", {
    detail: safeError(error),
  });
  finish(1);
});

function parseArgs(argv) {
  return {
    staticOnly: argv.includes("--static-only"),
    parentContract: argv.includes("--parent-contract"),
    json: argv.includes("--json"),
    reportPath: valueAfter(argv, "--report"),
  };
}

function valueAfter(argv, flag) {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] ?? null : null;
}

function safeMeta() {
  return {
    mode: args.staticOnly ? "static-only" : "runtime",
    platform: process.platform,
    arch: process.arch,
    node: process.versions.node,
    parentDaemon: PINS.parentDaemon.version,
    microsandboxSdk: PINS.microsandbox.sdk,
    microsandboxRuntime: PINS.microsandbox.runtime,
    libkrunfw: PINS.microsandbox.libkrunfw,
    image: PINS.image.ref,
    piPackage: PINS.pi.package,
    piVersion: PINS.pi.version,
  };
}

function safeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return report.redact(message).replace(PLACEHOLDER_PATTERN, "<redacted-placeholder>").slice(0, 500);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function main() {
  const image = await runStaticChecks();
  const parentContractOk = args.parentContract || !args.staticOnly;

  if (parentContractOk) {
    await runParentContract(PINS, report);
  }

  const runtime = await runHostRuntimeChecks();
  if (args.staticOnly) {
    report.blocked("guest.runtime", "Guest runtime checks", {
      blocker: "static-only run; sandbox creation was not attempted",
    });
    report.blocked("port.runtime", "Loopback publishing checks", {
      blocker: "static-only run; sandbox creation was not attempted",
    });
    report.blocked("persist.runtime", "Detached persistence checks", {
      blocker: "static-only run; sandbox creation was not attempted",
    });
    report.blocked("parent.runtime", "VM-backed parent registration checks", {
      blocker: "static-only run; sandbox creation was not attempted",
    });
    report.blocked("secrets.runtime", "Secret substitution checks", {
      blocker: "static-only run; sandbox creation was not attempted",
    });
    finish(staticChecksPassed() ? 0 : 1);
    return;
  }

  if (!runtime.ok) {
    report.blocked("guest.runtime", "Guest runtime checks", { blocker: runtime.blocker });
    report.blocked("port.runtime", "Loopback publishing checks", { blocker: runtime.blocker });
    report.blocked("persist.runtime", "Detached persistence checks", { blocker: runtime.blocker });
    report.blocked("parent.runtime", "VM-backed parent registration checks", { blocker: runtime.blocker });
    report.blocked("secrets.runtime", "Secret substitution checks", { blocker: runtime.blocker });
    finish(1);
    return;
  }

  await runSandboxSuite(image);
  finish(report.runtimeVerified() ? 0 : 1);
}

function staticChecksPassed() {
  return report.checks.every((check) => check.status !== "fail");
}

function sanitizeOutput(text) {
  return text.replace(PLACEHOLDER_PATTERN, "<redacted-placeholder>");
}

function finish(exitCode) {
  const { result, json } = report.finalize();
  const output = sanitizeOutput(args.json ? json : summary(result));
  process.stdout.write(output);
  if (!output.endsWith("\n")) process.stdout.write("\n");
  if (args.reportPath) {
    fs.writeFileSync(path.resolve(args.reportPath), sanitizeOutput(json));
  }
  process.exitCode = exitCode;
}

function summary(result) {
  const lines = [
    `paseo-msb vertical slice (${result.meta.mode})`,
    `runtime verified: ${result.runtimeVerified}`,
    "acceptance:",
    ...result.acceptance.map((group) => `  ${group.id}: ${group.status}`),
    "counts:",
    ...Object.entries(result.counts).map(([status, count]) => `  ${status}: ${count}`),
  ];
  if (result.blockers.length > 0) {
    lines.push("blockers:");
    for (const blocker of result.blockers) {
      lines.push(`  ${blocker.id}: ${blocker.status}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

async function runStaticChecks() {
  const packageJson = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
  const lock = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package-lock.json"), "utf8"));
  const locked = (name) => lock.packages?.[`node_modules/${name}`]?.version ?? null;

  if (
    packageJson.dependencies?.["@getpaseo/client"] === PINS.parentDaemon.version &&
    packageJson.dependencies?.microsandbox === PINS.microsandbox.sdk &&
    locked("@getpaseo/client") === PINS.parentDaemon.version &&
    locked("microsandbox") === PINS.microsandbox.sdk &&
    packageJson.engines?.node === `>=${PINS.pi.enginesNode.replace(">=", "")}`
  ) {
    report.staticPass("pins.packages", "Package and lockfile versions match the pins", {
      evidence: { manifestMatches: true, lockfileMatches: true },
    });
  } else {
    report.fail("pins.packages", "Package and lockfile versions match the pins", {
      detail: "package.json or package-lock.json differs from the spike pins",
    });
  }

  if (compareVersions(process.versions.node, PINS.pi.enginesNode.replace(">=", "")) >= 0) {
    report.staticPass("pins.node", "Local Node meets the Pi engine floor", {
      evidence: { version: process.versions.node, meetsFloor: true },
    });
  } else {
    report.fail("pins.node", "Local Node meets the Pi engine floor", {
      detail: "local Node is below the pinned engine floor",
    });
  }

  let image = null;
  try {
    image = await inspectImage(PINS, { downloadLayers: true });
    const expected = expectedImageDigest();
    if (image.tagDigest !== PINS.image.indexDigest || image.platformDigest !== expected) {
      report.fail("pins.image", "Pinned image digest resolves unchanged", {
        detail: "registry digest differs from the pinned image",
      });
    } else {
      report.staticPass("pins.image", "Pinned image digest resolves unchanged", {
        evidence: {
          platform: platformKey(),
          indexDigestMatches: true,
          platformDigestMatches: true,
          layers: image.layersScanned,
        },
      });
    }
    if (image.nodeVersion === PINS.image.nodeVersion && image.npmVersion === PINS.image.npmVersion) {
      report.staticPass("pins.image-runtime", "Image contains the pinned Node and npm", {
        evidence: { nodeMatches: true, npmMatches: true },
      });
    } else {
      report.fail("pins.image-runtime", "Image contains the pinned Node and npm", {
        detail: "image Node or npm version differs from the pins",
      });
    }

    const initCandidates = Object.values(image.initCandidates);
    if (initCandidates.every((present) => present === false) && image.tini && image.entrypointScript) {
      report.staticPass("pins.image-init", "Image requires the pinned tini fallback", {
        evidence: {
          initCandidatesPresent: initCandidates.filter(Boolean).length,
          tini: true,
          entrypointScript: true,
        },
      });
      report.staticPass("init.auto-config", "Builder accepts init auto for comparison", {
        evidence: { autoConfigBuilt: true },
      });
    } else {
      report.fail("pins.image-init", "Image requires the pinned tini fallback", {
        detail: "image init layout differs from the fallback pin",
      });
    }
  } catch (error) {
    report.fail("pins.image", "Pinned image digest resolves unchanged", {
      detail: safeError(error),
    });
  }

  await checkPiMetadata();
  await checkRuntimePins();
  await checkParentCli();
  await checkConfigContract();
  return image;
}

async function checkPiMetadata() {
  try {
    const url = `https://registry.npmjs.org/${encodeURIComponent(PINS.pi.package)}/${PINS.pi.version}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`npm registry returned ${response.status}`);
    const metadata = await response.json();
    if (
      metadata.version === PINS.pi.version &&
      metadata.dist?.integrity === PINS.pi.integrity &&
      metadata.engines?.node === PINS.pi.enginesNode
    ) {
      report.staticPass("pins.pi", "Pi package version, integrity, and engine match the pins", {
        evidence: { versionMatches: true, integrityMatches: true, enginesMatch: true },
      });
    } else {
      report.fail("pins.pi", "Pi package version, integrity, and engine match the pins", {
        detail: "npm metadata differs from the Pi pins",
      });
    }
  } catch (error) {
    report.fail("pins.pi", "Pi package version, integrity, and engine match the pins", {
      detail: safeError(error),
    });
  }
}

async function checkRuntimePins() {
  try {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, "node_modules/microsandbox/package.json"), "utf8"),
    );
    const installed = isRuntimeInstalled();
    const runtime = installed ? resolveRuntime() : null;
    const version = runtime ? await resolveRuntimeVersion(runtime.msbPath) : null;
    const firmwareMatches = runtime
      ? path.basename(runtime.libkrunfwPath).includes(`libkrunfw.so.${PINS.microsandbox.libkrunfw}`)
      : false;
    if (
      packageJson.version === PINS.microsandbox.sdk &&
      installed &&
      version === PINS.microsandbox.runtime &&
      firmwareMatches
    ) {
      report.staticPass("pins.microsandbox", "microsandbox SDK and runtime match the pins", {
        evidence: { sdkMatches: true, runtimeMatches: true, libkrunfwMatches: true, origin: runtime.origin },
      });
    } else {
      report.fail("pins.microsandbox", "microsandbox SDK and runtime match the pins", {
        detail: "microsandbox SDK, runtime, or libkrunfw differs from the pins",
      });
    }
  } catch (error) {
    report.fail("pins.microsandbox", "microsandbox SDK and runtime match the pins", {
      detail: safeError(error),
    });
  }
}

async function checkParentCli() {
  try {
    const version = execFileSync(process.env.PASEO_BIN ?? "paseo", ["--version"], {
      encoding: "utf8",
      timeout: 15_000,
    }).trim();
    if (version === PINS.parentDaemon.version) {
      report.staticPass("pins.parent-cli", "Paseo CLI matches the parent daemon pin", {
        evidence: { versionMatches: true },
      });
    } else {
      report.fail("pins.parent-cli", "Paseo CLI matches the parent daemon pin", {
        detail: "Paseo CLI version differs from the pin",
      });
    }
  } catch (error) {
    report.fail("pins.parent-cli", "Paseo CLI matches the parent daemon pin", {
      detail: safeError(error),
    });
  }
}

async function checkConfigContract() {
  try {
    const labels = { [PINS.labels.managed]: PINS.labels.version };
    const config = await buildSandboxConfig({ name: "paseo-msb-spike-static", init: "fallback", hostPort: 0, labels });
    const summary = assertConfigContract(config, { hostPort: 0 });
    const autoConfig = await buildSandboxConfig({ name: "paseo-msb-spike-static-auto", init: "auto", hostPort: null });
    const autoSummary = inspectConfig(autoConfig);
    if (autoSummary.init?.cmd === "auto") {
      report.staticPass("init.auto-accepted", "Builder accepts init auto", {
        evidence: { autoAccepted: true },
      });
    } else {
      report.fail("init.auto-accepted", "Builder accepts init auto", {
        detail: "builder did not persist init auto",
      });
    }
    report.staticPass("pins.config-contract", "Fixed resources and header-only credential policy build cleanly", {
      evidence: {
        cpus: summary.cpus,
        memoryMiB: summary.memoryMiB,
        guestPort: summary.ports.find((port) => port.guestPort === PINS.resources.guestPort)?.guestPort ?? null,
        loopbackBind: summary.ports.every((port) => port.hostBind === "127.0.0.1"),
        credentialCount: summary.secrets.length,
        headerOnly: summary.secrets.every(
          (secret) => secret.substitution?.headers && !secret.substitution?.query && !secret.substitution?.body,
        ),
        noPasswordEnv: !summary.env.includes("PASEO_PASSWORD"),
        fixedInit: summary.init?.cmd === PINS.init.fallback.cmd,
      },
    });
  } catch (error) {
    report.fail("pins.config-contract", "Fixed resources and header-only credential policy build cleanly", {
      detail: safeError(error),
    });
  }
}

async function runHostRuntimeChecks() {
  if (process.platform === "linux") {
    try {
      fs.accessSync(KVM_PATH, fs.constants.R_OK | fs.constants.W_OK);
      report.pass("runtime.kvm", "Host exposes KVM to microsandbox", {
        evidence: { platform: "linux", kvmAccessible: true },
      });
    } catch {
      return {
        ok: false,
        blocker: `${KVM_PATH} is absent or inaccessible; Linux microsandbox needs KVM to boot a guest`,
      };
    }
  } else if (process.platform === "darwin" && process.arch === "arm64") {
    report.pass("runtime.hypervisor", "Host platform can run local microsandbox", {
      evidence: { platform: "darwin/arm64" },
    });
  } else {
    return {
      ok: false,
      blocker: `local microsandbox runtime is not supported on ${process.platform}/${process.arch}`,
    };
  }

  if (defaultBackendKind() !== "local") {
    return { ok: false, blocker: "microsandbox default backend is not local" };
  }

  const runtime = resolveRuntime();
  const version = await resolveRuntimeVersion(runtime.msbPath);
  if (version !== PINS.microsandbox.runtime) {
    return { ok: false, blocker: "microsandbox runtime version differs from the pin" };
  }
  report.pass("runtime.backend", "Local runtime and backend are ready", {
    evidence: { backend: "local", runtimeMatches: true },
  });
  return { ok: true };
}

function findPublishedPorts(value, accumulator = []) {
  if (!value || typeof value !== "object" || accumulator.length >= 40) return accumulator;
  if (typeof value.guestPort === "number" && typeof value.hostPort === "number") {
    accumulator.push({
      hostPort: value.hostPort,
      guestPort: value.guestPort,
      hostBind: typeof value.hostBind === "string" ? value.hostBind : null,
      protocol: typeof value.protocol === "string" ? value.protocol : null,
    });
  }
  for (const child of Object.values(value)) {
    if (child && typeof child === "object") findPublishedPorts(child, accumulator);
  }
  return accumulator;
}

async function discoverHostPort(sandbox, name) {
  let ports = [];
  try {
    ports = findPublishedPorts(await sandbox.config());
  } catch {
    ports = [];
  }
  let assigned = ports.find((port) => port.guestPort === PINS.resources.guestPort && port.hostPort > 0);
  if (assigned) return assigned;

  try {
    const runtime = resolveRuntime();
    const raw = execFileSync(
      runtime.msbPath,
      ["sandbox", "inspect", name, "--format", "json"],
      { encoding: "utf8", timeout: 30_000, maxBuffer: 32 * 1024 * 1024 },
    );
    ports = findPublishedPorts(JSON.parse(raw));
    assigned = ports.find((port) => port.guestPort === PINS.resources.guestPort && port.hostPort > 0);
    return assigned ?? null;
  } catch {
    return null;
  }
}

function waitForHttp(port, requestPath, timeoutMs) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const attempt = () => {
      const request = http.get(
        { hostname: "127.0.0.1", port, path: requestPath, timeout: 2_000 },
        (response) => {
          response.resume();
          if (response.statusCode === 200) resolve();
          else retry();
        },
      );
      request.on("timeout", () => {
        request.destroy();
        retry();
      });
      request.on("error", retry);
    };
    const retry = () => {
      if (Date.now() >= deadline) {
        reject(new Error("child daemon did not become healthy through the published port"));
        return;
      }
      setTimeout(attempt, 500);
    };
    attempt();
  });
}

function canBindLocalPort(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

async function waitForPortRelease(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await canBindLocalPort(port)) return true;
    await sleep(500);
  }
  return false;
}

async function execGuest(sandbox, command, commandArgs = [], options = {}) {
  return sandbox.execWith(command, (builder) => {
    builder.args(commandArgs);
    if (options.user) builder.user(options.user);
    if (options.env) builder.envs(options.env);
    if (options.cwd) builder.cwd(options.cwd);
    builder.timeout(options.timeoutMs ?? 120_000);
    return builder;
  });
}

async function waitForJob(job, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const info = await job.inspect();
    if (info.state === "exited" || info.state === "failed" || info.state === "lost") return info;
    await sleep(500);
  }
  throw new Error("detached job did not finish within the timeout");
}

function inspectDetachedSandbox(name, jobId) {
  const code = [
    'import { Sandbox } from "microsandbox";',
    "const handle = await Sandbox.get(process.env.PASEO_MSB_SPIKE_NAME);",
    "const running = await handle.connect();",
    "const job = await running.getJob(process.env.PASEO_MSB_SPIKE_JOB);",
    "const info = await job.inspect();",
    "console.log(JSON.stringify({ id: handle.id, status: handle.status, state: info.state, exitCode: info.exitCode }));",
  ].join("\n");
  const output = execFileSync(process.execPath, ["--input-type=module", "--eval", code], {
    encoding: "utf8",
    timeout: 60_000,
    cwd: REPO_ROOT,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? os.tmpdir(),
      TMPDIR: process.env.TMPDIR ?? os.tmpdir(),
      PASEO_MSB_SPIKE_NAME: name,
      PASEO_MSB_SPIKE_JOB: jobId,
    },
  });
  return JSON.parse(output.trim().split("\n").pop());
}

async function runSandboxSuite(image) {
  const runId = `${process.pid}-${Date.now().toString(36)}`;
  const name = `paseo-msb-spike-${runId}`.slice(0, 128);
  const labels = {
    [PINS.labels.managed]: PINS.labels.version,
    [PINS.labels.parent]: "spike",
    [PINS.labels.id]: runId,
    [PINS.labels.phase]: "creating",
  };
  let sandbox = null;
  let controlled = null;
  let job = null;
  let hostPort = null;
  try {
    controlled = await startControlledHttps();
    const config = await buildSandboxConfig({
      name,
      init: "fallback",
      hostPort: 0,
      labels,
      includeControlledSecret: true,
      controlledCaPath: controlled.caCertPath,
    });
    assertConfigContract(config, { hostPort: 0, includeControlledSecret: true });
    report.pass("init.fallback-config", "Pinned fallback init builds with the fixed resources", {
      evidence: { fallbackInit: true, fixedResources: true },
    });
    if (image) {
      report.pass("init.auto-unavailable", "Image has no init auto candidates, so the fallback is selected", {
        evidence: { autoCandidates: Object.values(image.initCandidates).filter(Boolean).length, fallback: true },
      });
    }

    sandbox = await buildSandboxBuilder({
      name,
      init: "fallback",
      hostPort: 0,
      labels,
      includeControlledSecret: true,
      controlledCaPath: controlled.caCertPath,
    }).create();
    report.pass("persist.create", "Detached sandbox created with managed labels", {
      evidence: { stableIdAssigned: Boolean(sandbox.id), labels: Object.keys(labels).length },
    });

    const storedConfig = await sandbox.config();
    assertConfigContract(storedConfig, { includeControlledSecret: true });
    report.pass("persist.config", "Persisted config keeps fixed resources and header-only policy", {
      evidence: { configReadable: true, fixedResources: true, headerOnly: true },
    });
    const summary = inspectConfig(storedConfig);
    report.pass("persist.labels", "Managed labels survive in persisted config", {
      evidence: {
        managedLabel: summary.labels[PINS.labels.managed] === PINS.labels.version,
        labelCount: Object.keys(summary.labels).length,
      },
    });

    const nodeVersion = (await execGuest(sandbox, "node", ["-p", "process.versions.node"])).stdout().trim();
    if (compareVersions(nodeVersion, "22.19.0") >= 0) {
      report.pass("guest.node", "Guest Node meets the Pi engine floor", {
        evidence: { meetsFloor: true, node: nodeVersion },
      });
    } else {
      report.fail("guest.node", "Guest Node meets the Pi engine floor", {
        detail: "guest Node is below 22.19",
      });
    }

    const npmVersion = (await execGuest(sandbox, "npm", ["--version"])).stdout().trim();
    report.pass("guest.npm", "Guest npm is present", {
      evidence: { versionMatches: npmVersion === PINS.image.npmVersion, npm: npmVersion },
    });

    const uid = (await execGuest(sandbox, "id", ["-u"], { user: "paseo" })).stdout().trim();
    if (uid !== "0") {
      report.pass("guest.non-root", "Pi installs as the non-root daemon user", {
        evidence: { daemonUserNonRoot: true, uid: uid === "1000" ? "1000" : "non-zero" },
      });
    } else {
      report.fail("guest.non-root", "Pi installs as the non-root daemon user", {
        detail: "daemon user resolved to root",
      });
    }
    report.pass("init.fallback-boot", "Fallback init boots the pinned image", {
      evidence: { booted: true, image: PINS.image.tag },
    });

    hostPort = await discoverHostPort(sandbox, name);
    if (!hostPort) {
      report.fail("port.publish", "Published loopback port resolves to a host port", {
        detail: "host port 0 was requested but no assigned host port was observable",
      });
      return;
    }
    report.pass("port.publish", "Published loopback port resolves to a host port", {
      evidence: {
        hostPortZeroAccepted: true,
        guestPort: hostPort.guestPort,
        loopbackBind: hostPort.hostBind === "127.0.0.1",
      },
    });

    await waitForHttp(hostPort.hostPort, PINS.child.healthPath, 60_000);
    report.pass("parent.child-health", "Child daemon answers health through the published port", {
      evidence: { healthy: true },
    });

    job = await sandbox.execDetachedWith("npm", (builder) =>
      builder
        .args(["install", "-g", "--prefix", PINS.pi.installPrefix, `${PINS.pi.package}@${PINS.pi.version}`])
        .user("paseo")
        .env("HOME", "/home/paseo")
        .env("PATH", GUEST_PATH)
        .env("NPM_CONFIG_PREFIX", PINS.pi.installPrefix),
    );
    report.pass("guest.pi-job", "Pi install started as a detached job", {
      evidence: { jobIdAssigned: Boolean(job.id), detached: true },
    });

    const jobInfo = await waitForJob(job, 10 * 60_000);
    if (jobInfo.state === "exited" && jobInfo.exitCode === 0) {
      report.pass("guest.pi-install", "Pinned Pi package installed as paseo", {
        evidence: { exitCode: 0, pinnedVersion: true, nonRootUser: true },
      });
    } else {
      report.fail("guest.pi-install", "Pinned Pi package installed as paseo", {
        detail: "detached Pi install exited unsuccessfully",
      });
    }

    const piVersion = await execGuest(sandbox, "pi", ["--version"], {
      user: "paseo",
      env: { HOME: "/home/paseo", PATH: GUEST_PATH },
    });
    const piWhich = await execGuest(sandbox, "which", ["pi"], {
      user: "paseo",
      env: { HOME: "/home/paseo", PATH: GUEST_PATH },
    });
    const piVersionMatches = piVersion.stdout().includes(PINS.pi.version);
    const piOnPath = piWhich.stdout().trim().startsWith(PINS.pi.pathEntry);
    if (piVersion.success && piWhich.success && piVersionMatches && piOnPath) {
      report.pass("guest.pi-path", "Pi is on the daemon user's PATH at the pinned version", {
        evidence: { onPath: piOnPath, versionMatches: piVersionMatches },
      });
    } else {
      report.fail("guest.pi-path", "Pi is on the daemon user's PATH at the pinned version", {
        detail: "pi did not resolve from the pinned prefix",
      });
    }
    report.pass("guest.daemon-path", "Child daemon inherits the daemon-user PATH", {
      evidence: { pathConfigured: GUEST_PATH.includes(PINS.pi.pathEntry) },
    });

    const logs = await sandbox.logs({ tail: 40 });
    report.pass("persist.logs", "Bounded sandbox logs are readable", {
      evidence: { entries: logs.length, bounded: logs.length <= 40 },
    });

    const detached = inspectDetachedSandbox(name, job.id);
    report.pass("persist.detached-process", "A second process observes the same detached sandbox and job", {
      evidence: {
        stableIdMatches: detached.id === sandbox.id,
        sameSandbox: detached.id === sandbox.id,
        jobObserved: detached.state === "exited" || detached.state === "failed" || detached.state === "running",
      },
    });

    await runSandboxParentRegistration(report, sandbox, hostPort, job);
    await runSecretChecks(report, sandbox, controlled);

    await sandbox.stop();
    const released = await waitForPortRelease(hostPort.hostPort, 20_000);
    if (released) {
      report.pass("port.release", "Published loopback port is released after stop", {
        evidence: { released: true, loopback: true },
      });
    } else {
      report.fail("port.release", "Published loopback port is released after stop", {
        detail: "host port was still bound after the sandbox stopped",
      });
    }
    await waitForSandboxStatus(name, "stopped", 30_000);
    report.pass("persist.detached-stop", "Detached sandbox reaches stopped without the original handle", {
      evidence: { stopped: true },
    });

    const oldHandle = await Sandbox.get(name);
    const oldId = oldHandle.id;
    await oldHandle.destroy();
    sandbox = null;
    const afterDestroy = await Sandbox.listWith((list) => list.label(PINS.labels.managed, PINS.labels.version));
    const stillListed = afterDestroy.sandboxes.some((entry) => entry.name === name);
    if (!stillListed) {
      report.pass("persist.destroy", "Exact sandbox is removed by its stable handle", {
        evidence: { removed: true },
      });
    } else {
      report.fail("persist.destroy", "Exact sandbox is removed by its stable handle", {
        detail: "sandbox remained listed after destroy",
      });
    }

    await checkStableIdReplacement(oldHandle, oldId, name, labels);
  } catch (error) {
    report.fail("runtime.suite", "Runtime sandbox suite completed", { detail: safeError(error) });
  } finally {
    if (sandbox) {
      try {
        await sandbox.stop();
      } catch {
        // Best-effort cleanup only.
      }
    }
    if (sandbox) {
      try {
        await (await Sandbox.get(name)).destroy();
      } catch {
        // Best-effort cleanup only.
      }
    }
    if (controlled) await controlled.close();
  }
}

async function waitForSandboxStatus(name, status, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const handle = await Sandbox.get(name);
    if (handle.status === status) return handle;
    await sleep(500);
  }
  throw new Error(`sandbox did not reach ${status} within the timeout`);
}

async function checkStableIdReplacement(oldHandle, oldId, name, labels) {
  let replacement = null;
  let rejected = false;
  try {
    replacement = await buildSandboxBuilder({
      name,
      init: "fallback",
      hostPort: 0,
      labels: { ...labels, [PINS.labels.phase]: "ready" },
    }).create();
    const current = await Sandbox.get(name);
    const replaced = current.id !== oldId;
    try {
      await oldHandle.destroy();
    } catch (error) {
      rejected = error?.code === "sandboxReplaced";
    }
    if (replaced && rejected) {
      report.pass("persist.stable-id-replacement", "Stale handles refuse a same-name replacement", {
        evidence: { idChanged: true, staleHandleRejected: true },
      });
    } else {
      report.fail("persist.stable-id-replacement", "Stale handles refuse a same-name replacement", {
        detail: "replacement identity or stale-handle protection was not observed",
      });
    }
  } finally {
    try {
      await (await Sandbox.get(name)).destroy();
    } catch {
      // Best-effort cleanup only.
    }
    if (replacement) {
      try {
        await replacement.destroy();
      } catch {
        // Best-effort cleanup only.
      }
    }
  }
}

async function runSandboxParentRegistration(sandboxReport, sandbox, published, job) {
  const parent = await startIsolatedParent();
  let parentClient = null;
  let registrationId = null;
  try {
    parentClient = await connectParent(parent.url, { clientId: `spike-sandbox-parent-${process.pid}` });
    const self = (await parentClient.api.hosts.list()).self;
    const added = await parentClient.api.hosts.add({
      connection: `127.0.0.1:${published.hostPort}`,
      label: `${self.label}/${sandbox.name}`,
      sourceKey: sandbox.id,
      metadata: {
        source: "paseo-msb-spike",
        vm: sandbox.id,
        name: sandbox.name,
      },
    });
    registrationId = added.registrationId;
    sandboxReport.pass("parent.add", "hosts.add uses the stable sandbox ID as sourceKey", {
      evidence: {
        registrationCreated: true,
        sourceKeyMatchesSandboxId: added.source.key === sandbox.id,
        metadataFields: Object.keys(added.metadata).length,
      },
    });

    const online = await waitForHost(parentClient.api, registrationId, "online", 60_000);
    sandboxReport.pass("parent.online", "Routed child reaches online", {
      evidence: { online: true, serverIdAssigned: Boolean(online.serverId) },
    });

    const routed = await parentClient.api.hosts.client(online.serverId);
    try {
      await routed.providers.refresh();
      const pi = await waitForProvider(routed, "pi", 60_000);
      if (pi?.available) {
        sandboxReport.pass("parent.refresh", "providers.refresh sees Pi through the routed child", {
          evidence: { piAvailable: true },
        });
      } else {
        sandboxReport.fail("parent.refresh", "providers.refresh sees Pi through the routed child", {
          detail: "Pi was not available after refresh",
        });
      }
    } finally {
      await routed.dispose();
    }

    await restartIsolatedParent(parent);
    parentClient = await connectParent(parent.url, { clientId: `spike-sandbox-parent-restarted-${process.pid}` });
    await waitForHost(parentClient.api, registrationId, "online", 60_000);
    sandboxReport.pass("parent.restart", "Registration survives a parent daemon restart", {
      evidence: { onlineAfterRestart: true },
    });

    const afterRestart = inspectDetachedSandbox(sandbox.name, job.id);
    sandboxReport.pass("persist.job-after-parent-restart", "Detached job remains inspectable after parent restart", {
      evidence: { jobObserved: Boolean(afterRestart.state), sameSandbox: afterRestart.id === sandbox.id },
    });

    await parentClient.api.hosts.remove(registrationId);
    registrationId = null;
    const directory = await parentClient.api.hosts.list();
    const stillRegistered = directory.hosts.some((entry) => entry.source.key === sandbox.id);
    if (!stillRegistered) {
      sandboxReport.pass("parent.remove", "hosts.remove removes the plugin-owned registration", {
        evidence: { removed: true },
      });
    } else {
      sandboxReport.fail("parent.remove", "hosts.remove removes the plugin-owned registration", {
        detail: "registration remained after remove",
      });
    }
  } catch (error) {
    sandboxReport.fail("parent.suite", "VM-backed parent registration completed", { detail: safeError(error) });
    if (registrationId && parentClient) {
      try {
        await parentClient.api.hosts.remove(registrationId);
      } catch {
        // Best-effort cleanup only.
      }
    }
  } finally {
    if (parentClient) await parentClient.close();
    await stopIsolatedParent(parent);
  }
}

async function runSecretChecks(secretReport, sandbox, controlled) {
  let placeholderCount = 0;
  for (const { env } of CREDENTIALS) {
    const output = await execGuest(sandbox, "printenv", [env]);
    const value = output.stdout().trim();
    if (value === placeholderFor(env) && value !== FAKE_SECRETS[env]) placeholderCount += 1;
  }
  if (placeholderCount === CREDENTIALS.length) {
    secretReport.pass("secrets.placeholders", "All fixed guest variables contain placeholders", {
      evidence: { variables: CREDENTIALS.length, placeholders: placeholderCount, rawValuesExposed: false },
    });
  } else {
    secretReport.fail("secrets.placeholders", "All fixed guest variables contain placeholders", {
      detail: "one or more fixed guest variables did not contain the expected placeholder",
    });
  }

  const before = controlled.requests.length;
  const allowed = await runGuestHttpsRequest(sandbox, controlled.url, CONTROLLED_SECRET_ENV, "allowed");
  const request = controlled.requests[before];
  const header = request?.headers?.["x-paseo-spike-secret"];
  const headerValue = Array.isArray(header) ? header[0] : header;
  const placeholder = placeholderFor(CONTROLLED_SECRET_ENV);
  const fake = FAKE_SECRETS[CONTROLLED_SECRET_ENV];
  const headerSubstituted = headerValue === fake;
  const queryUnchanged = typeof request?.url === "string" && request.url.includes(encodeURIComponent(placeholder));
  const bodyUnchanged = typeof request?.body === "string" && request.body.includes(placeholder) && !request.body.includes(fake);
  if (allowed.status === 200 && request && headerSubstituted && queryUnchanged && bodyUnchanged) {
    secretReport.pass("secrets.header-only", "Allowed host receives a header substitution only", {
      evidence: {
        status: 200,
        headerSubstituted: true,
        queryUnchanged: true,
        bodyUnchanged: true,
        guestValueHidden: true,
      },
    });
  } else {
    secretReport.fail("secrets.header-only", "Allowed host receives a header substitution only", {
      detail: "header substitution or non-header placeholder preservation did not match the contract",
    });
  }

  const requestsBeforeBlocked = controlled.requests.length;
  const blocked = await runGuestHttpsRequest(sandbox, controlled.url, CONTROLLED_SECRET_ENV, "blocked");
  const blockedReachedUpstream = controlled.requests.length !== requestsBeforeBlocked;
  if ((blocked.status === null || blocked.status >= 400) && !blockedReachedUpstream) {
    secretReport.pass("secrets.blocked-destination", "A mismatched destination is blocked before the controlled upstream", {
      evidence: { blocked: true, blockedStatus: blocked.status ?? "error", upstreamRequests: controlled.requests.length },
    });
  } else {
    secretReport.fail("secrets.blocked-destination", "A mismatched destination is blocked before the controlled upstream", {
      detail: "the controlled upstream observed a request that should have been denied",
    });
  }
}

async function runGuestHttpsRequest(sandbox, url, secretEnv, mode) {
  const code = [
    'import https from "node:https";',
    "const target = new URL(process.argv[1]);",
    "const secret = process.env[process.argv[2]];",
    "const mode = process.argv[3];",
    "const body = JSON.stringify({ probe: secret });",
    "const headers = { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-paseo-spike-secret': secret };",
    "if (mode === 'blocked') headers.host = `blocked.paseo-msb.invalid:${target.port}`;",
    "const request = https.request({ hostname: target.hostname, port: target.port, path: `${target.pathname}?probe=${encodeURIComponent(secret)}`, method: 'POST', headers }, (response) => {",
    "  const chunks = [];",
    "  response.on('data', (chunk) => chunks.push(chunk));",
    "  response.on('end', () => console.log(JSON.stringify({ status: response.statusCode, bodyLength: Buffer.concat(chunks).length })));",
    "});",
    "request.on('error', (error) => console.log(JSON.stringify({ status: null, error: error.code || 'request-failed' })));",
    "request.end(body);",
  ].join("\n");
  const output = await execGuest(sandbox, "node", ["--input-type=module", "--eval", code, url, secretEnv, mode], {
    user: "paseo",
    env: { HOME: "/home/paseo", PATH: GUEST_PATH },
    timeoutMs: 60_000,
  });
  try {
    return JSON.parse(output.stdout().trim().split("\n").pop());
  } catch {
    return { status: null, error: "unparseable response" };
  }
}

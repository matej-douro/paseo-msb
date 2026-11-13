#!/usr/bin/env node
/**
 * Task 1 vertical spike.
 *
 * Proves the external API contract the paseo-msb plugin will depend on:
 * microsandbox SDK create/exec/job/labels/config/logs, Paseo host registration
 * and routed provider refresh, and microsandbox header-only secret substitution.
 *
 * This is a scratch verification script, not plugin code. It creates one
 * microVM, installs Pi, registers it with an isolated parent daemon, exercises
 * restart and repair basics, then removes everything it created.
 *
 * Usage:
 *   npm run spike:vertical
 *   SPIKE_KEEP=1 npm run spike:vertical   # leave the sandbox for inspection
 *
 * Environment:
 *   PASEO_HOME         Parent daemon home (default .scratch/paseo-home)
 *   PASEO_PARENT_URL   Parent daemon WebSocket URL (default ws://127.0.0.1:6780/ws)
 *   SPIKE_SANDBOX      Sandbox name (default paseo-msb-spike)
 *   SPIKE_IMAGE        Pinned Paseo image (default ghcr.io/getpaseo/paseo:0.15.4)
 *   SPIKE_PI_VERSION   Pinned Pi package version (default 1.1.0)
 */

import { Sandbox, MiB, NetworkPolicy } from "microsandbox";
import { createPaseoClient } from "@getpaseo/client";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { request as httpsRequest } from "node:https";
import net from "node:net";
import crypto from "node:crypto";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");

const IMAGE = process.env.SPIKE_IMAGE ?? "ghcr.io/getpaseo/paseo:0.15.4";
const PI_PACKAGE = "@earendil-works/pi-coding-agent";
const PI_VERSION = process.env.SPIKE_PI_VERSION ?? "1.1.0";
const SANDBOX_NAME = process.env.SPIKE_SANDBOX ?? "paseo-msb-spike";
const PARENT_HOME =
  process.env.PASEO_HOME ?? join(repoRoot, ".scratch/paseo-home");
const PARENT_URL =
  process.env.PASEO_PARENT_URL ?? "ws://127.0.0.1:6780/ws";
const KEEP = process.env.SPIKE_KEEP === "1";

const GUEST_PORT = 6767;
const GUEST_PATH =
  "/home/paseo/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const GUEST_HOME = "/home/paseo";
const PI_PREFIX = "/home/paseo/.local";
const ECHO_HOST = "host.microsandbox.internal";

const FIXED_SECRETS = [
  { env: "ANTHROPIC_API_KEY", hosts: ["api.anthropic.com"] },
  { env: "OPENAI_API_KEY", hosts: ["api.openai.com"] },
  { env: "GEMINI_API_KEY", hosts: ["generativelanguage.googleapis.com"] },
  { env: "NEURALWATT_API_KEY", hosts: ["api.neuralwatt.com"] },
  { env: "GH_TOKEN", hosts: ["api.github.com", "github.com", "uploads.github.com"] },
];

const TEST_SECRET_ENV = "SPIKE_TEST_ALLOWED";
const BLOCKED_SECRET_ENV = "SPIKE_TEST_BLOCKED";

const results = [];
const nonce = crypto.randomBytes(4).toString("hex");
const fakeValue = (name) => `fake-${name.toLowerCase().replaceAll("_", "-")}-${nonce}`;

const fixedFakes = Object.fromEntries(
  FIXED_SECRETS.map(({ env }) => [env, fakeValue(env)]),
);
const testFake = fakeValue(TEST_SECRET_ENV);
const blockedFake = fakeValue(BLOCKED_SECRET_ENV);
const allFakes = [...Object.values(fixedFakes), testFake, blockedFake];

function indent(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}

async function step(name, fn) {
  process.stdout.write(`\n== ${name}\n`);
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail });
    process.stdout.write(`PASS ${name}\n`);
    if (detail !== undefined && detail !== null) {
      process.stdout.write(`${indent(detail)}\n`);
    }
    return detail;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    results.push({ name, ok: false, error: message });
    process.stdout.write(`FAIL ${name}\n${indent(message)}\n`);
    throw error;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function run(command, args, options = {}) {
  const { stdout, stderr } = await execFileAsync(command, args, {
    timeout: options.timeout ?? 120_000,
    maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
    cwd: options.cwd ?? repoRoot,
    env: { ...process.env, ...options.env },
  });
  return { stdout: stdout.trim(), stderr: stderr.trim() };
}

async function waitFor(label, predicate, { timeoutMs = 120_000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(
    `${label} timed out after ${timeoutMs}ms${lastError ? `: ${lastError.message}` : ""}`,
  );
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close(() => (port ? resolve(port) : reject(new Error("no port"))));
    });
  });
}

function canBind(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.on("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

function httpStatus(url) {
  return fetch(url, { signal: AbortSignal.timeout(10_000) }).then((response) => response.status);
}

function httpsJson(port, path) {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      { host: "127.0.0.1", port, path, rejectUnauthorized: false, timeout: 10_000 },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("echo request timed out")));
    req.on("error", reject);
    req.end();
  });
}

function redact(text, values) {
  let output = String(text);
  for (const value of values) output = output.split(value).join("[redacted]");
  return output;
}

function withTimeout(promise, timeoutMs, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs),
    ),
  ]);
}

async function makeTestCerts(dir) {
  const caConf = join(dir, "ca.cnf");
  const reqConf = join(dir, "req.cnf");
  const extConf = join(dir, "ext.cnf");
  const caKey = join(dir, "ca-key.pem");
  const caCert = join(dir, "ca.pem");
  const serverKey = join(dir, "server-key.pem");
  const serverCsr = join(dir, "server.csr");
  const serverCert = join(dir, "server.pem");
  await writeFile(
    caConf,
    [
      "[req]",
      "distinguished_name = dn",
      "x509_extensions = v3",
      "prompt = no",
      "[dn]",
      "CN = paseo-msb-spike-ca",
      "[v3]",
      "basicConstraints = critical, CA:TRUE",
      "keyUsage = critical, keyCertSign, cRLSign",
      "subjectKeyIdentifier = hash",
      "",
    ].join("\n"),
  );
  await writeFile(
    reqConf,
    ["[req]", "distinguished_name = dn", "prompt = no", "[dn]", `CN = ${ECHO_HOST}`, ""].join("\n"),
  );
  await writeFile(
    extConf,
    [
      "basicConstraints = critical, CA:FALSE",
      "keyUsage = critical, digitalSignature, keyEncipherment",
      "extendedKeyUsage = serverAuth",
      `subjectAltName = DNS:${ECHO_HOST}`,
      "subjectKeyIdentifier = hash",
      "authorityKeyIdentifier = keyid,issuer",
      "",
    ].join("\n"),
  );
  await run(
    "openssl",
    ["req", "-x509", "-newkey", "rsa:2048", "-sha256", "-nodes", "-days", "1",
      "-keyout", caKey, "-out", caCert, "-config", caConf],
    { timeout: 60_000 },
  );
  await run(
    "openssl",
    ["req", "-newkey", "rsa:2048", "-sha256", "-nodes",
      "-keyout", serverKey, "-out", serverCsr, "-config", reqConf],
    { timeout: 60_000 },
  );
  await run(
    "openssl",
    ["x509", "-req", "-in", serverCsr, "-CA", caCert, "-CAkey", caKey,
      "-CAcreateserial", "-out", serverCert, "-days", "1", "-sha256", "-extfile", extConf],
    { timeout: 60_000 },
  );
  return { caCert, serverCert, serverKey };
}

async function startEchoServer(port, cert, key) {
  const child = spawn(
    process.execPath,
    [join(here, "fixtures/https-echo.mjs"), String(port), cert, key],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`echo server did not start: ${stderr}`)),
      10_000,
    );
    child.stdout.on("data", (chunk) => {
      if (String(chunk).includes("listening")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`echo server exited with ${code}: ${stderr}`));
    });
  });
  return {
    child,
    stop: () =>
      new Promise((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once("exit", resolve);
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 2_000);
      }),
  };
}

function createParentClient() {
  return createPaseoClient({
    url: PARENT_URL,
    clientId: "paseo-msb-vertical-spike",
    connectTimeoutMs: 15_000,
  });
}

async function readGuestEnv(sandbox, names) {
  const expression = names.map((name) => `"$${name}"`).join(" ");
  const script = `printf '%s\\n' ${expression}`;
  const output = await sandbox.execWith("sh", (builder) =>
    builder.args(["-lc", script]).user("paseo"),
  );
  return output
    .stdout()
    .toString("utf8")
    .split("\n")
    .slice(0, names.length);
}

async function registerAndRefresh(parent, sandbox, parentServerId, port) {
  const host = await parent.hosts.add({
    connection: `127.0.0.1:${port}`,
    label: `${parentServerId}/${SANDBOX_NAME}`,
    metadata: {
      source: "paseo-msb",
      vm: sandbox.id,
      name: SANDBOX_NAME,
    },
    sourceKey: sandbox.id,
  });

  const online = await waitFor("host online", async () => {
    const directory = await parent.hosts.list();
    const entry = directory.hosts.find(
      (candidate) => candidate.registrationId === host.registrationId,
    );
    return entry?.status === "online" && entry.serverId ? entry : null;
  });

  const remote = await parent.hosts.client(online.serverId);
  try {
    const refresh = await remote.providers.refresh({ providers: ["pi"] });
    assert(refresh.acknowledged, "providers.refresh was not acknowledged");
    const snapshot = await remote.providers.snapshot({});
    const pi = snapshot.entries.find((entry) => entry.provider === "pi");
    assert(pi, "no pi provider in routed snapshot");
    assert(pi.status === "ready", `pi provider status is ${pi.status}`);
    return { host, online, pi };
  } finally {
    await remote.dispose();
  }
}

async function cleanup({ parent, sandbox, hostRegistrationId, echo, certDir }) {
  if (parent) {
    if (hostRegistrationId) {
      try {
        await withTimeout(parent.hosts.remove(hostRegistrationId), 10_000, "host remove");
      } catch (error) {
        process.stdout.write(`cleanup: host remove failed: ${error.message}\n`);
      }
    }
    try {
      await withTimeout(parent.close(), 10_000, "parent close");
    } catch {
      // ignore
    }
  }
  if (echo) {
    try {
      await withTimeout(echo.stop(), 8_000, "echo stop");
    } catch (error) {
      process.stdout.write(`cleanup: echo stop failed: ${error.message}\n`);
    }
  }
  if (sandbox && !KEEP) {
    try {
      await withTimeout(
        sandbox.destroy({ force: true, timeoutMs: 15_000 }),
        30_000,
        "sandbox destroy",
      );
    } catch (error) {
      process.stdout.write(`cleanup: sandbox destroy failed: ${error.message}\n`);
      try {
        await withTimeout(Sandbox.remove(SANDBOX_NAME), 15_000, "sandbox remove");
      } catch (removeError) {
        process.stdout.write(`cleanup: sandbox remove failed: ${removeError.message}\n`);
      }
    }
  }
  if (certDir) {
    try {
      await rm(certDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

async function main() {
  let parent;
  let sandbox;
  let hostRegistrationId;
  let echo;
  let certDir;

  try {
    const versions = await step("record pins", async () => {
      const [msbVersion, paseoVersion, sdkPackage] = await Promise.all([
        run("msb", ["--version"]),
        run("paseo", ["--version"]),
        readFile(join(repoRoot, "node_modules/microsandbox/package.json"), "utf8"),
      ]);
      const runtime = JSON.parse(sdkPackage);
      await run("msb", ["pull", IMAGE], { timeout: 900_000 });
      const inspect = JSON.parse(
        (await run("msb", ["image", "inspect", IMAGE, "--format", "json"])).stdout,
      );
      return {
        image: IMAGE,
        imageDigest: inspect.digest,
        imageManifestDigest: inspect.config?.digest ?? null,
        guestNodeVersion: (inspect.config?.env ?? [])
          .find((entry) => entry.startsWith("NODE_VERSION="))
          ?.split("=")[1],
        msb: msbVersion.stdout,
        microsandboxSdk: runtime.version,
        paseo: paseoVersion.stdout,
        piPackage: `${PI_PACKAGE}@${PI_VERSION}`,
      };
    });

    const parentStatus = await step("parent daemon", async () => {
      const status = JSON.parse(
        (await run("paseo", ["--home", PARENT_HOME, "status", "--json"])).stdout,
      );
      assert(status.connectedDaemon === "reachable", "parent daemon is not reachable");
      parent = createParentClient();
      await parent.connect();
      const directory = await parent.hosts.list();
      return {
        home: PARENT_HOME,
        url: PARENT_URL,
        daemonVersion: status.daemonVersion,
        serverId: directory.self.serverId,
      };
    });
    const parentServerId = parentStatus.serverId;

    const fixture = await step("start controlled HTTPS endpoint", async () => {
      certDir = await mkdtemp(join(tmpdir(), "paseo-msb-spike-certs-"));
      const { caCert, serverCert, serverKey } = await makeTestCerts(certDir);
      const echoPort = await findFreePort();
      echo = await startEchoServer(echoPort, serverCert, serverKey);
      return { echoPort, caCert };
    });

    const hostPort = await step("probe host port", async () => {
      if (process.env.SPIKE_PORT) {
        const requested = Number(process.env.SPIKE_PORT);
        assert(await canBind(requested), `SPIKE_PORT ${requested} is not free`);
        return requested;
      }
      const port = await findFreePort();
      assert(await canBind(port), `probed port ${port} is not free`);
      return port;
    });

    const created = await step("create fixed detached sandbox", async () => {
      if (await Sandbox.get(SANDBOX_NAME).catch(() => null)) {
        throw new Error(
          `sandbox ${SANDBOX_NAME} already exists; remove it first or set SPIKE_SANDBOX`,
        );
      }

      const builder = Sandbox.builder(SANDBOX_NAME)
        .image(IMAGE)
        .cpus(2)
        .memory(MiB(2048))
        .detached(true)
        // auto fails on this image: its entrypoint is tini, not a distro init.
        .init("/usr/bin/tini", ["--", "/usr/local/bin/paseo-docker-entrypoint"])
        .port(hostPort, GUEST_PORT)
        .env("PATH", GUEST_PATH)
        .labels({
          "paseo-msb": "v1",
          "paseo-msb-parent": parentServerId,
          "paseo-msb-phase": "creating",
        })
        .network((network) => {
          let configured = network
            .policy(NetworkPolicy.fromProfiles(["public", "host"]))
            .tls((tls) =>
              tls
                .interceptedPorts([fixture.echoPort])
                .upstreamCaCert(fixture.caCert),
            );
          for (const { env, hosts } of FIXED_SECRETS) {
            configured = configured.secret((secret) => {
              let entry = secret
                .env(env)
                .value(fixedFakes[env])
                .substituteInHeaders(true)
                .substituteInQuery(false)
                .substituteInBody(false);
              for (const upstream of hosts) entry = entry.allow(upstream);
              return entry;
            });
          }
          configured = configured.secret((secret) =>
            secret
              .env(TEST_SECRET_ENV)
              .value(testFake)
              .allow(ECHO_HOST)
              .substituteInHeaders(true)
              .substituteInQuery(false)
              .substituteInBody(false),
          );
          configured = configured.secret((secret) =>
            secret
              .env(BLOCKED_SECRET_ENV)
              .value(blockedFake)
              .allow("api.anthropic.com")
              .substituteInHeaders(true)
              .substituteInQuery(false)
              .substituteInBody(false),
          );
          return configured;
        });

      const createdSandbox = await builder.create();
      sandbox = createdSandbox;

      await createdSandbox.modify({
        labels: {
          "paseo-msb-id": createdSandbox.id,
          "paseo-msb-phase": "installing",
        },
      });

      const persisted = (await Sandbox.get(SANDBOX_NAME)).config();
      assert(
        persisted.labels["paseo-msb-id"] === createdSandbox.id,
        "stable sandbox ID label was not persisted",
      );

      const memoryMib =
        persisted.resources.memoryMib ?? persisted.resources.memory_mib;
      assert(
        persisted.resources.cpus === 2 && memoryMib === 2048,
        `unexpected resources: ${JSON.stringify(persisted.resources)}`,
      );

      return {
        name: createdSandbox.name,
        stableId: createdSandbox.id,
        hostPort,
        resources: { cpus: persisted.resources.cpus, memoryMib },
        init: persisted.init,
        state: (await Sandbox.get(SANDBOX_NAME)).status,
      };
    });

    await step("guest Node, npm, and non-root user", async () => {
      const output = await sandbox.execWith("sh", (builder) =>
        builder
          .args(["-lc", "id; node -v; npm -v; command -v node; command -v npm"])
          .user("paseo"),
      );
      const text = output.stdout().toString("utf8");
      const nodeVersion = text.match(/v(\d+)\.(\d+)\.(\d+)/);
      assert(nodeVersion, `could not read node version from: ${text}`);
      const [, major, minor] = nodeVersion;
      assert(
        Number(major) > 22 || (Number(major) === 22 && Number(minor) >= 19),
        `guest node ${nodeVersion[0]} is below 22.19`,
      );
      assert(text.includes("uid=1000(paseo)"), "commands did not run as paseo");
      return text.trim();
    });

    const job = await step("install Pi as paseo with a detached job", async () => {
      const createdJob = await sandbox.execDetachedWith("npm", (builder) =>
        builder
          .args([
            "install",
            "-g",
            "--ignore-scripts",
            "--prefix",
            PI_PREFIX,
            `${PI_PACKAGE}@${PI_VERSION}`,
          ])
          .user("paseo")
          .env("HOME", GUEST_HOME)
          .env("PATH", GUEST_PATH)
          .stdinNull(),
      );

      const exit = await Promise.race([
        createdJob.wait(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Pi install job timed out")), 600_000),
        ),
      ]);
      const info = await createdJob.inspect();
      const logs = await createdJob.logs({ tail: 30 });
      if (exit.code !== 0 || info.state !== "exited") {
        throw new Error(
          redact(
            `Pi install failed: state=${info.state} code=${exit.code}\n` +
              logs.map((entry) => entry.data.toString("utf8")).join(""),
            allFakes,
          ),
        );
      }

      await sandbox.modify({
        labels: {
          "paseo-msb-job": createdJob.id,
          "paseo-msb-phase": "registering",
        },
      });

      return { id: createdJob.id, state: info.state, exitCode: exit.code };
    });

    await step("Pi resolves on the daemon user PATH", async () => {
      const guest = await sandbox.execWith("sh", (builder) =>
        builder
          .args(["-lc", `PATH=${GUEST_PATH} pi --version`])
          .user("paseo"),
      );
      const version = guest.stdout().toString("utf8").trim();
      assert(version === PI_VERSION, `pi --version returned ${version}`);

      const diagnostic = JSON.parse(
        (
          await run("paseo", [
            "--host",
            `127.0.0.1:${hostPort}`,
            "provider",
            "diagnostic",
            "pi",
            "--json",
          ])
        ).stdout,
      ).diagnostic;
      assert(diagnostic.includes(`Resolved path: ${PI_PREFIX}/bin/pi`), diagnostic);
      assert(diagnostic.includes(`Version: ${PI_VERSION}`), diagnostic);
      assert(diagnostic.includes("Status: Ready"), diagnostic);
      return { guestVersion: version, daemonStatus: "Ready" };
    });

    await step("child daemon answers without PASEO_PASSWORD", async () => {
      const status = await waitFor("child HTTP 200", async () => {
        const code = await httpStatus(`http://127.0.0.1:${hostPort}/`);
        return code === 200 ? code : null;
      });
      const childStatus = JSON.parse(
        (
          await run("paseo", [
            "--host",
            `127.0.0.1:${hostPort}`,
            "status",
            "--json",
          ])
        ).stdout,
      );
      assert(childStatus.connectedDaemon === "reachable", "child daemon unreachable");
      return `HTTP ${status}; child serverId ${childStatus.serverId}`;
    });

    const registration = await step("register and refresh through routed client", async () => {
      const result = await registerAndRefresh(parent, sandbox, parentServerId, hostPort);
      hostRegistrationId = result.host.registrationId;
      return {
        registrationId: result.host.registrationId,
        serverId: result.online.serverId,
        status: result.online.status,
        pi: result.pi.status,
      };
    });

    await step("secrets: guest variables are placeholders", async () => {
      const names = [...FIXED_SECRETS.map((entry) => entry.env), TEST_SECRET_ENV, BLOCKED_SECRET_ENV];
      const values = await readGuestEnv(sandbox, names);
      const expected = names.map((name) => `$MSB_${name}`);
      assert(
        JSON.stringify(values) === JSON.stringify(expected),
        `guest env mismatch: ${JSON.stringify(values)}`,
      );
      const config = (await Sandbox.get(SANDBOX_NAME)).config();
      const secretByEnv = new Map(
        (config.network.secrets?.secrets ?? []).map((secret) => [secret.envVar, secret]),
      );
      for (const { env, hosts } of FIXED_SECRETS) {
        const secret = secretByEnv.get(env);
        assert(secret, `secret ${env} missing from config`);
        assert(secret.placeholder === `$MSB_${env}`, `${env} placeholder mismatch`);
        assert(secret.substitution.headers === true, `${env} headers disabled`);
        assert(secret.substitution.query === false, `${env} query enabled`);
        assert(secret.substitution.body === false, `${env} body enabled`);
        assert(
          JSON.stringify(secret.allowedHosts.map((host) => host.exact)) ===
            JSON.stringify(hosts),
          `${env} allowed hosts mismatch: ${JSON.stringify(secret.allowedHosts)}`,
        );
      }
      assert(
        config.network.tls?.enabled === true,
        "TLS interception is not enabled",
      );
      assert(
        JSON.stringify(config.network.tls?.interceptedPorts) ===
          JSON.stringify([fixture.echoPort]),
        `unexpected intercepted ports: ${JSON.stringify(config.network.tls?.interceptedPorts)}`,
      );
      assert(
        (config.network.tls?.upstreamCaCert ?? []).includes(fixture.caCert),
        `upstream CA missing: ${JSON.stringify(config.network.tls?.upstreamCaCert)}`,
      );
      return expected.join(", ");
    });

    await step("secrets: header substitution only on the allowed host", async () => {
      const before = await httpsJson(fixture.echoPort, "/__count");
      const script = [
        "curl -sk --max-time 30 -D /tmp/spike-headers.txt",
        `-H 'Authorization: Bearer $MSB_${TEST_SECRET_ENV}'`,
        `-H 'X-Header-Probe: $MSB_${TEST_SECRET_ENV}'`,
        `'https://${ECHO_HOST}:${fixture.echoPort}/echo?token=$MSB_${TEST_SECRET_ENV}'`,
        `--data 'body=$MSB_${TEST_SECRET_ENV}'`,
      ].join(" ");
      const output = await sandbox.execWith("sh", (builder) =>
        builder.args(["-lc", script]).user("paseo"),
      );
      const text = output.stdout().toString("utf8");
      let echoed;
      try {
        echoed = JSON.parse(text.slice(text.indexOf("{")));
      } catch {
        throw new Error(
          redact(
            `echo server returned non-JSON (code ${output.code}): ${text}\n${output.stderr()}`,
            allFakes,
          ),
        );
      }
      assert(
        echoed.headers.authorization === `Bearer ${testFake}`,
        "allowed host did not receive the substituted header",
      );
      assert(
        echoed.headers["x-header-probe"] === testFake,
        "second header placeholder was not substituted",
      );
      assert(
        echoed.url.includes(`token=$MSB_${TEST_SECRET_ENV}`),
        "query placeholder was substituted",
      );
      assert(
        echoed.body.includes(`body=$MSB_${TEST_SECRET_ENV}`),
        "body placeholder was substituted",
      );
      const after = await httpsJson(fixture.echoPort, "/__count");
      assert(after.requests === before.requests + 1, "echo server did not count one request");
      return "Authorization header substituted; query, body, and other headers unchanged";
    });

    await step("secrets: blocked destination", async () => {
      const before = await httpsJson(fixture.echoPort, "/__count");
      const script = [
        "curl -sk --max-time 30 -o /tmp/spike-blocked.txt -w '%{http_code}'",
        `-H 'Authorization: Bearer $MSB_${BLOCKED_SECRET_ENV}'`,
        `'https://${ECHO_HOST}:${fixture.echoPort}/blocked'`,
      ].join(" ");
      const output = await sandbox.execWith("sh", (builder) =>
        builder.args(["-lc", script]).user("paseo"),
      );
      const code = output.stdout().toString("utf8").trim();
      const body = await sandbox.execWith("sh", (builder) =>
        builder.args(["-lc", "cat /tmp/spike-blocked.txt"]).user("paseo"),
      );
      const blockedBody = body.stdout().toString("utf8");
      assert(code !== "200", `blocked request returned ${code}`);
      assert(
        /secret|blocked|denied|forbidden/i.test(blockedBody) || code === "403",
        `unexpected blocked response: ${redact(blockedBody, allFakes)}`,
      );
      const after = await httpsJson(fixture.echoPort, "/__count");
      assert(after.requests === before.requests, "blocked request reached the upstream");
      return `blocked with HTTP ${code}`;
    });

    await step("labels, config, and logs survive a parent daemon restart", async () => {
      const before = await httpsJson(fixture.echoPort, "/__count");
      await run("paseo", ["daemon", "restart", "--home", PARENT_HOME], {
        timeout: 180_000,
      });
      await waitFor("parent restart", async () => {
        const status = JSON.parse(
          (await run("paseo", ["--home", PARENT_HOME, "status", "--json"])).stdout,
        );
        return status.connectedDaemon === "reachable";
      });

      await parent.close();
      parent = createParentClient();
      await parent.connect();
      const online = await waitFor("registration reconnects", async () => {
        const directory = await parent.hosts.list();
        const entry = directory.hosts.find(
          (candidate) => candidate.registrationId === hostRegistrationId,
        );
        return entry?.status === "online" ? entry : null;
      });

      const handle = await Sandbox.get(SANDBOX_NAME);
      assert(handle.status === "running", `sandbox status after restart is ${handle.status}`);
      const config = handle.config();
      assert(config.labels["paseo-msb-id"] === created.stableId, "stable ID label lost");
      assert(config.labels["paseo-msb-job"] === job.id, "job label lost");
      const logs = await handle.logs({ tail: 20 });
      assert(logs.length > 0, "no sandbox logs after restart");
      const restoredJob = await handle.getJob(job.id);
      const jobInfo = await restoredJob.inspect();
      assert(jobInfo.id === job.id, "detached job cannot be inspected after restart");
      const remote = await parent.hosts.client(online.serverId);
      try {
        await remote.providers.refresh({ providers: ["pi"] });
        const snapshot = await remote.providers.snapshot({});
        const pi = snapshot.entries.find((entry) => entry.provider === "pi");
        assert(pi?.status === "ready", `pi status after restart is ${pi?.status}`);
      } finally {
        await remote.dispose();
      }
      const after = await httpsJson(fixture.echoPort, "/__count");
      assert(after.requests === before.requests, "echo fixture saw restart traffic");
      return {
        sandboxStatus: handle.status,
        jobState: jobInfo.state,
        labels: config.labels,
        logLines: logs.length,
      };
    });

    await step("hosts.remove and port release after stop", async () => {
      await parent.hosts.remove(hostRegistrationId);
      hostRegistrationId = null;
      const directory = await parent.hosts.list();
      assert(
        !directory.hosts.some((entry) => entry.label === `${parentServerId}/${SANDBOX_NAME}`),
        "registration was not removed",
      );

      const handle = await Sandbox.get(SANDBOX_NAME);
      await handle.stop();
      const released = await waitFor("port release after stop", () => canBind(hostPort), {
        timeoutMs: 60_000,
      });
      assert(released, "host port was not released after stop");
      return `registration removed; 127.0.0.1:${hostPort} released after stop`;
    });

    await step("stable-ID replacement checks", async () => {
      const name = `${SANDBOX_NAME}-replace`;
      const first = await Sandbox.builder(name)
        .image("debian:trixie-slim")
        .cpus(1)
        .memory(MiB(256))
        .detached(true)
        .create();
      const firstId = first.id;
      await first.destroy();
      const second = await Sandbox.builder(name)
        .image("debian:trixie-slim")
        .cpus(1)
        .memory(MiB(256))
        .detached(true)
        .create();
      try {
        assert(second.id !== firstId, "same-name replacement reused the stable ID");
        let refused = false;
        try {
          await first.destroy();
        } catch {
          refused = true;
        }
        assert(refused, "old handle destroyed a same-name replacement");
        return `stable ID changed ${firstId} -> ${second.id}; old handle refused`;
      } finally {
        await second.destroy();
      }
    });

    process.stdout.write("\n== summary\n");
    process.stdout.write(
      `${JSON.stringify({ pins: versions, parent: parentStatus, created, registration, job }, null, 2)}\n`,
    );
    process.stdout.write("\nAll vertical-slice checks passed.\n");
  } finally {
    await cleanup({ parent, sandbox, hostRegistrationId, echo, certDir });
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    process.stderr.write(`\n${error.stack ?? error.message}\n`);
    process.exit(1);
  });

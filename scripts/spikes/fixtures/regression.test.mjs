import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startControlledHttps } from "./controlled-https.mjs";
import { startIsolatedParent, stopIsolatedParent } from "./paseo-daemon.mjs";
import { BLOCKED_HOST, CONTROLLED_HOST } from "./pins.mjs";
import { Report } from "./report.mjs";
import { buildSandboxConfig, inspectConfig } from "./sandbox-config.mjs";

function hasPaseoCli() {
  const result = spawnSync(process.env.PASEO_BIN ?? "paseo", ["--version"], { encoding: "utf8" });
  return result.status === 0;
}

function temporaryTlsDirectories() {
  return new Set(
    fs
      .readdirSync(os.tmpdir())
      .filter((entry) => entry.startsWith("paseo-msb-spike-tls-")),
  );
}

test("static init evidence does not make a runtime acceptance group pass", () => {
  const report = new Report({});
  report.staticPass("init.auto-unavailable", "Image has no init auto candidates", {
    evidence: { autoCandidates: 0 },
  });
  const guest = report.acceptance().find((group) => group.id === "guest");
  assert.ok(guest);
  assert.notEqual(guest.status, "pass");
  assert.equal(report.runtimeVerified(), false);
});

test("controlled HTTPS uses a distinct disallowed host and cleans its certificate directory", async () => {
  const controlled = await startControlledHttps();
  try {
    assert.ok(fs.existsSync(controlled.directory));
    assert.equal(fs.existsSync(controlled.caCertPath), true);
    assert.notEqual(new URL(controlled.blockedUrl).hostname, CONTROLLED_HOST);
    assert.equal(new URL(controlled.blockedUrl).hostname, BLOCKED_HOST);

    const certificate = new X509Certificate(fs.readFileSync(controlled.serverCertPath));
    assert.match(certificate.subjectAltName ?? "", /DNS:host\.microsandbox\.internal/);
    assert.match(certificate.subjectAltName ?? "", /DNS:blocked\.paseo-msb\.invalid/);

    const config = await buildSandboxConfig({
      name: "paseo-msb-spike-regression-config",
      init: "fallback",
      hostPort: 0,
      includeControlledSecret: true,
      controlledCaPath: controlled.caCertPath,
    });
    const summary = inspectConfig(config);
    const controlledSecret = summary.secrets.find(
      (entry) => entry.allowedHosts?.some((host) => host.exact === CONTROLLED_HOST),
    );
    assert.ok(controlledSecret);
    assert.equal(
      controlledSecret.allowedHosts.some((host) => host.exact === BLOCKED_HOST),
      false,
    );
    const scopedCaHosts = summary.tls.scopedUpstreamCaCert.map((entry) => entry.pattern);
    assert.ok(scopedCaHosts.includes(BLOCKED_HOST));
  } finally {
    await controlled.close();
  }
  assert.equal(fs.existsSync(controlled.directory), false);
});

test("controlled HTTPS startup failure preserves the original error and removes cert temp state", async () => {
  const before = temporaryTlsDirectories();
  const emptyPath = fs.mkdtempSync(path.join(os.tmpdir(), "paseo-msb-spike-no-tools-"));
  const originalPath = process.env.PATH;
  try {
    process.env.PATH = emptyPath;
    await assert.rejects(startControlledHttps(), (error) => {
      assert.equal(error?.code, "ENOENT");
      assert.doesNotMatch(String(error?.message), /Cannot read properties of null/);
      return true;
    });
  } finally {
    process.env.PATH = originalPath;
    fs.rmSync(emptyPath, { recursive: true, force: true });
  }
  const leftover = [...temporaryTlsDirectories()].filter((entry) => !before.has(entry));
  assert.deepEqual(leftover, []);
});

test("stopping an isolated parent removes its temporary home", async (t) => {
  if (!hasPaseoCli()) {
    t.skip("paseo CLI is unavailable");
    return;
  }
  const parent = await startIsolatedParent();
  assert.equal(fs.existsSync(parent.home), true);
  await stopIsolatedParent(parent);
  assert.equal(fs.existsSync(parent.home), false);
});

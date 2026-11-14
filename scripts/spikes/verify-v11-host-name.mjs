#!/usr/bin/env node
/**
 * Task 1.1 spike: named registration and host display.
 *
 * Creates a sandbox with a custom name, registers it with
 * `label = <name>` and `metadata = { source, name }`, and inspects the parent
 * host directory. It also proves that a duplicate strict create fails without
 * replacing the first sandbox and records how the pinned runtime and parent
 * treat the V1.1 1–63 lowercase-slug rule.
 *
 * Run against an isolated parent daemon and the pinned microsandbox runtime:
 *
 *   node scripts/spikes/verify-v11-host-name.mjs \
 *     --parent "$PASEO_PARENT_URL" --name paseo-v11-name-probe
 *
 * Environment:
 *   PASEO_PARENT_URL   Parent daemon WebSocket URL (default ws://127.0.0.1:6780/ws)
 *   PASEO_PASSWORD     Parent daemon password, when required
 *   PASEO_IMAGE_PIN    Pinned Paseo image (default ghcr.io/getpaseo/paseo:0.15.4)
 *
 * Results are recorded in docs/spikes/v11-host-name.md. Every registration and
 * sandbox is removed in `finally`.
 */

import { createPaseoClient } from "@getpaseo/client";
import { MiB, Sandbox } from "microsandbox";
import net from "node:net";
import { parseArgs } from "node:util";

const SLUG_RULE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const GUEST_PORT = 6767;
const GUEST_USER = "paseo";
const INIT_COMMAND = "/usr/bin/tini";
const INIT_ARGS = ["--", "/usr/local/bin/paseo-docker-entrypoint"];
const SPIKE_LABEL = "paseo-msb-v11-host-name-spike";

const { values } = parseArgs({
  options: {
    parent: {
      type: "string",
      default: process.env.PASEO_PARENT_URL?.trim() || "ws://127.0.0.1:6780/ws",
    },
    name: { type: "string", default: "paseo-v11-name-probe" },
    image: {
      type: "string",
      default: process.env.PASEO_IMAGE_PIN?.trim() || "ghcr.io/getpaseo/paseo:0.15.4",
    },
    timeout: { type: "string", default: "90" },
    password: { type: "string", default: process.env.PASEO_PASSWORD?.trim() || "" },
  },
  allowPositionals: false,
});

const PARENT_URL = values.parent;
const NAME = values.name;
const IMAGE = values.image;
const ONLINE_TIMEOUT_MS = Number(values.timeout) * 1_000;
const PASSWORD = values.password;
const nonce = `${process.pid}-${Date.now().toString(36)}`;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function attempt(operation) {
  try {
    return { rejected: false, value: await operation() };
  } catch (error) {
    return {
      rejected: true,
      name: error instanceof Error ? error.name : typeof error,
      code: typeof error?.code === "string" ? error.code : null,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function waitFor(label, predicate, { timeoutMs, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  return { timedOut: true, label, lastError: lastError?.message ?? null };
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close(() => (port ? resolve(port) : reject(new Error("no free port"))));
    });
  });
}

function probeBuilder(name, { hostPort } = {}) {
  let builder = Sandbox.builder(name)
    .image(IMAGE)
    .cpus(1)
    .memory(MiB(1024))
    .detached(true)
    .init(INIT_COMMAND, INIT_ARGS)
    .labels({ [SPIKE_LABEL]: "v11" });

  if (hostPort) builder = builder.port(hostPort, GUEST_PORT);
  return builder;
}

function describeAttempt(result) {
  if (!result.rejected) return { rejected: false };
  return {
    rejected: true,
    name: result.name,
    code: result.code,
    message: result.message,
  };
}

function projectRow(row) {
  return {
    registrationId: row.registrationId,
    serverId: row.serverId,
    label: row.label,
    metadata: row.metadata,
    source: row.source,
    enabled: row.enabled,
    status: row.status,
    targetDescription: row.targetDescription,
  };
}

async function readGuestHostname(handle) {
  try {
    const connected = await handle.connect();
    const output = await connected.execWith("sh", (builder) =>
      builder.args(["-lc", "hostname 2>/dev/null || cat /etc/hostname"]).user(GUEST_USER),
    );
    return {
      code: output.code,
      hostname: String(output.stdout()).trim() || null,
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function main() {
  assert(
    SLUG_RULE.test(NAME),
    `--name "${NAME}" does not match the V1.1 1-63 lowercase-slug rule`,
  );

  const summary = {
    startedAt: new Date().toISOString(),
    parentUrl: PARENT_URL,
    image: IMAGE,
    requestedName: NAME,
    rule: {
      pattern: SLUG_RULE.source,
      description:
        "1-63 chars, lowercase ASCII letters, digits, internal hyphens, starting and ending alphanumeric",
    },
  };
  const created = [];
  const registrations = new Set();
  const sourceKeys = new Set();
  const cleanup = { registrations: [], sandboxes: [] };
  let parent;
  let mainRow = null;

  try {
    parent = createPaseoClient({
      url: PARENT_URL,
      clientId: `paseo-msb-v11-host-name-spike-${nonce}`,
      connectTimeoutMs: 15_000,
      ...(PASSWORD ? { password: PASSWORD } : {}),
    });
    await parent.connect();

    const initial = await parent.hosts.list();
    summary.parent = {
      serverId: initial.self.serverId,
      label: initial.self.label,
      registrations: initial.hosts.length,
    };

    const hostPort = await findFreePort();
    const createAttempt = await attempt(() => probeBuilder(NAME, { hostPort }).create());
    assert(
      !createAttempt.rejected,
      `strict create rejected the chosen name: ${createAttempt.message}`,
    );
    const handle = await Sandbox.get(NAME);
    created.push({ name: NAME, handle });
    sourceKeys.add(handle.id);
    assert(handle.id === createAttempt.value.id, "strict create returned a different generation");

    summary.sandbox = {
      name: handle.name,
      id: handle.id,
      hostPort,
      guestPort: GUEST_PORT,
      guestHostname: await readGuestHostname(handle),
    };

    const registrationInput = {
      connection: `127.0.0.1:${hostPort}`,
      label: NAME,
      metadata: { source: "paseo-msb", name: NAME },
      sourceKey: handle.id,
    };
    summary.registrationInput = registrationInput;

    const added = await parent.hosts.add(registrationInput);
    registrations.add(added.registrationId);

    const rowResult = await waitFor(
      "registration listed",
      async () => {
        const directory = await parent.hosts.list();
        const row = directory.hosts.find(
          (candidate) => candidate.registrationId === added.registrationId,
        );
        return row ? projectRow(row) : null;
      },
      { timeoutMs: 15_000 },
    );
    assert(!rowResult.timedOut, "registration never appeared in the host directory");
    mainRow = rowResult;

    assert(mainRow.label === NAME, `parent rewrote the label: ${JSON.stringify(mainRow.label)}`);
    assert(
      mainRow.metadata.source === "paseo-msb" && mainRow.metadata.name === NAME,
      `parent rewrote registration metadata: ${JSON.stringify(mainRow.metadata)}`,
    );

    const online = await waitFor(
      "registration online",
      async () => {
        const directory = await parent.hosts.list();
        const row = directory.hosts.find(
          (candidate) => candidate.registrationId === added.registrationId,
        );
        if (!row) return null;
        mainRow = projectRow(row);
        return row.status === "online" && row.serverId ? mainRow : null;
      },
      { timeoutMs: ONLINE_TIMEOUT_MS },
    );

    summary.registration = {
      producer: added.source,
      directoryRow: mainRow,
      finalStatus: mainRow?.status ?? null,
      online: !online.timedOut,
      onlineWait: online.timedOut
        ? { timedOut: true, lastError: online.lastError }
        : { timedOut: false },
    };

    // The guest daemon's own label is the alternative source the picker could
    // have used. Record it when routing is available.
    if (mainRow?.serverId) {
      const routed = await attempt(async () => {
        const client = await parent.hosts.client(mainRow.serverId);
        try {
          const directory = await client.hosts.list();
          return {
            serverId: directory.self.serverId,
            label: directory.self.label,
          };
        } finally {
          await client.dispose().catch(() => {});
        }
      });
      summary.guestDaemon = routed.rejected
        ? { error: routed.message }
        : { directorySelf: routed.value };
    } else {
      summary.guestDaemon = { unavailable: "registration is not routed online yet" };
    }

    const duplicate = await attempt(() => probeBuilder(NAME, { hostPort }).create());
    const replacement = await Sandbox.get(NAME);
    const refreshed = await handle.refresh();
    const afterDuplicateDirectory = await parent.hosts.list();
    const duplicateRow = afterDuplicateDirectory.hosts.find(
      (candidate) => candidate.registrationId === added.registrationId,
    );

    summary.duplicateCreate = {
      ...describeAttempt(duplicate),
      originalId: handle.id,
      idAfterDuplicate: replacement.id,
      refreshedId: refreshed.id,
      sameGeneration: replacement.id === handle.id && refreshed.id === handle.id,
      registrationRowStillPresent: Boolean(duplicateRow),
    };

    assert(duplicate.rejected, "duplicate strict create unexpectedly succeeded");
    assert(replacement.id === handle.id, "duplicate create replaced the first sandbox");
    assert(refreshed.id === handle.id, "the first sandbox generation changed");
    assert(duplicateRow, "registration disappeared after the duplicate create");
    assert(
      duplicateRow.label === NAME && duplicateRow.metadata.name === NAME,
      "duplicate create changed the registration display",
    );

    // The pinned runtime and parent are more permissive than the V1.1 rule.
    // Test the boundaries so task 2.5 knows validation must live in the plugin.
    const candidates = [
      { case: "valid-min", name: "a" },
      { case: "valid-max-63", name: "a".repeat(63) },
      { case: "too-long-64", name: "a".repeat(64) },
      { case: "uppercase", name: "Mixed-Case" },
      { case: "underscore", name: "has_underscore" },
      { case: "dot", name: "has.dot" },
      { case: "trailing-hyphen", name: "trailing-" },
      { case: "leading-hyphen", name: "-leading" },
      { case: "slash", name: "has/slash" },
      { case: "space", name: "has space" },
      { case: "unicode", name: "é" },
    ];
    const runtimeMatrix = [];
    for (const candidate of candidates) {
      const built = await attempt(() => probeBuilder(candidate.name).build());
      runtimeMatrix.push({
        ...candidate,
        pluginRuleAccepts: SLUG_RULE.test(candidate.name),
        runtimeBuild: describeAttempt(built),
      });
    }

    const longPrefix = "paseo-v11-slug-";
    const longName = `${longPrefix}${"a".repeat(64 - longPrefix.length)}`;
    assert(longName.length === 64, "long probe name is not exactly 64 characters");
    const longCreate = await attempt(() => probeBuilder(longName).create());
    if (!longCreate.rejected) {
      const longHandle = await Sandbox.get(longName);
      created.push({ name: longName, handle: longHandle });
    }

    const longLabel = "a".repeat(64);
    const parentLongAdd = await attempt(() =>
      parent.hosts.add({
        connection: "127.0.0.1:1",
        label: longLabel,
        metadata: { source: "paseo-msb", name: longLabel },
        sourceKey: `spike-slug-64-${nonce}`,
      }),
    );
    if (!parentLongAdd.rejected) registrations.add(parentLongAdd.value.registrationId);
    sourceKeys.add(`spike-slug-64-${nonce}`);

    const tooLongLabel = "a".repeat(257);
    const parentTooLongAdd = await attempt(() =>
      parent.hosts.add({
        connection: "127.0.0.1:1",
        label: tooLongLabel,
        metadata: { source: "paseo-msb", name: tooLongLabel },
        sourceKey: `spike-slug-257-${nonce}`,
      }),
    );
    if (!parentTooLongAdd.rejected) registrations.add(parentTooLongAdd.value.registrationId);
    sourceKeys.add(`spike-slug-257-${nonce}`);

    summary.ruleCheck = {
      runtimeBuildMatrix: runtimeMatrix,
      runtimeCreateAt64: {
        name: longName,
        length: longName.length,
        ...describeAttempt(longCreate),
      },
      parentAddAt64: {
        labelLength: longLabel.length,
        ...describeAttempt(parentLongAdd),
      },
      parentAddAt257: {
        labelLength: tooLongLabel.length,
        ...describeAttempt(parentTooLongAdd),
      },
      conclusion:
        "The pinned runtime accepts names outside the V1.1 slug rule, and the parent only bounds the label at 256 characters. The plugin must enforce the 1-63 lowercase-slug rule before create and registration.",
    };

    summary.pass =
      mainRow.label === NAME &&
      mainRow.metadata.source === "paseo-msb" &&
      mainRow.metadata.name === NAME &&
      duplicate.rejected === true &&
      replacement.id === handle.id;
  } finally {
    if (parent) {
      // A lost add response may have created a row without a known id. Remove
      // every spike-owned source key as well as every recorded registration.
      try {
        const directory = await parent.hosts.list();
        for (const row of directory.hosts) {
          if (row.source?.key && sourceKeys.has(row.source.key)) {
            registrations.add(row.registrationId);
          }
        }
      } catch {
        // Registration cleanup still attempts recorded ids below.
      }

      for (const registrationId of [...registrations].reverse()) {
        try {
          await parent.hosts.remove(registrationId);
          cleanup.registrations.push({ registrationId, removed: true });
        } catch (error) {
          cleanup.registrations.push({
            registrationId,
            removed: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      try {
        const directory = await parent.hosts.list();
        cleanup.registrationsRemaining = directory.hosts
          .filter((row) => registrations.has(row.registrationId))
          .map((row) => row.registrationId);
      } catch (error) {
        cleanup.registrationsRemainingError =
          error instanceof Error ? error.message : String(error);
      }
    }

    for (const entry of created.reverse()) {
      try {
        await entry.handle.destroy({ force: true, timeoutMs: 15_000 });
        cleanup.sandboxes.push({ name: entry.name, removed: true });
      } catch (error) {
        try {
          await Sandbox.remove(entry.name);
          cleanup.sandboxes.push({ name: entry.name, removed: true, fallback: "Sandbox.remove" });
        } catch (fallbackError) {
          cleanup.sandboxes.push({
            name: entry.name,
            removed: false,
            error: error instanceof Error ? error.message : String(error),
            fallbackError:
              fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
          });
        }
      }
    }

    const verifiedRemovals = [];
    for (const entry of created) {
      const remaining = await Sandbox.get(entry.name)
        .then((sandbox) => ({ name: entry.name, remaining: true, id: sandbox.id }))
        .catch(() => ({ name: entry.name, remaining: false }));
      verifiedRemovals.push(remaining);
    }
    cleanup.verifiedRemovals = verifiedRemovals;

    if (parent) {
      try {
        await parent.close();
      } catch {
        // ignore
      }
    }

    summary.cleanup = cleanup;
    summary.finishedAt = new Date().toISOString();
    summary.pass =
      Boolean(summary.pass) &&
      cleanup.registrations.every((entry) => entry.removed) &&
      cleanup.sandboxes.every((entry) => entry.removed) &&
      verifiedRemovals.every((entry) => !entry.remaining) &&
      (cleanup.registrationsRemaining?.length ?? 0) === 0;

    process.stdout.write(`\nSPIKE_RESULT ${JSON.stringify(summary)}\n`);
    process.stdout.write(`\n${summary.pass ? "PASS" : "FAIL"} named registration spike\n`);
    if (!summary.pass) process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`\nSpike failed: ${error instanceof Error ? error.stack : error}\n`);
  process.exitCode = 1;
});

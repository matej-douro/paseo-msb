#!/usr/bin/env node
/**
 * Task 7 spikes: exact-handle identity, paginated job recovery, and real
 * plugin registration semantics.
 *
 * Run against an isolated parent daemon and the pinned microsandbox runtime:
 *
 *   npm run spike:identity
 *
 * Environment:
 *   PASEO_HOME         Parent daemon home (default .scratch/paseo-home)
 *   PASEO_PARENT_URL   Parent daemon WebSocket URL (default ws://127.0.0.1:6793/ws)
 *   SPIKE_IMAGE        Pinned Paseo image (default ghcr.io/getpaseo/paseo:0.15.4)
 *   SPIKE_KEEP=1       Leave created sandboxes for inspection
 *
 * Results are recorded in docs/spikes/identity-lifecycle.md.
 */

import { createPaseoClient } from "@getpaseo/client";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { MiB, Sandbox } from "microsandbox";
import crypto from "node:crypto";
import { cp, mkdtemp, rm, symlink } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");

const IMAGE = process.env.SPIKE_IMAGE ?? "ghcr.io/getpaseo/paseo:0.15.4";
const PARENT_HOME = process.env.PASEO_HOME ?? join(repoRoot, ".scratch/paseo-home");
const PARENT_URL = process.env.PASEO_PARENT_URL ?? "ws://127.0.0.1:6793/ws";
const KEEP = process.env.SPIKE_KEEP === "1";

const GUEST_PORT = 6767;
const GUEST_USER = "paseo";
const GUEST_PATH =
  "/home/paseo/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const INIT_COMMAND = "/usr/bin/tini";
const INIT_ARGS = ["--", "/usr/local/bin/paseo-docker-entrypoint"];

const nonce = crypto.randomBytes(3).toString("hex");
const NAME = `paseo-msb-identity-${nonce}`;
const SPIKE_PLUGIN_ID = "paseo-msb-identity-spike";
const SPIKE_PLUGIN_DIR = join(here, "fixtures", "identity-plugin");

const results = [];

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

function describeAttempt(result) {
  if (result.rejected) {
    return {
      rejected: true,
      name: result.name,
      code: result.code,
      message: result.message,
    };
  }
  return { rejected: false };
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function waitFor(label, predicate, { timeoutMs = 120_000, intervalMs = 250 } = {}) {
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
  throw new Error(`${label} timed out${lastError ? `: ${lastError.message}` : ""}`);
}

function findFreePort() {
  return new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close(() => (port ? resolvePort(port) : reject(new Error("no port"))));
    });
  });
}

async function attempt(operation) {
  try {
    const value = await operation();
    return { rejected: false, value };
  } catch (error) {
    return {
      rejected: true,
      name: error instanceof Error ? error.name : typeof error,
      code: typeof error?.code === "string" ? error.code : null,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function createSandbox(name, parentId, hostPort) {
  const sandbox = await Sandbox.builder(name)
    .image(IMAGE)
    .cpus(1)
    .memory(MiB(1024))
    .detached(true)
    .init(INIT_COMMAND, INIT_ARGS)
    .port(hostPort, GUEST_PORT)
    .env("PATH", GUEST_PATH)
    .labels({
      "paseo-msb": "v1",
      "paseo-msb-parent": parentId,
      "paseo-msb-phase": "creating",
    })
    .create();
  return { sandbox, handle: await Sandbox.get(name) };
}

async function destroy(name, handle) {
  if (KEEP) return;
  try {
    if (handle) await handle.destroy({ force: true, timeoutMs: 15_000 });
  } catch {
    // fall through to name-based removal
  }
  try {
    await Sandbox.remove(name);
  } catch {
    // already gone
  }
}

async function inspectJob(handle, id) {
  const job = await handle.getJob(id);
  return job.inspect();
}

async function listAllJobs(handle, pageSize = 2) {
  const items = [];
  const seen = new Set();
  let cursor;
  while (true) {
    const page = await handle.listJobsWith((builder) => {
      const configured = builder.all(true).limit(pageSize);
      return cursor ? configured.cursor(cursor) : configured;
    });
    items.push(...page.items);
    if (!page.nextCursor) break;
    assert(!seen.has(page.nextCursor), "job pagination repeated a cursor");
    seen.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  return items;
}

async function main() {
  let parent;
  let first;
  let replacement;
  const created = [];

  try {
    const parentInfo = await step("parent daemon and directory", async () => {
      parent = createPaseoClient({
        url: PARENT_URL,
        clientId: `paseo-msb-identity-spike-${nonce}`,
        connectTimeoutMs: 15_000,
      });
      await parent.connect();
      const directory = await parent.hosts.list();
      return {
        home: PARENT_HOME,
        url: PARENT_URL,
        serverId: directory.self.serverId,
        registrations: directory.hosts.length,
      };
    });
    const parentId = parentInfo.serverId;

    const exactHandle = await step("exact-handle matrix", async () => {
      const hostPort = await findFreePort();
      first = await createSandbox(NAME, parentId, hostPort);
      created.push({ name: NAME, value: first });

      const refreshed = await first.handle.refresh();
      assert(refreshed.id === first.handle.id, "refresh changed the stable id");

      const connected = await first.handle.connect();
      assert(connected.id === first.handle.id, "connect changed the stable id");
      const guest = await connected.execWith("sh", (builder) =>
        builder.args(["-lc", "id -un"]).user(GUEST_USER),
      );
      assert(guest.code === 0, "connect could not execute in the guest");

      await first.handle.modify({ labels: { "spike-exact": "yes" } });
      const updated = await waitFor("modified label", async () => {
        const refreshed = await first.handle.refresh();
        return refreshed.config().labels["spike-exact"] === "yes" ? refreshed : null;
      });
      const labels = updated.config().labels;

      return {
        id: first.handle.id,
        refreshId: refreshed.id,
        connectId: connected.id,
        guestUser: guest.stdout().toString("utf8").trim(),
        modifiedLabels: {
          "spike-exact": labels["spike-exact"],
        },
      };
    });

    const replacementInfo = await step("same-name replacement rejects stale handle", async () => {
      const staleHandle = first.handle;
      const oldId = staleHandle.id;
      const staleJob = await first.sandbox.execDetachedWith("sh", (builder) =>
        builder.args(["-lc", "echo stale-job"]).user(GUEST_USER),
      );
      await staleJob.wait();

      await staleHandle.destroy({ force: true, timeoutMs: 15_000 });
      first = null;

      const hostPort = await findFreePort();
      replacement = await createSandbox(NAME, parentId, hostPort);
      created.push({ name: NAME, value: replacement });
      assert(replacement.sandbox.name === NAME, "replacement did not reuse the name");
      assert(replacement.handle.id !== oldId, "replacement reused the stable id");

      const refresh = await attempt(() => staleHandle.refresh());
      const connect = await attempt(() => staleHandle.connect());
      const modify = await attempt(() =>
        staleHandle.modify({ labels: { "spike-stale": "yes" } }),
      );
      const listJobs = await attempt(() =>
        staleHandle.listJobsWith((b) => b.all(true).limit(2)),
      );
      const getJob = await attempt(() => staleHandle.getJob(staleJob.id));
      const destroy = await attempt(() =>
        staleHandle.destroy({ force: true, timeoutMs: 15_000 }),
      );

      const survivor = await Sandbox.get(NAME);
      const survivorLabels = survivor.config().labels;
      const survivorJobs = await listAllJobs(survivor, 10);

      // Assertion-backed regression guard for every documented stale-handle
      // outcome. If the SDK changes, this spike must fail instead of silently
      // recording a different matrix.
      for (const [label, outcome] of [
        ["refresh", refresh],
        ["connect", connect],
        ["listJobsWith", listJobs],
        ["getJob", getJob],
        ["destroy", destroy],
      ]) {
        assert(outcome.rejected, `stale ${label} was accepted`);
      }
      assert(survivor.id === replacement.handle.id, "stale destroy removed the replacement");
      assert(
        survivorLabels["spike-stale"] === "yes",
        "stale modify no longer reaches the replacement: narrow guardedModify",
      );

      return {
        oldId,
        replacementId: replacement.handle.id,
        stale: {
          refresh: describeAttempt(refresh),
          connect: describeAttempt(connect),
          modify: {
            ...describeAttempt(modify),
            appliedToReplacement: survivorLabels["spike-stale"] === "yes",
          },
          listJobs: {
            ...describeAttempt(listJobs),
            returnedJobIds: listJobs.rejected ? null : listJobs.value.items.map((item) => item.id),
            replacementJobIds: survivorJobs.map((item) => item.id),
          },
          getJob: describeAttempt(getJob),
          destroy: {
            ...describeAttempt(destroy),
            replacementSurvived: survivor.id === replacement.handle.id,
          },
        },
      };
    });

    const jobs = await step("job inventory and recovery", async () => {
      const success = await replacement.sandbox.execDetachedWith("sh", (builder) =>
        builder.args(["-lc", "echo spike-success"]).user(GUEST_USER),
      );
      await success.wait();

      const failure = await replacement.sandbox.execDetachedWith("sh", (builder) =>
        builder.args(["-lc", "echo spike-failure >&2; exit 7"]).user(GUEST_USER),
      );
      await failure.wait();

      const running = await replacement.sandbox.execDetachedWith("sh", (builder) =>
        builder.args(["-lc", "sleep 60"]).user(GUEST_USER),
      );
      const runningInfo = await running.inspect();
      assert(runningInfo.state === "running" || runningInfo.state === "starting", "long job is not running");
      await running.kill();

      const inventory = await listAllJobs(replacement.handle, 2);
      const ids = inventory.map((item) => item.id);
      for (const job of [success, failure, running]) {
        assert(ids.includes(job.id), `job inventory is missing ${job.id}`);
      }

      const successInfo = await success.inspect();
      const failureInfo = await failure.inspect();

      assert(
        successInfo.state === "exited" && successInfo.exitCode === 0,
        "successful job was not classified as exited/0",
      );
      assert(
        failureInfo.state === "exited" && failureInfo.exitCode === 7,
        "failing job was not classified as exited/7",
      );

      // Reload: a fresh handle sees the same durable jobs and states.
      const reloaded = await Sandbox.get(NAME);
      const reloadedJobs = await listAllJobs(reloaded, 2);
      const reloadedIds = reloadedJobs.map((item) => item.id);
      for (const job of [success, failure, running]) {
        assert(reloadedIds.includes(job.id), `reloaded inventory is missing ${job.id}`);
      }
      const recovered = await inspectJob(reloaded, success.id);

      // Uncertain launch errors may carry a recoverable job id.
      let uncertain = null;
      try {
        await replacement.sandbox.execDetachedWith("definitely-not-a-real-command", (builder) =>
          builder.args(["--spike"]).user(GUEST_USER),
        );
      } catch (error) {
        uncertain = {
          name: error instanceof Error ? error.name : typeof error,
          code: typeof error?.code === "string" ? error.code : null,
          jobId: typeof error?.jobId === "string" ? error.jobId : null,
          inspectable: false,
        };
        if (uncertain.jobId) {
          try {
            const info = await inspectJob(replacement.handle, uncertain.jobId);
            uncertain.inspectable = true;
            uncertain.state = info.state;
            uncertain.exitCode = info.exitCode;
          } catch (inspectError) {
            uncertain.inspectError = inspectError.message;
          }
        }
      }

      assert(
        uncertain === null || uncertain.jobId === null || uncertain.inspectable,
        "uncertain launch exposed an uninspectable job id",
      );

      return {
        jobs: inventory.map((item) => ({
          id: item.id,
          command: item.command,
          state: item.state,
          exitCode: item.exitCode,
          timedOut: item.timedOut,
          failure: item.failure,
        })),
        success: {
          state: successInfo.state,
          exitCode: successInfo.exitCode,
          command: successInfo.command,
        },
        failure: {
          state: failureInfo.state,
          exitCode: failureInfo.exitCode,
          command: failureInfo.command,
        },
        recovered: {
          id: recovered.id,
          state: recovered.state,
          exitCode: recovered.exitCode,
          command: recovered.command,
        },
        uncertain,
      };
    });

    const registration = await step("real plugin registration semantics", async () => {
      const input = {
        connection: "127.0.0.1:1",
        label: `${parentId}/${NAME}`,
        metadata: { source: "paseo-msb", name: NAME },
        sourceKey: replacement.handle.id,
      };

      const firstAdd = await parent.hosts.add(input);
      const repeatedAdd = await attempt(() => parent.hosts.add(input));
      const afterRepeat = await parent.hosts.list();
      const repeatRegistrations = afterRepeat.hosts.filter(
        (candidate) => candidate.source.key === replacement.handle.id,
      );
      assert(
        repeatRegistrations.length === 1,
        "repeated add did not leave exactly one registration",
      );

      await parent.hosts.update(firstAdd.registrationId, { enabled: false });
      const disabled = await waitFor("registration disabled", async () => {
        const directory = await parent.hosts.list();
        const entry = directory.hosts.find(
          (candidate) => candidate.registrationId === firstAdd.registrationId,
        );
        return entry?.enabled === false ? entry : null;
      });

      const afterDisabledAdd = await attempt(() => parent.hosts.add(input));
      const stillDisabled = await waitFor("disabled state preserved", async () => {
        const directory = await parent.hosts.list();
        const entry = directory.hosts.find(
          (candidate) => candidate.registrationId === firstAdd.registrationId,
        );
        return entry?.enabled === false ? entry : null;
      });

      const conflict = await attempt(() =>
        parent.hosts.add({
          ...input,
          metadata: { source: "paseo-msb", name: `${NAME}-changed` },
        }),
      );
      assert(conflict.rejected, "changed-metadata add did not conflict");

      const updated = await parent.hosts.update(firstAdd.registrationId, {
        metadata: { source: "paseo-msb", name: NAME },
        label: `${parentId}/${NAME}`,
        connection: "127.0.0.1:2",
        enabled: true,
      });

      const lostResponseRetry = await attempt(() => parent.hosts.add(input));
      const afterLostResponse = await parent.hosts.list();
      const lostResponseRegistrations = afterLostResponse.hosts.filter(
        (candidate) => candidate.source.key === replacement.handle.id,
      );
      assert(
        lostResponseRegistrations.length === 1,
        "lost-response retry did not leave exactly one registration",
      );

      await parent.hosts.remove(firstAdd.registrationId);
      const removed = await waitFor("registration removed", async () => {
        const directory = await parent.hosts.list();
        return directory.hosts.every(
          (candidate) => candidate.registrationId !== firstAdd.registrationId,
        );
      });

      return {
        producer: firstAdd.source,
        registrationId: firstAdd.registrationId,
        repeatedAdd: {
          ...describeAttempt(repeatedAdd),
          registrationCount: repeatRegistrations.length,
          sameRegistrationId:
            repeatRegistrations[0]?.registrationId === firstAdd.registrationId,
        },
        disabledStatus: disabled.status,
        disabledAdd: {
          ...describeAttempt(afterDisabledAdd),
          preserved: stillDisabled.status === "disabled" && stillDisabled.enabled === false,
        },
        conflict: describeAttempt(conflict),
        updated: {
          registrationId: updated.registrationId,
          label: updated.label,
          metadata: updated.metadata,
          enabled: updated.enabled,
        },
        lostResponseRetry: {
          ...describeAttempt(lostResponseRetry),
          registrationCount: lostResponseRegistrations.length,
          sameRegistrationId:
            lostResponseRegistrations[0]?.registrationId === firstAdd.registrationId,
        },
        removed,
      };
    });

    const pluginRegistration = await step("real-plugin producer and registration", async () => {
      const directory = await mkdtemp(join(tmpdir(), "paseo-msb-identity-plugin-"));
      await cp(SPIKE_PLUGIN_DIR, directory, { recursive: true });
      await symlink(join(repoRoot, "node_modules"), join(directory, "node_modules"), "dir");

      const daemon = new DaemonClient({
        url: PARENT_URL,
        clientId: `paseo-msb-identity-plugin-${nonce}`,
        connectTimeoutMs: 15_000,
      });
      await daemon.connect();

      const invoke = (method, input) =>
        daemon.invokePluginRpc(SPIKE_PLUGIN_ID, method, input);

      try {
        const existing = (await daemon.listPlugins()).find(
          (plugin) => plugin.id === SPIKE_PLUGIN_ID,
        );
        if (existing) await daemon.removePlugin(SPIKE_PLUGIN_ID);
        await daemon.installDirectoryPlugin(directory, SPIKE_PLUGIN_ID);
        await daemon.reloadPlugin(SPIKE_PLUGIN_ID);
        await waitFor("spike plugin running", async () => {
          const plugin = (await daemon.listPlugins()).find(
            (candidate) => candidate.id === SPIKE_PLUGIN_ID,
          );
          return plugin?.status === "running" ? plugin : null;
        });

        const input = {
          connection: "127.0.0.1:3",
          label: `${parentId}/${NAME}`,
          metadata: { source: "paseo-msb", name: NAME },
          sourceKey: replacement.handle.id,
        };

        const added = await invoke("spike.add", input);
        const producer = added.registration.source;
        assert(
          producer.id === `plugin:${SPIKE_PLUGIN_ID}`,
          `unexpected plugin producer id ${producer.id}`,
        );

        const repeated = await attempt(() => invoke("spike.add", input));
        const listed = await invoke("spike.list", {});
        const ownRegistrations = listed.hosts.filter(
          (entry) => entry.source.key === replacement.handle.id,
        );
        assert(ownRegistrations.length === 1, "repeated plugin add duplicated the registration");

        const disabled = await invoke("spike.update", {
          registrationId: added.registration.registrationId,
          enabled: false,
        });
        const afterDisabledAdd = await attempt(() => invoke("spike.add", input));
        const disabledList = await invoke("spike.list", {});
        const disabledEntry = disabledList.hosts.find(
          (entry) => entry.registrationId === added.registration.registrationId,
        );

        const updated = await invoke("spike.update", {
          registrationId: added.registration.registrationId,
          metadata: { source: "paseo-msb", name: NAME },
          label: `${parentId}/${NAME}`,
          connection: "127.0.0.1:4",
          enabled: true,
        });

        await invoke("spike.remove", {
          registrationId: added.registration.registrationId,
        });

        return {
          producer,
          registrationId: added.registration.registrationId,
          repeated: describeAttempt(repeated),
          registrationCount: ownRegistrations.length,
          disabled: disabled.enabled,
          disabledAfterAdd: disabledEntry?.enabled ?? null,
          afterDisabledAdd: describeAttempt(afterDisabledAdd),
          updated: {
            label: updated.label,
            metadata: updated.metadata,
            enabled: updated.enabled,
          },
          removed: true,
        };
      } finally {
        await daemon.removePlugin(SPIKE_PLUGIN_ID).catch(() => undefined);
        await daemon.close().catch(() => undefined);
        await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      }
    });

    const summary = {
      name: NAME,
      exactHandle,
      replacementInfo,
      jobs,
      registration,
      pluginRegistration,
    };

    process.stdout.write(`\nSPIKE_RESULT ${JSON.stringify(summary)}\n`);
    process.stdout.write("\nAll identity/lifecycle spikes passed.\n");
  } finally {
    if (parent) {
      try {
        await parent.close();
      } catch {
        // ignore
      }
    }
    for (const entry of created.reverse()) {
      await destroy(entry.name, entry.value?.handle ?? null);
    }
    process.stdout.write(`\n${JSON.stringify(results.map(({ name, ok }) => ({ name, ok })))}\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`\nSpike failed: ${error instanceof Error ? error.stack : error}\n`);
  process.exitCode = 1;
});

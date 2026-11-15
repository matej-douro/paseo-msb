import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { SandboxHandle } from "microsandbox";
import {
  GUEST_IMAGE,
  GUEST_INIT_ARGS,
  GUEST_INIT_COMMAND,
  GUEST_PATH,
  GUEST_USER,
  MICROSANDBOX_VERSION,
} from "../../shared/constants";
import {
  loadMicrosandbox,
  REPO_ROOT,
  waitFor,
  type MicrosandboxModule,
} from "./fixtures/harness";

const RELEASE_ENABLED =
  process.env.PASEO_MSB_RELEASE_TEST === "1" ||
  (process.env.PASEO_PARENT_URL?.trim().length ?? 0) > 0;

interface Attempt {
  readonly rejected: boolean;
  readonly code: string | null;
  readonly message: string;
}

async function attempt(operation: () => Promise<unknown>): Promise<Attempt> {
  try {
    await operation();
    return { rejected: false, code: null, message: "" };
  } catch (error) {
    return {
      rejected: true,
      code:
        typeof (error as { code?: unknown }).code === "string"
          ? ((error as { code: string }).code)
          : null,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Creates a real detached sandbox with no managed labels. This test only needs
 * the raw microsandbox handle contract; it deliberately does not use the plugin.
 */
async function createSandbox(
  msb: MicrosandboxModule,
  name: string,
): Promise<SandboxHandle> {
  await msb.Sandbox.builder(name)
    .image(GUEST_IMAGE)
    .cpus(1)
    .memory(msb.MiB(1024))
    .detached(true)
    .init(GUEST_INIT_COMMAND, [...GUEST_INIT_ARGS])
    .env("PATH", GUEST_PATH)
    .create();

  return waitFor(
    `sandbox ${name} to run`,
    async () => {
      const handle = await msb.Sandbox.get(name).catch(() => null);
      if (!handle) return null;
      const refreshed = await handle.refresh();
      return refreshed.status === "running" ? refreshed : null;
    },
    { timeoutMs: 120_000, intervalMs: 250 },
  );
}

function sandboxLabels(handle: SandboxHandle): Record<string, string> {
  const labels = (handle.config() as { labels?: Record<string, string> }).labels;
  return labels ?? {};
}

function sandboxEnv(handle: SandboxHandle, name: string): string | undefined {
  const env = (handle.config() as { env?: unknown }).env;
  if (Array.isArray(env)) {
    for (const entry of env) {
      const item = entry as { name?: string; key?: string; value?: unknown };
      if ((item.name ?? item.key) === name && typeof item.value === "string") {
        return item.value;
      }
    }
    return undefined;
  }
  if (typeof env === "object" && env !== null) {
    const value = (env as Record<string, unknown>)[name];
    return typeof value === "string" ? value : undefined;
  }
  return undefined;
}

function sandboxRootDiskMib(handle: SandboxHandle): number | undefined {
  const config = handle.config() as {
    image?: { Oci?: { rootDisk?: { sizeMib?: unknown } } };
  };
  const size = config.image?.Oci?.rootDisk?.sizeMib;
  return typeof size === "number" ? size : undefined;
}

/**
 * After a same-name replacement, every captured-handle operation must reject
 * except `modify()`, which the pinned SDK applies to the replacement. That
 * exception is DESIGN's residual window; it is asserted here rather than hidden.
 */
describe.skipIf(!RELEASE_ENABLED)("stale handle identity contract", () => {
  let msb: MicrosandboxModule | null = null;
  let name = "";

  afterAll(async () => {
    if (!msb || name.length === 0) return;
    const handle = await msb.Sandbox.get(name).catch(() => null);
    if (handle) {
      await handle.destroy({ force: true, timeoutMs: 15_000 }).catch(() => {});
    }
  });

  it(
    "rejects stale operations and applies only stale modify() to the replacement",
    async () => {
      msb = await loadMicrosandbox();
      const packageJson = JSON.parse(
        await readFile(
          path.join(REPO_ROOT, "node_modules/microsandbox/package.json"),
          "utf8",
        ),
      ) as { version?: string };
      expect(
        packageJson.version,
        "the identity contract is pinned to the verified microsandbox SDK",
      ).toBe(MICROSANDBOX_VERSION);

      name = `paseo-msb-identity-${randomUUID()}`;

      const original = await createSandbox(msb, name);
      const originalId = original.id;
      const sandbox = await original.connect();
      const staleJob = await sandbox.execDetachedWith("sh", (builder) =>
        builder.args(["-lc", "echo stale-handle-job"]).user(GUEST_USER),
      );
      await staleJob.wait();

      await original.destroy({ force: true, timeoutMs: 15_000 });

      const replacement = await createSandbox(msb, name);
      expect(replacement.name).toBe(name);
      expect(replacement.id).not.toBe(originalId);

      // A stale modify is not generation-bound in microsandbox 0.7.14. The
      // plugin compensates by refreshing and comparing the id before every
      // label, environment, or resource write; these assertions record the
      // underlying SDK limitation for each kind of write.
      const staleLabel = await attempt(() =>
        original.modify({ labels: { "stale-handle": "applied" } }),
      );
      expect(staleLabel.rejected).toBe(false);

      const staleEnv = await attempt(() =>
        original.modify({
          env: { STALE_HANDLE_ENV: "applied" },
          policy: "next_start",
        }),
      );
      expect(staleEnv.rejected).toBe(false);

      const staleDisk = await attempt(() => original.modify({ rootDiskSize: 20_480 }));
      expect(staleDisk.rejected).toBe(false);

      const afterModify = await replacement.refresh();
      expect(sandboxLabels(afterModify)["stale-handle"]).toBe("applied");
      expect(sandboxEnv(afterModify, "STALE_HANDLE_ENV")).toBe("applied");
      expect(sandboxRootDiskMib(afterModify)).toBe(20_480);

      const outcomes: readonly [string, Attempt][] = [
        ["refresh", await attempt(() => original.refresh())],
        ["connect", await attempt(() => original.connect())],
        [
          "listJobsWith",
          await attempt(() =>
            original.listJobsWith((builder) => builder.all(true).limit(2)),
          ),
        ],
        ["getJob", await attempt(() => original.getJob(staleJob.id))],
        [
          "destroy",
          await attempt(() =>
            original.destroy({ force: true, timeoutMs: 15_000 }),
          ),
        ],
      ];

      for (const [label, outcome] of outcomes) {
        expect(outcome.rejected, `stale ${label} was accepted`).toBe(true);
        expect(
          `${outcome.code ?? ""} ${outcome.message}`.toLowerCase(),
          `stale ${label} did not report a replaced generation`,
        ).toContain("replace");
      }

      // A stale destroy must leave the replacement alive and unmodified.
      const survivor = await msb.Sandbox.get(name);
      expect(survivor.id).toBe(replacement.id);
      expect(sandboxLabels(await survivor.refresh())["stale-handle"]).toBe(
        "applied",
      );
    },
    10 * 60_000,
  );
});

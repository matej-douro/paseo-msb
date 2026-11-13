import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { safeError } from "../../shared/errors";
import {
  createSecretsStore,
  defaultSecretsFilePath,
  type SecretsStore,
} from "../../server/secrets-store";
import { listSecrets, resolveSelectedSecrets } from "../../server/secrets";

const cleanup: string[] = [];

async function tempStore(): Promise<{ store: SecretsStore; filePath: string; directory: string }> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "paseo-msb-secrets-"));
  cleanup.push(directory);
  const filePath = path.join(directory, "nested", "secrets.json");
  return { store: createSecretsStore(filePath), filePath, directory };
}

afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("secrets store", () => {
  it("persists, updates, and removes fixed credential names", async () => {
    const { store, filePath } = await tempStore();

    await store.set("OPENAI_API_KEY", "first");
    await store.set("GH_TOKEN", "gh-token");
    await store.set("OPENAI_API_KEY", "second");

    const reopened = createSecretsStore(filePath);
    const read = await reopened.read();

    expect(read.status).toBe("ok");
    expect(read.values.get("OPENAI_API_KEY")).toBe("second");
    expect(read.values.get("GH_TOKEN")).toBe("gh-token");

    expect(await reopened.delete("GH_TOKEN")).toBe(true);
    expect(await reopened.delete("GH_TOKEN")).toBe(false);
    expect((await reopened.read()).values.has("GH_TOKEN")).toBe(false);
  });

  it("writes the file with owner-only permissions", async () => {
    const { store, filePath } = await tempStore();
    await store.set("ANTHROPIC_API_KEY", "secret-value");

    const [fileStat, directoryStat] = await Promise.all([
      fs.stat(filePath),
      fs.stat(path.dirname(filePath)),
    ]);

    expect(fileStat.mode & 0o777).toBe(0o600);
    expect(directoryStat.mode & 0o777).toBe(0o700);
  });

  it("ignores unknown names and blank values in the file", async () => {
    const { store, filePath } = await tempStore();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        secrets: {
          ANTHROPIC_API_KEY: "keep",
          CUSTOM_TOKEN: "ignore",
          OPENAI_API_KEY: "   ",
        },
      }),
      { mode: 0o600 },
    );

    const read = await store.read();
    expect(read.status).toBe("ok");
    expect([...read.values.keys()]).toEqual(["ANTHROPIC_API_KEY"]);
  });

  it("refuses to use or clobber a corrupt file", async () => {
    const { store, filePath } = await tempStore();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, "{not json", { mode: 0o600 });

    expect(await store.read()).toEqual({ status: "unavailable", values: new Map() });
    await expect(store.set("OPENAI_API_KEY", "value")).rejects.toThrow(
      "secrets store unavailable",
    );
    expect(await fs.readFile(filePath, "utf8")).toBe("{not json");
  });

  it("prefers a stored value over the parent environment", () => {
    const stored = new Map([["ANTHROPIC_API_KEY" as const, "stored"]]);

    expect(
      resolveSelectedSecrets(["ANTHROPIC_API_KEY"], { ANTHROPIC_API_KEY: "env" }, stored),
    ).toEqual({
      status: "ok",
      secrets: [
        {
          envVar: "ANTHROPIC_API_KEY",
          value: "stored",
          allowedHosts: ["api.anthropic.com"],
        },
      ],
    });

    expect(
      resolveSelectedSecrets(["OPENAI_API_KEY"], { OPENAI_API_KEY: "env" }, stored),
    ).toMatchObject({ status: "ok" });
    expect(resolveSelectedSecrets(["GH_TOKEN"], {}, stored)).toEqual({
      status: "missing",
      missing: ["GH_TOKEN"],
    });
  });

  it("lists names and sources without values", async () => {
    const { store, filePath } = await tempStore();
    await store.set("OPENAI_API_KEY", "stored-openai-value");

    const result = await listSecrets(store, { GH_TOKEN: "env-gh-value" });

    expect(result.secrets).toEqual([
      { name: "ANTHROPIC_API_KEY", stored: false, environment: false },
      { name: "CLAUDE_CODE_OAUTH_TOKEN", stored: false, environment: false },
      { name: "OPENAI_API_KEY", stored: true, environment: false },
      { name: "GEMINI_API_KEY", stored: false, environment: false },
      { name: "NEURALWATT_API_KEY", stored: false, environment: false },
      { name: "GH_TOKEN", stored: false, environment: true },
    ]);
    expect(JSON.stringify(result)).not.toContain("stored-openai-value");
    expect(JSON.stringify(result)).not.toContain("env-gh-value");
    expect(JSON.stringify(result)).not.toContain(filePath);
  });

  it("reports an unavailable store with a safe error", async () => {
    const { store, filePath } = await tempStore();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, "[]", { mode: 0o600 });

    await expect(listSecrets(store, {})).rejects.toThrow(
      safeError("secrets_unavailable").message,
    );
  });
});

describe("defaultSecretsFilePath", () => {
  it("honors the explicit override", () => {
    expect(
      defaultSecretsFilePath({ PASEO_MSB_SECRETS_FILE: "/tmp/custom-secrets.json" }),
    ).toBe("/tmp/custom-secrets.json");
  });

  it("uses the Paseo home plugin data directory", () => {
    expect(defaultSecretsFilePath({ PASEO_HOME: "/home/test/.paseo" })).toBe(
      "/home/test/.paseo/plugin-data/paseo-msb/secrets.json",
    );
  });
});

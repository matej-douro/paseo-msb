#!/usr/bin/env node
/**
 * Diagnoses why the microsandbox native binding does not load.
 *
 * napi-rs reports every load failure as "Cannot find native binding" plus an
 * npm optional-dependencies hint, which hides the real error. On macOS the
 * common cause is the hardened runtime refusing an ad-hoc-signed addon, not a
 * missing package. This script prints the actual cause chain for both the
 * current Node process and, when present, the signed Paseo.app runtime that
 * spawns plugin processes.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const probe = `
try {
  require(process.env.MSB_NATIVE_PATH);
  console.log("OK");
} catch (error) {
  let current = error;
  while (current) {
    console.log(String(current.message || current));
    current = current.cause;
  }
}
`;

function loadResult(command, args, env) {
  try {
    const output = execFileSync(command, args, {
      encoding: "utf8",
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return output.startsWith("OK") ? { ok: true } : { ok: false, detail: output };
  } catch (error) {
    const stderr = typeof error.stderr === "string" ? error.stderr.trim() : "";
    const stdout = typeof error.stdout === "string" ? error.stdout.trim() : "";
    return { ok: false, detail: stderr || stdout || error.message };
  }
}

let nativePath;
try {
  nativePath = require.resolve("microsandbox/native");
} catch {
  nativePath = "";
}

console.log(`node:        ${process.version} (${process.platform}/${process.arch})`);
console.log(`native path: ${nativePath || "not resolvable from this directory"}`);
console.log(`exists:      ${nativePath ? existsSync(nativePath) : false}`);

if (!nativePath) process.exitCode = 1;

const current = loadResult(process.execPath, ["-e", probe], {
  MSB_NATIVE_PATH: nativePath,
});
printResult("system node", current);

const appBinary = "/Applications/Paseo.app/Contents/MacOS/Paseo";
if (process.platform === "darwin" && existsSync(appBinary)) {
  const packaged = loadResult(appBinary, ["-e", probe], {
    ELECTRON_RUN_AS_NODE: "1",
    MSB_NATIVE_PATH: nativePath,
  });
  printResult("Paseo.app runtime", packaged);

  if (current.ok && !packaged.ok) {
    console.log(
      "\nThe addon is installed and works under system Node. The Paseo.app runtime " +
        "cannot load it because the app uses the hardened runtime without " +
        "com.apple.security.cs.disable-library-validation, while the addon is " +
        "ad-hoc signed (no Team ID). Reinstalling dependencies cannot change that.\n\n" +
        "Use a parent daemon that runs under system Node (for example " +
        "@getpaseo/cli), or use a Paseo build signed/permitted to load the addon.",
    );
  }
}

if (!current.ok) process.exitCode = 1;

function printResult(label, result) {
  if (result.ok) {
    console.log(`${label}: OK`);
    return;
  }
  console.log(`${label}: FAILED`);
  for (const line of (result.detail ?? "").split("\n")) {
    console.log(`  ${line}`);
  }
}

import {
  GUEST_HOME,
  GUEST_PATH,
  GUEST_USER,
  PI_PACKAGE,
  PI_PREFIX,
  PI_VERSION,
} from "../shared/constants";
import type { ExecSpec } from "./sandbox";

const PI_BINARY = `${PI_PREFIX}/bin/pi`;

/**
 * Detached Pi installation verified by the task 1 spike: non-root install as
 * `paseo`, ignoring lifecycle scripts, into the pinned prefix that the guest
 * PATH already exposes.
 */
export function piInstallSpec(): ExecSpec {
  return {
    command: "npm",
    args: [
      "install",
      "-g",
      "--ignore-scripts",
      "--prefix",
      PI_PREFIX,
      `${PI_PACKAGE}@${PI_VERSION}`,
    ],
    user: GUEST_USER,
    env: { HOME: GUEST_HOME, PATH: GUEST_PATH },
    stdinNull: true,
  };
}

/** The exact argv the detached Pi install job must match during recovery. */
export function piInstallArgv(): readonly string[] {
  const spec = piInstallSpec();
  return [spec.command, ...spec.args];
}

/**
 * Checks the binary the daemon process would resolve, not a fresh `msb exec`
 * default PATH. The inline assignment keeps a login shell from resetting it.
 * `&&` avoids running `pi` when it is absent, so the probe does not write a
 * `pi: not found` line into the sandbox log before the first install.
 */
export function piPathCheckSpec(): ExecSpec {
  return {
    command: "sh",
    args: [
      "-lc",
      `PATH=${GUEST_PATH} command -v pi && PATH=${GUEST_PATH} pi --version`,
    ],
    user: GUEST_USER,
  };
}

export interface PiInstallCheck {
  readonly path: string;
  readonly version: string;
}

/**
 * Parses `command -v pi; pi --version`. Returns null unless both the pinned
 * prefix and the exact package version match.
 */
export function inspectPiInstall(stdout: string): PiInstallCheck | null {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const path = lines[0];
  const version = lines[1];
  if (path !== PI_BINARY || version !== PI_VERSION) return null;

  return { path, version };
}

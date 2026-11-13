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

/**
 * Checks the binary the daemon process would resolve, not a fresh `msb exec`
 * default PATH. The inline assignment keeps a login shell from resetting it.
 */
export function piPathCheckSpec(): ExecSpec {
  return {
    command: "sh",
    args: [
      "-lc",
      `PATH=${GUEST_PATH} command -v pi; PATH=${GUEST_PATH} pi --version`,
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

export interface PiInstallJobLike {
  wait(): Promise<{ readonly code: number }>;
  inspect(): Promise<{ readonly state: string; readonly exitCode: number | null }>;
}

function succeeded(info: { readonly state: string; readonly exitCode: number | null }): boolean {
  return info.state === "exited" && info.exitCode === 0;
}

/**
 * Bounds the detached install wait and reports whether the job exited cleanly.
 * Never replays the install; a running job is awaited, not restarted.
 */
export async function waitForPiInstall(
  job: PiInstallJobLike,
  timeoutMs: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });

    return await Promise.race([run(job), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function run(job: PiInstallJobLike): Promise<boolean> {
  try {
    const info = await job.inspect();
    if (!succeeded(info) && (info.state === "starting" || info.state === "running")) {
      await job.wait();
      return succeeded(await job.inspect());
    }
    return succeeded(info);
  } catch {
    return false;
  }
}

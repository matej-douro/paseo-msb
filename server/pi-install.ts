import {
  CHILD,
  GUEST_PATH,
  JOB_POLL_MS,
  PI,
  PI_INSTALL_TIMEOUT_MS,
} from "../shared/constants";
import type { CreatedSandbox, DetachedJob } from "./sandbox";

const INSTALL_ARGS = [
  "install",
  "-g",
  "--prefix",
  PI.installPrefix,
  `${PI.package}@${PI.version}`,
];

export interface PiInstallOptions {
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly pollMs?: number;
  readonly timeoutMs?: number;
}

export class PiInstallFailedError extends Error {
  constructor() {
    super("pi install failed");
    this.name = "PiInstallFailedError";
  }
}

export class PiInstallTimeoutError extends Error {
  constructor() {
    super("pi install timed out");
    this.name = "PiInstallTimeoutError";
  }
}

export class PiPathError extends Error {
  constructor() {
    super("pi path verification failed");
    this.name = "PiPathError";
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function startPiInstall(sandbox: CreatedSandbox): Promise<DetachedJob> {
  const job = await sandbox.execDetached("npm", {
    args: INSTALL_ARGS,
    user: CHILD.user,
    env: {
      HOME: CHILD.home,
      PATH: GUEST_PATH,
      NPM_CONFIG_PREFIX: PI.installPrefix,
    },
    timeoutMs: PI_INSTALL_TIMEOUT_MS,
  });
  if (!job.id) throw new Error("pi install job has no id");
  return job;
}

export async function waitForPiInstall(
  job: DetachedJob,
  options: PiInstallOptions = {},
): Promise<void> {
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const pollMs = options.pollMs ?? JOB_POLL_MS;
  const timeoutMs = options.timeoutMs ?? PI_INSTALL_TIMEOUT_MS;
  const deadline = now() + timeoutMs;

  while (true) {
    const info = await job.inspect();
    if (info.state === "exited") {
      if (info.exitCode === 0) return;
      throw new PiInstallFailedError();
    }
    if (info.state === "failed" || info.state === "lost") {
      throw new PiInstallFailedError();
    }
    if (now() >= deadline) {
      throw new PiInstallTimeoutError();
    }
    await sleep(pollMs);
  }
}

export async function verifyPiOnPath(sandbox: CreatedSandbox): Promise<void> {
  const env = { HOME: CHILD.home, PATH: GUEST_PATH };
  const version = await sandbox.exec("pi", {
    args: ["--version"],
    user: CHILD.user,
    env,
  });
  if (!version.success || !version.stdout.includes(PI.version)) {
    throw new PiPathError();
  }

  const which = await sandbox.exec("which", {
    args: ["pi"],
    user: CHILD.user,
    env,
  });
  if (!which.success || !which.stdout.trim().startsWith(PI.pathEntry)) {
    throw new PiPathError();
  }

  const daemonPath = await sandbox.exec("printenv", {
    args: ["PATH"],
    user: CHILD.user,
    env: { HOME: CHILD.home },
  });
  if (
    !daemonPath.success ||
    !daemonPath.stdout.trim().split(":").includes(PI.pathEntry)
  ) {
    throw new PiPathError();
  }
}

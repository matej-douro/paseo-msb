import { JOB_LABEL, PHASE_LABEL } from "../shared/constants";
import type { SafeErrorCode } from "../shared/errors";
import { inspectPiInstall, piPathCheckSpec, waitForPiInstall } from "./pi-install";
import {
  registerSandbox,
  SetupFailure,
  type RegistrationContext,
} from "./registration";
import {
  loadManagedSandboxes,
  markSandboxFailed,
  readSandboxHostPort,
  type LoadedSandbox,
  type SandboxHost,
  type SandboxRuntime,
} from "./sandbox";

const DEFAULT_INSTALL_TIMEOUT_MS = 600_000;

export interface RecoveryContext extends RegistrationContext {
  readonly runtime: SandboxRuntime;
  readonly sandboxHost: SandboxHost;
  readonly installTimeoutMs?: number;
}

/**
 * Runs once after the plugin subprocess loads. It rediscovers labelled
 * sandboxes and resumes only unambiguous install or registration work by the
 * persisted stable and job IDs. Everything else is left untouched or marked
 * failed without replaying side effects.
 */
export async function recoverManagedSandboxes(context: RecoveryContext): Promise<void> {
  const directory = await context.hosts.list().catch(() => null);
  if (!directory) return;

  const parentId = directory.self.serverId;
  const inventory = await loadManagedSandboxes(context.runtime, parentId);
  if (inventory.status !== "available") return;

  for (const loaded of inventory.sandboxes) {
    const phase = loaded.sandbox.labels[PHASE_LABEL];

    if (phase === "creating") {
      // The sandbox exists but never reached a persisted install step.
      await markSandboxFailed(loaded.handle, "create_failed");
      continue;
    }

    if (phase !== "installing" && phase !== "registering") continue;

    try {
      await resumeSetup(context, parentId, loaded);
    } catch (error) {
      await markSandboxFailed(loaded.handle, errorCode(error, "registration_failed"));
    }
  }
}

/**
 * Continues an interrupted setup. A missing or failed job is reported instead
 * of starting another install, and no sandbox is created, started, or deleted.
 */
export async function resumeSetup(
  context: RecoveryContext,
  parentId: string,
  loaded: LoadedSandbox,
): Promise<void> {
  if (loaded.sandbox.labels[PHASE_LABEL] === "installing") {
    await finishInstall(context, loaded);
  }

  await registerLoaded(context, parentId, loaded);
}

export async function finishInstall(
  context: RecoveryContext,
  loaded: LoadedSandbox,
): Promise<void> {
  const jobId = loaded.sandbox.labels[JOB_LABEL];
  if (!jobId) throw new SetupFailure("install_failed");

  const job = await loaded.handle.getJob(jobId).catch(() => null);
  if (!job) throw new SetupFailure("install_failed");

  const timeoutMs = context.installTimeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS;
  if (!(await waitForPiInstall(job, timeoutMs))) {
    throw new SetupFailure("install_failed");
  }

  // Reconnect without starting a stopped sandbox; a failed reconnect is
  // uncertain, so the install is not replayed.
  const resumed = await context.sandboxHost.resume(loaded.sandbox.name).catch(() => null);
  if (!resumed) throw new SetupFailure("install_failed");

  const output = await resumed.exec(piPathCheckSpec()).catch(() => null);
  if (!output || !inspectPiInstall(output)) {
    throw new SetupFailure("path_unverified");
  }

  await loaded.handle
    .modify({ labels: { [PHASE_LABEL]: "registering" } })
    .catch(() => {
      throw new SetupFailure("install_failed");
    });
}

/** Adds or reuses the registration, waits for online, confirms Pi, sets ready. */
export async function registerLoaded(
  context: RecoveryContext,
  parentId: string,
  loaded: LoadedSandbox,
): Promise<void> {
  const hostPort = readSandboxHostPort(loaded.handle);
  if (hostPort === null) throw new SetupFailure("registration_failed");

  await registerSandbox(context, parentId, loaded.sandbox, hostPort);

  await loaded.handle
    .modify({ labels: { [PHASE_LABEL]: "ready" } })
    .catch(() => {
      throw new SetupFailure("registration_failed");
    });
}

function errorCode(error: unknown, fallback: SafeErrorCode): SafeErrorCode {
  return error instanceof SetupFailure ? error.code : fallback;
}

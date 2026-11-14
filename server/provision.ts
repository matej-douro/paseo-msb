import { GUEST_HOME, GUEST_PATH, GUEST_USER } from "../shared/constants";
import {
  buildProvisionScript,
  isProvisionSuccess,
  parseProvisionStatus,
  provisionMaterializeSpec,
  provisionStatusPath,
  type CanonicalPlan,
  type ProvisionScript,
  type ProvisionStatus,
} from "../shared/provisioning";
import { failureDetail } from "./diagnostics";
import {
  classifyJob,
  isPiInstallJob,
  listAllJobs,
  waitForInstallJob,
  type InstallJobOutcome,
} from "./jobs";
import { bounded, LifecycleAbortedError, type LaneToken } from "./lanes";
import type { ReconcileContext } from "./reconciler";
import { SetupFailure } from "./registration";
import {
  isSandboxReplacedError,
  type ExecSpec,
  type SandboxConnectHandleLike,
  type SandboxHandleLike,
  type SandboxJobInfoLike,
} from "./sandbox";

const DEFAULT_INSTALL_TIMEOUT_MS = 600_000;
const DEFAULT_SDK_CALL_TIMEOUT_MS = 60_000;

interface ProvisionJobInventory {
  /** Running or unclassifiable matching jobs. Never launch while this is non-empty. */
  readonly active: readonly SandboxJobInfoLike[];
}

/**
 * Ensures the plan's content-addressed script ran successfully. The status
 * file is the source of truth; probes make a repeated run a no-op. Historical
 * failed jobs are not terminal, because Repair is the documented retry path.
 */
export async function ensureProvisioned(
  context: ReconcileContext,
  handle: SandboxHandleLike,
  plan: CanonicalPlan,
  redaction: readonly string[],
  token: LaneToken,
): Promise<boolean> {
  token.throwIfAborted();

  const provision = buildProvisionScript(plan);
  const existingStatus = await readProvisionStatus(context, handle, redaction, token);
  if (existingStatus && isProvisionSuccess(existingStatus, provision.planHash)) {
    return false;
  }

  // A legacy child may still have the old Pi-only npm job running. Wait for it
  // before launching the generic script so two package installs cannot race.
  await awaitActiveLegacyPiJob(context, handle, token);

  const inventory = await listProvisionJobs(context, handle, provision.argv, token);
  if (inventory.active.length > 1) throw new SetupFailure("provision_conflict");
  if (inventory.active.length === 1) {
    return awaitProvisionJob(
      context,
      handle,
      inventory.active[0].id,
      provision,
      redaction,
      token,
    );
  }

  await materializeProvisionScript(context, handle, provision, redaction, token);
  token.throwIfAborted();

  let jobId: string;
  try {
    const job = await bounded(context.sandboxHost.startInstall(handle, provisionExecSpec(provision)), {
      timeoutMs: sdkTimeoutMs(context),
      signal: token.signal,
    });
    jobId = job.id;
  } catch (error) {
    if (error instanceof LifecycleAbortedError) throw error;

    // A launch error or timeout is uncertain. Re-list before deciding anything;
    // never start a second job on speculation.
    const after = await listProvisionJobs(context, handle, provision.argv, token);
    if (after.active.length > 1) throw new SetupFailure("provision_conflict");
    if (after.active.length === 1) {
      return awaitProvisionJob(
        context,
        handle,
        after.active[0].id,
        provision,
        redaction,
        token,
      );
    }

    const uncertain = (error as { jobId?: unknown }).jobId;
    if (typeof uncertain === "string" && uncertain.length > 0) {
      return awaitProvisionJob(
        context,
        handle,
        uncertain,
        provision,
        redaction,
        token,
      );
    }

    throw new SetupFailure("provision_pending", failureDetail(error, redaction));
  }

  return awaitProvisionJob(context, handle, jobId, provision, redaction, token);
}

/**
 * A non-zero exit is fatal, but the status file still knows which step failed.
 * Surface that bounded step name instead of the generic job failure.
 */
async function awaitProvisionJob(
  context: ReconcileContext,
  handle: SandboxHandleLike,
  jobId: string,
  provision: ProvisionScript,
  redaction: readonly string[],
  token: LaneToken,
): Promise<boolean> {
  const outcome = await waitForInstallJob(
    handle,
    jobId,
    installTimeoutMs(context),
    token.signal,
  );

  if (outcome.status === "failed") {
    const status = await readProvisionStatus(context, handle, redaction, token);
    throw new SetupFailure(
      "provision_failed",
      status?.failedStep
        ? `provisioning step ${status.failedStep} failed`
        : "the provision job did not exit successfully",
    );
  }

  interpretProvisionOutcome(outcome);
  return confirmStatus(context, handle, provision, redaction, token);
}

/** The newest matching provision job, used for the detail log bundle. */
export async function findLatestProvisionJob(
  handle: SandboxHandleLike,
  argv: readonly string[],
  options?: { readonly timeoutMs?: number; readonly signal?: AbortSignal },
): Promise<SandboxJobInfoLike | null> {
  const jobs = (await listAllJobs(handle, undefined, options)).filter((job) =>
    sameArgv(job.command, argv),
  );
  if (jobs.length === 0) return null;

  const sorted = [...jobs].sort((left, right) => (left.createdAt ?? 0) - (right.createdAt ?? 0));
  return sorted[sorted.length - 1] ?? null;
}

async function confirmStatus(
  context: ReconcileContext,
  handle: SandboxHandleLike,
  provision: ProvisionScript,
  redaction: readonly string[],
  token: LaneToken,
): Promise<boolean> {
  const status = await readProvisionStatus(context, handle, redaction, token);
  if (status && isProvisionSuccess(status, provision.planHash)) return true;

  const detail = status?.failedStep
    ? `provisioning step ${status.failedStep} failed`
    : "the provision job did not write a successful status";
  throw new SetupFailure("provision_failed", detail);
}

async function readProvisionStatus(
  context: ReconcileContext,
  handle: SandboxHandleLike,
  redaction: readonly string[],
  token: LaneToken,
): Promise<ProvisionStatus | null> {
  const connected = await connectSandbox(context, handle, redaction, token);
  const result = await execGuest(
    context,
    connected,
    {
      command: "cat",
      args: [provisionStatusPath()],
      user: GUEST_USER,
      env: { HOME: GUEST_HOME, PATH: GUEST_PATH },
      stdinNull: true,
    },
    token,
  );
  if (result.code !== 0) return null;

  const text = result.stdout.trim();
  if (text.length === 0) return null;

  try {
    return parseProvisionStatus(JSON.parse(text));
  } catch {
    return null;
  }
}

async function materializeProvisionScript(
  context: ReconcileContext,
  handle: SandboxHandleLike,
  provision: ProvisionScript,
  redaction: readonly string[],
  token: LaneToken,
): Promise<void> {
  const connected = await connectSandbox(context, handle, redaction, token);
  const spec = provisionMaterializeSpec(provision);
  const result = await execGuest(
    context,
    connected,
    {
      ...spec,
      args: [...spec.args],
      user: GUEST_USER,
      env: { HOME: GUEST_HOME, PATH: GUEST_PATH },
      stdinNull: true,
    },
    token,
  );
  if (result.code !== 0) {
    throw new SetupFailure("provision_failed", "the provision script could not be written");
  }
}

async function listProvisionJobs(
  context: ReconcileContext,
  handle: SandboxHandleLike,
  argv: readonly string[],
  token: LaneToken,
): Promise<ProvisionJobInventory> {
  let jobs: readonly SandboxJobInfoLike[];
  try {
    jobs = await listAllJobs(handle, undefined, {
      timeoutMs: sdkTimeoutMs(context),
      signal: token.signal,
    });
  } catch (error) {
    if (error instanceof LifecycleAbortedError) throw error;
    throw new SetupFailure("job_inventory_unavailable");
  }

  const active = jobs.filter((job) => {
    if (!sameArgv(job.command, argv)) return false;
    const outcome = classifyJob(job);
    return outcome.status === "running" || outcome.status === "unknown";
  });

  return { active };
}

async function awaitActiveLegacyPiJob(
  context: ReconcileContext,
  handle: SandboxHandleLike,
  token: LaneToken,
): Promise<void> {
  let jobs: readonly SandboxJobInfoLike[];
  try {
    jobs = await listAllJobs(handle, undefined, {
      timeoutMs: sdkTimeoutMs(context),
      signal: token.signal,
    });
  } catch (error) {
    if (error instanceof LifecycleAbortedError) throw error;
    throw new SetupFailure("job_inventory_unavailable");
  }

  const active = jobs.filter((job) => {
    if (!isPiInstallJob(job)) return false;
    const outcome = classifyJob(job);
    return outcome.status === "running" || outcome.status === "unknown";
  });
  if (active.length === 0) return;
  if (active.length > 1) throw new SetupFailure("provision_conflict");

  const activeJob = active[0];
  if (!activeJob) return;
  const outcome = await waitForInstallJob(
    handle,
    activeJob.id,
    installTimeoutMs(context),
    token.signal,
  );
  if (outcome.status === "running" || outcome.status === "unknown") {
    throw new SetupFailure("provision_pending", "the legacy Pi install is still running");
  }
}

function interpretProvisionOutcome(outcome: InstallJobOutcome): void {
  switch (outcome.status) {
    case "succeeded":
      return;
    case "failed":
      throw new SetupFailure("provision_failed", "the provision job did not exit successfully");
    case "running":
      throw new SetupFailure("provision_pending", "the provision job is still running");
    case "unknown":
      throw new SetupFailure("provision_pending", "the provision job state is unknown");
  }
}

function provisionExecSpec(provision: ProvisionScript): ExecSpec {
  return {
    command: "/bin/sh",
    args: [provision.path, provision.planHash],
    user: GUEST_USER,
    env: { HOME: GUEST_HOME, PATH: GUEST_PATH },
    stdinNull: true,
  };
}

async function connectSandbox(
  context: ReconcileContext,
  handle: SandboxHandleLike,
  redaction: readonly string[],
  token: LaneToken,
): Promise<SandboxConnectHandleLike> {
  try {
    return await bounded(context.sandboxHost.connect(handle), {
      timeoutMs: sdkTimeoutMs(context),
      signal: token.signal,
    });
  } catch (error) {
    if (error instanceof LifecycleAbortedError) throw error;
    if (isSandboxReplacedError(error)) throw new SetupFailure("id_mismatch");
    throw new SetupFailure("runtime_unavailable", failureDetail(error, redaction));
  }
}

async function execGuest(
  context: ReconcileContext,
  connected: SandboxConnectHandleLike,
  spec: ExecSpec,
  token: LaneToken,
): Promise<{ readonly code: number; readonly stdout: string }> {
  try {
    const result = await bounded(connected.exec(spec), {
      timeoutMs: sdkTimeoutMs(context),
      signal: token.signal,
    });
    return { code: result.code, stdout: result.stdout };
  } catch (error) {
    if (error instanceof LifecycleAbortedError) throw error;
    if (isSandboxReplacedError(error)) throw new SetupFailure("id_mismatch");
    throw new SetupFailure("runtime_unavailable");
  }
}

function sameArgv(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function sdkTimeoutMs(context: ReconcileContext): number {
  return context.sdkCallTimeoutMs ?? DEFAULT_SDK_CALL_TIMEOUT_MS;
}

function installTimeoutMs(context: ReconcileContext): number {
  return context.installTimeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS;
}

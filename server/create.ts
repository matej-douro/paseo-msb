import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import {
  FIXED_RESOURCES,
  LABELS,
  PORT_RETRY_LIMIT,
} from "../shared/constants";
import {
  safeError,
  vmCreate,
  type CredentialName,
  type SafeErrorCode,
} from "../shared/contracts";
import {
  startPiInstall,
  verifyPiOnPath,
  waitForPiInstall,
  PiInstallFailedError,
  PiInstallTimeoutError,
  PiPathError,
} from "./pi-install";
import {
  addPendingCreate,
  removePendingCreate,
  sandboxNameForRequest,
  updatePendingCreate,
  type PendingCreates,
} from "./pending";
import {
  decodeHostDirectory,
  parentFromDirectory,
} from "./status";
import {
  managedCreateLabels,
  type CreatedSandbox,
  type SandboxRuntime,
} from "./sandbox";
import {
  resolveSecretMaterial,
  type HeaderSecretBinding,
  type SecretMaterial,
} from "./secrets";

export interface CreateDependencies {
  readonly pending: PendingCreates;
  readonly runtime: SandboxRuntime;
  readonly env: NodeJS.ProcessEnv;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

export interface CreateHandler {
  create(
    input: RpcInput<typeof vmCreate>,
    context: PluginHandlerContext,
  ): Promise<RpcOutput<typeof vmCreate>>;
  idle(): Promise<void>;
}

class StageError extends Error {
  readonly code: SafeErrorCode;

  constructor(code: SafeErrorCode) {
    super(code);
    this.name = "StageError";
    this.code = code;
  }
}

function errorMarker(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const record = error as Record<string, unknown>;
  return [record.name, record.code, record.message]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
}

function isPortError(error: unknown): boolean {
  return /port|bind|eaddrinuse|addrinuse/i.test(errorMarker(error));
}

function isNameConflict(error: unknown): boolean {
  return /alreadyexists|replaced|conflict|exists/i.test(errorMarker(error));
}

export function safeCodeForCreateError(error: unknown): SafeErrorCode {
  if (error instanceof StageError) return error.code;
  if (isNameConflict(error)) return "create_name_conflict";
  if (isPortError(error)) return "port_unavailable";
  if (/image|pull|registry/i.test(errorMarker(error))) return "image_pull_failed";
  return "sandbox_boot_failed";
}

function isLoopbackAssigned(
  port: { readonly hostPort: number; readonly hostBind: string | null } | null,
): port is { readonly hostPort: number; readonly hostBind: string | null } {
  return Boolean(port && port.hostPort > 0 && port.hostBind === "127.0.0.1");
}

async function assignedLoopbackPort(
  sandbox: CreatedSandbox,
): Promise<number | null> {
  const published = await sandbox.discoverPort(FIXED_RESOURCES.guestPort);
  if (!published || !isLoopbackAssigned(published)) return null;
  return published.hostPort;
}

async function createSandboxWithLoopbackPort(
  runtime: SandboxRuntime,
  options: {
    readonly name: string;
    readonly parentServerId: string;
    readonly labels: Readonly<Record<string, string>>;
    readonly secrets: readonly HeaderSecretBinding[];
  },
): Promise<{ readonly sandbox: CreatedSandbox; readonly hostPort: number }> {
  let first: CreatedSandbox | null = null;
  try {
    first = await runtime.create({ ...options, hostPort: 0 });
  } catch (error) {
    if (!isPortError(error)) throw error;
  }

  if (first) {
    const assigned = await assignedLoopbackPort(first);
    if (assigned !== null) return { sandbox: first, hostPort: assigned };
    await first.destroy();
  }

  for (let attempt = 0; attempt < PORT_RETRY_LIMIT; attempt += 1) {
    const hostPort = await runtime.probeLoopbackPort();
    let sandbox: CreatedSandbox;
    try {
      sandbox = await runtime.create({ ...options, hostPort });
    } catch (error) {
      if (isPortError(error)) continue;
      throw error;
    }

    const assigned = await assignedLoopbackPort(sandbox);
    if (assigned !== null) return { sandbox, hostPort: assigned };
    await sandbox.destroy();
  }

  throw new StageError("port_unavailable");
}

async function markSandboxFailed(
  sandbox: CreatedSandbox,
  code: SafeErrorCode,
): Promise<void> {
  await sandbox.modify({
    labels: {
      [LABELS.phase]: "failed",
      [LABELS.error]: code,
    },
  });
}

export function createCreateHandler(deps: CreateDependencies): CreateHandler {
  const inFlight = new Map<string, Promise<void>>();

  async function run(
    requestId: string,
    name: string,
    secretEnvVars: readonly CredentialName[],
    context: PluginHandlerContext,
  ): Promise<void> {
    let material: SecretMaterial | null = null;
    let sandbox: CreatedSandbox | null = null;
    let pendingRemoved = false;

    try {
      const resolution = resolveSecretMaterial(secretEnvVars, deps.env);
      if (resolution.status === "missing") {
        throw new StageError("credentials_missing");
      }
      if (resolution.status === "invalid") {
        throw new StageError("credentials_invalid");
      }
      material = resolution.material;

      let parentServerId: string;
      try {
        const directory = decodeHostDirectory(await context.paseo.hosts.list());
        parentServerId = parentFromDirectory(directory).serverId;
      } catch {
        throw new StageError("parent_unavailable");
      }

      const creation = await createSandboxWithLoopbackPort(deps.runtime, {
        name,
        parentServerId,
        labels: managedCreateLabels(parentServerId, "creating"),
        secrets: material.bindings(),
      });
      sandbox = creation.sandbox;
      if (!sandbox.id) throw new StageError("create_failed");

      try {
        await sandbox.modify({
          labels: {
            [LABELS.id]: sandbox.id,
            [LABELS.phase]: "installing",
          },
        });
      } catch {
        throw new StageError("label_update_failed");
      }

      removePendingCreate(deps.pending, requestId);
      pendingRemoved = true;

      let job;
      try {
        job = await startPiInstall(sandbox);
      } catch {
        throw new StageError("pi_install_failed");
      }

      try {
        await sandbox.modify({ labels: { [LABELS.job]: job.id } });
      } catch {
        throw new StageError("label_update_failed");
      }

      try {
        await waitForPiInstall(job, {
          sleep: deps.sleep,
          now: deps.now,
        });
      } catch (error) {
        if (error instanceof PiInstallTimeoutError) {
          throw new StageError("pi_install_timeout");
        }
        if (error instanceof PiInstallFailedError) {
          throw new StageError("pi_install_failed");
        }
        throw new StageError("pi_install_failed");
      }

      try {
        await verifyPiOnPath(sandbox);
      } catch (error) {
        if (error instanceof PiPathError) {
          throw new StageError("pi_path_unverified");
        }
        throw new StageError("pi_path_unverified");
      }

      try {
        await sandbox.modify({ labels: { [LABELS.phase]: "registering" } });
      } catch {
        throw new StageError("label_update_failed");
      }
    } catch (error) {
      const code = safeCodeForCreateError(error);
      if (sandbox && pendingRemoved) {
        try {
          await markSandboxFailed(sandbox, code);
        } catch {
          // The failed phase is best-effort after the sandbox exists.
        }
      } else {
        updatePendingCreate(deps.pending, requestId, "failed", safeError(code));
      }
    } finally {
      material?.dispose();
    }
  }

  async function create(
    input: RpcInput<typeof vmCreate>,
    context: PluginHandlerContext,
  ): Promise<RpcOutput<typeof vmCreate>> {
    const name = sandboxNameForRequest(input.requestId);
    const existing = deps.pending.get(input.requestId);

    if (existing && existing.phase !== "failed") {
      return { name: existing.name };
    }
    if (inFlight.has(input.requestId)) {
      return { name: existing?.name ?? name };
    }

    if (existing) {
      updatePendingCreate(deps.pending, input.requestId, "creating", null);
    } else {
      addPendingCreate(deps.pending, input.requestId);
    }

    const work = run(input.requestId, name, input.secretEnvVars, context)
      .catch(() => {
        // Background errors are converted to pending or label state.
      })
      .finally(() => {
        inFlight.delete(input.requestId);
      });
    inFlight.set(input.requestId, work);

    return { name };
  }

  async function idle(): Promise<void> {
    await Promise.allSettled([...inFlight.values()]);
  }

  return { create, idle };
}

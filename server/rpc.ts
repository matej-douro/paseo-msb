import type {
  VmChild,
  VmDetailInput,
  VmDetailResult,
  VmListResult,
} from "../shared/contracts";
import type { CredentialName } from "../shared/constants";
import { safeError, type SafeError } from "../shared/errors";
import { persistedCredentialValues } from "./diagnostics";
import { findLatestInstallJob } from "./jobs";
import {
  credentialValues,
  readJobLogs,
  readSandboxLogs,
  unavailableLogBundle,
} from "./logs";
import { failureDetail } from "./diagnostics";
import type { PendingCreate } from "./pending";
import { loadManagedSandboxes, type SandboxInventory, type SandboxRuntime } from "./sandbox";
import {
  buildVmList,
  type HostDirectoryLike,
  type ParentHostsLike,
  type RegistrationsView,
} from "./status";

export interface ReadContext {
  readonly hosts: ParentHostsLike;
  readonly runtime: SandboxRuntime;
  readonly pending: readonly PendingCreate[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly storedCredentials: readonly CredentialName[];
  readonly storedSecrets: ReadonlyMap<CredentialName, string>;
}

type DirectoryLoad =
  | { readonly status: "available"; readonly directory: HostDirectoryLike }
  | { readonly status: "unavailable"; readonly error: SafeError };

async function loadDirectory(
  hosts: ParentHostsLike,
  redaction: readonly string[],
): Promise<DirectoryLoad> {
  try {
    return { status: "available", directory: await hosts.list() };
  } catch (error) {
    return {
      status: "unavailable",
      error: safeError("registrations_unavailable", failureDetail(error, redaction)),
    };
  }
}

function registrationsView(loaded: DirectoryLoad): RegistrationsView {
  return loaded.status === "available"
    ? { status: "available", hosts: loaded.directory.hosts }
    : { status: "unavailable", error: loaded.error };
}

interface Projection {
  readonly list: VmListResult;
  readonly inventory: SandboxInventory;
}

async function readProjection(context: ReadContext): Promise<Projection> {
  const redaction = credentialValues(context.env, context.storedSecrets);
  const loaded = await loadDirectory(context.hosts, redaction);
  const registrations = registrationsView(loaded);
  const parentId = loaded.status === "available" ? loaded.directory.self.serverId : null;

  const inventory: SandboxInventory = parentId
    ? await loadManagedSandboxes(context.runtime, parentId, redaction)
    : { status: "unavailable", error: safeError("inventory_unavailable") };

  return {
    list: buildVmList({
      parentId,
      inventory,
      registrations,
      pending: context.pending,
      env: context.env,
      storedCredentials: context.storedCredentials,
    }),
    inventory,
  };
}

export async function readVmList(context: ReadContext): Promise<VmListResult> {
  return (await readProjection(context)).list;
}

export async function readVmDetail(
  context: ReadContext,
  input: VmDetailInput,
): Promise<VmDetailResult> {
  const projection = await readProjection(context);
  const child = selectChild(projection.list.children, input);

  let logs: VmDetailResult["logs"] = {
    sandbox: unavailableLogBundle(),
    job: unavailableLogBundle(),
  };

  if (child?.kind === "sandbox" && projection.inventory.status === "available") {
    const sandbox = projection.inventory.sandboxes.find(
      (candidate) =>
        candidate.sandbox.id === child.id && candidate.sandbox.name === child.name,
    );

    if (sandbox) {
      const secrets = [
        ...credentialValues(context.env, context.storedSecrets),
        ...persistedCredentialValues(sandbox.handle.config()),
      ];
      const job = await findLatestInstallJob(sandbox.handle).catch(() => null);
      logs = {
        sandbox: await readSandboxLogs(sandbox.handle, secrets),
        job: job
          ? await readJobLogs(sandbox.handle, job.id, secrets)
          : unavailableLogBundle(),
      };
    }
  }

  return {
    inventory: projection.list.inventory,
    registrations: projection.list.registrations,
    child,
    logs,
  };
}

/**
 * Rows can share a name (a settled failed attempt plus its leftover
 * registration). An explicit id selects the exact generation; otherwise the
 * first matching row wins.
 */
function selectChild(children: readonly VmChild[], input: VmDetailInput): VmChild | null {
  const named = children.filter((candidate) => candidate.name === input.name);
  if (named.length === 0) return null;
  if (!input.id) return named[0] ?? null;
  return (
    named.find((candidate) => candidate.kind !== "pending" && candidate.id === input.id) ?? null
  );
}

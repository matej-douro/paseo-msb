import type { VmDetailInput, VmDetailResult, VmListResult } from "../shared/contracts";
import { JOB_LABEL } from "../shared/constants";
import { safeError, type SafeError } from "../shared/errors";
import {
  credentialValues,
  readJobLogs,
  readSandboxLogs,
  unavailableLogBundle,
} from "./logs";
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
}

type DirectoryLoad =
  | { readonly status: "available"; readonly directory: HostDirectoryLike }
  | { readonly status: "unavailable"; readonly error: SafeError };

async function loadDirectory(hosts: ParentHostsLike): Promise<DirectoryLoad> {
  try {
    return { status: "available", directory: await hosts.list() };
  } catch {
    return { status: "unavailable", error: safeError("registrations_unavailable") };
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
  const loaded = await loadDirectory(context.hosts);
  const registrations = registrationsView(loaded);
  const parentId = loaded.status === "available" ? loaded.directory.self.serverId : null;

  const inventory: SandboxInventory = parentId
    ? await loadManagedSandboxes(context.runtime, parentId)
    : { status: "unavailable", error: safeError("inventory_unavailable") };

  return {
    list: buildVmList({
      parentId,
      inventory,
      registrations,
      pending: context.pending,
      env: context.env,
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
  const child = projection.list.children.find((candidate) => candidate.name === input.name) ?? null;

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
      const secrets = credentialValues(context.env);
      const jobId = sandbox.sandbox.labels[JOB_LABEL];
      logs = {
        sandbox: await readSandboxLogs(sandbox.handle, secrets),
        job: jobId
          ? await readJobLogs(sandbox.handle, jobId, secrets)
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

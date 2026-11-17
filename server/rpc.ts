import type {
  VmDetailInput,
  VmDetailResult,
  VmListResult,
} from "../shared/contracts";
import type { CredentialName } from "../shared/constants";
import { buildProvisionScript, legacyPiPlan } from "../shared/provisioning";
import { selectVmChild } from "../shared/selection";
import { safeError, type SafeError } from "../shared/errors";
import { persistedCredentialValues } from "./diagnostics";
import { findLatestInstallJob } from "./jobs";
import { bounded } from "./lanes";
import {
  credentialValues,
  readJobLogs,
  readSandboxLogs,
  unavailableLogBundle,
} from "./logs";
import { failureDetail } from "./diagnostics";
import type { PendingCreate } from "./pending";
import { findLatestProvisionJob } from "./provision";
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
  /** Refreshes the cached parent id used by `vm.metrics`. */
  readonly onParentId?: (parentId: string) => void;
  /** Bound for one parent directory read; tests shorten it. */
  readonly hostCallTimeoutMs?: number;
}

/** Bound for one parent directory read in the read projection. */
const DEFAULT_HOST_CALL_TIMEOUT_MS = 60_000;

type DirectoryLoad =
  | { readonly status: "available"; readonly directory: HostDirectoryLike }
  | { readonly status: "unavailable"; readonly error: SafeError };

async function loadDirectory(
  hosts: ParentHostsLike,
  redaction: readonly string[],
  timeoutMs: number,
): Promise<DirectoryLoad> {
  try {
    return { status: "available", directory: await bounded(hosts.list(), { timeoutMs }) };
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
  const loaded = await loadDirectory(
    context.hosts,
    redaction,
    context.hostCallTimeoutMs ?? DEFAULT_HOST_CALL_TIMEOUT_MS,
  );
  const registrations = registrationsView(loaded);
  const parentId = loaded.status === "available" ? loaded.directory.self.serverId : null;
  if (parentId) context.onParentId?.(parentId);

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
  const child = selectVmChild(projection.list.children, input);

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
      const provision = buildProvisionScript(sandbox.sandbox.plan ?? legacyPiPlan());
      const job =
        (await findLatestProvisionJob(sandbox.handle, provision.argv).catch(() => null)) ??
        (await findLatestInstallJob(sandbox.handle).catch(() => null));
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

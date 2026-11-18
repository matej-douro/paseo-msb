import type { VmDeleteInput, VmDeleteResult } from "../shared/contracts";
import { safeError } from "../shared/errors";
import { cleanupName } from "./cleanup";
import { bounded, LifecycleAbortedError, type LaneToken } from "./lanes";
import type { MutationRegistry } from "./mutations";
import type { RegistrationContext } from "./registration";
import {
  ownershipOf,
  type SandboxHandleLike,
  type SandboxHost,
} from "./sandbox";

/** Bound for one Delete parent/runtime call. */
const DEFAULT_DELETE_TIMEOUT_MS = 60_000;

function deleteTimeout(context: DeleteContext): number {
  return context.deleteTimeoutMs ?? DEFAULT_DELETE_TIMEOUT_MS;
}

export interface DeleteContext extends RegistrationContext {
  readonly hosts: RegistrationContext["hosts"];
  readonly sandboxHost: SandboxHost;
  /** Raw native mutation settlement, shared with Create and Repair. */
  readonly mutations: MutationRegistry;
  /** Bound for one Delete parent/runtime call; tests shorten it. */
  readonly deleteTimeoutMs?: number;
}

/**
 * `vm.delete` runs in the same per-name lane as Create and Repair. It destroys
 * the exact generation the caller confirmed, then removes every plugin-owned
 * host row for that name. Instead of a durable deletion tombstone, the
 * background sweep proves a leftover row stale by the same rule, so an
 * interrupted Delete converges on the next sweep.
 *
 * Every parent/runtime call is bounded and carries the lane's abort signal, so
 * Delete can never stall plugin teardown or a queued same-name operation.
 */
export async function deleteVm(
  context: DeleteContext,
  input: VmDeleteInput,
  token: LaneToken,
): Promise<VmDeleteResult> {
  if (input.confirmName !== input.name) {
    throw new Error(safeError("invalid_request").message);
  }

  token.throwIfAborted();

  // Registrations must be readable before anything is destroyed, so an
  // unavailable daemon never leaves an unmanaged running VM behind.
  const directory = await listDirectory(context, token);
  const parentId = directory.self.serverId;

  const handle = await findSandbox(context, input.name, token);

  if (handle) {
    if (handle.id !== input.id) throw new Error(safeError("id_mismatch").message);

    const ownership = ownershipOf(handle, parentId);
    if (ownership !== "owned") throw new Error(safeError("invalid_config").message);

    // An unsettled native write (a resize) may still reach this name. Do not
    // destroy under it. A registration-only child has no sandbox, so a stale
    // mutation entry can never block its cleanup.
    if (context.mutations.pending(input.name)) {
      throw new Error(safeError("mutation_pending").message);
    }

    token.throwIfAborted();
    try {
      await bounded(context.sandboxHost.destroy(handle), {
        timeoutMs: deleteTimeout(context),
        signal: token.signal,
      });
    } catch (error) {
      if (error instanceof LifecycleAbortedError) throw error;
      throw new Error(safeError("delete_failed").message);
    }
  }

  token.throwIfAborted();

  // Remove this child's host rows. The requested generation is gone (destroyed
  // above, or never found); its rows are removed even if the runtime still
  // reports a dying handle. A different live replacement keeps its own row.
  const after = await listDirectory(context, token);
  const cleanup = await cleanupName(context, input.name, after.hosts, {
    signal: token.signal,
    confirmedGoneId: input.id,
  });
  if (cleanup.failed > 0) {
    throw new Error(safeError("registration_failed").message);
  }

  return { name: input.name, removed: true };
}

async function listDirectory(context: DeleteContext, token: LaneToken) {
  try {
    return await bounded(context.hosts.list(), {
      timeoutMs: deleteTimeout(context),
      signal: token.signal,
    });
  } catch (error) {
    if (error instanceof LifecycleAbortedError) throw error;
    throw new Error(safeError("registrations_unavailable").message);
  }
}

async function findSandbox(
  context: DeleteContext,
  name: string,
  token: LaneToken,
): Promise<SandboxHandleLike | null> {
  try {
    return await bounded(context.sandboxHost.find(name), {
      timeoutMs: deleteTimeout(context),
      signal: token.signal,
    });
  } catch (error) {
    if (error instanceof LifecycleAbortedError) throw error;
    throw new Error(safeError("runtime_unavailable").message);
  }
}

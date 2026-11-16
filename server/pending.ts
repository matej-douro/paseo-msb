import {
  CPUS,
  MEMORY_MIB,
  ROOT_DISK_MIB,
  sandboxName,
  type Phase,
} from "../shared/constants";
import type {
  ResourceRequest,
  VmCreateInput,
  VmDismissResult,
  VmResources,
} from "../shared/contracts";
import type { CanonicalPlan } from "../shared/provisioning";
import { canonicalizePlan, plansEqual } from "../shared/provisioning";
import { safeError, type SafeErrorCode } from "../shared/errors";

/**
 * The canonical identity and desired shape of one Create request. A repeated
 * request must match every field; the name is derived from the request ID when
 * the client omitted it.
 */
export interface PendingCreateRequest {
  readonly requestId: string;
  readonly name: string;
  readonly plan: CanonicalPlan;
  readonly resources: VmResources;
  readonly resourcesSpecified: boolean;
}

/**
 * A create attempt that has not produced a sandbox yet. The store is the only
 * plugin-owned volatile state and lives in the plugin subprocess, so pending
 * creates stay visible across UI navigation.
 *
 * A pending entry never carries credential values: only the request ID, the
 * chosen name, the canonical provider/integration plan, the desired resources,
 * whether those resources were explicitly supplied, a phase, a safe error code,
 * and bounded redacted detail.
 */
export interface PendingCreate extends PendingCreateRequest {
  readonly phase: Phase;
  readonly createdAt: number;
  readonly errorCode: SafeErrorCode | null;
  readonly errorDetail: string | null;
}

/** Applies defaults and the fixed CPU count to an accepted Create input. */
export function createRequestFor(input: VmCreateInput, plan: CanonicalPlan): PendingCreateRequest {
  return {
    requestId: input.requestId,
    name: input.name ?? sandboxName(input.requestId),
    plan: canonicalizePlan(plan),
    resources: resourcesFor(input.resources),
    resourcesSpecified: input.resources !== undefined,
  };
}

/**
 * Synchronous reservation result. `reserved` means this caller owns the only
 * attempt for the request and must settle it; `joined` means an identical
 * attempt is already running; `conflict` means the request reuses the same ID
 * with a different name, plan, resources, or resources-specified flag.
 */
export type PendingReservation =
  | { readonly status: "reserved"; readonly entry: PendingCreate }
  | { readonly status: "joined"; readonly entry: PendingCreate }
  | { readonly status: "conflict" };

export interface PendingCreateStore {
  list(): readonly PendingCreate[];
  find(requestId: string): PendingCreate | null;
  /**
   * Reserves the request without any external await. A failed entry is
   * restarted under the same request ID; a running entry is joined.
   */
  reserve(request: PendingCreateRequest): PendingReservation;
  /** Settles a running attempt as failed. Never resurrects or replaces a newer entry. */
  fail(
    requestId: string,
    code: SafeErrorCode,
    detail?: string | null,
    entry?: PendingCreate,
  ): void;
  /**
   * Settles a running attempt as successful or cancelled. Passing the reserved
   * entry prevents an old attempt's late settlement from removing a newer
   * attempt that reused the same request ID.
   */
  settle(requestId: string, entry?: PendingCreate): void;
}

function resourcesFor(request: ResourceRequest | undefined): VmResources {
  return {
    cpus: request?.cpus ?? CPUS,
    memoryMib: request?.memoryMib ?? MEMORY_MIB,
    diskMib: request?.diskMib ?? ROOT_DISK_MIB,
  };
}

function resourcesEqual(left: VmResources, right: VmResources): boolean {
  return (
    left.cpus === right.cpus &&
    left.memoryMib === right.memoryMib &&
    left.diskMib === right.diskMib
  );
}

/** Every field of a repeated request must match the original attempt. */
function requestsEqual(left: PendingCreateRequest, right: PendingCreateRequest): boolean {
  return (
    left.name === right.name &&
    left.resourcesSpecified === right.resourcesSpecified &&
    resourcesEqual(left.resources, right.resources) &&
    plansEqual(left.plan, right.plan)
  );
}

function initialEntry(request: PendingCreateRequest): PendingCreate {
  return {
    requestId: request.requestId,
    name: request.name,
    plan: request.plan,
    resources: request.resources,
    resourcesSpecified: request.resourcesSpecified,
    phase: "creating",
    createdAt: Date.now(),
    errorCode: null,
    errorDetail: null,
  };
}

export function dismissPendingCreate(
  store: PendingCreateStore,
  requestId: string,
): VmDismissResult {
  const entry = store.find(requestId);
  if (!entry) throw new Error(safeError("not_found").message);
  if (entry.phase !== "failed") throw new Error(safeError("invalid_request").message);

  store.settle(requestId, entry);
  return { name: entry.name, dismissed: true };
}

export function createPendingCreateStore(): PendingCreateStore {
  const entries = new Map<string, PendingCreate>();

  return {
    list() {
      return [...entries.values()].sort(
        (left, right) => left.createdAt - right.createdAt || left.name.localeCompare(right.name),
      );
    },

    find(requestId) {
      return entries.get(requestId) ?? null;
    },

    reserve(request) {
      const existing = entries.get(request.requestId);

      if (existing) {
        if (!requestsEqual(existing, request)) return { status: "conflict" };
        if (existing.phase !== "failed") return { status: "joined", entry: existing };
      }

      return {
        status: "reserved",
        entry: insert(initialEntry(request)),
      };
    },

    fail(requestId, code, detail = null, entry) {
      const existing = entries.get(requestId);
      if (!existing) return;
      if (entry && existing !== entry) return;
      insert({ ...existing, phase: "failed", errorCode: code, errorDetail: detail });
    },

    settle(requestId, entry) {
      const existing = entries.get(requestId);
      if (!existing) return;
      if (entry && existing !== entry) return;
      entries.delete(requestId);
    },
  };

  function insert(entry: PendingCreate): PendingCreate {
    entries.set(entry.requestId, entry);
    return entry;
  }
}

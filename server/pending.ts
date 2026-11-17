import type { Phase } from "../shared/constants";
import {
  defaultResources,
  resourcesEqual,
  type ResourceRequest,
  type VmCreateInput,
  type VmDismissResult,
  type VmResources,
} from "../shared/contracts";
import type { CanonicalPlan } from "../shared/provisioning";
import { canonicalizePlan, plansEqual } from "../shared/provisioning";
import { safeError, type SafeErrorCode } from "../shared/errors";

/**
 * The canonical identity and desired shape of one Create request. The name is
 * the identity: a repeated request must match every other field, and a
 * different shape under the same name is a conflict.
 */
export interface PendingCreateRequest {
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
 * A pending entry never carries credential values: only the chosen name, the
 * canonical provider/integration plan, the desired resources, whether those
 * resources were explicitly supplied, a phase, a safe error code, and bounded
 * redacted detail.
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
    name: input.name,
    plan: canonicalizePlan(plan),
    resources: resourcesFor(input.resources),
    resourcesSpecified: input.resources !== undefined,
  };
}

/**
 * Synchronous reservation result. `reserved` means this caller owns the only
 * attempt for the name and must settle it; `joined` means an identical attempt
 * is already running; `conflict` means the name was reused with a different
 * plan, resources, or resources-specified flag.
 */
export type PendingReservation =
  | { readonly status: "reserved"; readonly entry: PendingCreate }
  | { readonly status: "joined"; readonly entry: PendingCreate }
  | { readonly status: "conflict" };

export interface PendingCreateStore {
  list(): readonly PendingCreate[];
  find(name: string): PendingCreate | null;
  /**
   * Reserves the name without any external await. A failed entry is restarted
   * under the same name; a running entry is joined.
   */
  reserve(request: PendingCreateRequest): PendingReservation;
  /** Settles a running attempt as failed. Never resurrects or replaces a newer entry. */
  fail(
    name: string,
    code: SafeErrorCode,
    detail?: string | null,
    entry?: PendingCreate,
  ): void;
  /**
   * Settles a running attempt as successful or cancelled. Passing the reserved
   * entry prevents an old attempt's late settlement from removing a newer
   * attempt that reused the same name.
   */
  settle(name: string, entry?: PendingCreate): void;
}

function resourcesFor(request: ResourceRequest | undefined): VmResources {
  const defaults = defaultResources();
  return {
    cpus: request?.cpus ?? defaults.cpus,
    memoryMib: request?.memoryMib ?? defaults.memoryMib,
    diskMib: request?.diskMib ?? defaults.diskMib,
  };
}

/** Every field of a repeated request must match the original attempt. */
function requestsEqual(left: PendingCreateRequest, right: PendingCreateRequest): boolean {
  return (
    left.resourcesSpecified === right.resourcesSpecified &&
    resourcesEqual(left.resources, right.resources) &&
    plansEqual(left.plan, right.plan)
  );
}

function initialEntry(request: PendingCreateRequest): PendingCreate {
  return {
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
  name: string,
): VmDismissResult {
  const entry = store.find(name);
  if (!entry) throw new Error(safeError("not_found").message);
  if (entry.phase !== "failed") throw new Error(safeError("invalid_request").message);

  store.settle(name, entry);
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

    find(name) {
      return entries.get(name) ?? null;
    },

    reserve(request) {
      const existing = entries.get(request.name);

      if (existing) {
        if (!requestsEqual(existing, request)) return { status: "conflict" };
        if (existing.phase !== "failed") return { status: "joined", entry: existing };
      }

      return {
        status: "reserved",
        entry: insert(initialEntry(request)),
      };
    },

    fail(name, code, detail = null, entry) {
      const existing = entries.get(name);
      if (!existing) return;
      if (entry && existing !== entry) return;
      insert({ ...existing, phase: "failed", errorCode: code, errorDetail: detail });
    },

    settle(name, entry) {
      const existing = entries.get(name);
      if (!existing) return;
      if (entry && existing !== entry) return;
      entries.delete(name);
    },
  };

  function insert(entry: PendingCreate): PendingCreate {
    entries.set(entry.name, entry);
    return entry;
  }
}

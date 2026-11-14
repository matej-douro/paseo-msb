import { sandboxName, type Phase } from "../shared/constants";
import type { VmDismissResult } from "../shared/contracts";
import type { CanonicalPlan } from "../shared/provisioning";
import { canonicalizePlan, plansEqual } from "../shared/provisioning";
import { safeError, type SafeErrorCode } from "../shared/errors";

/**
 * A create attempt that has not produced a sandbox yet. The store is the only
 * plugin-owned volatile state and lives in the plugin subprocess, so pending
 * creates stay visible across UI navigation.
 *
 * A pending entry never carries credential values: only the request ID, the
 * generated name, the canonical provider/integration plan, a phase, a safe
 * error code, and bounded redacted detail.
 */
export interface PendingCreate {
  readonly requestId: string;
  readonly name: string;
  readonly plan: CanonicalPlan;
  readonly phase: Phase;
  readonly createdAt: number;
  readonly errorCode: SafeErrorCode | null;
  readonly errorDetail: string | null;
}

/**
 * Synchronous reservation result. `reserved` means this caller owns the only
 * attempt for the request and must settle it; `joined` means an identical
 * attempt is already running; `conflict` means the request reuses a different
 * credential selection.
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
  reserve(
    requestId: string,
    plan: CanonicalPlan,
  ): PendingReservation;
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

function initialEntry(
  requestId: string,
  plan: CanonicalPlan,
): PendingCreate {
  return {
    requestId,
    name: sandboxName(requestId),
    plan: canonicalizePlan(plan),
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

    reserve(requestId, plan) {
      const existing = entries.get(requestId);

      if (existing) {
        if (!plansEqual(existing.plan, plan)) {
          return { status: "conflict" };
        }
        if (existing.phase !== "failed") return { status: "joined", entry: existing };
        return {
          status: "reserved",
          entry: insert(initialEntry(requestId, plan)),
        };
      }

      return {
        status: "reserved",
        entry: insert(initialEntry(requestId, plan)),
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

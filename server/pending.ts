import { sandboxName, type Phase } from "../shared/constants";
import type { SafeErrorCode } from "../shared/errors";

/**
 * A create attempt that has not produced a sandbox yet. The store is the only
 * plugin-owned volatile state and lives in the plugin subprocess, so pending
 * creates stay visible across UI navigation.
 *
 * A pending entry never carries credential values: only the request ID, the
 * generated name, a phase, a safe error code, and bounded redacted detail.
 */
export interface PendingCreate {
  readonly requestId: string;
  readonly name: string;
  readonly phase: Phase;
  readonly createdAt: number;
  readonly errorCode: SafeErrorCode | null;
  readonly errorDetail: string | null;
}

export interface PendingCreateStore {
  list(): readonly PendingCreate[];
  find(requestId: string): PendingCreate | null;
  /** Adds the attempt, or returns the existing entry for a repeated request ID. */
  ensure(requestId: string): PendingCreate;
  /** Restarts an empty pre-create failure under the same request ID. */
  restart(requestId: string): PendingCreate;
  fail(requestId: string, code: SafeErrorCode, detail?: string | null): void;
  remove(requestId: string): void;
}

function initialEntry(requestId: string): PendingCreate {
  return {
    requestId,
    name: sandboxName(requestId),
    phase: "creating",
    createdAt: Date.now(),
    errorCode: null,
    errorDetail: null,
  };
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

    ensure(requestId) {
      return entries.get(requestId) ?? insert(initialEntry(requestId));
    },

    restart(requestId) {
      return insert(initialEntry(requestId));
    },

    fail(requestId, code, detail = null) {
      const existing = entries.get(requestId);
      if (existing) {
        insert({ ...existing, phase: "failed", errorCode: code, errorDetail: detail });
      }
    },

    remove(requestId) {
      entries.delete(requestId);
    },
  };

  function insert(entry: PendingCreate): PendingCreate {
    entries.set(entry.requestId, entry);
    return entry;
  }
}

import type { Phase } from "../shared/constants";
import type { SafeErrorCode } from "../shared/errors";

/**
 * A create attempt that has not produced a sandbox yet. Task 3 owns the
 * lifecycle of this map; task 2 only exposes its initially empty read side.
 */
export interface PendingCreate {
  readonly requestId: string;
  readonly name: string;
  readonly phase: Phase;
  readonly createdAt: number;
  readonly errorCode: SafeErrorCode | null;
}

const pendingCreates = new Map<string, PendingCreate>();

export function listPendingCreates(): readonly PendingCreate[] {
  return [...pendingCreates.values()].sort(
    (left, right) => left.createdAt - right.createdAt || left.name.localeCompare(right.name),
  );
}

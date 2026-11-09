import type { ManagedPhase, PendingChild, SafeError } from "../shared/contracts";

export type PendingCreates = Map<string, PendingChild>;

export function sandboxNameForRequest(requestId: string): string {
  return `paseo-${requestId}`;
}

export function findPendingByName(
  pending: ReadonlyMap<string, PendingChild>,
  name: string,
): PendingChild | null {
  for (const child of pending.values()) {
    if (child.name === name) return child;
  }
  return null;
}

export function addPendingCreate(
  pending: PendingCreates,
  requestId: string,
): PendingChild {
  const existing = pending.get(requestId);
  if (existing) return existing;

  const entry: PendingChild = {
    requestId,
    name: sandboxNameForRequest(requestId),
    phase: "creating",
    error: null,
  };
  pending.set(requestId, entry);
  return entry;
}

export function updatePendingCreate(
  pending: PendingCreates,
  requestId: string,
  phase: ManagedPhase,
  error: SafeError | null,
): PendingChild | null {
  const existing = pending.get(requestId);
  if (!existing) return null;

  const entry: PendingChild = { ...existing, phase, error };
  pending.set(requestId, entry);
  return entry;
}

export function removePendingCreate(
  pending: PendingCreates,
  requestId: string,
): void {
  pending.delete(requestId);
}

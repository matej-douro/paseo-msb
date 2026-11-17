import type { VmChild } from "./contracts";

/** Identifies one row in the merged child list. */
export interface ChildSelection {
  readonly name: string;
  readonly id?: string;
}

/**
 * Resolves a selection against the current list. Omitting the id follows the
 * name's pending attempt first, then the first row with that name; an explicit
 * id selects the exact non-pending generation.
 */
export function selectVmChild(
  children: readonly VmChild[],
  selection: ChildSelection,
): VmChild | null {
  const named = children.filter((child) => child.name === selection.name);
  if (named.length === 0) return null;

  if (selection.id) {
    return named.find((child) => child.kind !== "pending" && child.id === selection.id) ?? null;
  }

  return named.find((child) => child.kind === "pending") ?? named[0] ?? null;
}

import { useCallback, useState } from "react";
import type { Child } from "../../shared/contracts";
import { deleteChild, repairChild } from "../actions";
import type { VmApi } from "../api";
import { useVmApi } from "./useVmApi";

export interface ChildActions {
  repairing: boolean;
  deleting: boolean;
  error: string | null;
  repair(
    child: Child,
  ): Promise<Awaited<ReturnType<VmApi["reconcile"]>> | null>;
  remove(child: Child, confirmName: string): Promise<boolean>;
  clearError(): void;
}

export function useChildActions(
  onChanged: () => void | Promise<void>,
  onDeleted: (child: Child) => void | Promise<void>,
): ChildActions {
  const api = useVmApi();
  const [repairing, setRepairing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const clearError = useCallback(() => setError(null), []);

  const repair = useCallback(
    async (child: Child) => {
      setError(null);
      setRepairing(true);
      try {
        const result = await repairChild(api, child);
        await onChanged();
        return result;
      } catch {
        setError("Repair failed. Check the child state and retry.");
        return null;
      } finally {
        setRepairing(false);
      }
    },
    [api, onChanged],
  );

  const remove = useCallback(
    async (child: Child, confirmName: string) => {
      setError(null);
      setDeleting(true);
      try {
        await deleteChild(api, child, confirmName);
        await onDeleted(child);
        return true;
      } catch {
        setError("Delete failed. The child may still exist; retry.");
        return false;
      } finally {
        setDeleting(false);
      }
    },
    [api, onDeleted],
  );

  return { repairing, deleting, error, repair, remove, clearError };
}

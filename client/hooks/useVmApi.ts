import { useMemo } from "react";
import { useRpc } from "@getpaseo/plugin/client";
import {
  vmCreate,
  vmDelete,
  vmDetail,
  vmList,
  vmReconcile,
} from "../../shared/contracts";
import type { VmApi } from "../api";

export function useVmApi(): VmApi {
  const list = useRpc(vmList);
  const detail = useRpc(vmDetail);
  const create = useRpc(vmCreate);
  const remove = useRpc(vmDelete);
  const reconcile = useRpc(vmReconcile);

  return useMemo(
    () => ({
      list: () => list({}),
      detail: (input) => detail(input),
      create: (input) => create(input),
      delete: (input) => remove(input),
      reconcile: (input) => reconcile(input),
    }),
    [list, detail, create, remove, reconcile],
  );
}

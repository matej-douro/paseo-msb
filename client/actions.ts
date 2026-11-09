import type { RpcOutput } from "@getpaseo/plugin";
import {
  vmCreate,
  vmDelete,
  vmReconcile,
  type Child,
} from "../shared/contracts";
import type { VmApi } from "./api";
import type { CredentialName } from "./types";

export function createChild(
  api: VmApi,
  input: { requestId: string; secretEnvVars: readonly CredentialName[] },
): Promise<RpcOutput<typeof vmCreate>> {
  if (input.secretEnvVars.length === 0) {
    throw new Error("Select at least one credential.");
  }
  return api.create({
    requestId: input.requestId,
    secretEnvVars: [...input.secretEnvVars],
  });
}

export function repairChild(
  api: VmApi,
  child: Child,
): Promise<RpcOutput<typeof vmReconcile>> {
  return api.reconcile({ name: child.name, id: child.id });
}

export function deleteChild(
  api: VmApi,
  child: Child,
  confirmName: string,
): Promise<RpcOutput<typeof vmDelete>> {
  if (confirmName !== child.name) {
    throw new Error("Confirmation does not match the child name.");
  }
  return api.delete({ name: child.name, id: child.id, confirmName });
}

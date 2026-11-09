import type { PluginRpcContract, RpcInput, RpcOutput } from "@getpaseo/plugin";
import {
  vmCreate,
  vmDelete,
  vmDetail,
  vmList,
  vmReconcile,
} from "../shared/contracts";

export type RpcInvoke = (method: string, input: unknown) => Promise<unknown>;

export interface VmApi {
  list(): Promise<RpcOutput<typeof vmList>>;
  detail(input: RpcInput<typeof vmDetail>): Promise<RpcOutput<typeof vmDetail>>;
  create(input: RpcInput<typeof vmCreate>): Promise<RpcOutput<typeof vmCreate>>;
  delete(input: RpcInput<typeof vmDelete>): Promise<RpcOutput<typeof vmDelete>>;
  reconcile(
    input: RpcInput<typeof vmReconcile>,
  ): Promise<RpcOutput<typeof vmReconcile>>;
}

async function invokeContract<Contract extends PluginRpcContract>(
  contract: Contract,
  invoke: RpcInvoke,
  input: unknown,
): Promise<RpcOutput<Contract>> {
  const parsedInput = await contract.input.parseAsync(input);
  const output = await invoke(contract.name, parsedInput);
  return (await contract.output.parseAsync(output)) as RpcOutput<Contract>;
}

export function createVmApi(invoke: RpcInvoke): VmApi {
  return {
    list: () => invokeContract(vmList, invoke, {}),
    detail: (input) => invokeContract(vmDetail, invoke, input),
    create: (input) => invokeContract(vmCreate, invoke, input),
    delete: (input) => invokeContract(vmDelete, invoke, input),
    reconcile: (input) => invokeContract(vmReconcile, invoke, input),
  };
}

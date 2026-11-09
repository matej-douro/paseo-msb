import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import {
  vmDetail,
  vmList,
  type PendingChild,
  safeError,
} from "../shared/contracts";
import { LOG_ENTRY_LIMIT } from "../shared/constants";
import {
  logsAvailable,
  logsUnavailable,
  projectLogs,
} from "./logs";
import type { SandboxInventory } from "./sandbox";
import {
  availableCredentialNames,
  availableInventory,
  decodeHostDirectory,
  parentFromDirectory,
  projectChild,
  registrationsBySourceKey,
  registrationsFromDirectory,
  unavailableInventory,
} from "./status";

export interface ReadDependencies {
  readonly inventory: SandboxInventory;
  readonly pendingCreates: ReadonlyMap<string, PendingChild>;
  readonly env: NodeJS.ProcessEnv;
}

export function createReadHandlers(deps: ReadDependencies) {
  async function list(
    _input: RpcInput<typeof vmList>,
    context: PluginHandlerContext,
  ): Promise<RpcOutput<typeof vmList>> {
    const pending = [...deps.pendingCreates.values()];
    const credentials = availableCredentialNames(deps.env);

    let directory;
    try {
      directory = decodeHostDirectory(await context.paseo.hosts.list());
    } catch {
      return {
        parent: null,
        pending,
        children: [],
        credentials,
        inventory: unavailableInventory("parent_unavailable"),
        registrations: unavailableInventory("parent_unavailable"),
      };
    }

    const parent = parentFromDirectory(directory);
    const registrations = registrationsFromDirectory(directory);
    const bySourceKey = registrationsBySourceKey(registrations);

    let sandboxes;
    try {
      sandboxes = await deps.inventory.listManaged(parent.serverId);
    } catch {
      return {
        parent,
        pending,
        children: [],
        credentials,
        inventory: unavailableInventory("inventory_unavailable"),
        registrations: availableInventory(),
      };
    }

    const children = sandboxes
      .map((sandbox) => projectChild(sandbox, bySourceKey.get(sandbox.id) ?? null))
      .sort((left, right) => left.name.localeCompare(right.name));

    return {
      parent,
      pending,
      children,
      credentials,
      inventory: availableInventory(),
      registrations: availableInventory(),
    };
  }

  async function detail(
    input: RpcInput<typeof vmDetail>,
    context: PluginHandlerContext,
  ): Promise<RpcOutput<typeof vmDetail>> {
    const pending =
      [...deps.pendingCreates.values()].find((child) => child.name === input.name) ??
      null;
    if (pending) {
      return {
        pending,
        child: null,
        logs: logsAvailable(),
        inventory: availableInventory(),
        registrations: availableInventory(),
        error: null,
      };
    }

    let directory;
    try {
      directory = decodeHostDirectory(await context.paseo.hosts.list());
    } catch {
      return {
        pending: null,
        child: null,
        logs: logsUnavailable("parent_unavailable"),
        inventory: unavailableInventory("parent_unavailable"),
        registrations: unavailableInventory("parent_unavailable"),
        error: safeError("parent_unavailable"),
      };
    }

    const parent = parentFromDirectory(directory);
    const registrations = registrationsFromDirectory(directory);
    const bySourceKey = registrationsBySourceKey(registrations);

    let lookup;
    try {
      lookup = await deps.inventory.getManaged(input.name, parent.serverId);
    } catch {
      return {
        pending: null,
        child: null,
        logs: logsUnavailable("inventory_unavailable"),
        inventory: unavailableInventory("inventory_unavailable"),
        registrations: availableInventory(),
        error: safeError("inventory_unavailable"),
      };
    }

    if (lookup.status === "not_found") {
      return {
        pending: null,
        child: null,
        logs: logsAvailable(),
        inventory: availableInventory(),
        registrations: availableInventory(),
        error: safeError("sandbox_not_found"),
      };
    }

    if (lookup.status === "invalid") {
      return {
        pending: null,
        child: null,
        logs: logsUnavailable("config_invalid"),
        inventory: availableInventory(),
        registrations: availableInventory(),
        error: safeError("config_invalid"),
      };
    }

    const sandbox = lookup.sandbox;
    if (input.id && input.id !== sandbox.id) {
      return {
        pending: null,
        child: null,
        logs: logsAvailable(),
        inventory: availableInventory(),
        registrations: availableInventory(),
        error: safeError("sandbox_replaced"),
      };
    }

    const child = projectChild(sandbox, bySourceKey.get(sandbox.id) ?? null);

    let logs;
    try {
      logs = projectLogs(await deps.inventory.readLogs(sandbox), deps.env);
    } catch {
      logs = logsUnavailable("logs_unavailable");
    }

    if (logs.entries.length > LOG_ENTRY_LIMIT) {
      logs = { ...logs, entries: logs.entries.slice(-LOG_ENTRY_LIMIT) };
    }

    return {
      pending: null,
      child,
      logs,
      inventory: availableInventory(),
      registrations: availableInventory(),
      error: null,
    };
  }

  return { list, detail };
}

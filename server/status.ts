import { z } from "zod";
import {
  CREDENTIALS,
  LABELS,
  REGISTRATION,
} from "../shared/constants";
import {
  type Child,
  type InventoryState,
  type Parent,
  type Registration,
  SAFE_ERROR_CODES,
  type SafeError,
  type SafeErrorCode,
  RegistrationStatusSchema,
  safeError,
} from "../shared/contracts";
import type { ManagedSandbox } from "./sandbox";

const hostDirectorySchema = z.object({
  self: z.object({
    serverId: z.string().min(1),
    label: z.string().min(1),
  }),
  hosts: z.array(
    z.object({
      registrationId: z.string().min(1),
      serverId: z.string().min(1).nullable(),
      label: z.string().min(1).nullable(),
      source: z.object({
        id: z.string(),
        key: z.string().min(1),
      }),
      metadata: z.record(z.string(), z.string()),
      status: RegistrationStatusSchema,
    }),
  ),
});

export type HostDirectory = z.infer<typeof hostDirectorySchema>;

export function decodeHostDirectory(value: unknown): HostDirectory {
  return hostDirectorySchema.parse(value);
}

export function availableCredentialNames(
  env: NodeJS.ProcessEnv,
): Array<(typeof CREDENTIALS)[number]["env"]> {
  return CREDENTIALS.filter(({ env: name }) => {
    const value = env[name];
    return typeof value === "string" && value.length > 0;
  }).map(({ env: name }) => name);
}

export function availableInventory(): InventoryState {
  return { status: "available", error: null };
}

export function unavailableInventory(code: SafeErrorCode): InventoryState {
  return { status: "unavailable", error: safeError(code) };
}

export function parentFromDirectory(directory: HostDirectory): Parent {
  return {
    serverId: directory.self.serverId,
    label: directory.self.label,
  };
}

export function registrationsFromDirectory(directory: HostDirectory): Registration[] {
  return directory.hosts
    .filter((host) => host.metadata.source === REGISTRATION.source)
    .map((host) => ({
      registrationId: host.registrationId,
      serverId: host.serverId,
      label: host.label,
      status: host.status,
      sourceKey: host.source.key,
    }));
}

export function registrationsBySourceKey(
  registrations: readonly Registration[],
): Map<string, Registration> {
  const bySourceKey = new Map<string, Registration>();
  for (const registration of registrations) {
    if (!bySourceKey.has(registration.sourceKey)) {
      bySourceKey.set(registration.sourceKey, registration);
    }
  }
  return bySourceKey;
}

function childError(sandbox: ManagedSandbox): SafeError | null {
  if (sandbox.labels[LABELS.phase] !== "failed") return null;
  const code = sandbox.labels[LABELS.error];
  if (code && (SAFE_ERROR_CODES as readonly string[]).includes(code)) {
    return safeError(code as SafeErrorCode);
  }
  return safeError("sandbox_failed");
}

export function projectChild(
  sandbox: ManagedSandbox,
  registration: Registration | null,
): Child {
  return {
    id: sandbox.id,
    name: sandbox.name,
    labels: sandbox.labels,
    runtimeStatus: sandbox.runtimeStatus,
    registration,
    error: childError(sandbox),
  };
}

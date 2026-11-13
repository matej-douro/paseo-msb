import {
  CREDENTIAL_NAMES,
  ERROR_LABEL,
  MANAGED_LABEL,
  PARENT_LABEL,
  PHASE_LABEL,
  PLUGIN_VERSION,
  REGISTRATION_SOURCE,
  REGISTRATION_STATUSES,
  SANDBOX_ID_LABEL,
  type CredentialName,
  type RegistrationStatus,
} from "../shared/constants";
import type { Availability, ManagedLabels, Registration, VmChild, VmListResult } from "../shared/contracts";
import { safeError, type SafeError } from "../shared/errors";
import type { PendingCreate } from "./pending";
import type { LoadedSandbox, SandboxDecodeFailure, SandboxInventory } from "./sandbox";

/** The subset of the parent host directory this plugin reads. */
export interface HostRegistrationLike {
  readonly registrationId: string;
  readonly serverId: string | null;
  readonly status: string;
  readonly label?: string | null;
  readonly source?: { readonly id?: string; readonly key?: string };
  readonly metadata: Readonly<Record<string, string>>;
}

export interface HostDirectoryLike {
  readonly self: { readonly serverId: string };
  readonly hosts: readonly HostRegistrationLike[];
}

/** The subset of the parent host API the plugin uses. */
export interface ParentHostsLike {
  list(): Promise<HostDirectoryLike>;
}

export type RegistrationsView =
  | { readonly status: "available"; readonly hosts: readonly HostRegistrationLike[] }
  | { readonly status: "unavailable"; readonly error: SafeError };

export interface VmListInput {
  readonly parentId: string | null;
  readonly inventory: SandboxInventory;
  readonly registrations: RegistrationsView;
  readonly pending: readonly PendingCreate[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly storedCredentials?: readonly CredentialName[];
}

const RegistrationStatusSchema = new Set<string>(REGISTRATION_STATUSES);

function normalizeRegistrationStatus(value: string): RegistrationStatus {
  return RegistrationStatusSchema.has(value) ? (value as RegistrationStatus) : "unknown";
}

/** Reports names only. Values never leave the parent process. */
export function availableCredentialNames(
  env: Readonly<Record<string, string | undefined>>,
  stored: readonly CredentialName[] = [],
): CredentialName[] {
  return CREDENTIAL_NAMES.filter((name) => {
    if (stored.includes(name)) return true;
    const value = env[name];
    return typeof value === "string" && value.trim().length > 0;
  });
}

export function isManagedRegistration(registration: HostRegistrationLike): boolean {
  return registration.metadata.source === REGISTRATION_SOURCE;
}

/**
 * The registration uses the stable sandbox ID as its source key and also
 * records it in metadata. Match only stable identity so a same-name
 * replacement never inherits an older registration.
 */
export function findRegistration(
  id: string,
  registrations: readonly HostRegistrationLike[],
): HostRegistrationLike | null {
  const managed = registrations.filter(isManagedRegistration);
  return (
    managed.find((candidate) => candidate.source?.key === id) ??
    managed.find((candidate) => candidate.metadata.vm === id) ??
    null
  );
}

function toRegistrationDto(registration: HostRegistrationLike): Registration {
  return {
    registrationId: registration.registrationId,
    status: normalizeRegistrationStatus(registration.status),
    serverId: registration.serverId && registration.serverId.length > 0 ? registration.serverId : null,
  };
}

function registrationFor(
  sandbox: LoadedSandbox,
  registrations: RegistrationsView,
): Registration | null {
  if (registrations.status !== "available") return null;
  const match = findRegistration(sandbox.sandbox.id, registrations.hosts);
  return match ? toRegistrationDto(match) : null;
}

function pendingChild(pending: PendingCreate): VmChild {
  return {
    kind: "pending",
    name: pending.name,
    phase: pending.phase,
    error: pending.errorCode ? safeError(pending.errorCode) : null,
  };
}

function sandboxChild(sandbox: LoadedSandbox, registrations: RegistrationsView): VmChild {
  return {
    kind: "sandbox",
    name: sandbox.sandbox.name,
    id: sandbox.sandbox.id,
    labels: sandbox.sandbox.labels,
    runtimeStatus: sandbox.sandbox.runtimeStatus,
    registration: registrationFor(sandbox, registrations),
  };
}

function failedChild(parentId: string, failure: SandboxDecodeFailure): VmChild {
  const labels: ManagedLabels = {
    [MANAGED_LABEL]: PLUGIN_VERSION,
    [PARENT_LABEL]: parentId,
    [SANDBOX_ID_LABEL]: failure.id,
    [PHASE_LABEL]: "failed",
    [ERROR_LABEL]: failure.code,
  };
  return {
    kind: "sandbox",
    name: failure.name,
    id: failure.id,
    labels,
    runtimeStatus: failure.runtimeStatus,
    registration: null,
  };
}

function availabilityOf(inventory: SandboxInventory): Availability {
  return inventory.status === "available"
    ? { status: "available" }
    : { status: "unavailable", error: inventory.error };
}

function registrationsAvailability(registrations: RegistrationsView): Availability {
  return registrations.status === "available"
    ? { status: "available" }
    : { status: "unavailable", error: registrations.error };
}

/**
 * Projects inventory, pending creates, and parent registrations into the
 * read-side DTO. Raw sandbox config and environment never enter the result.
 */
export function buildVmList(input: VmListInput): VmListResult {
  const children: VmChild[] = input.pending.map(pendingChild);

  if (input.inventory.status === "available") {
    if (!input.parentId) {
      throw new Error("available inventory requires a parent id");
    }
    for (const sandbox of input.inventory.sandboxes) {
      children.push(sandboxChild(sandbox, input.registrations));
    }
    for (const failure of input.inventory.failures) {
      children.push(failedChild(input.parentId, failure));
    }
  }

  children.sort(
    (left, right) =>
      Number(left.kind !== "pending") - Number(right.kind !== "pending") ||
      left.name.localeCompare(right.name),
  );

  return {
    inventory: availabilityOf(input.inventory),
    registrations: registrationsAvailability(input.registrations),
    credentials: availableCredentialNames(input.env, input.storedCredentials ?? []),
    storedCredentials: [...(input.storedCredentials ?? [])],
    children,
  };
}

import {
  CREDENTIAL_NAMES,
  ERROR_LABEL,
  MANAGED_LABEL,
  PARENT_LABEL,
  PHASE_LABEL,
  PLUGIN_VERSION,
  REGISTRATION_PRODUCER_ID,
  REGISTRATION_STATUSES,
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
  readonly enabled?: boolean;
  readonly label?: string | null;
  readonly source?: { readonly id?: string; readonly key?: string };
  readonly metadata: Readonly<Record<string, string>>;
  /** Parent-provided connection description, used for deliberate updates. */
  readonly targetDescription?: string;
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
  return registration.source?.id === REGISTRATION_PRODUCER_ID;
}

/**
 * Registration identity is the authenticated producer plus the exact generation
 * id. Metadata is configuration and never proves ownership.
 */
export function findRegistration(
  id: string,
  registrations: readonly HostRegistrationLike[],
): HostRegistrationLike | null {
  return (
    registrations.find(
      (candidate) =>
        candidate.source?.id === REGISTRATION_PRODUCER_ID && candidate.source?.key === id,
    ) ?? null
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
    requestId: pending.requestId,
    credentialNames: [...pending.credentialNames],
    phase: pending.phase,
    error: pending.errorCode ? safeError(pending.errorCode) : null,
    errorDetail: pending.errorDetail,
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
    errorDetail: sandbox.sandbox.errorDetail,
  };
}

function failedChild(parentId: string, failure: SandboxDecodeFailure): VmChild {
  const labels: ManagedLabels = {
    [MANAGED_LABEL]: PLUGIN_VERSION,
    [PARENT_LABEL]: parentId,
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
    errorDetail: null,
  };
}

function registrationChild(registration: HostRegistrationLike): VmChild | null {
  const name = registration.metadata.name;
  const id = registration.source?.key;
  if (typeof name !== "string" || name.length === 0) return null;
  if (typeof id !== "string" || id.length === 0) return null;

  return {
    kind: "registration",
    name,
    id,
    phase: "registering",
    registration: toRegistrationDto(registration),
    error: null,
    errorDetail: null,
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
  const sandboxNames = new Set<string>();

  if (input.inventory.status === "available") {
    if (!input.parentId) {
      throw new Error("available inventory requires a parent id");
    }
    for (const sandbox of input.inventory.sandboxes) {
      sandboxNames.add(sandbox.sandbox.name);
    }
    for (const failure of input.inventory.failures) {
      sandboxNames.add(failure.name);
    }
  }

  // A live sandbox replaces a pending row with the same name.
  const pending = input.pending.filter((entry) => !sandboxNames.has(entry.name));
  const children: VmChild[] = pending.map(pendingChild);

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

  if (input.parentId && input.registrations.status === "available") {
    const known = new Set(pending.map((entry) => entry.name));
    for (const registration of input.registrations.hosts) {
      if (registration.source?.id !== REGISTRATION_PRODUCER_ID) continue;
      const name = registration.metadata.name;
      if (typeof name !== "string" || name.length === 0) continue;
      if (sandboxNames.has(name) || known.has(name)) continue;
      const child = registrationChild(registration);
      if (child) {
        known.add(name);
        children.push(child);
      }
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

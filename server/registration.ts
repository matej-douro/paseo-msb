import {
  MANAGED_NAME_PREFIX,
  REGISTRATION_PRODUCER_ID,
  REGISTRATION_SOURCE,
  registrationLabel,
} from "../shared/constants";
import type { SafeErrorCode } from "../shared/errors";
import { abortableSleep } from "./lanes";
import type { HostDirectoryLike, HostRegistrationLike } from "./status";

/** The parent host API used for registration, not just reads. */
export interface HostAddInput {
  readonly connection: string;
  readonly label: string;
  readonly metadata: Readonly<Record<string, string>>;
  readonly sourceKey: string;
}

export interface HostUpdateInput {
  readonly connection?: string;
  readonly label?: string;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly enabled?: boolean;
}

export interface ProviderEntryLike {
  readonly provider: string;
  readonly status: string;
}

/** The routed child client slice needed to confirm Pi. */
export interface RoutedPaseoLike {
  readonly providers: {
    refresh(options?: { readonly providers?: readonly string[] }): Promise<{
      readonly acknowledged: boolean;
    }>;
    snapshot(options?: {
      readonly cwd?: string;
      readonly requestId?: string;
    }): Promise<{ readonly entries: readonly ProviderEntryLike[] }>;
  };
  dispose(): Promise<void>;
}

export interface RegistrationHostsLike {
  list(): Promise<HostDirectoryLike>;
  add(input: HostAddInput): Promise<HostRegistrationLike>;
  update(registrationId: string, patch: HostUpdateInput): Promise<HostRegistrationLike>;
  remove(registrationId: string): Promise<void>;
  client(serverId: string): Promise<RoutedPaseoLike>;
}

/** A setup step failed with a fixed, safe code and optional safe detail. */
export class SetupFailure extends Error {
  constructor(
    readonly code: SafeErrorCode,
    readonly detail?: string | null,
  ) {
    super(code);
    this.name = "SetupFailure";
  }
}

export interface RegistrationContext {
  readonly hosts: RegistrationHostsLike;
  /** Wait for routed online and Pi readiness; tests shorten it. */
  readonly timeoutMs?: number;
  readonly pollMs?: number;
  readonly signal?: AbortSignal;
}

export const DEFAULT_REGISTRATION_TIMEOUT_MS = 120_000;
export const DEFAULT_REGISTRATION_POLL_MS = 500;

export interface SandboxIdentity {
  readonly id: string;
  readonly name: string;
}

/**
 * Registration metadata is display/configuration, not ownership proof. The
 * stable generation id appears only as `source.key`.
 */
export function registrationMetadata(sandbox: SandboxIdentity): Record<string, string> {
  return { source: REGISTRATION_SOURCE, name: sandbox.name };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return signal ? abortableSleep(ms, signal) : new Promise((resolve) => setTimeout(resolve, ms));
}

function timeoutMs(context: RegistrationContext): number {
  return context.timeoutMs ?? DEFAULT_REGISTRATION_TIMEOUT_MS;
}

function pollMs(context: RegistrationContext): number {
  return context.pollMs ?? DEFAULT_REGISTRATION_POLL_MS;
}

/** A registration belongs to this parent when its label starts with the parent ID. */
export function isRegistrationForParent(
  registration: HostRegistrationLike,
  parentId: string,
): boolean {
  const label = registration.label;
  return typeof label === "string" && label.startsWith(`${parentId}/`);
}

/**
 * The strict ownership predicate: authenticated producer plus the exact current
 * generation id. Metadata and labels never authorize ownership.
 */
export function isOwnedRegistration(
  registration: HostRegistrationLike,
  parentId: string,
  sandboxId: string,
): boolean {
  return (
    registration.source?.id === REGISTRATION_PRODUCER_ID &&
    registration.source?.key === sandboxId &&
    isRegistrationForParent(registration, parentId)
  );
}

export function matchingRegistrations(
  parentId: string,
  sandboxId: string,
  registrations: readonly HostRegistrationLike[],
): HostRegistrationLike[] {
  return registrations.filter((registration) =>
    isOwnedRegistration(registration, parentId, sandboxId),
  );
}

/**
 * Plugin-owned registrations for this parent whose metadata names a managed
 * child. Absence from sandbox inventory is not proof of deletion; callers must
 * confirm with an exact lookup before removing any of these.
 */
export function pluginRegistrations(
  parentId: string,
  registrations: readonly HostRegistrationLike[],
): HostRegistrationLike[] {
  return registrations.filter((registration) => {
    if (registration.source?.id !== REGISTRATION_PRODUCER_ID) return false;
    if (!isRegistrationForParent(registration, parentId)) return false;
    const name = registration.metadata.name;
    return typeof name === "string" && name.startsWith(MANAGED_NAME_PREFIX);
  });
}

/**
 * Ensures exactly one registration for `(producer, handle.id)`. The parent
 * rejects changed inputs with `source_conflict`; a lost-response retry re-lists
 * instead of blindly adding. A user-disabled registration is never re-enabled.
 */
export async function ensureRegistration(
  context: RegistrationContext,
  parentId: string,
  sandbox: SandboxIdentity,
  hostPort: number,
): Promise<{ readonly registration: HostRegistrationLike; readonly changed: boolean }> {
  const desired = {
    connection: `127.0.0.1:${hostPort}`,
    label: registrationLabel(parentId, sandbox.name),
    metadata: registrationMetadata(sandbox),
  };

  const directory = await context.hosts.list().catch(() => {
    throw new SetupFailure("registration_failed");
  });

  const matches = matchingRegistrations(parentId, sandbox.id, directory.hosts);
  if (matches.length > 1) throw new SetupFailure("registration_conflict");

  let registration = matches[0] ?? null;
  let changed = false;

  if (!registration) {
    try {
      registration = await context.hosts.add({
        ...desired,
        sourceKey: sandbox.id,
      });
      changed = true;
    } catch {
      // A lost response or a concurrent add is recoverable only by re-reading
      // the exact `(producer, source.key)` row.
      const retryDirectory = await context.hosts.list().catch(() => null);
      const retried = retryDirectory
        ? matchingRegistrations(parentId, sandbox.id, retryDirectory.hosts)
        : [];
      if (retried.length === 1) {
        registration = retried[0];
        changed = true;
      } else if (retried.length > 1) {
        throw new SetupFailure("registration_conflict");
      } else {
        throw new SetupFailure("registration_failed");
      }
    }
  }

  if (registration.enabled === false || registration.status === "disabled") {
    throw new SetupFailure("registration_failed");
  }

  if (
    registration.label !== desired.label ||
    !metadataMatches(registration.metadata, desired.metadata)
  ) {
    try {
      registration = await context.hosts.update(registration.registrationId, desired);
      changed = true;
    } catch {
      throw new SetupFailure("registration_failed");
    }
  }

  const online = await waitForOnline(context, registration.registrationId);
  if (!online.serverId) throw new SetupFailure("registration_failed");

  await confirmPi(context, online.serverId);
  return { registration: online, changed };
}

async function waitForOnline(
  context: RegistrationContext,
  registrationId: string,
): Promise<HostRegistrationLike> {
  const deadline = Date.now() + timeoutMs(context);

  while (Date.now() <= deadline) {
    context.signal?.throwIfAborted();

    const directory = await context.hosts.list().catch(() => {
      throw new SetupFailure("registration_failed");
    });
    const entry = directory.hosts.find(
      (candidate) => candidate.registrationId === registrationId,
    );

    if (!entry) throw new SetupFailure("registration_failed");
    if (entry.status === "online" && entry.serverId) return entry;
    if (entry.enabled === false || entry.status === "disabled") {
      throw new SetupFailure("registration_failed");
    }

    await sleep(pollMs(context), context.signal);
  }

  throw new SetupFailure("registration_timeout");
}

async function confirmPi(context: RegistrationContext, serverId: string): Promise<void> {
  const remote = await context.hosts.client(serverId).catch(() => {
    throw new SetupFailure("provider_unavailable");
  });

  try {
    const refresh = await remote.providers
      .refresh({ providers: ["pi"] })
      .catch(() => null);
    if (!refresh?.acknowledged) throw new SetupFailure("provider_unavailable");

    const deadline = Date.now() + timeoutMs(context);
    while (Date.now() <= deadline) {
      context.signal?.throwIfAborted();
      const snapshot = await remote.providers.snapshot().catch(() => null);
      const pi = snapshot?.entries.find((entry) => entry.provider === "pi");
      if (pi?.status === "ready") return;
      await sleep(pollMs(context), context.signal);
    }

    throw new SetupFailure("provider_unavailable");
  } finally {
    await remote.dispose().catch(() => {});
  }
}

function metadataMatches(
  actual: Readonly<Record<string, string>>,
  desired: Readonly<Record<string, string>>,
): boolean {
  const actualKeys = Object.keys(actual).sort();
  const desiredKeys = Object.keys(desired).sort();
  if (actualKeys.length !== desiredKeys.length) return false;
  if (actualKeys.some((key, index) => key !== desiredKeys[index])) return false;
  return desiredKeys.every((key) => actual[key] === desired[key]);
}

/**
 * Removing a registration is idempotent for this plugin: an error is treated as
 * success only when a fresh directory confirms the registration is gone.
 */
export async function removeRegistration(
  context: RegistrationContext,
  registrationId: string,
): Promise<void> {
  try {
    await context.hosts.remove(registrationId);
    return;
  } catch {
    const directory = await context.hosts.list().catch(() => null);
    const stillPresent =
      directory?.hosts.some((entry) => entry.registrationId === registrationId) ?? true;
    if (stillPresent) throw new SetupFailure("registration_failed");
  }
}

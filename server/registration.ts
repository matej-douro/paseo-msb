import {
  MANAGED_NAME_PREFIX,
  REGISTRATION_SOURCE,
  registrationLabel,
} from "../shared/constants";
import { type SafeErrorCode } from "../shared/errors";
import {
  isManagedRegistration,
  type HostDirectoryLike,
  type HostRegistrationLike,
} from "./status";

/** The parent host API used for registration, not just reads. */
export interface HostAddInput {
  readonly connection: string;
  readonly label: string;
  readonly metadata: Readonly<Record<string, string>>;
  readonly sourceKey: string;
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
  remove(registrationId: string): Promise<void>;
  client(serverId: string): Promise<RoutedPaseoLike>;
}

/** A setup step failed with a fixed, safe code. Raw upstream text never crosses. */
export class SetupFailure extends Error {
  constructor(readonly code: SafeErrorCode) {
    super(code);
    this.name = "SetupFailure";
  }
}

export interface RegistrationContext {
  readonly hosts: RegistrationHostsLike;
  /** Wait for routed online and Pi readiness; tests shorten it. */
  readonly timeoutMs?: number;
  readonly pollMs?: number;
}

export const DEFAULT_REGISTRATION_TIMEOUT_MS = 120_000;
export const DEFAULT_REGISTRATION_POLL_MS = 500;

export interface SandboxIdentity {
  readonly id: string;
  readonly name: string;
}

export function registrationMetadata(sandbox: SandboxIdentity): Record<string, string> {
  return { source: REGISTRATION_SOURCE, vm: sandbox.id, name: sandbox.name };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
 * Matches only plugin-owned registrations for this sandbox's stable ID. The
 * stable ID appears both as the source key and in metadata.
 */
export function matchingRegistrations(
  parentId: string,
  sandboxId: string,
  registrations: readonly HostRegistrationLike[],
): HostRegistrationLike[] {
  return registrations.filter(
    (registration) =>
      isManagedRegistration(registration) &&
      isRegistrationForParent(registration, parentId) &&
      (registration.source?.key === sandboxId || registration.metadata.vm === sandboxId),
  );
}

/**
 * Registrations owned by this plugin and parent whose sandbox is no longer in
 * the labelled inventory. Foreign labels and unknown owners are never included.
 */
export function staleRegistrations(
  parentId: string,
  liveSandboxIds: ReadonlySet<string>,
  registrations: readonly HostRegistrationLike[],
): HostRegistrationLike[] {
  return registrations.filter((registration) => {
    if (!isManagedRegistration(registration)) return false;
    if (!isRegistrationForParent(registration, parentId)) return false;

    const vm = registration.metadata.vm;
    const name = registration.metadata.name;
    if (typeof vm !== "string" || vm.length === 0) return false;
    if (typeof name !== "string" || !name.startsWith(MANAGED_NAME_PREFIX)) return false;

    return !liveSandboxIds.has(vm);
  });
}

/**
 * Adds a missing registration, waits for routed online, refreshes providers,
 * and confirms Pi. An existing owned registration is reused.
 */
export async function registerSandbox(
  context: RegistrationContext,
  parentId: string,
  sandbox: SandboxIdentity,
  hostPort: number,
): Promise<HostRegistrationLike> {
  const directory = await context.hosts.list().catch(() => {
    throw new SetupFailure("registration_failed");
  });

  const matches = matchingRegistrations(parentId, sandbox.id, directory.hosts);
  if (matches.length > 1) throw new SetupFailure("registration_conflict");

  let registration = matches[0] ?? null;
  if (!registration) {
    try {
      registration = await context.hosts.add({
        connection: `127.0.0.1:${hostPort}`,
        label: registrationLabel(parentId, sandbox.name),
        metadata: registrationMetadata(sandbox),
        sourceKey: sandbox.id,
      });
    } catch {
      throw new SetupFailure("registration_failed");
    }
  }

  const online = await waitForOnline(context, registration.registrationId);
  if (!online.serverId) throw new SetupFailure("registration_failed");

  await confirmPi(context, online.serverId);
  return registration;
}

async function waitForOnline(
  context: RegistrationContext,
  registrationId: string,
): Promise<HostRegistrationLike> {
  const deadline = Date.now() + timeoutMs(context);

  while (Date.now() <= deadline) {
    const directory = await context.hosts.list().catch(() => {
      throw new SetupFailure("registration_failed");
    });
    const entry = directory.hosts.find(
      (candidate) => candidate.registrationId === registrationId,
    );

    if (!entry) throw new SetupFailure("registration_failed");
    if (entry.status === "online" && entry.serverId) return entry;
    if (entry.status === "disabled") throw new SetupFailure("registration_failed");

    await sleep(pollMs(context));
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
      const snapshot = await remote.providers.snapshot().catch(() => null);
      const pi = snapshot?.entries.find((entry) => entry.provider === "pi");
      if (pi?.status === "ready") return;
      await sleep(pollMs(context));
    }

    throw new SetupFailure("provider_unavailable");
  } finally {
    await remote.dispose().catch(() => {});
  }
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

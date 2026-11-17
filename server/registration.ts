import {
  REGISTRATION_PRODUCER_ID,
  REGISTRATION_SOURCE,
} from "../shared/constants";
import type { SafeErrorCode } from "../shared/errors";
import type { IntegrationId } from "../shared/provisioning";
import { abortableSleep, bounded, LifecycleAbortedError } from "./lanes";
import type { PaseoToolsConnector, PaseoToolsHandle } from "./paseo-tools";
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

/** The routed child client slice needed to confirm selected providers. */
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
  /** Host-level integration setup that needs the routed child daemon. */
  readonly paseoTools?: PaseoToolsConnector;
  /** Wait for routed online and Pi readiness; tests shorten it. */
  readonly timeoutMs?: number;
  readonly pollMs?: number;
  /** Bound for one non-job setup call; defaults to a capped registration timeout. */
  readonly sdkCallTimeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface RegistrationSetup {
  /** Selected integrations after provisioning, in canonical order. */
  readonly integrations?: readonly IntegrationId[];
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

/**
 * The one ownership predicate: the parent directory this row came from plus the
 * authenticated producer and exact generation id. Labels and metadata are
 * mutable configuration and never authorize ownership or cleanup.
 */
export function isOwnedRegistration(
  registration: HostRegistrationLike,
  sandboxId: string,
): boolean {
  return (
    registration.source?.id === REGISTRATION_PRODUCER_ID &&
    registration.source?.key === sandboxId
  );
}

export function matchingRegistrations(
  sandboxId: string,
  registrations: readonly HostRegistrationLike[],
): HostRegistrationLike[] {
  return registrations.filter((registration) =>
    isOwnedRegistration(registration, sandboxId),
  );
}

/**
 * Plugin-owned registrations in this parent's directory whose metadata names a
 * managed child. This is the same producer/name predicate the read projection
 * uses, so every listed owned row can be targeted by Repair and recovery.
 * Absence from sandbox inventory is not proof of deletion; callers must confirm
 * with an exact lookup before removing any of these.
 */
export function pluginRegistrations(
  registrations: readonly HostRegistrationLike[],
): HostRegistrationLike[] {
  return registrations.filter((registration) => {
    if (!isManagedRegistration(registration)) return false;
    const name = registration.metadata.name;
    return typeof name === "string" && name.length > 0;
  });
}

/**
 * Ensures exactly one registration for `(producer, handle.id)`. The parent
 * rejects changed inputs with `source_conflict`; a lost-response retry re-lists
 * instead of blindly adding. A user-disabled registration is never re-enabled.
 */
export async function ensureRegistration(
  context: RegistrationContext,
  sandbox: SandboxIdentity,
  hostPort: number,
  providers: readonly string[],
  setup: RegistrationSetup = {},
): Promise<{ readonly registration: HostRegistrationLike; readonly changed: boolean }> {
  const connection = `127.0.0.1:${hostPort}`;
  const desired = {
    connection,
    // The chosen name is the display label; identity is producer + source.key.
    label: sandbox.name,
    metadata: registrationMetadata(sandbox),
  };

  const directory = await listDirectory(context);

  const matches = matchingRegistrations(sandbox.id, directory.hosts);
  if (matches.length > 1) throw new SetupFailure("registration_conflict");

  let registration = matches[0] ?? null;
  let changed = false;

  if (!registration) {
    try {
      registration = await bounded(
        context.hosts.add({
          ...desired,
          sourceKey: sandbox.id,
        }),
        { timeoutMs: timeoutMs(context), signal: context.signal },
      );
      changed = true;
    } catch (error) {
      if (error instanceof LifecycleAbortedError) throw error;
      // A lost response or a concurrent add is recoverable only by re-reading
      // the exact `(producer, source.key)` row.
      const retryDirectory = await listDirectory(context).catch(() => null);
      const retried = retryDirectory
        ? matchingRegistrations(sandbox.id, retryDirectory.hosts)
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
    // Repair never re-enables a registration the user disabled.
    throw new SetupFailure("registration_failed");
  }

  // Connection, label, and metadata drift are repaired through one explicit
  // update. The canonical connection is compared via the parent's own target
  // description rather than a locally remembered port.
  const patch = driftPatch(registration, desired);
  if (patch) {
    try {
      registration = await bounded(
        context.hosts.update(registration.registrationId, patch),
        { timeoutMs: timeoutMs(context), signal: context.signal },
      );
      changed = true;
    } catch (error) {
      if (error instanceof LifecycleAbortedError) throw error;
      throw new SetupFailure("registration_failed");
    }
  }

  const online = await waitForOnline(context, registration.registrationId);
  if (!online.serverId) throw new SetupFailure("registration_failed");

  await confirmProviders(context, online.serverId, providers);
  if (setup.integrations?.includes("paseo-tools")) {
    await ensurePaseoTools(context, connection, providers);
  }
  return { registration: online, changed };
}

async function waitForOnline(
  context: RegistrationContext,
  registrationId: string,
): Promise<HostRegistrationLike> {
  const deadline = Date.now() + timeoutMs(context);

  while (Date.now() <= deadline) {
    context.signal?.throwIfAborted();

    const directory = await listDirectory(context);
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

async function confirmProviders(
  context: RegistrationContext,
  serverId: string,
  providers: readonly string[],
): Promise<void> {
  const selected = providers.length > 0 ? [...new Set(providers)] : ["pi"];
  const remote = await bounded(context.hosts.client(serverId), {
    timeoutMs: timeoutMs(context),
    signal: context.signal,
  }).catch((error: unknown) => {
    if (error instanceof LifecycleAbortedError) throw error;
    throw new SetupFailure("provider_unavailable");
  });

  try {
    const refresh = await bounded(remote.providers.refresh({ providers: selected }), {
      timeoutMs: timeoutMs(context),
      signal: context.signal,
    }).catch((error: unknown) => {
      if (error instanceof LifecycleAbortedError) throw error;
      return null;
    });
    if (!refresh?.acknowledged) throw new SetupFailure("provider_unavailable");

    const deadline = Date.now() + timeoutMs(context);
    while (Date.now() <= deadline) {
      context.signal?.throwIfAborted();
      const snapshot = await bounded(remote.providers.snapshot(), {
        timeoutMs: timeoutMs(context),
        signal: context.signal,
      }).catch((error: unknown) => {
        if (error instanceof LifecycleAbortedError) throw error;
        return null;
      });
      const ready = selected.every((provider) =>
        snapshot?.entries.some(
          (entry) => entry.provider === provider && entry.status === "ready",
        ),
      );
      if (ready) return;
      await sleep(pollMs(context), context.signal);
    }

    throw new SetupFailure("provider_unavailable");
  } finally {
    await bounded(remote.dispose(), {
      timeoutMs: timeoutMs(context),
      signal: context.signal,
    }).catch(() => {});
  }
}

/**
 * The `paseo-tools` integration is host-level: the child daemon is already
 * routed online, so patch its provider tool policy and install the bundled
 * orchestration skills through the same loopback endpoint the parent uses.
 */
async function ensurePaseoTools(
  context: RegistrationContext,
  connection: string,
  providers: readonly string[],
): Promise<void> {
  const connect = context.paseoTools;
  if (!connect) throw new SetupFailure("paseo_tools_failed");

  const callTimeout = context.sdkCallTimeoutMs ?? Math.min(timeoutMs(context), 60_000);
  const deadline = Date.now() + callTimeout;
  const remaining = () => Math.max(1, deadline - Date.now());
  let handle: PaseoToolsHandle | null = null;
  let rawConnecting: Promise<PaseoToolsHandle> | null = null;

  try {
    rawConnecting = startPaseoToolsCall(context, () =>
      connect(connection, { signal: context.signal, timeoutMs: remaining() }),
    );
    const active = await boundPaseoTools(context, rawConnecting, remaining());
    handle = active;
    await boundPaseoTools(
      context,
      startPaseoToolsCall(context, () => active.enableTools(providers)),
      remaining(),
    );
    await boundPaseoTools(
      context,
      startPaseoToolsCall(context, () => active.installSkills()),
      remaining(),
    );
  } finally {
    const active = handle;
    if (active) {
      // Close unconditionally: an aborted lane must still release the socket.
      await bounded(active.close(), { timeoutMs: remaining() }).catch(() => {});
    } else if (rawConnecting) {
      // A connect that resolves after the lane aborted or the call timed out
      // must not leave its client and socket behind.
      void rawConnecting.then((late) => late.close()).catch(() => {});
    }
  }
}

function startPaseoToolsCall<T>(
  context: RegistrationContext,
  operation: () => Promise<T>,
): Promise<T> {
  if (context.signal?.aborted) return Promise.reject(new LifecycleAbortedError());

  try {
    return operation();
  } catch (error) {
    return Promise.reject(toPaseoToolsFailure(error));
  }
}

function boundPaseoTools<T>(
  context: RegistrationContext,
  pending: Promise<T>,
  callTimeout: number,
): Promise<T> {
  return bounded(pending, {
    timeoutMs: callTimeout,
    signal: context.signal,
    timeoutError: () => new SetupFailure("paseo_tools_failed"),
  }).catch((error: unknown) => Promise.reject(toPaseoToolsFailure(error)));
}

function toPaseoToolsFailure(error: unknown): Error {
  if (error instanceof LifecycleAbortedError || error instanceof SetupFailure) return error;
  return new SetupFailure("paseo_tools_failed");
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

function driftPatch(
  registration: HostRegistrationLike,
  desired: {
    readonly connection: string;
    readonly label: string;
    readonly metadata: Readonly<Record<string, string>>;
  },
): HostUpdateInput | null {
  const patch: { connection?: string; label?: string; metadata?: Record<string, string> } = {};
  if (registration.targetDescription !== desired.connection) {
    patch.connection = desired.connection;
  }
  if (registration.label !== desired.label) patch.label = desired.label;
  if (!metadataMatches(registration.metadata, desired.metadata)) {
    patch.metadata = { ...desired.metadata };
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

/**
 * Reads the parent directory with a bound and the lane's abort signal. A hung
 * parent call must not block Delete or plugin teardown behind a lane.
 */
async function listDirectory(context: RegistrationContext): Promise<HostDirectoryLike> {
  try {
    return await bounded(context.hosts.list(), {
      timeoutMs: timeoutMs(context),
      signal: context.signal,
      timeoutError: () => new SetupFailure("registration_failed"),
    });
  } catch (error) {
    if (error instanceof SetupFailure || error instanceof LifecycleAbortedError) throw error;
    throw new SetupFailure("registration_failed");
  }
}

export { listDirectory };

/**
 * Removing a registration is idempotent for this plugin: an error is treated as
 * success only when a fresh directory confirms the registration is gone.
 */
export async function removeRegistration(
  context: RegistrationContext,
  registrationId: string,
): Promise<void> {
  try {
    await bounded(context.hosts.remove(registrationId), {
      timeoutMs: timeoutMs(context),
      signal: context.signal,
    });
    return;
  } catch {
    const directory = await bounded(context.hosts.list(), {
      timeoutMs: timeoutMs(context),
      signal: context.signal,
    }).catch(() => null);
    const stillPresent =
      directory?.hosts.some((entry) => entry.registrationId === registrationId) ?? true;
    if (stillPresent) throw new SetupFailure("registration_failed");
  }
}

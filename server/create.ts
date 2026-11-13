import { sandboxName, type CredentialName } from "../shared/constants";
import type { VmCreateInput, VmCreateResult } from "../shared/contracts";
import { safeError } from "../shared/errors";
import { failureDetail } from "./diagnostics";
import { credentialValues } from "./logs";
import { LifecycleAbortedError, type LifecycleLanes, type LaneToken } from "./lanes";
import type { PendingCreate, PendingCreateStore } from "./pending";
import {
  credentialNamesMatch,
  knownCredentialNames,
  reconcileName,
  type ReconcileContext,
} from "./reconciler";
import { pluginRegistrations, SetupFailure } from "./registration";
import type { SandboxHandleLike, SandboxHost } from "./sandbox";
import { resolveSelectedSecrets, type ResolvedSecret } from "./secrets";
import type { SecretsStore } from "./secrets-store";

export interface CreateContext extends ReconcileContext {
  readonly lanes: LifecycleLanes;
  readonly sandboxHost: SandboxHost;
  readonly secretsStore: SecretsStore;
  readonly pending: PendingCreateStore;
}

export interface CreateAttempt {
  readonly name: string;
  /** Background work. Never rejects; failures land in pending/labels. */
  readonly started: Promise<void>;
}

/**
 * `vm.create`: validates the fixed input, records the selected credential
 * names, starts host-side reconciliation in the per-name lane, and returns the
 * generated name without waiting for the runtime.
 */
export async function createVm(
  context: CreateContext,
  input: VmCreateInput,
): Promise<VmCreateResult> {
  const stored = await context.secretsStore.read();
  if (stored.status !== "ok") {
    throw new Error(safeError("secrets_unavailable").message);
  }

  const attempt = await startCreate(context, input, stored.values);
  void attempt.started.catch(() => {});
  return { name: attempt.name };
}

/**
 * Reuses the request's pending entry or sandbox. Different credential names for
 * the same request are rejected instead of silently keeping the first choice.
 */
export async function startCreate(
  context: CreateContext,
  input: VmCreateInput,
  stored?: ReadonlyMap<CredentialName, string>,
): Promise<CreateAttempt> {
  const storedValues = stored ?? (await readStoredValues(context));
  const { requestId } = input;
  const name = sandboxName(requestId);
  const existing = context.pending.find(requestId);

  if (existing) {
    if (!credentialNamesMatch(existing.credentialNames, input.secretEnvVars)) {
      throw new Error(safeError("invalid_request").message);
    }
    if (existing.phase !== "failed") {
      return { name: existing.name, started: Promise.resolve() };
    }
  }

  const handle = await context.sandboxHost.find(name).catch(() => {
    throw new Error(safeError("runtime_unavailable").message);
  });

  if (handle) {
    rejectDifferentCredentialNames(handle, input.secretEnvVars);
    const entry = context.pending.ensure(requestId, input.secretEnvVars);
    return startBackground(context, entry, {
      allowCreate: false,
      credentials: [],
      redactionValues: credentialValues(context.env, storedValues),
    });
  }

  // A registration-only child means a Delete is still settling. Join that
  // cleanup; the caller's next Create can allocate a new generation.
  const registrationOnly = await hasRegistrationOnly(context, name);
  if (registrationOnly) {
    const entry = context.pending.ensure(requestId, input.secretEnvVars);
    return startBackground(context, entry, {
      allowCreate: false,
      credentials: [],
      redactionValues: credentialValues(context.env, storedValues),
    });
  }

  const resolution = resolveSelectedSecrets(input.secretEnvVars, context.env, storedValues);
  if (resolution.status === "missing") {
    throw new Error(safeError("missing_credentials").message);
  }

  const entry = existing
    ? context.pending.restart(requestId, input.secretEnvVars)
    : context.pending.ensure(requestId, input.secretEnvVars);

  return startBackground(context, entry, {
    allowCreate: true,
    credentials: resolution.secrets,
    redactionValues: credentialValues(context.env, storedValues),
  });
}

async function readStoredValues(
  context: CreateContext,
): Promise<ReadonlyMap<CredentialName, string>> {
  const stored = await context.secretsStore.read();
  if (stored.status !== "ok") {
    throw new Error(safeError("secrets_unavailable").message);
  }
  return stored.values;
}

function startBackground(
  context: CreateContext,
  entry: PendingCreate,
  options: {
    readonly allowCreate: boolean;
    readonly credentials: readonly ResolvedSecret[];
    readonly redactionValues: readonly string[];
  },
): CreateAttempt {
  const started = context.lanes
    .run(entry.name, (token: LaneToken) =>
      reconcileName(
        context,
        {
          name: entry.name,
          allowCreate: options.allowCreate,
          requestId: entry.requestId,
          credentials: options.credentials,
          credentialNames: entry.credentialNames,
          redactionValues: options.redactionValues,
        },
        token,
      ),
    )
    .then(
      () => undefined,
      (error) => {
        if (error instanceof LifecycleAbortedError) return;
        const failure = error instanceof SetupFailure ? error : null;
        context.pending.fail(
          entry.requestId,
          failure?.code ?? "create_failed",
          failure?.detail ?? failureDetail(error, options.redactionValues),
        );
      },
    );

  return { name: entry.name, started };
}

function rejectDifferentCredentialNames(
  handle: SandboxHandleLike,
  requested: readonly CredentialName[],
): void {
  const recorded = knownCredentialNames(handle);
  if (!credentialNamesMatch(recorded, requested)) {
    throw new Error(safeError("invalid_request").message);
  }
}

async function hasRegistrationOnly(context: CreateContext, name: string): Promise<boolean> {
  const directory = await context.hosts.list().catch(() => null);
  if (!directory) return false;
  const parentId = directory.self.serverId;
  if (!parentId) return false;
  return pluginRegistrations(parentId, directory.hosts).some(
    (registration) => registration.metadata.name === name,
  );
}

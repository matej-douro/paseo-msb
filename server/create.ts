import type { VmCreateInput, VmCreateResult } from "../shared/contracts";
import type { CredentialName } from "../shared/constants";
import { PROVISIONING_CREDENTIAL_NAMES } from "../shared/provisioning";
import {
  availableCredentialSet,
  parseProvisionPlan,
  resolveProvisionPlan,
} from "../shared/provisioning";
import { safeError } from "../shared/errors";
import { failureDetail } from "./diagnostics";
import { credentialValues } from "./logs";
import { LifecycleAbortedError, type LifecycleLanes, type LaneToken } from "./lanes";
import type { PendingCreate, PendingCreateStore } from "./pending";
import { createRequestFor } from "./pending";
import { reconcileName, type ReconcileContext } from "./reconciler";
import { SetupFailure } from "./registration";
import type { SandboxHost } from "./sandbox";
import type { SecretsStore } from "./secrets-store";
import { resolveSelectedSecrets, type ResolvedSecret } from "./secrets";

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
 * `vm.create`: returns the name before any external work and leaves one
 * per-name reconciliation running in the background.
 */
export async function createVm(
  context: CreateContext,
  input: VmCreateInput,
): Promise<VmCreateResult> {
  const attempt = startCreate(context, input);
  void attempt.started.catch(() => {});
  return { name: attempt.name };
}

/**
 * Reserves the request without awaiting anything. A repeated request with the
 * same plan, resources, and resources-specified flag joins the running attempt;
 * a failed attempt restarts under the same name; any other reuse of the name
 * is rejected here and only here.
 */
export function startCreate(context: CreateContext, input: VmCreateInput): CreateAttempt {
  if (context.lanes.closed) {
    throw new Error(safeError("runtime_unavailable").message);
  }

  const parsed = parseProvisionPlan(input.plan);
  if (!parsed.ok) {
    throw new Error(safeError("invalid_request").message);
  }

  const reservation = context.pending.reserve(createRequestFor(input, parsed.plan));
  if (reservation.status === "conflict") {
    throw new Error(
      `${safeError("invalid_request").message} A different attempt already uses this name; retry or dismiss it, or choose another name.`,
    );
  }
  if (reservation.status === "joined") {
    return { name: reservation.entry.name, started: Promise.resolve() };
  }

  const entry = reservation.entry;
  let redactionValues: readonly string[] = credentialValues(context.env);
  let taskStarted = false;

  const started = context.lanes
    .run(entry.name, async (token: LaneToken) => {
      taskStarted = true;
      try {
        redactionValues = await createInLane(context, entry, token, (values) => {
          redactionValues = values;
        });
        context.pending.settle(entry.name, entry);
      } catch (error) {
        if (error instanceof LifecycleAbortedError) {
          // A cancelled attempt (Delete or plugin cleanup) leaves no row that a
          // later Create could blindly join.
          context.pending.settle(entry.name, entry);
          throw error;
        }
        const failure = error instanceof SetupFailure ? error : null;
        context.pending.fail(
          entry.name,
          failure?.code ?? "create_failed",
          failure?.detail ?? failureDetail(error, redactionValues),
          entry,
        );
      }
    })
    .catch(() => {
      // The lane rejected before its task ran, so the task's own settlement
      // never happened. Keep the reserved entry from staying pending forever;
      // `entry` guards a newer attempt and a started task is never overwritten.
      if (!taskStarted) context.pending.settle(entry.name, entry);
    });

  return { name: entry.name, started };
}

/** Returns the redaction set so a later failure can be redacted too. */
async function createInLane(
  context: CreateContext,
  entry: PendingCreate,
  token: LaneToken,
  onRedaction: (values: readonly string[]) => void,
): Promise<readonly string[]> {
  token.throwIfAborted();

  // Current values are only needed to redact today's diagnostics and to seed an
  // initial create. Joining an existing generation relies on the persisted plan
  // and its recorded generations, never on values that may since be removed.
  const stored = await context.secretsStore.read();
  const storedValues: ReadonlyMap<CredentialName, string> =
    stored.status === "ok" ? stored.values : new Map();

  const redactionValues = credentialValues(context.env, storedValues);
  onRedaction(redactionValues);

  const resolveCredentials = (): readonly ResolvedSecret[] => {
    if (stored.status !== "ok") throw new SetupFailure("secrets_unavailable");

    const available = availableCredentialSet(
      PROVISIONING_CREDENTIAL_NAMES.filter(
        (name) => storedValues.has(name) || (context.env[name]?.trim().length ?? 0) > 0,
      ),
    );
    const resolution = resolveProvisionPlan(entry.plan, available);
    if (!resolution.ok) {
      throw new SetupFailure(
        resolution.code === "missing_credentials" ? "missing_credentials" : "invalid_request",
      );
    }

    const selected = resolveSelectedSecrets(
      resolution.requiredCredentials,
      context.env,
      storedValues,
    );
    if (selected.status === "missing") throw new SetupFailure("missing_credentials");
    return selected.secrets;
  };

  await reconcileName(
    context,
    {
      name: entry.name,
      allowCreate: true,
      plan: entry.plan,
      resources: entry.resources,
      resourcesSpecified: entry.resourcesSpecified,
      redactionValues,
      resolveCredentials,
    },
    token,
  );

  return redactionValues;
}

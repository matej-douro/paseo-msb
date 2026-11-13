import type { VmCreateInput, VmCreateResult } from "../shared/contracts";
import { safeError } from "../shared/errors";
import { failureDetail } from "./diagnostics";
import { credentialValues } from "./logs";
import { LifecycleAbortedError, type LifecycleLanes, type LaneToken } from "./lanes";
import type { PendingCreate, PendingCreateStore } from "./pending";
import { reconcileName, type ReconcileContext } from "./reconciler";
import { SetupFailure } from "./registration";
import type { SandboxHost } from "./sandbox";
import { resolveSelectedSecrets } from "./secrets";
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
 * `vm.create`: reserves the request synchronously, returns the generated name
 * before any external work, and starts one per-name reconciliation. Store
 * reads, credential resolution, and sandbox lookup all happen inside the lane.
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
 * same credential names joins the running attempt; a failed attempt restarts
 * under the same request ID; different names are rejected here and only here.
 */
export function startCreate(context: CreateContext, input: VmCreateInput): CreateAttempt {
  if (context.lanes.closed) {
    throw new Error(safeError("runtime_unavailable").message);
  }

  const reservation = context.pending.reserve(input.requestId, input.secretEnvVars);
  if (reservation.status === "conflict") {
    throw new Error(safeError("invalid_request").message);
  }
  if (reservation.status === "joined") {
    return { name: reservation.entry.name, started: Promise.resolve() };
  }

  const entry = reservation.entry;
  let redactionValues: readonly string[] = credentialValues(context.env);

  const started = context.lanes
    .run(entry.name, async (token: LaneToken) => {
      try {
        redactionValues = await createInLane(context, entry, token, (values) => {
          redactionValues = values;
        });
        context.pending.settle(entry.requestId, entry);
      } catch (error) {
        if (error instanceof LifecycleAbortedError) {
          // A cancelled attempt (Delete or plugin cleanup) leaves no row that a
          // later Create could blindly join.
          context.pending.settle(entry.requestId, entry);
          throw error;
        }
        const failure = error instanceof SetupFailure ? error : null;
        context.pending.fail(
          entry.requestId,
          failure?.code ?? "create_failed",
          failure?.detail ?? failureDetail(error, redactionValues),
          entry,
        );
      }
    })
    .catch(() => undefined);

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

  const stored = await context.secretsStore.read();
  if (stored.status !== "ok") throw new SetupFailure("secrets_unavailable");

  const redactionValues = credentialValues(context.env, stored.values);
  onRedaction(redactionValues);

  await reconcileName(
    context,
    {
      name: entry.name,
      allowCreate: true,
      credentialNames: entry.credentialNames,
      redactionValues,
      resolveCredentials: () => {
        const resolution = resolveSelectedSecrets(entry.credentialNames, context.env, stored.values);
        if (resolution.status === "missing") throw new SetupFailure("missing_credentials");
        return resolution.secrets;
      },
    },
    token,
  );

  return redactionValues;
}

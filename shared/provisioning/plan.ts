import { z } from "zod";
import {
  CLAUDE_CODE_VERSION,
  GH_VERSION,
  INTEGRATION_CATALOG,
  INTEGRATION_IDS,
  LLM_IDS,
  PI_NEURALWATT_VERSION,
  PROVISIONING_CREDENTIAL_NAMES,
  PROVISIONING_PI_VERSION,
  PROVISIONING_VERSION,
  PROVIDER_CATALOG,
  PROVIDER_IDS,
  type IntegrationId,
  type LlmId,
  type ProviderId,
  type ProvisioningCredential,
  integrationEntry,
  llmEntry,
  providerEntry,
} from "./catalog";

export const ProvisionProviderSelectionSchema = z
  .object({
    provider: z.enum(PROVIDER_IDS),
    llms: z.array(z.enum(LLM_IDS)).min(1),
  })
  .strict();

export const ProvisionPlanSchema = z
  .object({
    providers: z.array(ProvisionProviderSelectionSchema).min(1),
    integrations: z.array(z.enum(INTEGRATION_IDS)),
  })
  .strict()
  .superRefine((value, ctx) => {
    const seenProviders = new Set<ProviderId>();
    for (const selection of value.providers) {
      if (seenProviders.has(selection.provider)) {
        ctx.addIssue({ code: "custom", message: "duplicate provider" });
      }
      seenProviders.add(selection.provider);

      const allowed = new Set(providerEntry(selection.provider).llms.map((llm) => llm.id));
      const seenLlms = new Set<LlmId>();
      for (const llm of selection.llms) {
        if (!allowed.has(llm) || seenLlms.has(llm)) {
          ctx.addIssue({ code: "custom", message: "invalid or duplicate LLM option" });
        }
        seenLlms.add(llm);
      }

      if (selection.provider === "claude" && selection.llms.length !== 1) {
        ctx.addIssue({ code: "custom", message: "Claude requires exactly one auth option" });
      }
    }

    if (new Set(value.integrations).size !== value.integrations.length) {
      ctx.addIssue({ code: "custom", message: "duplicate integration" });
    }
  })
  .transform((value) => canonicalizePlan(value));

/** Shape-only schema for persisting and projecting an already-validated plan. */
export const CanonicalProviderSelectionSchema = z
  .object({
    provider: z.enum(PROVIDER_IDS),
    llms: z.array(z.enum(LLM_IDS)),
  })
  .strict();

export const CanonicalPlanSchema = z
  .object({
    providers: z.array(CanonicalProviderSelectionSchema),
    integrations: z.array(z.enum(INTEGRATION_IDS)),
  })
  .strict();

export type ProvisionPlanInput = z.infer<typeof ProvisionPlanSchema>;

export interface CanonicalProviderSelection {
  readonly provider: ProviderId;
  readonly llms: LlmId[];
}

export interface CanonicalPlan {
  readonly providers: CanonicalProviderSelection[];
  readonly integrations: IntegrationId[];
}

export type PlanResolution =
  | {
      readonly ok: true;
      readonly plan: CanonicalPlan;
      readonly requiredCredentials: readonly ProvisioningCredential[];
    }
  | {
      readonly ok: false;
      readonly code: "invalid_request" | "missing_credentials";
      readonly message: string;
      readonly missing: readonly ProvisioningCredential[];
    };

const INVALID_PLAN = "The provisioning plan is invalid.";
const INVALID_CREDENTIALS = "One or more selected provisioning options are unavailable.";

export type ParsePlanResult =
  | { readonly ok: true; readonly plan: CanonicalPlan }
  | { readonly ok: false; readonly message: string };

/**
 * Validates shape and provider-specific option membership without consulting
 * credentials. This is safe for persisted plans and DTOs.
 */
export function parseProvisionPlan(input: unknown): ParsePlanResult {
  const parsed = ProvisionPlanSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: INVALID_PLAN };

  const seenProviders = new Set<ProviderId>();
  for (const selection of parsed.data.providers) {
    if (seenProviders.has(selection.provider)) return { ok: false, message: INVALID_PLAN };
    seenProviders.add(selection.provider);

    const entry = providerEntry(selection.provider);
    const allowed = new Set(entry.llms.map((llm) => llm.id));
    const seenLlms = new Set<LlmId>();
    for (const llm of selection.llms) {
      if (!allowed.has(llm) || seenLlms.has(llm)) return { ok: false, message: INVALID_PLAN };
      seenLlms.add(llm);
    }

    if (selection.provider === "claude" && selection.llms.length !== 1) {
      return { ok: false, message: INVALID_PLAN };
    }
  }

  if (new Set(parsed.data.integrations).size !== parsed.data.integrations.length) {
    return { ok: false, message: INVALID_PLAN };
  }

  return { ok: true, plan: canonicalizePlan(parsed.data) };
}

/** Legacy sandboxes have no persisted plan and are upgraded as Pi-only. */
export function legacyPiPlan(): CanonicalPlan {
  return { providers: [{ provider: "pi", llms: [] }], integrations: [] };
}

export function plansEqual(left: CanonicalPlan, right: CanonicalPlan): boolean {
  return JSON.stringify(canonicalizePlan(left)) === JSON.stringify(canonicalizePlan(right));
}

/** True when a plan needs exactly the credentials a legacy VM already has. */
export function planMatchesCredentialNames(
  plan: CanonicalPlan,
  names: readonly ProvisioningCredential[],
): boolean {
  const required = requiredCredentialsForPlan(plan);
  if (required.length !== names.length) return false;
  const expected = new Set(required);
  return names.every((name) => expected.has(name));
}

function invalid(message: string): PlanResolution {
  return { ok: false, code: "invalid_request", message, missing: [] };
}

/**
 * Validates shape, provider-specific option membership, and availability.
 * Values are never part of a plan, so this can run in either runtime.
 */
export function resolveProvisionPlan(
  input: unknown,
  available: ReadonlySet<ProvisioningCredential>,
): PlanResolution {
  const parsed = parseProvisionPlan(input);
  if (!parsed.ok) return invalid(parsed.message);

  const required = requiredCredentialsForPlan(parsed.plan);
  const missing = required.filter((name) => !available.has(name));
  if (missing.length > 0) {
    return { ok: false, code: "missing_credentials", message: INVALID_CREDENTIALS, missing };
  }

  return { ok: true, plan: parsed.plan, requiredCredentials: required };
}

/** Stable order makes the plan hash independent of UI selection order. */
export function canonicalizePlan(plan: CanonicalPlan): CanonicalPlan {
  const providerOrder = new Map(PROVIDER_IDS.map((id, index) => [id, index]));
  const providers = plan.providers
    .map((selection) => {
      const entry = providerEntry(selection.provider);
      const llmOrder = new Map(entry.llms.map((llm, index) => [llm.id, index]));
      return {
        provider: selection.provider,
        llms: [...selection.llms].sort(
          (left, right) => (llmOrder.get(left) ?? 0) - (llmOrder.get(right) ?? 0),
        ),
      };
    })
    .sort(
      (left, right) =>
        (providerOrder.get(left.provider) ?? 0) - (providerOrder.get(right.provider) ?? 0),
    );

  const integrationOrder = new Map(INTEGRATION_IDS.map((id, index) => [id, index]));
  const integrations = [...plan.integrations].sort(
    (left, right) => (integrationOrder.get(left) ?? 0) - (integrationOrder.get(right) ?? 0),
  );

  return { providers, integrations };
}

/** Only credentials required by the selected options, never every stored value. */
export function requiredCredentialsForPlan(
  plan: CanonicalPlan,
): readonly ProvisioningCredential[] {
  const required = new Set<ProvisioningCredential>();

  for (const selection of plan.providers) {
    for (const llm of selection.llms) {
      for (const credential of llmEntry(selection.provider, llm).requiredCredentials) {
        required.add(credential);
      }
    }
  }

  for (const integration of plan.integrations) {
    for (const credential of integrationEntry(integration).requiredCredentials) {
      required.add(credential);
    }
  }

  return PROVISIONING_CREDENTIAL_NAMES.filter((name) => required.has(name));
}

export function paseoProviderIds(plan: CanonicalPlan): readonly string[] {
  return plan.providers.map((selection) => providerEntry(selection.provider).paseoProviderId);
}

/**
 * FNV-1a over the canonical plan plus the pin fingerprint. This is an
 * idempotency key, not a security primitive.
 */
export function stableHash(input: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;

  for (let index = 0; index < input.length; index += 1) {
    hash ^= BigInt(input.charCodeAt(index));
    hash = (hash * prime) & mask;
  }

  return hash.toString(16).padStart(16, "0");
}

export function catalogFingerprint(): string {
  return stableHash(
    JSON.stringify({
      version: PROVISIONING_VERSION,
      pins: {
        claude: CLAUDE_CODE_VERSION,
        pi: PROVISIONING_PI_VERSION,
        neuralwatt: PI_NEURALWATT_VERSION,
        gh: GH_VERSION,
      },
      providers: PROVIDER_CATALOG.map((provider) => ({
        id: provider.id,
        steps: provider.steps,
        llms: provider.llms.map((llm) => ({
          id: llm.id,
          requiredCredentials: llm.requiredCredentials,
          steps: llm.steps,
        })),
      })),
      integrations: INTEGRATION_CATALOG.map((integration) => ({
        id: integration.id,
        requiredCredentials: integration.requiredCredentials,
        steps: integration.steps,
      })),
    }),
  );
}

export function planHash(plan: CanonicalPlan): string {
  return stableHash(`${catalogFingerprint()}:${JSON.stringify(canonicalizePlan(plan))}`);
}

export interface LlmAvailability {
  readonly id: LlmId;
  readonly available: boolean;
  readonly missing: readonly ProvisioningCredential[];
}

export interface ProviderAvailability {
  readonly id: ProviderId;
  readonly available: boolean;
  /** Human-readable reason when the provider cannot be added at all. */
  readonly reason: string | null;
  readonly llms: readonly LlmAvailability[];
}

export interface IntegrationAvailability {
  readonly id: IntegrationId;
  readonly available: boolean;
  readonly reason: string | null;
  readonly missing: readonly ProvisioningCredential[];
}

export function availableCredentialSet(
  names: readonly ProvisioningCredential[],
): ReadonlySet<ProvisioningCredential> {
  return new Set(names);
}

function missingCredentials(
  required: readonly ProvisioningCredential[],
  available: ReadonlySet<ProvisioningCredential>,
): ProvisioningCredential[] {
  return required.filter((name) => !available.has(name));
}

function unavailableReason(
  label: string,
  required: readonly ProvisioningCredential[],
): string {
  const names = [...new Set(required)];
  return `Set ${names.join(" or ")} to enable ${label}.`;
}

export function providerAvailability(
  provider: ProviderId,
  available: ReadonlySet<ProvisioningCredential>,
): ProviderAvailability {
  const entry = providerEntry(provider);
  const llms = entry.llms.map((llm) => {
    const missing = missingCredentials(llm.requiredCredentials, available);
    return { id: llm.id, available: missing.length === 0, missing };
  });

  // Pi itself has no required credential; its nested LLM options do.
  if (provider === "pi") {
    return { id: provider, available: true, reason: null, llms };
  }

  const usable = llms.some((llm) => llm.available);
  return {
    id: provider,
    available: usable,
    reason: usable
      ? null
      : unavailableReason(
          entry.label,
          entry.llms.flatMap((llm) => llm.requiredCredentials),
        ),
    llms,
  };
}

export function integrationAvailability(
  integration: IntegrationId,
  available: ReadonlySet<ProvisioningCredential>,
): IntegrationAvailability {
  const entry = integrationEntry(integration);
  const missing = missingCredentials(entry.requiredCredentials, available);
  return {
    id: integration,
    available: missing.length === 0,
    reason:
      missing.length === 0
        ? null
        : unavailableReason(entry.label, entry.requiredCredentials),
    missing,
  };
}

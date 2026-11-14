import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import {
  CREDENTIAL_NAMES,
  ERROR_LABEL,
  MANAGED_LABEL,
  MAX_ERROR_DETAIL_CHARS,
  PARENT_LABEL,
  PHASES,
  PHASE_LABEL,
  PLUGIN_VERSION,
  REGISTRATION_STATUSES,
  RUNTIME_STATUSES,
} from "./constants";
import { SafeErrorSchema, SAFE_ERROR_CODES } from "./errors";
import { ProvisionPlanSchema } from "./provisioning";

const CredentialNameSchema = z.enum(CREDENTIAL_NAMES);
const PhaseSchema = z.enum(PHASES);
const RuntimeStatusSchema = z.enum(RUNTIME_STATUSES);
const RegistrationStatusSchema = z.enum(REGISTRATION_STATUSES);
const SafeErrorCodeSchema = z.enum(SAFE_ERROR_CODES);

const AvailabilitySchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("available") }).strict(),
  z.object({ status: z.literal("unavailable"), error: SafeErrorSchema }).strict(),
]);

const RegistrationSchema = z
  .object({
    registrationId: z.string().min(1),
    status: RegistrationStatusSchema,
    serverId: z.string().min(1).nullable(),
  })
  .strict();

/**
 * The only sandbox labels exposed to clients. Raw microsandbox config,
 * environment, and secret values are never projected into a DTO.
 */
const ManagedLabelsSchema = z
  .object({
    [MANAGED_LABEL]: z.literal(PLUGIN_VERSION),
    [PARENT_LABEL]: z.string().min(1),
    [PHASE_LABEL]: PhaseSchema,
    [ERROR_LABEL]: SafeErrorCodeSchema.optional(),
  })
  .strict();

const PendingChildSchema = z
  .object({
    kind: z.literal("pending"),
    name: z.string().min(1).max(128),
    /** Original identify for an idempotent retry. */
    requestId: z.string().uuid(),
    /** Original provider/integration selection; retries must preserve it. */
    plan: ProvisionPlanSchema,
    phase: PhaseSchema,
    error: SafeErrorSchema.nullable(),
    /** Bounded, redacted reason when the attempt failed. */
    errorDetail: z.string().min(1).max(MAX_ERROR_DETAIL_CHARS).nullable().optional(),
  })
  .strict();

const SandboxChildSchema = z
  .object({
    kind: z.literal("sandbox"),
    name: z.string().min(1).max(128),
    id: z.string().min(1),
    labels: ManagedLabelsSchema,
    runtimeStatus: RuntimeStatusSchema,
    /** Persisted plan; null for pre-provisioning legacy Pi-only children. */
    plan: ProvisionPlanSchema.nullable(),
    registration: RegistrationSchema.nullable(),
    /** Bounded, redacted reason when the child failed. */
    errorDetail: z.string().min(1).max(MAX_ERROR_DETAIL_CHARS).nullable().optional(),
  })
  .strict();

const RegistrationChildSchema = z
  .object({
    kind: z.literal("registration"),
    name: z.string().min(1).max(128),
    /** The generation token from `registration.source.key`. */
    id: z.string().min(1),
    phase: PhaseSchema,
    registration: RegistrationSchema,
    /** Bounded, redacted reason when the child failed. */
    error: SafeErrorSchema.nullable(),
    errorDetail: z.string().min(1).max(MAX_ERROR_DETAIL_CHARS).nullable().optional(),
  })
  .strict();

export const VmChildSchema = z.discriminatedUnion("kind", [
  PendingChildSchema,
  SandboxChildSchema,
  RegistrationChildSchema,
]);

const LogStreamSchema = z.enum(["stdout", "stderr", "output", "system"]);

const LogLineSchema = z
  .object({
    timestamp: z.string(),
    stream: LogStreamSchema,
    text: z.string(),
  })
  .strict();

const LogBundleSchema = z
  .object({
    available: z.boolean(),
    truncated: z.boolean(),
    entries: z.array(LogLineSchema),
  })
  .strict();

export const VmListOutputSchema = z
  .object({
    inventory: AvailabilitySchema,
    registrations: AvailabilitySchema,
    credentials: z.array(CredentialNameSchema),
    storedCredentials: z.array(CredentialNameSchema),
    children: z.array(VmChildSchema),
  })
  .strict();

export const VmDetailInputSchema = z
  .object({
    name: z.string().min(1).max(128),
    /** Optional generation id to disambiguate rows that share a name. */
    id: z.string().min(1).optional(),
  })
  .strict();

export const VmDetailOutputSchema = z
  .object({
    inventory: AvailabilitySchema,
    registrations: AvailabilitySchema,
    child: VmChildSchema.nullable(),
    logs: z
      .object({
        sandbox: LogBundleSchema,
        job: LogBundleSchema,
      })
      .strict(),
  })
  .strict();

export const VmCreateInputSchema = z
  .object({
    requestId: z.string().uuid(),
    plan: ProvisionPlanSchema,
  })
  .strict();

export const VmCreateOutputSchema = z
  .object({
    name: z.string().min(1).max(128),
  })
  .strict();

export const VmDismissInputSchema = z
  .object({
    requestId: z.string().uuid(),
  })
  .strict();

export const VmDismissOutputSchema = z
  .object({
    name: z.string().min(1).max(128),
    dismissed: z.literal(true),
  })
  .strict();

export const VmDeleteInputSchema = z
  .object({
    name: z.string().min(1).max(128),
    id: z.string().min(1),
    confirmName: z.string().min(1).max(128),
  })
  .strict()
  .refine((value) => value.confirmName === value.name, {
    message: "confirmName must match name",
  });

export const VmDeleteOutputSchema = z
  .object({
    name: z.string().min(1).max(128),
    removed: z.literal(true),
  })
  .strict();

export const VmReconcileInputSchema = z
  .object({
    name: z.string().min(1).max(128).optional(),
  })
  .strict();

const ReconcileErrorSchema = z
  .object({
    name: z.string().min(1).max(128),
    error: SafeErrorSchema,
  })
  .strict();

export const VmReconcileOutputSchema = z
  .object({
    repaired: z.array(z.string().min(1).max(128)),
    errors: z.array(ReconcileErrorSchema),
  })
  .strict();

const SecretEntrySchema = z
  .object({
    name: CredentialNameSchema,
    stored: z.boolean(),
    environment: z.boolean(),
  })
  .strict();

export const SecretsListOutputSchema = z
  .object({
    secrets: z.array(SecretEntrySchema),
  })
  .strict();

export const SecretsSetInputSchema = z
  .object({
    name: CredentialNameSchema,
    value: z
      .string()
      .min(1)
      .max(4096)
      .refine((value) => value.trim().length > 0, {
        message: "value must not be blank",
      }),
  })
  .strict();

export const SecretsSetOutputSchema = z
  .object({
    name: CredentialNameSchema,
  })
  .strict();

export const SecretsDeleteInputSchema = z
  .object({
    name: CredentialNameSchema,
  })
  .strict();

export const SecretsDeleteOutputSchema = z
  .object({
    name: CredentialNameSchema,
    removed: z.boolean(),
  })
  .strict();

export const vmListRpc = defineRpc({
  name: "vm.list",
  input: z.object({}).strict().optional(),
  output: VmListOutputSchema,
});

export const vmDetailRpc = defineRpc({
  name: "vm.detail",
  input: VmDetailInputSchema,
  output: VmDetailOutputSchema,
});

export const vmCreateRpc = defineRpc({
  name: "vm.create",
  input: VmCreateInputSchema,
  output: VmCreateOutputSchema,
});

export const vmDismissRpc = defineRpc({
  name: "vm.dismiss",
  input: VmDismissInputSchema,
  output: VmDismissOutputSchema,
});

export const vmDeleteRpc = defineRpc({
  name: "vm.delete",
  input: VmDeleteInputSchema,
  output: VmDeleteOutputSchema,
});

export const vmReconcileRpc = defineRpc({
  name: "vm.reconcile",
  input: VmReconcileInputSchema,
  output: VmReconcileOutputSchema,
});

export const secretsListRpc = defineRpc({
  name: "secrets.list",
  input: z.object({}).strict().optional(),
  output: SecretsListOutputSchema,
});

export const secretsSetRpc = defineRpc({
  name: "secrets.set",
  input: SecretsSetInputSchema,
  output: SecretsSetOutputSchema,
});

export const secretsDeleteRpc = defineRpc({
  name: "secrets.delete",
  input: SecretsDeleteInputSchema,
  output: SecretsDeleteOutputSchema,
});

export type VmListResult = z.infer<typeof VmListOutputSchema>;
export type VmDetailInput = z.infer<typeof VmDetailInputSchema>;
export type VmDetailResult = z.infer<typeof VmDetailOutputSchema>;
export type VmChild = z.infer<typeof VmChildSchema>;
export type RegistrationChild = z.infer<typeof RegistrationChildSchema>;
export type VmCreateInput = z.infer<typeof VmCreateInputSchema>;
export type VmCreateResult = z.infer<typeof VmCreateOutputSchema>;
export type VmDismissInput = z.infer<typeof VmDismissInputSchema>;
export type VmDismissResult = z.infer<typeof VmDismissOutputSchema>;
export type VmDeleteInput = z.infer<typeof VmDeleteInputSchema>;
export type VmDeleteResult = z.infer<typeof VmDeleteOutputSchema>;
export type VmReconcileInput = z.infer<typeof VmReconcileInputSchema>;
export type VmReconcileResult = z.infer<typeof VmReconcileOutputSchema>;
export type SecretsListResult = z.infer<typeof SecretsListOutputSchema>;
export type SecretEntry = z.infer<typeof SecretEntrySchema>;
export type SecretsSetInput = z.infer<typeof SecretsSetInputSchema>;
export type SecretsDeleteInput = z.infer<typeof SecretsDeleteInputSchema>;
export type Availability = z.infer<typeof AvailabilitySchema>;
export type Registration = z.infer<typeof RegistrationSchema>;
export type ManagedLabels = z.infer<typeof ManagedLabelsSchema>;
export type LogLine = z.infer<typeof LogLineSchema>;
export type LogBundle = z.infer<typeof LogBundleSchema>;

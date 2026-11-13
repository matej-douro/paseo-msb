import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import {
  CREDENTIAL_NAMES,
  ERROR_LABEL,
  JOB_LABEL,
  MANAGED_LABEL,
  PARENT_LABEL,
  PHASES,
  PHASE_LABEL,
  PLUGIN_VERSION,
  REGISTRATION_STATUSES,
  RUNTIME_STATUSES,
  SANDBOX_ID_LABEL,
} from "./constants";
import { SafeErrorSchema, SAFE_ERROR_CODES } from "./errors";

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
    [SANDBOX_ID_LABEL]: z.string().min(1),
    [PHASE_LABEL]: PhaseSchema,
    [JOB_LABEL]: z.string().min(1).optional(),
    [ERROR_LABEL]: SafeErrorCodeSchema.optional(),
  })
  .strict();

const PendingChildSchema = z
  .object({
    kind: z.literal("pending"),
    name: z.string().min(1).max(128),
    phase: PhaseSchema,
    error: SafeErrorSchema.nullable(),
  })
  .strict();

const SandboxChildSchema = z
  .object({
    kind: z.literal("sandbox"),
    name: z.string().min(1).max(128),
    id: z.string().min(1),
    labels: ManagedLabelsSchema,
    runtimeStatus: RuntimeStatusSchema,
    registration: RegistrationSchema.nullable(),
  })
  .strict();

export const VmChildSchema = z.discriminatedUnion("kind", [
  PendingChildSchema,
  SandboxChildSchema,
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
    children: z.array(VmChildSchema),
  })
  .strict();

export const VmDetailInputSchema = z
  .object({
    name: z.string().min(1).max(128),
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
    secretEnvVars: z
      .array(CredentialNameSchema)
      .min(1)
      .max(CREDENTIAL_NAMES.length)
      .refine((names) => new Set(names).size === names.length, {
        message: "secretEnvVars must not contain duplicates",
      }),
  })
  .strict();

export const VmCreateOutputSchema = z
  .object({
    name: z.string().min(1).max(128),
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

export type VmListResult = z.infer<typeof VmListOutputSchema>;
export type VmDetailInput = z.infer<typeof VmDetailInputSchema>;
export type VmDetailResult = z.infer<typeof VmDetailOutputSchema>;
export type VmChild = z.infer<typeof VmChildSchema>;
export type VmCreateInput = z.infer<typeof VmCreateInputSchema>;
export type VmCreateResult = z.infer<typeof VmCreateOutputSchema>;
export type VmDeleteInput = z.infer<typeof VmDeleteInputSchema>;
export type VmDeleteResult = z.infer<typeof VmDeleteOutputSchema>;
export type VmReconcileInput = z.infer<typeof VmReconcileInputSchema>;
export type VmReconcileResult = z.infer<typeof VmReconcileOutputSchema>;
export type Availability = z.infer<typeof AvailabilitySchema>;
export type Registration = z.infer<typeof RegistrationSchema>;
export type ManagedLabels = z.infer<typeof ManagedLabelsSchema>;
export type LogLine = z.infer<typeof LogLineSchema>;
export type LogBundle = z.infer<typeof LogBundleSchema>;

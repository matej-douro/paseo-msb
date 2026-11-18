import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import {
  CPUS,
  CPUS_MAX,
  CPUS_MIN,
  CREDENTIAL_NAMES,
  ERROR_LABEL,
  MANAGED_LABEL,
  MAX_ERROR_DETAIL_CHARS,
  MEMORY_MIB,
  MEMORY_MIB_MAX,
  MEMORY_MIB_MIN,
  MEMORY_MIB_STEP,
  PARENT_LABEL,
  PHASES,
  PHASE_LABEL,
  PLUGIN_VERSION,
  REGISTRATION_STATUSES,
  ROOT_DISK_MIB,
  ROOT_DISK_MIB_MAX,
  ROOT_DISK_MIB_MIN,
  ROOT_DISK_MIB_STEP,
  RUNTIME_STATUSES,
} from "./constants";
import { SafeErrorSchema, SAFE_ERROR_CODES } from "./errors";
import { ProvisionPlanSchema } from "./provisioning";

const CredentialNameSchema = z.enum(CREDENTIAL_NAMES);
const PhaseSchema = z.enum(PHASES);
const RuntimeStatusSchema = z.enum(RUNTIME_STATUSES);
const RegistrationStatusSchema = z.enum(REGISTRATION_STATUSES);
const SafeErrorCodeSchema = z.enum(SAFE_ERROR_CODES);

/**
 * The only sandbox-name shape V1.1 accepts: 1–63 lowercase ASCII letters,
 * digits, and internal hyphens, starting and ending with an alphanumeric
 * character. The pinned runtime and parent are both more permissive, so this
 * schema is the enforcement point.
 */
export const VmNameSchema = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/, {
    message: "name must be a lowercase slug of 1-63 characters",
  });

const CpusSchema = z.number().int().min(CPUS_MIN).max(CPUS_MAX);

const MemoryMibSchema = z
  .number()
  .int()
  .min(MEMORY_MIB_MIN)
  .max(MEMORY_MIB_MAX)
  .refine((value) => (value - MEMORY_MIB_MIN) % MEMORY_MIB_STEP === 0, {
    message: `memoryMib must be a multiple of ${MEMORY_MIB_STEP} above ${MEMORY_MIB_MIN}`,
  });

const RootDiskMibSchema = z
  .number()
  .int()
  .min(ROOT_DISK_MIB_MIN)
  .max(ROOT_DISK_MIB_MAX)
  .refine((value) => (value - ROOT_DISK_MIB_MIN) % ROOT_DISK_MIB_STEP === 0, {
    message: `diskMib must be a multiple of ${ROOT_DISK_MIB_STEP} above ${ROOT_DISK_MIB_MIN}`,
  });

/** The optional resource selection accepted by Create. CPU defaults to 2. */
export const ResourceRequestSchema = z
  .object({
    cpus: CpusSchema.optional(),
    memoryMib: MemoryMibSchema,
    diskMib: RootDiskMibSchema,
  })
  .strict();

/** Desired resources: every value is always known. */
export const VmResourcesSchema = z
  .object({
    cpus: CpusSchema,
    memoryMib: MemoryMibSchema,
    diskMib: RootDiskMibSchema,
  })
  .strict();

/**
 * Observed resources. `memoryMib` and `diskMib` are null when the pinned
 * runtime does not report that field; the plugin never invents a missing
 * observation.
 */
export const VmObservedResourcesSchema = z
  .object({
    cpus: CpusSchema,
    memoryMib: z.number().int().min(MEMORY_MIB_MIN).max(MEMORY_MIB_MAX).nullable(),
    diskMib: z.number().int().min(ROOT_DISK_MIB_MIN).max(ROOT_DISK_MIB_MAX).nullable(),
  })
  .strict();

/** Fixed reasons why a metrics snapshot is unavailable. Never raw SDK text. */
export const METRICS_UNAVAILABLE_REASONS = [
  "no_sandbox",
  "not_running",
  "disabled",
  "unavailable",
] as const;

const MetricsUnavailableReasonSchema = z.enum(METRICS_UNAVAILABLE_REASONS);

const ByteCountSchema = z.number().finite().nonnegative();

/** A metrics sample carries only numeric SDK fields and an ISO timestamp. */
export const MetricsSampleSchema = z
  .object({
    timestamp: z.iso.datetime(),
    cpuPercent: z.number().finite().nonnegative().max(100 * CPUS_MAX),
    memoryBytes: ByteCountSchema,
    memoryLimitBytes: ByteCountSchema,
    memoryAvailableBytes: ByteCountSchema.nullable(),
    diskReadBytes: ByteCountSchema,
    diskWriteBytes: ByteCountSchema,
    netRxBytes: ByteCountSchema,
    netTxBytes: ByteCountSchema,
    upperUsedBytes: ByteCountSchema.nullable(),
    upperFreeBytes: ByteCountSchema.nullable(),
    uptimeMs: z.number().finite().nonnegative(),
  })
  .strict();

const MetricsAvailabilitySchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("available"), sample: MetricsSampleSchema }).strict(),
  z
    .object({ status: z.literal("unavailable"), reason: MetricsUnavailableReasonSchema })
    .strict(),
]);

/** Aggregate outcome of a resize. */
export const RESIZE_OUTCOMES = [
  "applied",
  "unchanged",
  "converging",
  "restart_required",
  "resize_failed",
] as const;

const ResizeOutcomeSchema = z.enum(RESIZE_OUTCOMES);

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
    name: VmNameSchema,
    /** Original provider/integration selection; retries must preserve it. */
    plan: ProvisionPlanSchema,
    phase: PhaseSchema,
    error: SafeErrorSchema.nullable(),
    /** Bounded, redacted reason when the attempt failed. */
    errorDetail: z.string().min(1).max(MAX_ERROR_DETAIL_CHARS).nullable().optional(),
    /** Requested resources; a pending row always has a complete value. */
    resources: VmResourcesSchema,
    /** Whether the original Create supplied an explicit resource selection. */
    resourcesSpecified: z.boolean(),
  })
  .strict();

const SandboxChildSchema = z
  .object({
    kind: z.literal("sandbox"),
    name: VmNameSchema,
    id: z.string().min(1),
    labels: ManagedLabelsSchema,
    runtimeStatus: RuntimeStatusSchema,
    /** Persisted plan; null when the sandbox config could not be decoded. */
    plan: ProvisionPlanSchema.nullable(),
    registration: RegistrationSchema.nullable(),
    /** Bounded, redacted reason when the child failed. */
    errorDetail: z.string().min(1).max(MAX_ERROR_DETAIL_CHARS).nullable().optional(),
    /** Resources observed from the sandbox config; null fields are unreported. */
    resources: VmObservedResourcesSchema,
    /** Persisted desired resources when they differ from the observation. */
    requestedResources: VmResourcesSchema.nullable(),
  })
  .strict();

const RegistrationChildSchema = z
  .object({
    kind: z.literal("registration"),
    name: VmNameSchema,
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

/**
 * A pending row has no generation id, so omitting `id` selects it. Supplying
 * `id` selects the exact sandbox or registration-only row.
 */
export const VmDetailInputSchema = z
  .object({
    name: VmNameSchema,
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
    /** Created atomically per name; a repeated name joins or restarts it. */
    name: VmNameSchema,
    plan: ProvisionPlanSchema,
    /** Omitted means the default 4096 MiB RAM and 10240 MiB root disk. */
    resources: ResourceRequestSchema.optional(),
  })
  .strict();

export const VmCreateOutputSchema = z
  .object({
    name: VmNameSchema,
  })
  .strict();

export const VmDismissInputSchema = z
  .object({
    name: VmNameSchema,
  })
  .strict();

export const VmDismissOutputSchema = z
  .object({
    name: VmNameSchema,
    dismissed: z.literal(true),
  })
  .strict();

export const VmDeleteInputSchema = z
  .object({
    name: VmNameSchema,
    id: z.string().min(1),
    confirmName: VmNameSchema,
  })
  .strict()
  .refine((value) => value.confirmName === value.name, {
    message: "confirmName must match name",
  });

export const VmDeleteOutputSchema = z
  .object({
    name: VmNameSchema,
    removed: z.literal(true),
  })
  .strict();

export const VmReconcileInputSchema = z
  .object({
    name: VmNameSchema.optional(),
  })
  .strict();

const ReconcileErrorSchema = z
  .object({
    name: VmNameSchema,
    error: SafeErrorSchema,
  })
  .strict();

export const VmReconcileOutputSchema = z
  .object({
    repaired: z.array(VmNameSchema),
    errors: z.array(ReconcileErrorSchema),
  })
  .strict();

export const VmResizeInputSchema = z
  .object({
    name: VmNameSchema,
    id: z.string().min(1),
    /** RAM target in MiB; grow or shrink within the allowed range. */
    memoryMib: MemoryMibSchema.optional(),
    /** Root-disk target in MiB; growth only, checked against the observation. */
    diskMib: RootDiskMibSchema.optional(),
    /** Use the runtime restart policy after explicit user confirmation. */
    restart: z.boolean().optional(),
  })
  .strict()
  .refine((value) => value.memoryMib !== undefined || value.diskMib !== undefined, {
    message: "at least one of memoryMib or diskMib is required",
  });

export const VmResizeOutputSchema = z
  .object({
    name: VmNameSchema,
    id: z.string().min(1),
    result: ResizeOutcomeSchema,
    /** Observed resources after the attempt. */
    resources: VmObservedResourcesSchema,
    /** Persisted desired resources, or null when none are pending. */
    requestedResources: VmResourcesSchema.nullable(),
  })
  .strict();

export const VmMetricsInputSchema = z
  .object({
    name: VmNameSchema,
    id: z.string().min(1),
  })
  .strict();

export const VmMetricsOutputSchema = MetricsAvailabilitySchema;

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

export const vmResizeRpc = defineRpc({
  name: "vm.resize",
  input: VmResizeInputSchema,
  output: VmResizeOutputSchema,
});

export const vmMetricsRpc = defineRpc({
  name: "vm.metrics",
  input: VmMetricsInputSchema,
  output: VmMetricsOutputSchema,
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
export type VmResizeInput = z.infer<typeof VmResizeInputSchema>;
export type VmResizeResult = z.infer<typeof VmResizeOutputSchema>;
export type VmMetricsInput = z.infer<typeof VmMetricsInputSchema>;
export type VmMetricsResult = z.infer<typeof VmMetricsOutputSchema>;
export type MetricsSample = z.infer<typeof MetricsSampleSchema>;
export type MetricsUnavailableReason = (typeof METRICS_UNAVAILABLE_REASONS)[number];
export type ResizeOutcome = z.infer<typeof ResizeOutcomeSchema>;
export type VmName = z.infer<typeof VmNameSchema>;
export type ResourceRequest = z.infer<typeof ResourceRequestSchema>;
export type VmResources = z.infer<typeof VmResourcesSchema>;
export type VmObservedResources = z.infer<typeof VmObservedResourcesSchema>;
export type SecretsListResult = z.infer<typeof SecretsListOutputSchema>;
export type SecretEntry = z.infer<typeof SecretEntrySchema>;
export type SecretsSetInput = z.infer<typeof SecretsSetInputSchema>;
export type SecretsDeleteInput = z.infer<typeof SecretsDeleteInputSchema>;
export type Availability = z.infer<typeof AvailabilitySchema>;
export type Registration = z.infer<typeof RegistrationSchema>;
export type ManagedLabels = z.infer<typeof ManagedLabelsSchema>;
export type LogLine = z.infer<typeof LogLineSchema>;
export type LogBundle = z.infer<typeof LogBundleSchema>;

/** The desired resources used when a Create omits a resources object. */
export function defaultResources(): VmResources {
  return { cpus: CPUS, memoryMib: MEMORY_MIB, diskMib: ROOT_DISK_MIB };
}

export function resourcesEqual(left: VmResources, right: VmResources): boolean {
  return (
    left.cpus === right.cpus &&
    left.memoryMib === right.memoryMib &&
    left.diskMib === right.diskMib
  );
}

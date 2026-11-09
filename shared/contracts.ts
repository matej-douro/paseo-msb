import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { CREDENTIALS, LOG_ENTRY_LIMIT } from "./constants";

export const SAFE_ERROR_CODES = [
  "parent_unavailable",
  "inventory_unavailable",
  "inventory_partial",
  "sandbox_not_found",
  "sandbox_replaced",
  "config_invalid",
  "logs_unavailable",
  "job_unavailable",
  "sandbox_failed",
  "credentials_missing",
  "credentials_invalid",
  "create_name_conflict",
  "image_pull_failed",
  "sandbox_boot_failed",
  "port_unavailable",
  "label_update_failed",
  "pi_install_failed",
  "pi_install_timeout",
  "pi_path_unverified",
  "create_failed",
  "not_implemented",
] as const;

export type SafeErrorCode = (typeof SAFE_ERROR_CODES)[number];

const SAFE_ERROR_MESSAGES: Record<SafeErrorCode, string> = {
  parent_unavailable: "Parent host registration is unavailable.",
  inventory_unavailable: "Sandbox inventory is unavailable.",
  inventory_partial: "Some sandbox configurations are not readable.",
  sandbox_not_found: "Sandbox not found.",
  sandbox_replaced: "Sandbox identity changed.",
  config_invalid: "Sandbox configuration is not readable.",
  logs_unavailable: "Logs are unavailable.",
  job_unavailable: "Job logs are unavailable.",
  sandbox_failed: "Sandbox setup failed.",
  credentials_missing: "A selected credential is not available.",
  credentials_invalid: "A selected credential is not supported.",
  create_name_conflict: "A sandbox with this name already exists.",
  image_pull_failed: "The fixed image could not be prepared.",
  sandbox_boot_failed: "The sandbox did not boot.",
  port_unavailable: "No loopback port could be published.",
  label_update_failed: "Sandbox progress could not be persisted.",
  pi_install_failed: "Pi installation failed.",
  pi_install_timeout: "Pi installation timed out.",
  pi_path_unverified: "Pi is not available on the daemon user PATH.",
  create_failed: "Child creation failed.",
  not_implemented: "This operation is not implemented yet.",
};

export const SafeErrorSchema = z
  .object({
    code: z.enum(SAFE_ERROR_CODES),
    message: z.string().min(1).max(200),
  })
  .strict();

export type SafeError = z.infer<typeof SafeErrorSchema>;

export function safeError(code: SafeErrorCode): SafeError {
  return { code, message: SAFE_ERROR_MESSAGES[code] };
}

export const ManagedPhaseSchema = z.enum([
  "creating",
  "installing",
  "registering",
  "ready",
  "failed",
]);

export type ManagedPhase = z.infer<typeof ManagedPhaseSchema>;

export const RuntimeStatusSchema = z.enum([
  "created",
  "starting",
  "running",
  "draining",
  "paused",
  "stopped",
  "crashed",
]);

export const RegistrationStatusSchema = z.enum([
  "online",
  "offline",
  "connecting",
  "error",
  "disabled",
]);

export const ManagedLabelsSchema = z
  .object({
    "paseo-msb": z.literal("v1"),
    "paseo-msb-parent": z.string().min(1).max(128),
    "paseo-msb-id": z.string().min(1).max(128),
    "paseo-msb-phase": ManagedPhaseSchema.optional(),
    "paseo-msb-job": z.string().min(1).max(128).optional(),
    "paseo-msb-error": z.string().min(1).max(64).optional(),
  })
  .strict();

export type ManagedLabels = z.infer<typeof ManagedLabelsSchema>;

export const CredentialNameSchema = z.enum(
  CREDENTIALS.map((entry) => entry.env) as [
    (typeof CREDENTIALS)[number]["env"],
    ...(typeof CREDENTIALS)[number]["env"][],
  ],
);

export type CredentialName = z.infer<typeof CredentialNameSchema>;

export const ParentSchema = z
  .object({
    serverId: z.string().min(1).max(128),
    label: z.string().min(1).max(256),
  })
  .strict();

export type Parent = z.infer<typeof ParentSchema>;

export const RegistrationSchema = z
  .object({
    registrationId: z.string().min(1).max(256),
    serverId: z.string().min(1).max(128).nullable(),
    label: z.string().min(1).max(256).nullable(),
    status: RegistrationStatusSchema,
    sourceKey: z.string().min(1).max(128),
  })
  .strict();

export type Registration = z.infer<typeof RegistrationSchema>;

export const PendingChildSchema = z
  .object({
    requestId: z.string().uuid(),
    name: z.string().min(1).max(128),
    phase: ManagedPhaseSchema,
    error: SafeErrorSchema.nullable(),
  })
  .strict();

export type PendingChild = z.infer<typeof PendingChildSchema>;

export const ChildSchema = z
  .object({
    id: z.string().min(1).max(128),
    name: z.string().min(1).max(128),
    labels: ManagedLabelsSchema.nullable(),
    runtimeStatus: RuntimeStatusSchema,
    registration: RegistrationSchema.nullable(),
    error: SafeErrorSchema.nullable(),
  })
  .strict();

export type Child = z.infer<typeof ChildSchema>;

export const InventoryStateSchema = z
  .object({
    status: z.enum(["available", "partial", "unavailable"]),
    error: SafeErrorSchema.nullable(),
  })
  .strict();

export type InventoryState = z.infer<typeof InventoryStateSchema>;

export const VmListOutputSchema = z
  .object({
    parent: ParentSchema.nullable(),
    pending: z.array(PendingChildSchema),
    children: z.array(ChildSchema),
    credentials: z.array(CredentialNameSchema),
    inventory: InventoryStateSchema,
    registrations: InventoryStateSchema,
  })
  .strict();

export const VmDetailInputSchema = z
  .object({
    name: z.string().min(1).max(128),
    id: z.string().min(1).max(128).optional(),
  })
  .strict();

export const LogEntrySchema = z
  .object({
    source: z.enum(["sandbox", "job"]),
    stream: z.enum(["stdout", "stderr", "output", "system"]),
    timestamp: z.string().nullable(),
    text: z.string().min(1),
  })
  .strict();

export const LogBatchSchema = z
  .object({
    status: z.enum(["available", "partial", "unavailable"]),
    entries: z.array(LogEntrySchema).max(LOG_ENTRY_LIMIT),
    error: SafeErrorSchema.nullable(),
  })
  .strict();

export const VmDetailOutputSchema = z
  .object({
    pending: PendingChildSchema.nullable(),
    child: ChildSchema.nullable(),
    logs: LogBatchSchema,
    inventory: InventoryStateSchema,
    registrations: InventoryStateSchema,
    error: SafeErrorSchema.nullable(),
  })
  .strict();

export const VmCreateInputSchema = z
  .object({
    requestId: z.string().uuid(),
    secretEnvVars: z.array(CredentialNameSchema).min(1).max(CREDENTIALS.length),
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
    id: z.string().min(1).max(128),
    confirmName: z.string().min(1).max(128),
  })
  .strict();

export const VmDeleteOutputSchema = z
  .object({
    name: z.string().min(1).max(128),
    id: z.string().min(1).max(128),
  })
  .strict();

export const VmReconcileInputSchema = z
  .object({
    name: z.string().min(1).max(128),
    id: z.string().min(1).max(128),
  })
  .strict();

export const VmReconcileOutputSchema = z
  .object({
    name: z.string().min(1).max(128),
    id: z.string().min(1).max(128),
    phase: ManagedPhaseSchema,
  })
  .strict();

export const vmList = defineRpc({
  name: "vm.list",
  input: z.object({}).strict(),
  output: VmListOutputSchema,
});

export const vmDetail = defineRpc({
  name: "vm.detail",
  input: VmDetailInputSchema,
  output: VmDetailOutputSchema,
});

export const vmCreate = defineRpc({
  name: "vm.create",
  input: VmCreateInputSchema,
  output: VmCreateOutputSchema,
});

export const vmDelete = defineRpc({
  name: "vm.delete",
  input: VmDeleteInputSchema,
  output: VmDeleteOutputSchema,
});

export const vmReconcile = defineRpc({
  name: "vm.reconcile",
  input: VmReconcileInputSchema,
  output: VmReconcileOutputSchema,
});

export const VM_RPCS = [vmList, vmDetail, vmCreate, vmDelete, vmReconcile] as const;

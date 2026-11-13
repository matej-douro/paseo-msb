import { z } from "zod";
import { MAX_ERROR_DETAIL_CHARS } from "../constants";

export const PROVISION_STEP_STATUSES = ["ok", "skipped", "failed"] as const;

export const ProvisionStepStatusSchema = z
  .object({
    id: z.string().min(1).max(128),
    status: z.enum(PROVISION_STEP_STATUSES),
    exitCode: z.number().int().nullable(),
  })
  .strict();

export const ProvisionStatusSchema = z
  .object({
    planHash: z.string().min(1).max(64),
    ok: z.boolean(),
    steps: z.array(ProvisionStepStatusSchema),
    failedStep: z.string().min(1).max(128).nullable(),
    error: z.string().min(1).max(MAX_ERROR_DETAIL_CHARS).nullable(),
  })
  .strict();

export type ProvisionStepStatus = z.infer<typeof ProvisionStepStatusSchema>;
export type ProvisionStatus = z.infer<typeof ProvisionStatusSchema>;

/** Invalid or partially written status is unknown, never success. */
export function parseProvisionStatus(value: unknown): ProvisionStatus | null {
  const parsed = ProvisionStatusSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function isProvisionSuccess(
  status: ProvisionStatus,
  planHash: string,
): boolean {
  return (
    status.ok &&
    status.planHash === planHash &&
    status.failedStep === null &&
    status.steps.every((step) => step.status !== "failed")
  );
}

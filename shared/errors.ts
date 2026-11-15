import { z } from "zod";
import { MAX_ERROR_DETAIL_CHARS } from "./constants";

/**
 * Every error that crosses the RPC boundary uses one of these fixed codes
 * and messages. Raw SDK, parent, and guest error text never crosses.
 */
export const SAFE_ERROR_CODES = [
  "invalid_request",
  "invalid_config",
  "id_mismatch",
  "inventory_unavailable",
  "registrations_unavailable",
  "logs_unavailable",
  "not_found",
  "not_implemented",
  "missing_credentials",
  "runtime_unavailable",
  "name_conflict",
  "create_failed",
  "mutation_pending",
  "resize_failed",
  "port_unavailable",
  "install_failed",
  "install_pending",
  "install_conflict",
  "provision_failed",
  "provision_pending",
  "provision_conflict",
  "job_inventory_unavailable",
  "path_unverified",
  "registration_conflict",
  "registration_failed",
  "registration_timeout",
  "provider_unavailable",
  "delete_failed",
  "secrets_unavailable",
] as const;

export type SafeErrorCode = (typeof SAFE_ERROR_CODES)[number];

export const SAFE_ERROR_MESSAGES: Record<SafeErrorCode, string> = {
  invalid_request: "The request is invalid.",
  invalid_config: "The sandbox configuration is not a valid managed child.",
  id_mismatch: "The sandbox identity does not match its managed label.",
  inventory_unavailable: "Microsandbox inventory is unavailable.",
  registrations_unavailable: "Parent host registrations are unavailable.",
  logs_unavailable: "Logs are unavailable.",
  not_found: "The child was not found.",
  not_implemented: "This operation is not available yet.",
  missing_credentials: "One or more selected credentials are unavailable.",
  runtime_unavailable: "The parent runtime is unavailable.",
  name_conflict: "A sandbox with this name already exists.",
  create_failed: "The sandbox could not be created.",
  mutation_pending: "A previous sandbox change is still settling. Try again shortly.",
  resize_failed: "The sandbox resources could not be changed.",
  port_unavailable: "No loopback port could be published.",
  install_failed: "Pi installation failed.",
  install_pending: "Pi installation is still running or could not be confirmed.",
  install_conflict: "Multiple Pi installations are active in the child.",
  provision_failed: "Provisioning the selected providers or integrations failed.",
  provision_pending: "Provisioning is still running or could not be confirmed.",
  provision_conflict: "Multiple provisioning jobs are active in the child.",
  job_inventory_unavailable: "Detached job inventory is unavailable.",
  path_unverified: "Pi is not available on the child PATH.",
  registration_conflict: "Multiple parent registrations match this child.",
  registration_failed: "The parent registration could not be updated.",
  registration_timeout: "The child did not become reachable.",
  provider_unavailable: "Pi is not ready in the child.",
  delete_failed: "The sandbox could not be destroyed.",
  secrets_unavailable: "The plugin credential store is unavailable.",
};

export const SafeErrorSchema = z
  .object({
    code: z.enum(SAFE_ERROR_CODES),
    message: z.string().max(200),
    /** Bounded, redacted diagnostic text for the user. Never a raw secret. */
    detail: z.string().min(1).max(MAX_ERROR_DETAIL_CHARS).optional(),
  })
  .strict();

export type SafeError = z.infer<typeof SafeErrorSchema>;

export function safeError(code: SafeErrorCode, detail?: string | null): SafeError {
  return {
    code,
    message: SAFE_ERROR_MESSAGES[code],
    ...(detail ? { detail } : {}),
  };
}

export function isSafeErrorCode(value: string): value is SafeErrorCode {
  return (SAFE_ERROR_CODES as readonly string[]).includes(value);
}

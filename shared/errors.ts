import { z } from "zod";

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
};

export const SafeErrorSchema = z
  .object({
    code: z.enum(SAFE_ERROR_CODES),
    message: z.string().max(200),
  })
  .strict();

export type SafeError = z.infer<typeof SafeErrorSchema>;

export function safeError(code: SafeErrorCode): SafeError {
  return { code, message: SAFE_ERROR_MESSAGES[code] };
}

export function isSafeErrorCode(value: string): value is SafeErrorCode {
  return (SAFE_ERROR_CODES as readonly string[]).includes(value);
}

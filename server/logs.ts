import {
  CREDENTIALS,
  LOG_ENTRY_LIMIT,
  LOG_TEXT_LIMIT,
  LOG_TOTAL_LIMIT,
} from "../shared/constants";
import {
  LogBatchSchema,
  safeError,
  type SafeErrorCode,
} from "../shared/contracts";
import type { RawLogEntry, RawLogs } from "./sandbox";

function secretValues(env: NodeJS.ProcessEnv): string[] {
  return CREDENTIALS.flatMap(({ env: name }) => {
    const value = env[name];
    return typeof value === "string" && value.length > 0 ? [value] : [];
  });
}

export function redactLogText(text: string, secrets: readonly string[]): string {
  let redacted = text;
  for (const secret of secrets) {
    redacted = redacted.split(secret).join("[redacted]");
  }
  redacted = redacted.replace(/\$MSB_[A-Z0-9_]+/g, "[redacted]");
  redacted = redacted.replace(
    /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi,
    "$1 [redacted]",
  );
  redacted = redacted.replace(
    /\b(api[-_]?key|access[-_]?token|token|secret|password|authorization)\b(\s*[:=]\s*)[^\s]+/gi,
    "$1$2[redacted]",
  );
  return redacted;
}

function normalizeStream(stream: string): "stdout" | "stderr" | "output" | "system" {
  if (stream === "stdout" || stream === "stderr" || stream === "system") return stream;
  return "output";
}

export function projectLogs(raw: RawLogs, env: NodeJS.ProcessEnv) {
  const secrets = secretValues(env);
  const entries: Array<{
    source: "sandbox" | "job";
    stream: "stdout" | "stderr" | "output" | "system";
    timestamp: string | null;
    text: string;
  }> = [];
  let total = 0;

  const allEntries: RawLogEntry[] = [...raw.sandbox, ...raw.job];
  for (const entry of allEntries) {
    if (entries.length >= LOG_ENTRY_LIMIT || total >= LOG_TOTAL_LIMIT) break;

    const text = redactLogText(entry.text, secrets).trim();
    if (!text) continue;

    const remaining = LOG_TOTAL_LIMIT - total;
    const limit = Math.min(LOG_TEXT_LIMIT, remaining);
    const bounded = text.length > limit ? text.slice(0, limit) : text;
    if (!bounded) continue;

    entries.push({
      source: entry.origin,
      stream: normalizeStream(entry.stream),
      timestamp: entry.timestamp,
      text: bounded,
    });
    total += bounded.length;
  }

  return LogBatchSchema.parse({
    status: raw.jobUnavailable ? "partial" : "available",
    entries,
    error: raw.jobUnavailable ? safeError("job_unavailable") : null,
  });
}

export function logsUnavailable(code: SafeErrorCode) {
  return LogBatchSchema.parse({
    status: "unavailable",
    entries: [],
    error: safeError(code),
  });
}

export function logsAvailable() {
  return LogBatchSchema.parse({
    status: "available",
    entries: [],
    error: null,
  });
}

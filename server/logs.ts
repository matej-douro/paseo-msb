import {
  CREDENTIAL_NAMES,
  MAX_LOG_ENTRIES,
  MAX_LOG_LINE_BYTES,
  MAX_LOG_TOTAL_BYTES,
  type CredentialName,
} from "../shared/constants";
import type { LogBundle, LogLine } from "../shared/contracts";

type LogStream = LogLine["stream"];

const LOG_STREAMS = new Set<string>(["stdout", "stderr", "output", "system"]);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function normalizeStream(value: string): LogStream {
  return LOG_STREAMS.has(value) ? (value as LogStream) : "system";
}

function iso(value: Date | number): string {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
}

function byteLength(text: string): number {
  return encoder.encode(text).byteLength;
}

function truncateToBytes(text: string): { text: string; truncated: boolean } {
  if (byteLength(text) <= MAX_LOG_LINE_BYTES) return { text, truncated: false };
  return {
    text: decoder.decode(encoder.encode(text).subarray(0, MAX_LOG_LINE_BYTES)),
    truncated: true,
  };
}

/**
 * Replaces every fixed credential value present in the parent environment or
 * the plugin store. Stored values win for create, but both are redacted.
 */
export function credentialValues(
  env: Readonly<Record<string, string | undefined>>,
  stored: ReadonlyMap<CredentialName, string> = new Map(),
): string[] {
  const values = new Set<string>();

  for (const name of CREDENTIAL_NAMES) {
    const environment = env[name];
    if (typeof environment === "string" && environment.length > 0) values.add(environment);
    const pluginValue = stored.get(name);
    if (typeof pluginValue === "string" && pluginValue.length > 0) values.add(pluginValue);
  }

  return [...values].sort((left, right) => right.length - left.length);
}

export function redact(text: string, secrets: readonly string[]): string {
  let output = text;
  for (const secret of secrets) {
    if (secret.length > 0) output = output.split(secret).join("[redacted]");
  }
  return output;
}

export function unavailableLogBundle(): LogBundle {
  return { available: false, truncated: false, entries: [] };
}

/**
 * Keeps the newest bounded lines, redacts secret values, and caps both each
 * line and the whole bundle. Never returns raw upstream error text.
 */
export function boundLogLines(lines: readonly LogLine[], secrets: readonly string[]): LogBundle {
  let truncated = lines.length > MAX_LOG_ENTRIES;
  const recent = truncated ? lines.slice(-MAX_LOG_ENTRIES) : lines;

  const kept: LogLine[] = [];
  let totalBytes = 0;

  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const line = recent[index];
    const redacted = redact(line.text, secrets);
    const bounded = truncateToBytes(redacted);
    if (bounded.truncated) truncated = true;

    const bytes = byteLength(bounded.text);
    if (kept.length > 0 && totalBytes + bytes > MAX_LOG_TOTAL_BYTES) {
      truncated = true;
      break;
    }

    kept.push({ ...line, text: bounded.text });
    totalBytes += bytes;
  }

  kept.reverse();
  return { available: true, truncated, entries: kept };
}

export async function readSandboxLogs(
  handle: {
    logs(options: {
      tail?: number;
      sources?: readonly string[];
    }): Promise<
      readonly {
        readonly timestamp: Date | number;
        readonly source: string;
        text(): string;
      }[]
    >;
  },
  secrets: readonly string[],
): Promise<LogBundle> {
  try {
    const entries = await handle.logs({
      tail: MAX_LOG_ENTRIES,
      sources: ["stdout", "stderr", "output"],
    });

    const lines: LogLine[] = entries.map((entry) => {
      let text: string;
      try {
        text = entry.text();
      } catch {
        text = "[unreadable]";
      }
      return {
        timestamp: iso(entry.timestamp),
        stream: normalizeStream(entry.source),
        text,
      };
    });

    return boundLogLines(lines, secrets);
  } catch {
    return unavailableLogBundle();
  }
}

export async function readJobLogs(
  handle: {
    getJob(id: string): Promise<{
      logs(options: { tail?: number }): Promise<
        readonly {
          readonly timestamp: number;
          readonly source: string;
          readonly data: Uint8Array;
        }[]
      >;
    }>;
  },
  jobId: string,
  secrets: readonly string[],
): Promise<LogBundle> {
  try {
    const job = await handle.getJob(jobId);
    const entries = await job.logs({ tail: MAX_LOG_ENTRIES });
    const lines: LogLine[] = entries.map((entry) => {
      let text: string;
      try {
        text = decoder.decode(entry.data);
      } catch {
        text = "[unreadable]";
      }
      return {
        timestamp: iso(entry.timestamp),
        stream: normalizeStream(entry.source),
        text,
      };
    });
    return boundLogLines(lines, secrets);
  } catch {
    return unavailableLogBundle();
  }
}

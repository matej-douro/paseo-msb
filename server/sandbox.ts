import {
  Sandbox,
  SandboxNotFoundError,
  type JobLogEntry,
  type SandboxHandle,
  type SandboxStatus,
} from "microsandbox";
import { z } from "zod";
import {
  LABELS,
  LOG_SOURCE_LIMIT,
  MANAGED_LABEL_KEYS,
} from "../shared/constants";
import { ManagedLabelsSchema, type ManagedLabels } from "../shared/contracts";

const sandboxConfigSchema = z
  .object({
    labels: z.record(z.string(), z.string()).optional(),
  })
  .loose();

export interface ManagedSandbox {
  readonly id: string;
  readonly name: string;
  readonly runtimeStatus: SandboxStatus;
  readonly labels: ManagedLabels;
}

export interface RawLogEntry {
  readonly origin: "sandbox" | "job";
  readonly stream: string;
  readonly timestamp: string | null;
  readonly text: string;
}

export interface RawLogs {
  readonly sandbox: readonly RawLogEntry[];
  readonly job: readonly RawLogEntry[];
  readonly jobUnavailable: boolean;
}

export type ManagedSandboxLookup =
  | { readonly status: "found"; readonly sandbox: ManagedSandbox }
  | { readonly status: "not_found" }
  | { readonly status: "invalid" };

export interface SandboxInventory {
  listManaged(parentServerId: string): Promise<readonly ManagedSandbox[]>;
  getManaged(name: string, parentServerId: string): Promise<ManagedSandboxLookup>;
  readLogs(sandbox: ManagedSandbox): Promise<RawLogs>;
}

export function decodeManagedLabels(
  config: unknown,
  expectedId: string,
  expectedParent?: string,
): ManagedLabels | null {
  const parsedConfig = sandboxConfigSchema.safeParse(config);
  if (!parsedConfig.success) return null;

  const sourceLabels = parsedConfig.data.labels;
  if (!sourceLabels) return null;

  const candidate: Record<string, string> = {};
  for (const key of MANAGED_LABEL_KEYS) {
    const value = sourceLabels[key];
    if (value !== undefined) candidate[key] = value;
  }

  const parsedLabels = ManagedLabelsSchema.safeParse(candidate);
  if (!parsedLabels.success) return null;
  if (parsedLabels.data[LABELS.id] !== expectedId) return null;
  if (expectedParent && parsedLabels.data[LABELS.parent] !== expectedParent) return null;
  return parsedLabels.data;
}

function decodeHandle(
  handle: SandboxHandle,
  parentServerId: string,
): ManagedSandbox | null {
  try {
    const labels = decodeManagedLabels(handle.config(), handle.id, parentServerId);
    if (!labels) return null;
    return {
      id: handle.id,
      name: handle.name,
      runtimeStatus: handle.status,
      labels,
    };
  } catch {
    return null;
  }
}

function sandboxLogEntry(entry: {
  source: string;
  timestamp: Date;
  text(): string;
}): RawLogEntry {
  return {
    origin: "sandbox",
    stream: entry.source,
    timestamp: entry.timestamp.toISOString(),
    text: entry.text(),
  };
}

function jobLogEntry(entry: JobLogEntry): RawLogEntry {
  return {
    origin: "job",
    stream: entry.source,
    timestamp: new Date(entry.timestamp).toISOString(),
    text: entry.data.toString("utf8"),
  };
}

async function getManagedHandle(name: string): Promise<SandboxHandle | null> {
  try {
    return await Sandbox.get(name);
  } catch (error) {
    if (error instanceof SandboxNotFoundError) return null;
    throw error;
  }
}

export function createSandboxInventory(): SandboxInventory {
  return {
    async listManaged(parentServerId) {
      const sandboxes: ManagedSandbox[] = [];
      let cursor: string | undefined;

      do {
        const page = await Sandbox.listWith((list) => {
          const filtered = list
            .limit(100)
            .labels({
              [LABELS.managed]: LABELS.version,
              [LABELS.parent]: parentServerId,
            });
          return cursor ? filtered.cursor(cursor) : filtered;
        });

        for (const handle of page.sandboxes) {
          const sandbox = decodeHandle(handle, parentServerId);
          if (sandbox) sandboxes.push(sandbox);
        }
        cursor = page.nextCursor;
      } while (cursor);

      return sandboxes;
    },

    async getManaged(name, parentServerId) {
      const handle = await getManagedHandle(name);
      if (!handle) return { status: "not_found" };

      const sandbox = decodeHandle(handle, parentServerId);
      if (!sandbox) return { status: "invalid" };
      return { status: "found", sandbox };
    },

    async readLogs(sandbox) {
      const handle = await getManagedHandle(sandbox.name);
      if (!handle || handle.id !== sandbox.id) {
        throw new Error("sandbox identity changed");
      }

      const sandboxEntries = await handle.logs({
        tail: LOG_SOURCE_LIMIT,
        sources: ["stdout", "stderr", "output"],
      });
      const sandboxLogs = sandboxEntries.map(sandboxLogEntry);

      let jobLogs: RawLogEntry[] = [];
      let jobUnavailable = false;
      const jobId = sandbox.labels[LABELS.job];
      if (jobId) {
        try {
          const job = await handle.getJob(jobId);
          const entries = await job.logs({
            tail: LOG_SOURCE_LIMIT,
            sources: ["stdout", "stderr"],
          });
          jobLogs = entries.map(jobLogEntry);
        } catch {
          jobUnavailable = true;
        }
      }

      return { sandbox: sandboxLogs, job: jobLogs, jobUnavailable };
    },
  };
}

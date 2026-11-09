import {
  NetworkPolicy,
  Sandbox,
  SandboxNotFoundError,
  resolveRuntime,
  type JobLogEntry,
  type JobState,
  type SandboxHandle,
  type SandboxStatus,
} from "microsandbox";
import { execFileSync } from "node:child_process";
import net from "node:net";
import { z } from "zod";
import {
  CHILD,
  FIXED_RESOURCES,
  GUEST_PATH,
  IMAGE,
  INIT,
  LABELS,
  LOG_SOURCE_LIMIT,
  MANAGED_LABEL_KEYS,
} from "../shared/constants";
import {
  ManagedLabelsSchema,
  type ManagedLabels,
  type ManagedPhase,
} from "../shared/contracts";
import type { HeaderSecretBinding } from "./secrets";

const sandboxConfigSchema = z
  .object({
    labels: z.record(z.string(), z.string()).optional(),
  })
  .loose();

export interface ManagedSandbox {
  readonly id: string;
  readonly name: string;
  readonly runtimeStatus: SandboxStatus;
  readonly labels: ManagedLabels | null;
}

export interface ManagedSandboxList {
  readonly sandboxes: readonly ManagedSandbox[];
  readonly degraded: number;
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
  | { readonly status: "not_found" };

export interface CreateSandboxOptions {
  readonly name: string;
  readonly parentServerId: string;
  readonly hostPort: number;
  readonly labels: Readonly<Record<string, string>>;
  readonly secrets: readonly HeaderSecretBinding[];
}

export interface ExecOptions {
  readonly args?: readonly string[];
  readonly user?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
  readonly timeoutMs?: number;
}

export interface ExecResult {
  readonly success: boolean;
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface DetachedJobInfo {
  readonly state: JobState;
  readonly exitCode: number | null;
}

export interface DetachedJob {
  readonly id: string;
  inspect(): Promise<DetachedJobInfo>;
}

export interface CreatedSandbox {
  readonly id: string;
  readonly name: string;
  config(): Promise<unknown>;
  discoverPort(guestPort: number): Promise<PublishedPort | null>;
  modify(options: { readonly labels?: Readonly<Record<string, string>> }): Promise<void>;
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;
  execDetached(command: string, options?: ExecOptions): Promise<DetachedJob>;
  destroy(): Promise<void>;
}

export interface SandboxRuntime {
  create(options: CreateSandboxOptions): Promise<CreatedSandbox>;
  probeLoopbackPort(): Promise<number>;
}

export interface PublishedPort {
  readonly hostPort: number;
  readonly guestPort: number;
  readonly hostBind: string | null;
}

export function managedCreateLabels(
  parentServerId: string,
  phase: ManagedPhase,
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> {
  return {
    [LABELS.managed]: LABELS.version,
    [LABELS.parent]: parentServerId,
    [LABELS.phase]: phase,
    ...extra,
  };
}

export function buildSandboxBuilder(options: CreateSandboxOptions) {
  let builder = Sandbox.builder(options.name)
    .image(IMAGE.ref)
    .cpus(FIXED_RESOURCES.cpus)
    .memory(FIXED_RESOURCES.memoryMiB)
    .detached(true)
    .workdir("/workspace")
    .env("PATH", GUEST_PATH)
    .env("PASEO_LISTEN", CHILD.listen)
    .labels({ ...options.labels })
    .init(INIT.fallback.cmd, [...INIT.fallback.args])
    .portBind("127.0.0.1", options.hostPort, FIXED_RESOURCES.guestPort)
    .network((network) =>
      network.policy(NetworkPolicy.fromProfiles(["public"])),
    );

  for (const secret of options.secrets) {
    builder = builder.secret((configure) => {
      let next = configure
        .env(secret.env)
        .value(secret.value)
        .requireTlsIdentity(true)
        .substituteInHeaders(true)
        .substituteInQuery(false)
        .substituteInBody(false);
      for (const host of secret.hosts) {
        next = next.allow(host);
      }
      return next;
    });
  }

  return builder;
}

interface ExecBuilder {
  args(values: string[]): ExecBuilder;
  user(value: string): ExecBuilder;
  envs(values: Record<string, string>): ExecBuilder;
  cwd(value: string): ExecBuilder;
  timeout(ms: number): ExecBuilder;
}

function configureExec<T extends ExecBuilder>(
  builder: T,
  options: ExecOptions | undefined,
): T {
  let next: T = builder;
  if (options?.args) next = next.args([...options.args]) as T;
  if (options?.user) next = next.user(options.user) as T;
  if (options?.env) next = next.envs({ ...options.env }) as T;
  if (options?.cwd) next = next.cwd(options.cwd) as T;
  if (options?.timeoutMs) next = next.timeout(options.timeoutMs) as T;
  return next;
}

function discoverPortFromRuntime(name: string, guestPort: number): PublishedPort | null {
  try {
    const runtime = resolveRuntime();
    const raw = execFileSync(
      runtime.msbPath,
      ["sandbox", "inspect", name, "--format", "json"],
      { encoding: "utf8", timeout: 30_000, maxBuffer: 32 * 1024 * 1024 },
    );
    return findPublishedPort(JSON.parse(raw), guestPort);
  } catch {
    return null;
  }
}

function wrapSandbox(sandbox: Sandbox): CreatedSandbox {
  return {
    id: sandbox.id,
    name: sandbox.name,
    config: () => sandbox.config(),
    async discoverPort(guestPort) {
      const fromConfig = findPublishedPort(await sandbox.config(), guestPort);
      return fromConfig ?? discoverPortFromRuntime(sandbox.name, guestPort);
    },
    async modify(options) {
      if (!options.labels) return;
      await sandbox.modify({
        labels: { ...options.labels },
        policy: "no_restart",
      });
    },
    async exec(command, options) {
      const output = await sandbox.execWith(command, (builder) =>
        configureExec(builder, options),
      );
      return {
        success: output.success,
        code: output.code,
        stdout: output.stdout(),
        stderr: output.stderr(),
      };
    },
    async execDetached(command, options) {
      const job = await sandbox.execDetachedWith(command, (builder) =>
        configureExec(builder, options),
      );
      return {
        id: job.id,
        async inspect() {
          const info = await job.inspect();
          return { state: info.state, exitCode: info.exitCode };
        },
      };
    },
    destroy: () => sandbox.destroy(),
  };
}

export function createMicrosandboxRuntime(): SandboxRuntime {
  return {
    async create(options) {
      return wrapSandbox(await buildSandboxBuilder(options).create());
    },
    probeLoopbackPort,
  };
}

export function findPublishedPort(
  value: unknown,
  guestPort: number,
): PublishedPort | null {
  if (!value || typeof value !== "object") return null;

  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findPublishedPort(entry, guestPort);
      if (found) return found;
    }
    return null;
  }

  const record = value as Record<string, unknown>;
  if (
    record.guestPort === guestPort &&
    typeof record.hostPort === "number" &&
    record.hostPort > 0
  ) {
    return {
      hostPort: record.hostPort,
      guestPort,
      hostBind: typeof record.hostBind === "string" ? record.hostBind : null,
    };
  }

  for (const entry of Object.values(record)) {
    const found = findPublishedPort(entry, guestPort);
    if (found) return found;
  }
  return null;
}

export function probeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("loopback port probe failed")));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

export interface SandboxInventory {
  listManaged(parentServerId: string): Promise<ManagedSandboxList>;
  getManaged(name: string, parentServerId: string): Promise<ManagedSandboxLookup>;
  readLogs(sandbox: ManagedSandbox): Promise<RawLogs>;
}

export interface SandboxHandleView {
  readonly id: string;
  readonly name: string;
  readonly status: SandboxStatus;
  config(): unknown;
}

export type DecodedSandboxHandle =
  | { readonly status: "managed"; readonly sandbox: ManagedSandbox }
  | { readonly status: "degraded"; readonly sandbox: ManagedSandbox }
  | { readonly status: "foreign" };

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

export function decodeSandboxHandle(
  handle: SandboxHandleView,
  parentServerId: string,
  options: { readonly assumeManaged?: boolean } = {},
): DecodedSandboxHandle {
  let config: unknown;
  try {
    config = handle.config();
  } catch {
    if (!options.assumeManaged) return { status: "foreign" };
    return {
      status: "degraded",
      sandbox: {
        id: handle.id,
        name: handle.name,
        runtimeStatus: handle.status,
        labels: null,
      },
    };
  }

  const labels = decodeManagedLabels(config, handle.id, parentServerId);
  if (labels) {
    return {
      status: "managed",
      sandbox: {
        id: handle.id,
        name: handle.name,
        runtimeStatus: handle.status,
        labels,
      },
    };
  }

  if (!options.assumeManaged) return { status: "foreign" };

  return {
    status: "degraded",
    sandbox: {
      id: handle.id,
      name: handle.name,
      runtimeStatus: handle.status,
      labels: null,
    },
  };
}

export function lookupManagedSandbox(
  handle: SandboxHandleView | null,
  parentServerId: string,
): ManagedSandboxLookup {
  if (!handle) return { status: "not_found" };

  const decoded = decodeSandboxHandle(handle, parentServerId);
  if (decoded.status !== "managed") return { status: "not_found" };
  return { status: "found", sandbox: decoded.sandbox };
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
      let degraded = 0;
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
          const decoded = decodeSandboxHandle(handle, parentServerId, {
            assumeManaged: true,
          });
          if (decoded.status === "foreign") continue;
          sandboxes.push(decoded.sandbox);
          if (decoded.status === "degraded") degraded += 1;
        }
        cursor = page.nextCursor;
      } while (cursor);

      return { sandboxes, degraded };
    },

    async getManaged(name, parentServerId) {
      return lookupManagedSandbox(await getManagedHandle(name), parentServerId);
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
      const jobId = sandbox.labels?.[LABELS.job];
      if (jobId) {
        try {
          const job = await handle.getJob(jobId);
          const entries = await job.logs({
            tail: LOG_SOURCE_LIMIT,
            sources: ["stdout", "stderr", "output"],
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

import {
  ERROR_LABEL,
  JOB_LABEL,
  MANAGED_LABEL,
  PARENT_LABEL,
  PHASE_LABEL,
  PI_PREFIX,
  PI_VERSION,
  PLUGIN_VERSION,
  REGISTRATION_SOURCE,
  SANDBOX_ID_LABEL,
  type Phase,
} from "../../shared/constants";
import type {
  ExecSpec,
  SandboxCreateHandleLike,
  SandboxCreateRequest,
  SandboxCreator,
  SandboxHandleLike,
  SandboxJobHandleLike,
  SandboxJobLike,
  SandboxLogEntryLike,
  SandboxRuntime,
} from "../../server/sandbox";
import type {
  HostDirectoryLike,
  HostRegistrationLike,
  ParentHostsLike,
} from "../../server/status";

export const PARENT_ID = "srv_parent";
export const SECRET_VALUE = "fake-anthropic-secret-value-123";

export interface ManagedLabelOptions {
  id: string;
  parentId?: string;
  phase?: Phase;
  job?: string;
  error?: string;
}

export function managedLabels(options: ManagedLabelOptions): Record<string, string> {
  return {
    [MANAGED_LABEL]: PLUGIN_VERSION,
    [PARENT_LABEL]: options.parentId ?? PARENT_ID,
    [SANDBOX_ID_LABEL]: options.id,
    [PHASE_LABEL]: options.phase ?? "ready",
    ...(options.job ? { [JOB_LABEL]: options.job } : {}),
    ...(options.error ? { [ERROR_LABEL]: options.error } : {}),
  };
}

export interface FakeSandboxOptions {
  id: string;
  name: string;
  status?: string;
  phase?: Phase;
  job?: string;
  error?: string;
  parentId?: string;
  labels?: Record<string, string>;
  extraLabels?: Record<string, string>;
  configExtras?: Record<string, unknown>;
  rawConfig?: unknown;
  logs?: readonly SandboxLogEntryLike[];
  jobLogs?: readonly { timestamp: number; source: string; data: Uint8Array }[];
}

export function fakeSandbox(options: FakeSandboxOptions): SandboxHandleLike {
  const labels = {
    ...managedLabels({
      id: options.id,
      parentId: options.parentId,
      phase: options.phase,
      job: options.job,
      error: options.error,
    }),
    ...(options.extraLabels ?? {}),
    ...(options.labels ?? {}),
  };

  const config = {
    image: "ghcr.io/getpaseo/paseo:0.15.4",
    env: [{ name: "ANTHROPIC_API_KEY", value: SECRET_VALUE }],
    network: {
      secrets: {
        secrets: [
          {
            envVar: "ANTHROPIC_API_KEY",
            value: SECRET_VALUE,
            allowedHosts: ["api.anthropic.com"],
            substitution: { headers: true, query: false, body: false },
          },
        ],
      },
    },
    labels,
    ...(options.configExtras ?? {}),
  };

  return {
    id: options.id,
    name: options.name,
    status: options.status ?? "running",
    config: () => (options.rawConfig !== undefined ? options.rawConfig : config),
    logs: async (readOptions) => {
      const tail = readOptions.tail ?? options.logs?.length ?? 0;
      return (options.logs ?? []).slice(-tail);
    },
    getJob: async (): Promise<SandboxJobLike> => ({
      logs: async (readOptions) => {
        const tail = readOptions.tail ?? options.jobLogs?.length ?? 0;
        return (options.jobLogs ?? []).slice(-tail);
      },
    }),
  };
}

export function fakeRuntime(handles: readonly SandboxHandleLike[]): SandboxRuntime {
  return {
    list: async () => handles,
  };
}

export function failingRuntime(): SandboxRuntime {
  return {
    list: async () => {
      throw new Error("inventory backend unavailable: leaked detail");
    },
  };
}

export function fakeRegistration(overrides: Partial<HostRegistrationLike> = {}): HostRegistrationLike {
  return {
    registrationId: "reg_1",
    serverId: "srv_child",
    status: "online",
    source: { id: "plugin", key: "sandbox_1" },
    metadata: {
      source: REGISTRATION_SOURCE,
      vm: "sandbox_1",
      name: "paseo-1",
    },
    ...overrides,
  };
}

export function fakeHostDirectory(
  hosts: readonly HostRegistrationLike[],
  parentId = PARENT_ID,
): HostDirectoryLike {
  return { self: { serverId: parentId }, hosts };
}

export function fakeHosts(directory = fakeHostDirectory([])): ParentHostsLike {
  return { list: async () => directory };
}

export function failingHosts(): ParentHostsLike {
  return {
    list: async () => {
      throw new Error("parent directory unavailable: leaked detail");
    },
  };
}

export interface FakeCreatorOptions {
  existing?: SandboxHandleLike | null;
  findError?: Error;
  /** Consumed one per create attempt before the SDK failure path. */
  createFailures?: readonly Error[];
  /** Delays the resolved create, for observing an in-flight attempt. */
  createGate?: Promise<void>;
  sandboxId?: string;
  jobId?: string;
  jobExitCode?: number;
  jobState?: string;
  /** Overrides the job wait, for observing an in-flight install. */
  jobWait?: () => Promise<{ readonly code: number }>;
  execOutput?: string;
  execError?: Error;
  execDetachedError?: Error;
  modifyError?: Error;
  hostPorts?: readonly number[];
  probeError?: Error;
}

/**
 * Recording fake for the create runner. It captures the exact create request,
 * label updates, and guest command specs so tests can assert the contract
 * without the microsandbox runtime.
 */
export class FakeSandboxCreator implements SandboxCreator {
  readonly requests: SandboxCreateRequest[] = [];
  readonly labelUpdates: Record<string, string>[] = [];
  readonly execSpecs: ExecSpec[] = [];
  createCount = 0;
  probeCount = 0;

  private readonly failures: Error[];

  constructor(private readonly options: FakeCreatorOptions = {}) {
    this.failures = [...(options.createFailures ?? [])];
  }

  async find(_name: string): Promise<SandboxHandleLike | null> {
    if (this.options.findError) throw this.options.findError;
    return this.options.existing ?? null;
  }

  async probePort(): Promise<number> {
    if (this.options.probeError) throw this.options.probeError;
    const port = this.options.hostPorts?.[this.probeCount] ?? 41_000 + this.probeCount;
    this.probeCount += 1;
    return port;
  }

  async create(request: SandboxCreateRequest): Promise<SandboxCreateHandleLike> {
    this.createCount += 1;
    this.requests.push(request);

    const failure = this.failures.shift();
    if (failure) throw failure;

    if (this.options.createGate) await this.options.createGate;

    const options = this.options;
    const job: SandboxJobHandleLike = {
      id: options.jobId ?? "job_1",
      wait: options.jobWait ?? (async () => ({ code: options.jobExitCode ?? 0 })),
      inspect: async () => ({ state: options.jobState ?? "exited" }),
    };

    return {
      id: options.sandboxId ?? "sandbox_1",
      name: request.name,
      modify: async (update) => {
        if (options.modifyError) throw options.modifyError;
        this.labelUpdates.push({ ...update.labels });
      },
      execDetached: async (spec: ExecSpec) => {
        this.execSpecs.push(spec);
        if (options.execDetachedError) throw options.execDetachedError;
        return job;
      },
      exec: async (spec: ExecSpec) => {
        this.execSpecs.push(spec);
        if (options.execError) throw options.execError;
        return options.execOutput ?? `${PI_PREFIX}/bin/pi\n${PI_VERSION}\n`;
      },
    };
  }
}

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
  SandboxHandleLike,
  SandboxHost,
  SandboxJobHandleLike,
  SandboxJobLike,
  SandboxLogEntryLike,
  SandboxResumeHandleLike,
  SandboxRuntime,
} from "../../server/sandbox";
import type {
  HostAddInput,
  RegistrationHostsLike,
  RoutedPaseoLike,
} from "../../server/registration";
import type {
  HostDirectoryLike,
  HostRegistrationLike,
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
  hostPort?: number;
  logs?: readonly SandboxLogEntryLike[];
  jobLogs?: readonly { timestamp: number; source: string; data: Uint8Array }[];
  labelUpdates?: Record<string, string>[];
  modifyError?: Error;
  getJobError?: Error;
  jobState?: string;
  jobExitCode?: number;
  jobStateAfterWait?: string;
  jobWaitCode?: number;
  jobWaitError?: Error;
  jobInspectError?: Error;
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
      ports: [
        {
          hostPort: options.hostPort ?? 41_000,
          guestPort: 6767,
          protocol: "tcp",
          hostBind: "127.0.0.1",
        },
      ],
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
    modify: async (update) => {
      if (options.modifyError) throw options.modifyError;
      options.labelUpdates?.push({ ...update.labels });
    },
    logs: async (readOptions) => {
      const tail = readOptions.tail ?? options.logs?.length ?? 0;
      return (options.logs ?? []).slice(-tail);
    },
    getJob: async (): Promise<SandboxJobLike> => {
      if (options.getJobError) throw options.getJobError;

      let state = options.jobState ?? "exited";
      return {
        inspect: async () => {
          if (options.jobInspectError) throw options.jobInspectError;
          return { state, exitCode: options.jobExitCode ?? 0 };
        },
        wait: async () => {
          if (options.jobWaitError) throw options.jobWaitError;
          state = options.jobStateAfterWait ?? "exited";
          return { code: options.jobWaitCode ?? 0 };
        },
        logs: async (readOptions) => {
          const tail = readOptions.tail ?? options.jobLogs?.length ?? 0;
          return (options.jobLogs ?? []).slice(-tail);
        },
      };
    },
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
  const metadata =
    overrides.metadata ?? {
      source: REGISTRATION_SOURCE,
      vm: "sandbox_1",
      name: "paseo-1",
    };

  return {
    registrationId: "reg_1",
    serverId: "srv_child",
    status: "online",
    label: `${PARENT_ID}/${metadata.name}`,
    source: { id: "plugin", key: metadata.vm },
    metadata,
    ...overrides,
  };
}

export function fakeHostDirectory(
  hosts: readonly HostRegistrationLike[],
  parentId = PARENT_ID,
): HostDirectoryLike {
  return { self: { serverId: parentId }, hosts };
}

export interface FakePaseoHostsOptions {
  directory?: HostDirectoryLike;
  listError?: Error;
  addError?: Error;
  removeError?: Error;
  onlineImmediately?: boolean;
  clientError?: Error;
  refreshError?: Error;
  refreshAcknowledged?: boolean;
  snapshotError?: Error;
  providerStatus?: string;
  providerMissing?: boolean;
}

/** Recording parent host API with a routed client for provider checks. */
export class FakePaseoHosts implements RegistrationHostsLike {
  directory: HostDirectoryLike;
  readonly added: HostAddInput[] = [];
  readonly removed: string[] = [];
  readonly clients: string[] = [];
  disposed = 0;

  private readonly options: FakePaseoHostsOptions;

  constructor(options: FakePaseoHostsOptions = {}) {
    this.options = options;
    this.directory = options.directory ?? fakeHostDirectory([]);
  }

  async list(): Promise<HostDirectoryLike> {
    if (this.options.listError) throw this.options.listError;
    return this.directory;
  }

  async add(input: HostAddInput): Promise<HostRegistrationLike> {
    if (this.options.addError) throw this.options.addError;
    this.added.push(input);

    const online = this.options.onlineImmediately ?? true;
    const registration: HostRegistrationLike = {
      registrationId: `reg_${this.added.length}`,
      serverId: online ? "srv_child" : null,
      status: online ? "online" : "connecting",
      label: input.label,
      source: { id: "plugin", key: input.sourceKey },
      metadata: input.metadata,
    };

    this.directory = { ...this.directory, hosts: [...this.directory.hosts, registration] };
    return registration;
  }

  async remove(registrationId: string): Promise<void> {
    if (this.options.removeError) throw this.options.removeError;
    this.removed.push(registrationId);
    this.directory = {
      ...this.directory,
      hosts: this.directory.hosts.filter((entry) => entry.registrationId !== registrationId),
    };
  }

  async client(serverId: string): Promise<RoutedPaseoLike> {
    this.clients.push(serverId);
    if (this.options.clientError) throw this.options.clientError;

    const entries = this.options.providerMissing
      ? []
      : [{ provider: "pi", status: this.options.providerStatus ?? "ready" }];

    return {
      providers: {
        refresh: async () => {
          if (this.options.refreshError) throw this.options.refreshError;
          return { acknowledged: this.options.refreshAcknowledged ?? true };
        },
        snapshot: async () => {
          if (this.options.snapshotError) throw this.options.snapshotError;
          return { entries };
        },
      },
      dispose: async () => {
        this.disposed += 1;
      },
    };
  }
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
  resumeError?: Error;
  destroyError?: Error;
  hostPorts?: readonly number[];
  probeError?: Error;
}

/**
 * Recording fake for the create and recovery runners. It captures the exact
 * create request, label updates, and guest command specs so tests can assert
 * the contract without the microsandbox runtime.
 */
export class FakeSandboxCreator implements SandboxHost {
  readonly requests: SandboxCreateRequest[] = [];
  readonly labelUpdates: Record<string, string>[] = [];
  readonly execSpecs: ExecSpec[] = [];
  readonly destroyed: string[] = [];
  createCount = 0;
  probeCount = 0;
  resumeCount = 0;

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

    const job: SandboxJobHandleLike = {
      id: this.options.jobId ?? "job_1",
      wait: this.options.jobWait ?? (async () => ({ code: this.options.jobExitCode ?? 0 })),
      inspect: async () => ({
        state: this.options.jobState ?? "exited",
        exitCode: this.options.jobExitCode ?? 0,
      }),
    };

    return {
      id: this.options.sandboxId ?? "sandbox_1",
      name: request.name,
      modify: (update) => this.modify(update.labels),
      execDetached: async (spec: ExecSpec) => {
        this.execSpecs.push(spec);
        if (this.options.execDetachedError) throw this.options.execDetachedError;
        return job;
      },
      exec: (spec) => this.exec(spec),
    };
  }

  async resume(_name: string): Promise<SandboxResumeHandleLike> {
    this.resumeCount += 1;
    if (this.options.resumeError) throw this.options.resumeError;
    return {
      modify: (update) => this.modify(update.labels),
      exec: (spec) => this.exec(spec),
    };
  }

  async destroy(handle: SandboxHandleLike): Promise<void> {
    if (this.options.destroyError) throw this.options.destroyError;
    this.destroyed.push(handle.id);
  }

  private async modify(labels: Readonly<Record<string, string>>): Promise<void> {
    if (this.options.modifyError) throw this.options.modifyError;
    this.labelUpdates.push({ ...labels });
  }

  private async exec(spec: ExecSpec): Promise<string> {
    this.execSpecs.push(spec);
    if (this.options.execError) throw this.options.execError;
    return this.options.execOutput ?? `${PI_PREFIX}/bin/pi\n${PI_VERSION}\n`;
  }
}

import {
  CPUS,
  ERROR_LABEL,
  MANAGED_LABEL,
  MEMORY_MIB,
  PARENT_LABEL,
  PHASE_LABEL,
  PI_PREFIX,
  PLAN_ENV_VAR,
  PLUGIN_VERSION,
  REGISTRATION_PRODUCER_ID,
  REGISTRATION_SOURCE,
  RESOURCES_ENV_VAR,
  RESOURCES_SPECIFIED_ENV_VAR,
  ROOT_DISK_MIB,
  type CredentialName,
  type Phase,
} from "../../shared/constants";
import type {
  ExecSpec,
  SandboxConnectHandleLike,
  SandboxCreateHandleLike,
  SandboxCreateRequest,
  SandboxHandleLike,
  SandboxHost,
  SandboxJobHandleLike,
  SandboxJobInfoLike,
  SandboxJobLike,
  SandboxJobListBuilderLike,
  SandboxLogEntryLike,
  SandboxMetricsLike,
  SandboxModificationPlanLike,
  SandboxModifyOptionsLike,
  SandboxRuntime,
} from "../../server/sandbox";
import type {
  HostAddInput,
  HostUpdateInput,
  RegistrationHostsLike,
  RoutedPaseoLike,
} from "../../server/registration";
import type { PaseoToolsHandle } from "../../server/paseo-tools";
import type {
  HostDirectoryLike,
  HostRegistrationLike,
} from "../../server/status";
import type { SecretsStore } from "../../server/secrets-store";
import type { CanonicalPlan, ProvisionStatus } from "../../shared/provisioning";

export const PARENT_ID = "srv_parent";
export const SECRET_VALUE = "fake-anthropic-secret-value-123";

/** In-memory store for create and RPC tests; never touches the filesystem. */
export function memorySecretsStore(
  initial: Partial<Record<CredentialName, string>> = {},
): SecretsStore {
  const values = new Map<CredentialName, string>();
  for (const [name, value] of Object.entries(initial)) {
    if (typeof value === "string") values.set(name as CredentialName, value);
  }

  return {
    filePath: "/memory/paseo-msb/secrets.json",
    async read() {
      return { status: "ok", values: new Map(values) };
    },
    async set(name, value) {
      values.set(name, value);
    },
    async delete(name) {
      return values.delete(name);
    },
  };
}

export function unavailableSecretsStore(): SecretsStore {
  return {
    filePath: "/memory/paseo-msb/secrets.json",
    async read() {
      return { status: "unavailable", values: new Map() };
    },
    async set() {
      throw new Error("secrets unavailable");
    },
    async delete() {
      throw new Error("secrets unavailable");
    },
  };
}

export interface ManagedLabelOptions {
  id?: string;
  parentId?: string;
  phase?: Phase;
  error?: string;
}

/** New managed labels never include a stable ID or job label. */
export function managedLabels(options: ManagedLabelOptions = {}): Record<string, string> {
  return {
    [MANAGED_LABEL]: PLUGIN_VERSION,
    [PARENT_LABEL]: options.parentId ?? PARENT_ID,
    [PHASE_LABEL]: options.phase ?? "ready",
    ...(options.error ? { [ERROR_LABEL]: options.error } : {}),
  };
}

export interface FakeJobOptions {
  id: string;
  command?: readonly string[];
  state?: string;
  exitCode?: number | null;
  timedOut?: boolean;
  createdAt?: number;
  failure?: { kind: string; message: string } | null;
}

export interface FakeSandboxOptions {
  id: string;
  name: string;
  status?: string;
  phase?: Phase;
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
  /** Holds every `modify()` until released, for settlement tests. */
  modifyGate?: Promise<void>;
  /** Every `modify()` call, in order. */
  modifyCalls?: SandboxModifyOptionsLike[];
  /** Apply resource/env changes to the fake config. Defaults to true. */
  modifyApplies?: boolean;
  /** Overrides the plan returned by `modify()`; changes still apply. */
  modifyPlan?: (options: SandboxModifyOptionsLike) => unknown;
  /** One metrics sample; defaults to a minimal idle snapshot. */
  metrics?: SandboxMetricsLike;
  metricsError?: Error;
  /** Holds every `metrics()` call until released. */
  metricsGate?: Promise<void>;
  /** Counts native `metrics()` invocations. */
  metricsCalls?: number[];
  refreshError?: Error;
  connectError?: Error;
  execError?: Error;
  execCode?: number;
  execOutput?: string;
  /** Return codes for successive VM setup skill probes; the last repeats. */
  skillProbeCodes?: readonly number[];
  /** Return code for the VM setup skill write action. */
  skillActionCode?: number;
  /** Records every exec made over the connect handle. */
  connectExecs?: ExecSpec[];
  /** Whether the guest answers the Pi readiness probe. Defaults to a ready
   * or registering phase. */
  piInstalled?: boolean;
  jobs?: FakeJobOptions[];
  listJobsError?: Error;
  jobStateAfterWait?: string;
  jobWaitCode?: number;
  jobWaitError?: Error;
  jobInspectError?: Error;
  getJobError?: Error;
  /** Persisted provisioning plan for decode and provisioning tests. */
  plan?: CanonicalPlan;
  /** Desired resources written to the environment. */
  requestedResources?: { cpus: number; memoryMib: number; diskMib: number };
  resourcesSpecified?: boolean;
  /** Pre-existing provision status, for resume tests. */
  provisionStatus?: ProvisionStatus | null;
}

/** Canonical plan recorded when a test does not supply one. */
export const DEFAULT_PLAN: CanonicalPlan = {
  providers: [{ provider: "pi", llms: ["neuralwatt"] }],
  integrations: [],
};

/**
 * Complete managed env entries for `rawConfig` tests. Later entries override
 * the defaults, and a test that models a partial write passes its own array
 * instead.
 */
export function managedEnv(
  entries: readonly { name?: string; key?: string; value: string }[] = [],
): { name?: string; key?: string; value: string }[] {
  return [
    { name: "PATH", value: "/home/paseo/.local/bin:/usr/local/bin:/usr/bin:/bin" },
    { name: PLAN_ENV_VAR, value: JSON.stringify(DEFAULT_PLAN) },
    {
      name: RESOURCES_ENV_VAR,
      value: JSON.stringify({ cpus: CPUS, memoryMib: MEMORY_MIB, diskMib: ROOT_DISK_MIB }),
    },
    { name: RESOURCES_SPECIFIED_ENV_VAR, value: "0" },
    ...entries,
  ];
}

const DEFAULT_METRICS: SandboxMetricsLike = {
  cpuPercent: 0,
  memoryBytes: 0,
  memoryLimitBytes: 4_096 * 1_024 * 1_024,
  memoryAvailableBytes: null,
  diskReadBytes: 0,
  diskWriteBytes: 0,
  netRxBytes: 0,
  netTxBytes: 0,
  upperUsedBytes: null,
  upperFreeBytes: null,
  uptimeMs: 0,
  timestamp: new Date(0),
};

const provisionStatusSetters = new WeakMap<
  SandboxHandleLike,
  (status: ProvisionStatus | null) => void
>();

function jobList(options: FakeSandboxOptions): FakeJobOptions[] {
  return options.jobs ?? [];
}

/** Applies a modify call to the fake config so a refresh observes it. */
function applyModify(config: Record<string, unknown>, update: SandboxModifyOptionsLike): void {
  const resources = config.resources as Record<string, unknown> | undefined;
  if (resources) {
    if (update.memory !== undefined) resources.memoryMib = update.memory;
    if (update.maxMemory !== undefined) resources.maxMemoryMib = update.maxMemory;
  }

  if (update.rootDiskSize !== undefined) {
    const image = config.image as { Oci?: { rootDisk?: Record<string, unknown> } } | undefined;
    const rootDisk = image?.Oci?.rootDisk;
    if (rootDisk) rootDisk.sizeMib = update.rootDiskSize;
  }

  if (!update.env) return;
  const env = config.env;
  if (!Array.isArray(env)) return;

  for (const [name, value] of Object.entries(update.env)) {
    const entry = env.find((candidate) => {
      const item = candidate as { name?: string; key?: string };
      return (item.name ?? item.key) === name;
    }) as { name?: string; value?: unknown } | undefined;
    if (entry) entry.value = value;
    else env.push({ name, value });
  }
}

function defaultModifyPlan(
  update: SandboxModifyOptionsLike,
  applied: boolean,
): SandboxModificationPlanLike {
  const changes: {
    field: string;
    disposition: "live" | "next start" | "requires restart" | "unsupported";
  }[] = [];
  if (update.memory !== undefined) changes.push({ field: "memory", disposition: "live" });
  if (update.maxMemory !== undefined) changes.push({ field: "max_memory", disposition: "live" });
  if (update.rootDiskSize !== undefined) {
    changes.push({ field: "root_disk_size", disposition: "live" });
  }
  if (update.env) {
    changes.push({
      field: "env",
      disposition: update.policy === "restart" ? "live" : "next start",
    });
  }

  return {
    applied,
    conflicts: [],
    changes,
    resizeStatus:
      update.memory === undefined
        ? []
        : [{ resource: "memory", state: applied ? "applied" : "converging" }],
  };
}

export function fakeSandbox(options: FakeSandboxOptions): SandboxHandleLike {
  const labels = {
    ...managedLabels({
      parentId: options.parentId,
      phase: options.phase,
      error: options.error,
    }),
    ...(options.extraLabels ?? {}),
    ...(options.labels ?? {}),
  };

  const jobs = jobList(options);
  let provisionStatus: ProvisionStatus | null = options.provisionStatus ?? null;

  const config = {
    image: { Oci: { rootDisk: { sizeMib: 10_240 } } },
    resources: { cpus: 2, memoryMib: 4_096 },
    env: [
      { name: "PATH", value: "/home/paseo/.local/bin:/usr/local/bin:/usr/bin:/bin" },
      {
        name: PLAN_ENV_VAR,
        value: JSON.stringify(options.plan ?? DEFAULT_PLAN),
      },
      {
        name: RESOURCES_ENV_VAR,
        value: JSON.stringify(
          options.requestedResources ?? {
            cpus: CPUS,
            memoryMib: MEMORY_MIB,
            diskMib: ROOT_DISK_MIB,
          },
        ),
      },
      {
        name: RESOURCES_SPECIFIED_ENV_VAR,
        value: (options.resourcesSpecified ?? false) ? "1" : "0",
      },
      { name: "ANTHROPIC_API_KEY", value: SECRET_VALUE },
    ],
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

  function jobInfos(): readonly SandboxJobInfoLike[] {
    return jobs.map((job) => ({
      id: job.id,
      command: job.command ?? ["sh", "-lc", "true"],
      state: job.state ?? "exited",
      exitCode: job.exitCode ?? 0,
      timedOut: job.timedOut ?? false,
      createdAt: job.createdAt,
      failure: job.failure ?? null,
    }));
  }

  function piInstalled(): boolean {
    if (typeof options.piInstalled === "boolean") return options.piInstalled;
    return labels[PHASE_LABEL] === "ready" || labels[PHASE_LABEL] === "registering";
  }

  const connectHandle: SandboxConnectHandleLike = {
    async exec(spec) {
      if (options.execError) throw options.execError;
      options.connectExecs?.push(spec);
      const snippet =
        spec.command === "sh" && spec.args[0] === "-c" ? (spec.args[1] ?? "") : "";
      if (snippet.startsWith("set -eu\numask 077\nfor d in ")) {
        return { code: options.skillActionCode ?? 0, stdout: "" };
      }
      if (snippet.startsWith('test -f "$HOME/.agents/skills/')) {
        const codes = options.skillProbeCodes;
        const index = Math.min(skillProbeCalls, (codes?.length ?? 1) - 1);
        skillProbeCalls += 1;
        return { code: codes?.[index] ?? 0, stdout: "" };
      }
      if (spec.args.some((arg) => arg.endsWith("status.json"))) {
        return provisionStatus
          ? { code: 0, stdout: JSON.stringify(provisionStatus) }
          : { code: 1, stdout: "" };
      }
      if (
        spec.command === "sh" &&
        spec.args[0] === "-c" &&
        spec.args.some((arg) => arg.includes("provision-"))
      ) {
        return { code: 0, stdout: "" };
      }
      if (spec.command === "sh" && spec.args.some((arg) => arg.includes("command -v pi"))) {
        if (!piInstalled()) return { code: 1, stdout: "" };
        return {
          code: options.execCode ?? 0,
          stdout: options.execOutput ?? `${PI_PREFIX}/bin/pi\n`,
        };
      }
      return { code: options.execCode ?? 0, stdout: options.execOutput ?? "" };
    },
  };

  let currentLabels = labels;
  let skillProbeCalls = 0;

  const handle: SandboxHandleLike = {
    id: options.id,
    name: options.name,
    status: options.status ?? "running",
    config: () => {
      const raw = options.rawConfig !== undefined ? options.rawConfig : config;
      if (typeof raw === "object" && raw !== null) {
        return { ...raw, labels: currentLabels };
      }
      return raw;
    },
    modify: async (update) => {
      if (options.modifyGate) await options.modifyGate;
      if (options.modifyError) throw options.modifyError;
      options.modifyCalls?.push(update);
      const applies = options.modifyApplies ?? true;
      if (applies) applyModify(config, update);
      if (update.labels) {
        currentLabels = { ...currentLabels, ...update.labels };
        options.labelUpdates?.push({ ...update.labels });
      }
      return options.modifyPlan?.(update) ?? defaultModifyPlan(update, applies);
    },
    metrics: async () => {
      options.metricsCalls?.push(1);
      if (options.metricsGate) await options.metricsGate;
      if (options.metricsError) throw options.metricsError;
      return options.metrics ?? DEFAULT_METRICS;
    },
    refresh: async () => {
      if (options.refreshError) throw options.refreshError;
      return handle;
    },
    connect: async () => {
      if (options.connectError) throw options.connectError;
      return connectHandle;
    },
    listJobsWith: async (configure) => {
      if (options.listJobsError) throw options.listJobsError;
      const builder = new FakeJobListBuilder();
      configure(builder);
      return builder.page(jobInfos());
    },
    logs: async (readOptions) => {
      const tail = readOptions.tail ?? options.logs?.length ?? 0;
      return (options.logs ?? []).slice(-tail);
    },
    getJob: async (id: string): Promise<SandboxJobLike> => {
      if (options.getJobError) throw options.getJobError;
      const job = jobInfos().find((candidate) => candidate.id === id);
      if (!job) throw new Error("job not found");

      let state = job.state;
      return {
        inspect: async () => {
          if (options.jobInspectError) throw options.jobInspectError;
          return { ...job, state };
        },
        wait: async () => {
          if (options.jobWaitError) throw options.jobWaitError;
          state = options.jobStateAfterWait ?? "exited";
          const source = jobs.find((candidate) => candidate.id === id);
          if (source) {
            source.state = state;
            if (options.jobWaitCode !== undefined) source.exitCode = options.jobWaitCode;
          }
          return { code: options.jobWaitCode ?? 0 };
        },
        logs: async (readOptions) => {
          const tail = readOptions.tail ?? options.jobLogs?.length ?? 0;
          return (options.jobLogs ?? []).slice(-tail);
        },
      };
    },
  };

  provisionStatusSetters.set(handle, (status) => {
    provisionStatus = status;
  });
  handleJobs.set(handle, jobs);
  return handle;
}

const handleJobs = new WeakMap<SandboxHandleLike, FakeJobOptions[]>();

class FakeJobListBuilder implements SandboxJobListBuilderLike {
  private limited = 100;
  private after: string | undefined;

  all(): this {
    return this;
  }

  limit(value: number): this {
    this.limited = value;
    return this;
  }

  cursor(value: string): this {
    this.after = value;
    return this;
  }

  page(items: readonly SandboxJobInfoLike[]): {
    items: readonly SandboxJobInfoLike[];
    nextCursor: string | null;
  } {
    const start = this.after ? Number(this.after) : 0;
    const slice = items.slice(start, start + this.limited);
    const next = start + this.limited;
    return {
      items: slice,
      nextCursor: next < items.length ? String(next) : null,
    };
  }
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

export function fakeRegistration(
  overrides: Partial<HostRegistrationLike> = {},
): HostRegistrationLike {
  const metadata =
    overrides.metadata ?? {
      source: REGISTRATION_SOURCE,
      name: "paseo-1",
    };

  return {
    registrationId: "reg_1",
    serverId: "srv_child",
    status: "online",
    enabled: true,
    label: metadata.name,
    source: { id: REGISTRATION_PRODUCER_ID, key: "sandbox_1" },
    metadata,
    targetDescription: "127.0.0.1:41000",
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
  updateError?: Error;
  removeError?: Error;
  onlineImmediately?: boolean;
  clientError?: Error;
  refreshError?: Error;
  refreshAcknowledged?: boolean;
  snapshotError?: Error;
  providerStatus?: string;
  providerMissing?: boolean;
  /** Selected Paseo providers returned by the snapshot. Defaults to Pi. */
  providers?: readonly string[];
}

/** Recording parent host API with the real producer and conflict semantics. */
export class FakePaseoHosts implements RegistrationHostsLike {
  directory: HostDirectoryLike;
  readonly added: HostAddInput[] = [];
  readonly updated: { registrationId: string; patch: HostUpdateInput }[] = [];
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

    const existing = this.directory.hosts.find(
      (registration) =>
        registration.source?.id === REGISTRATION_PRODUCER_ID &&
        registration.source?.key === input.sourceKey,
    );

    if (existing) {
      const unchanged =
        existing.label === input.label &&
        existing.metadata.source === input.metadata.source &&
        existing.metadata.name === input.metadata.name &&
        existing.targetDescription === input.connection;
      if (!unchanged) {
        const error = new Error("source_conflict") as Error & { code?: string };
        error.code = "source_conflict";
        throw error;
      }
      return existing;
    }

    this.added.push(input);
    const online = this.options.onlineImmediately ?? true;
    const registration: HostRegistrationLike = {
      registrationId: `reg_${this.added.length}`,
      serverId: online ? "srv_child" : null,
      status: online ? "online" : "connecting",
      enabled: true,
      label: input.label,
      source: { id: REGISTRATION_PRODUCER_ID, key: input.sourceKey },
      metadata: input.metadata,
      targetDescription: input.connection,
    };

    this.directory = { ...this.directory, hosts: [...this.directory.hosts, registration] };
    return registration;
  }

  async update(
    registrationId: string,
    patch: HostUpdateInput,
  ): Promise<HostRegistrationLike> {
    if (this.options.updateError) throw this.options.updateError;
    this.updated.push({ registrationId, patch });

    let updated: HostRegistrationLike | null = null;
    this.directory = {
      ...this.directory,
      hosts: this.directory.hosts.map((entry) => {
        if (entry.registrationId !== registrationId) return entry;
        updated = {
          ...entry,
          ...(patch.label !== undefined ? { label: patch.label } : {}),
          ...(patch.metadata !== undefined ? { metadata: patch.metadata } : {}),
          ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
          ...(patch.connection !== undefined ? { targetDescription: patch.connection } : {}),
        };
        return updated;
      }),
    };

    if (!updated) throw new Error("registration not found");
    return updated;
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
      : (this.options.providers ?? ["pi"]).map((provider) => ({
          provider,
          status: this.options.providerStatus ?? "ready",
        }));

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

export interface FakePaseoToolsOptions {
  connectError?: Error;
  connectGate?: Promise<void>;
  enableError?: Error;
  skillsError?: Error;
  skillsGate?: Promise<void>;
}

/** Recording stand-in for the post-registration child-daemon setup. */
export class FakePaseoTools implements PaseoToolsHandle {
  readonly connections: string[] = [];
  readonly enabledProviders: string[][] = [];
  installCalls = 0;
  closes = 0;

  private readonly options: FakePaseoToolsOptions;

  constructor(options: FakePaseoToolsOptions = {}) {
    this.options = options;
  }

  async connect(
    connection: string,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<PaseoToolsHandle> {
    this.connections.push(connection);
    if (this.options.connectError) throw this.options.connectError;
    if (this.options.connectGate) await this.options.connectGate;
    if (options.signal?.aborted) throw new Error("connection aborted");
    return this;
  }

  async enableTools(providers: readonly string[]): Promise<void> {
    if (this.options.enableError) throw this.options.enableError;
    this.enabledProviders.push([...providers]);
  }

  async installSkills(): Promise<void> {
    this.installCalls += 1;
    if (this.options.skillsGate) await this.options.skillsGate;
    if (this.options.skillsError) throw this.options.skillsError;
  }

  async close(): Promise<void> {
    this.closes += 1;
  }
}

export interface FakeCreatorOptions {
  existing?: SandboxHandleLike | null;
  findError?: Error;
  /** Optional scripted exact-lookup results, consumed one per call. */
  findSequence?: readonly (SandboxHandleLike | null | Error)[];
  createFailures?: readonly Error[];
  createGate?: Promise<void>;
  sandboxId?: string;
  jobId?: string;
  jobExitCode?: number;
  jobState?: string;
  jobWait?: () => Promise<{ readonly code: number }>;
  execOutput?: string;
  execError?: Error;
  execDetachedError?: Error;
  modifyError?: Error;
  modifyGate?: Promise<void>;
  destroyError?: Error;
  destroyGate?: Promise<void>;
  /** Leave the handle visible after destroy to model runtime lag. */
  keepAfterDestroy?: boolean;
  hostPorts?: readonly number[];
  probeError?: Error;
}

/**
 * Recording fake SandboxHost. Created sandboxes are real fake handles, so the
 * reconciler can look them up, connect, install, and register end to end.
 */
export class FakeSandboxCreator implements SandboxHost {
  readonly requests: SandboxCreateRequest[] = [];
  readonly labelUpdates: Record<string, string>[] = [];
  readonly execSpecs: ExecSpec[] = [];
  readonly destroyed: string[] = [];
  destroyCalls = 0;
  createCount = 0;
  probeCount = 0;
  connectCount = 0;
  findCount = 0;

  private readonly failures: Error[];
  private readonly sandboxes = new Map<string, SandboxHandleLike>();
  private readonly findSequence: (SandboxHandleLike | null | Error)[] | undefined;

  constructor(private readonly options: FakeCreatorOptions = {}) {
    this.failures = [...(options.createFailures ?? [])];
    this.findSequence = options.findSequence ? [...options.findSequence] : undefined;
    if (options.existing) this.sandboxes.set(options.existing.name, options.existing);
  }

  async find(name: string): Promise<SandboxHandleLike | null> {
    this.findCount += 1;
    if (this.options.findError) throw this.options.findError;
    const scripted = this.findSequence;
    if (scripted && scripted.length > 0) {
      const next = scripted.shift();
      if (next instanceof Error) throw next;
      return next ?? null;
    }
    return this.sandboxes.get(name) ?? null;
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

    const id = this.options.sandboxId ?? `sandbox_${this.createCount}`;
    const jobs: FakeJobOptions[] = [];
    const handle = fakeSandbox({
      id,
      name: request.name,
      phase: "creating",
      hostPort: request.hostPort,
      plan: request.plan,
      requestedResources: request.resources ?? {
        cpus: CPUS,
        memoryMib: MEMORY_MIB,
        diskMib: ROOT_DISK_MIB,
      },
      resourcesSpecified: request.resourcesSpecified ?? false,
      labelUpdates: this.labelUpdates,
      modifyGate: this.options.modifyGate,
      execError: this.options.execError,
      execOutput: this.options.execOutput,
      jobs,
    });
    this.sandboxes.set(request.name, handle);
    return { id, name: request.name };
  }

  async connect(handle: SandboxHandleLike): Promise<SandboxConnectHandleLike> {
    this.connectCount += 1;
    return handle.connect();
  }

  async startJob(
    handle: SandboxHandleLike,
    spec: ExecSpec,
  ): Promise<SandboxJobHandleLike> {
    this.execSpecs.push(spec);
    if (this.options.execDetachedError) throw this.options.execDetachedError;

    const id = this.options.jobId ?? "job_1";
    const jobs = handleJobs.get(handle) ?? [];
    jobs.push({
      id,
      command: [spec.command, ...spec.args],
      state: this.options.jobState ?? "exited",
      exitCode: this.options.jobExitCode ?? 0,
    });
    handleJobs.set(handle, jobs);

    if (spec.command === "/bin/sh" && spec.args[0]?.includes("/provision-")) {
      const planHash = spec.args[1] ?? "";
      const failed = (this.options.jobExitCode ?? 0) !== 0;
      provisionStatusSetters.get(handle)?.({
        planHash,
        ok: !failed,
        steps: [],
        failedStep: failed ? "provision" : null,
        error: failed ? "provisioning step provision failed" : null,
      });
    }

    return {
      id,
      wait: this.options.jobWait ?? (async () => ({ code: this.options.jobExitCode ?? 0 })),
      inspect: async () => ({
        id,
        command: [spec.command, ...spec.args],
        state: this.options.jobState ?? "exited",
        exitCode: this.options.jobExitCode ?? 0,
        timedOut: false,
        failure: null,
      }),
    };
  }

  async destroy(handle: SandboxHandleLike): Promise<void> {
    this.destroyCalls += 1;
    if (this.options.destroyError) throw this.options.destroyError;
    if (this.options.destroyGate) await this.options.destroyGate;
    this.destroyed.push(handle.id);
    if (!this.options.keepAfterDestroy) this.sandboxes.delete(handle.name);
  }
}

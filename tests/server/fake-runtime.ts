import {
  ERROR_LABEL,
  JOB_LABEL,
  MANAGED_LABEL,
  PARENT_LABEL,
  PHASE_LABEL,
  PLUGIN_VERSION,
  REGISTRATION_SOURCE,
  SANDBOX_ID_LABEL,
  type Phase,
} from "../../shared/constants";
import type {
  SandboxHandleLike,
  SandboxJobLike,
  SandboxLogEntryLike,
  SandboxRuntime,
} from "../../server/sandbox";
import type { HostDirectoryLike, HostRegistrationLike } from "../../server/status";

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

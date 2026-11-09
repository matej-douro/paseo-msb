import { GUEST_PATH, PI } from "../../shared/constants";
import {
  findPublishedPort,
  type CreateSandboxOptions,
  type CreatedSandbox,
  type DetachedJob,
  type DetachedJobInfo,
  type ExecOptions,
  type ExecResult,
  type SandboxRuntime,
} from "../../server/sandbox";

export const FAKE_CREDENTIAL_VALUES = {
  ANTHROPIC_API_KEY: "fake-anthropic-value",
  OPENAI_API_KEY: "fake-openai-value",
  GEMINI_API_KEY: "fake-gemini-value",
  NEURALWATT_API_KEY: "fake-neuralwatt-value",
  GH_TOKEN: "fake-github-value",
} as const;

export interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

export class FakeJob implements DetachedJob {
  readonly id: string;
  readonly #states: DetachedJobInfo[];
  #inspectCount = 0;

  constructor(id: string, states: DetachedJobInfo[] = [{ state: "exited", exitCode: 0 }]) {
    this.id = id;
    this.#states = states;
  }

  async inspect(): Promise<DetachedJobInfo> {
    const index = Math.min(this.#inspectCount, this.#states.length - 1);
    this.#inspectCount += 1;
    return this.#states[index];
  }
}

function success(stdout = ""): ExecResult {
  return { success: true, code: 0, stdout, stderr: "" };
}

function defaultExec(command: string, options?: ExecOptions): ExecResult {
  if (command === "pi" && options?.args?.[0] === "--version") {
    return success(PI.version);
  }
  if (command === "which" && options?.args?.[0] === "pi") {
    return success(`${PI.pathEntry}/pi`);
  }
  if (command === "printenv" && options?.args?.[0] === "PATH") {
    return success(GUEST_PATH);
  }
  return success();
}

export interface FakeExecCall {
  readonly command: string;
  readonly options: ExecOptions | undefined;
}

export class FakeSandbox implements CreatedSandbox {
  readonly id: string;
  readonly name: string;
  readonly labels: Record<string, string>;
  readonly modifyCalls: Array<Record<string, string>> = [];
  readonly execCalls: FakeExecCall[] = [];
  readonly detachedCalls: FakeExecCall[] = [];
  destroyed = false;
  #config: unknown;
  readonly #execHandler?: (command: string, options?: ExecOptions) => ExecResult;
  readonly #jobStates?: DetachedJobInfo[];
  readonly #modifyError?: Error;

  constructor(options: {
    id: string;
    name: string;
    labels: Record<string, string>;
    config: unknown;
    execHandler?: (command: string, options?: ExecOptions) => ExecResult;
    jobStates?: DetachedJobInfo[];
    modifyError?: Error;
  }) {
    this.id = options.id;
    this.name = options.name;
    this.labels = { ...options.labels };
    this.#config = options.config;
    this.#execHandler = options.execHandler;
    this.#jobStates = options.jobStates;
    this.#modifyError = options.modifyError;
  }

  async config(): Promise<unknown> {
    return this.#config;
  }

  async discoverPort(guestPort: number) {
    return findPublishedPort(this.#config, guestPort);
  }

  async modify(options: { readonly labels?: Readonly<Record<string, string>> }): Promise<void> {
    if (this.#modifyError) throw this.#modifyError;
    if (!options.labels) return;
    const labels = { ...options.labels };
    Object.assign(this.labels, labels);
    this.modifyCalls.push(labels);
  }

  async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    this.execCalls.push({ command, options });
    return this.#execHandler ? this.#execHandler(command, options) : defaultExec(command, options);
  }

  async execDetached(command: string, options?: ExecOptions): Promise<DetachedJob> {
    this.detachedCalls.push({ command, options });
    return new FakeJob(`fake-job-${this.id}`, this.#jobStates);
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
  }
}

export interface FakeRuntimeOptions {
  readonly createError?: (attempt: number) => Error | null;
  readonly createGate?: Deferred<void>;
  readonly assignedPorts?: Array<number | null>;
  readonly probePorts?: number[];
  readonly jobStates?: DetachedJobInfo[];
  readonly execHandler?: (command: string, options?: ExecOptions) => ExecResult;
  readonly modifyError?: Error;
}

export interface FakeCreateCall {
  readonly options: CreateSandboxOptions;
  sandbox: FakeSandbox | null;
}

export class FakeSandboxRuntime implements SandboxRuntime {
  readonly createCalls: FakeCreateCall[] = [];
  readonly sandboxes: FakeSandbox[] = [];
  readonly probeCalls: number[] = [];
  readonly #options: FakeRuntimeOptions;
  #nextPort = 45000;

  constructor(options: FakeRuntimeOptions = {}) {
    this.#options = options;
  }

  async create(options: CreateSandboxOptions): Promise<CreatedSandbox> {
    const attempt = this.createCalls.length;
    const recordedOptions: CreateSandboxOptions = {
      ...options,
      labels: { ...options.labels },
      secrets: options.secrets.map((secret) => ({
        ...secret,
        hosts: [...secret.hosts],
      })),
    };
    const call: FakeCreateCall = { options: recordedOptions, sandbox: null };
    this.createCalls.push(call);

    const error = this.#options.createError?.(attempt) ?? null;
    if (error) throw error;
    if (this.#options.createGate) {
      await this.#options.createGate.promise;
    }

    const assigned = this.#options.assignedPorts
      ? this.#options.assignedPorts[attempt] ?? null
      : options.hostPort > 0
        ? options.hostPort
        : this.#nextPort++;
    const sandbox = new FakeSandbox({
      id: `fake-sandbox-${attempt + 1}`,
      name: options.name,
      labels: { ...options.labels },
      config: {
        labels: { ...options.labels },
        network: {
          ports:
            assigned === null
              ? []
              : [
                  {
                    hostPort: assigned,
                    guestPort: 6767,
                    protocol: "tcp",
                    hostBind: "127.0.0.1",
                  },
                ],
        },
      },
      execHandler: this.#options.execHandler,
      jobStates: this.#options.jobStates,
      modifyError: this.#options.modifyError,
    });
    call.sandbox = sandbox;
    this.sandboxes.push(sandbox);
    return sandbox;
  }

  async probeLoopbackPort(): Promise<number> {
    const port = this.#options.probePorts?.shift();
    if (port === undefined) throw new Error("no fake probe port available");
    this.probeCalls.push(port);
    return port;
  }
}

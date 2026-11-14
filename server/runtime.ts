import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import {
  MANAGED_LABEL,
  MAX_JOB_PAGES,
  MAX_SANDBOX_PAGE_SIZE,
  PARENT_LABEL,
  PLUGIN_ID,
  PLUGIN_VERSION,
} from "../shared/constants";
import {
  buildSandboxCreatePlan,
  isSandboxNotFoundError,
  type ExecSpec,
  type SandboxConnectHandleLike,
  type SandboxCreateHandleLike,
  type SandboxHandleLike,
  type SandboxHost,
  type SandboxJobHandleLike,
  type SandboxJobInfoLike,
  type SandboxRuntime,
} from "./sandbox";

type MicrosandboxModule = typeof import("microsandbox");
type PaseoApi = PluginHandlerContext["paseo"];

let sdkPromise: Promise<MicrosandboxModule> | null = null;

/**
 * Paseo bundles plugin server code as CommonJS, which turns the microsandbox
 * ESM SDK's `import.meta.url` into `undefined`. Load the installed ESM package
 * at runtime from the directory source instead of bundling it.
 */
async function importMicrosandbox(paseo: PaseoApi): Promise<MicrosandboxModule> {
  const { config } = await paseo.config.get();
  const plugin = config.plugins?.[PLUGIN_ID];

  if (plugin?.source !== "directory" || !plugin.path) {
    throw new Error("plugin directory is unavailable");
  }

  const entry = path.join(
    plugin.path,
    "node_modules",
    "microsandbox",
    "dist",
    "index.js",
  );

  return (await import(pathToFileURL(entry).href)) as MicrosandboxModule;
}

function loadMicrosandbox(paseo: PaseoApi): Promise<MicrosandboxModule> {
  if (!sdkPromise) {
    sdkPromise = importMicrosandbox(paseo).catch((error) => {
      sdkPromise = null;
      throw error;
    });
  }
  return sdkPromise;
}

/**
 * A complete inventory read gets the same bounded page budget as job and log
 * reads. A repeated cursor or an exhausted budget is an inspection failure,
 * never a silently truncated inventory.
 */
const MAX_SANDBOX_PAGES = MAX_JOB_PAGES;

interface SandboxListPageLike {
  readonly sandboxes: readonly SandboxHandleLike[];
  readonly nextCursor: string | null;
}

export async function collectSandboxPages(
  loadPage: (cursor: string | undefined) => Promise<SandboxListPageLike>,
): Promise<readonly SandboxHandleLike[]> {
  const handles: SandboxHandleLike[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  for (let page = 0; page < MAX_SANDBOX_PAGES; page += 1) {
    const result = await loadPage(cursor);
    handles.push(...result.sandboxes);

    if (!result.nextCursor) return handles;
    if (seenCursors.has(result.nextCursor)) {
      throw new Error("sandbox inventory repeated a cursor");
    }
    seenCursors.add(result.nextCursor);
    cursor = result.nextCursor;
  }

  throw new Error("sandbox inventory exceeded the page budget");
}

/**
 * The only place the microsandbox SDK is used for inventory. Label filtering
 * happens in the runtime so foreign sandboxes never reach the projection.
 */
export function createMicrosandboxRuntime(paseo: PaseoApi): SandboxRuntime {
  return {
    async list(parentId) {
      const { Sandbox } = await loadMicrosandbox(paseo);

      return collectSandboxPages(async (cursor) => {
        const page = await Sandbox.listWith((list) => {
          const filtered = list
            .labels({
              [MANAGED_LABEL]: PLUGIN_VERSION,
              [PARENT_LABEL]: parentId,
            })
            .limit(MAX_SANDBOX_PAGE_SIZE);
          return cursor ? filtered.cursor(cursor) : filtered;
        });

        return {
          sandboxes: page.sandboxes as unknown as readonly SandboxHandleLike[],
          nextCursor: page.nextCursor ?? null,
        };
      });
    },
  };
}

/**
 * Create-side runtime. The builder applies the fixed plan from `sandbox.ts`, so
 * image, resources, init, loopback port, PATH, labels, and header-only secrets
 * stay identical between tests and production.
 */
export function createMicrosandboxHost(paseo: PaseoApi): SandboxHost {
  return {
    async find(name) {
      const { Sandbox } = await loadMicrosandbox(paseo);
      try {
        const handle = await Sandbox.get(name);
        return handle as unknown as SandboxHandleLike;
      } catch (error) {
        if (isSandboxNotFoundError(error)) return null;
        throw error;
      }
    },

    probePort: probeLoopbackPort,

    async connect(handle) {
      const sandbox = await handle.connect();
      return wrapConnectHandle(handle.id, sandbox as unknown as SdkSandboxLike);
    },

    async startInstall(handle, spec) {
      const sandbox = (await handle.connect()) as unknown as SdkSandboxLike;
      return sandbox.execDetachedWith(spec.command, (builder) => applyExecSpec(builder, spec));
    },

    async destroy(handle) {
      try {
        await (handle as unknown as SdkHandleDestroyLike).destroy({
          force: true,
          timeoutMs: 15_000,
        });
      } catch (error) {
        if (isSandboxNotFoundError(error)) return;
        throw error;
      }
    },

    async create(request) {
      const { Sandbox, MiB } = await loadMicrosandbox(paseo);
      const plan = buildSandboxCreatePlan(request);

      let builder = Sandbox.builder(plan.name)
        .image(plan.image)
        .cpus(plan.cpus)
        .memory(MiB(plan.memoryMib))
        .detached(plan.detached)
        // The pinned image's entrypoint is tini, not a distro init, so
        // `.init("auto")` fails; the verified fallback is explicit tini.
        .init(plan.init.command, [...plan.init.args])
        .port(plan.hostPort, plan.guestPort)
        .labels({ ...plan.labels });

      // Apply every planned env entry, including PATH and the persisted plan.
      for (const [key, value] of Object.entries(plan.env)) {
        builder = builder.env(key, value);
      }

      builder = builder.network((network) => {
        let configured: NetworkBuilderLike = network;
        for (const secret of plan.secrets) {
          configured = configured.secret((entry) => {
            let configuredEntry = entry
              .env(secret.envVar)
              .value(secret.value)
              .substituteInHeaders(secret.substitution.headers)
              .substituteInQuery(secret.substitution.query)
              .substituteInBody(secret.substitution.body);
            for (const host of secret.allowedHosts) {
              configuredEntry = configuredEntry.allow(host);
            }
            return configuredEntry;
          });
        }
        return configured;
      });

      const sandbox = await builder.create();
      return { id: sandbox.id, name: sandbox.name } satisfies SandboxCreateHandleLike;
    },
  };
}

/** The subset of the SDK secret builder chained when applying plan secrets. */
interface SecretBuilderLike {
  env(envVar: string): SecretBuilderLike;
  value(value: string): SecretBuilderLike;
  substituteInHeaders(enabled: boolean): SecretBuilderLike;
  substituteInQuery(enabled: boolean): SecretBuilderLike;
  substituteInBody(enabled: boolean): SecretBuilderLike;
  allow(host: string): SecretBuilderLike;
}

/** The subset of the SDK network builder chained when applying plan secrets. */
interface NetworkBuilderLike {
  secret(configure: (entry: SecretBuilderLike) => SecretBuilderLike): NetworkBuilderLike;
}

/** The subset of the SDK exec-options builder chained by `applyExecSpec`. */
interface ExecOptionsBuilderLike {
  args(args: readonly string[]): ExecOptionsBuilderLike;
  user(user: string): ExecOptionsBuilderLike;
  env(key: string, value: string): ExecOptionsBuilderLike;
  stdinNull(): ExecOptionsBuilderLike;
}

/** The subset of `connect()`'s sandbox used for guest execution and installs. */
interface SdkSandboxLike {
  readonly id: string;
  readonly name: string;
  execDetachedWith(
    command: string,
    configure: (builder: ExecOptionsBuilderLike) => ExecOptionsBuilderLike,
  ): Promise<SandboxJobHandleLike>;
  execWith(
    command: string,
    configure: (builder: ExecOptionsBuilderLike) => ExecOptionsBuilderLike,
  ): Promise<{
    readonly code: number;
    stdout(): string;
  }>;
}

interface SdkHandleDestroyLike {
  destroy(options: { force: boolean; timeoutMs: number }): Promise<void>;
}



function applyExecSpec(builder: ExecOptionsBuilderLike, spec: ExecSpec): ExecOptionsBuilderLike {
  let configured = builder.args([...spec.args]).user(spec.user);
  for (const [key, value] of Object.entries(spec.env ?? {})) {
    configured = configured.env(key, value);
  }
  return spec.stdinNull ? configured.stdinNull() : configured;
}

function wrapConnectHandle(
  expectedId: string,
  sandbox: SdkSandboxLike,
): SandboxConnectHandleLike {
  if (sandbox.id !== expectedId) {
    throw new Error("sandbox identity changed before connect");
  }

  return {
    async exec(spec) {
      const output = await sandbox.execWith(spec.command, (builder) => applyExecSpec(builder, spec));
      return { code: output.code, stdout: String(output.stdout()) };
    },
  };
}

/** Binds and releases a loopback port so the runtime publishes a real one. */
function probeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close(() => (port ? resolve(port) : reject(new Error("no port"))));
    });
  });
}

export type { SandboxJobInfoLike };

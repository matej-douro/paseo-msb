import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import {
  MANAGED_LABEL,
  MAX_SANDBOX_PAGE_SIZE,
  PARENT_LABEL,
  PLUGIN_ID,
  PLUGIN_VERSION,
} from "../shared/constants";
import {
  buildSandboxCreatePlan,
  type ExecSpec,
  type SandboxCreateHandleLike,
  type SandboxCreator,
  type SandboxHandleLike,
  type SandboxJobHandleLike,
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

  if (!plugin || plugin.source !== "directory" || !plugin.path) {
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
 * The only place the microsandbox SDK is used for inventory. Label filtering
 * happens in the runtime so foreign sandboxes never reach the projection.
 */
export function createMicrosandboxRuntime(paseo: PaseoApi): SandboxRuntime {
  return {
    async list(parentId) {
      const { Sandbox } = await loadMicrosandbox(paseo);
      const handles: SandboxHandleLike[] = [];
      const seenCursors = new Set<string>();
      let cursor: string | undefined;

      while (true) {
        const page = await Sandbox.listWith((list) => {
          const filtered = list
            .labels({
              [MANAGED_LABEL]: PLUGIN_VERSION,
              [PARENT_LABEL]: parentId,
            })
            .limit(MAX_SANDBOX_PAGE_SIZE);
          return cursor ? filtered.cursor(cursor) : filtered;
        });

        handles.push(...(page.sandboxes as unknown as SandboxHandleLike[]));

        const next = page.nextCursor;
        if (!next || seenCursors.has(next)) break;
        seenCursors.add(next);
        cursor = next;
      }

      return handles;
    },
  };
}

/**
 * Create-side runtime. The builder applies the fixed plan from `sandbox.ts`, so
 * image, resources, init, loopback port, PATH, labels, and header-only secrets
 * stay identical between tests and production.
 */
export function createMicrosandboxCreator(paseo: PaseoApi): SandboxCreator {
  return {
    async find(name) {
      const { Sandbox } = await loadMicrosandbox(paseo);
      try {
        const handle = await Sandbox.get(name);
        return handle as unknown as SandboxHandleLike;
      } catch {
        return null;
      }
    },

    probePort: probeLoopbackPort,

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
        .env("PATH", plan.env.PATH)
        .labels({ ...plan.labels });

      builder = builder.network((network) => {
        let configured: any = network;
        for (const secret of plan.secrets) {
          configured = configured.secret((entry: any) => {
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

      return wrapCreateHandle(await builder.create());
    },
  };
}

/** Structural view of the SDK sandbox returned by a strict create. */
interface SdkSandboxLike {
  readonly id: string;
  readonly name: string;
  modify(options: { labels: Record<string, string> }): Promise<unknown>;
  execDetachedWith(
    command: string,
    configure: (builder: any) => any,
  ): Promise<SandboxJobHandleLike>;
  execWith(command: string, configure: (builder: any) => any): Promise<{
    readonly code: number;
    stdout(): string;
  }>;
}

function applyExecSpec(builder: any, spec: ExecSpec): any {
  let configured = builder.args([...spec.args]).user(spec.user);
  for (const [key, value] of Object.entries(spec.env ?? {})) {
    configured = configured.env(key, value);
  }
  return spec.stdinNull ? configured.stdinNull() : configured;
}

function wrapCreateHandle(sandbox: SdkSandboxLike): SandboxCreateHandleLike {
  return {
    id: sandbox.id,
    name: sandbox.name,

    async modify(options) {
      await sandbox.modify({ labels: { ...options.labels } });
    },

    async execDetached(spec) {
      return sandbox.execDetachedWith(spec.command, (builder) => applyExecSpec(builder, spec));
    },

    async exec(spec) {
      const output = await sandbox.execWith(spec.command, (builder) => applyExecSpec(builder, spec));
      if (output.code !== 0) throw new Error("guest command failed");
      return output.stdout();
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

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
import type { SandboxHandleLike, SandboxRuntime } from "./sandbox";

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

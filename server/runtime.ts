import { Sandbox } from "microsandbox";
import {
  MANAGED_LABEL,
  MAX_SANDBOX_PAGE_SIZE,
  PARENT_LABEL,
  PLUGIN_VERSION,
} from "../shared/constants";
import type { SandboxHandleLike, SandboxRuntime } from "./sandbox";

/**
 * The only place the microsandbox SDK is used for inventory. Label filtering
 * happens in the runtime so foreign sandboxes never reach the projection.
 */
export function createMicrosandboxRuntime(): SandboxRuntime {
  return {
    async list(parentId) {
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

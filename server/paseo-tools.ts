import { createHostClient } from "@getpaseo/client/node";
import type { MutableDaemonConfigPatch } from "@getpaseo/protocol/messages";

/**
 * The same surface Paseo's "Enable Paseo tools" setting applies, plus the
 * provider policy guard: inject the Paseo MCP tools into agents and ensure the
 * selected providers do not keep Paseo tools disabled.
 */
export function paseoToolsPatch(providers: readonly string[]): MutableDaemonConfigPatch {
  if (providers.length === 0) {
    throw new Error("No Paseo provider is selected for Paseo tools.");
  }

  return {
    mcp: { injectIntoAgents: true },
    providers: Object.fromEntries(
      providers.map((provider) => [provider, { paseoTools: { enabled: true } }]),
    ),
  };
}

/**
 * The child daemon operations behind the `paseo-tools` integration. This runs
 * after the child is routed online, so it is deliberately separate from the
 * provisioning script and its content-addressed status contract.
 */
export interface PaseoToolsHandle {
  /** Enable the Paseo tool policy for each selected Paseo provider id. */
  enableTools(providers: readonly string[]): Promise<void>;
  /** Persist an "all skills" selection and install the bundled skills. */
  installSkills(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Injected by the plugin server and replaced by a recording fake in tests. The
 * connection is the child's published parent-loopback endpoint, never a guest
 * network path.
 */
export interface PaseoToolsConnectOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export type PaseoToolsConnector = (
  connection: string,
  options?: PaseoToolsConnectOptions,
) => Promise<PaseoToolsHandle>;

/**
 * Opens a direct client to the child daemon. The child runs without
 * `PASEO_PASSWORD` and listens only on parent loopback, so setup uses that
 * loopback directly; the authenticated parent route remains the user-facing
 * boundary.
 */
export const connectPaseoTools: PaseoToolsConnector = async (connection, options = {}) => {
  const client = createHostClient(connection, {
    clientId: "paseo-msb",
    clientType: "cli",
    connectTimeoutMs: options.timeoutMs,
    // A bounded setup call must not leave a reconnecting client behind when the
    // lane aborts or times out during connect.
    reconnect: { enabled: false },
  });

  const closeOnAbort = () => {
    void client.close().catch(() => {});
  };
  options.signal?.addEventListener("abort", closeOnAbort, { once: true });

  try {
    await client.connect();
  } catch (error) {
    await client.close().catch(() => {});
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", closeOnAbort);
  }

  return {
    async enableTools(providers) {
      const { config } = await client.patchDaemonConfig(paseoToolsPatch(providers));
      if (config.mcp?.injectIntoAgents !== true) {
        throw new Error("Paseo tools injection remained disabled.");
      }
      for (const provider of providers) {
        if (config.providers?.[provider]?.paseoTools?.enabled !== true) {
          throw new Error(`Paseo tools remained disabled for provider ${provider}.`);
        }
      }
    },

    async installSkills() {
      const result = await client.saveAgentSkillsSelection({ mode: "all" });
      if (result.confirmationRequired) {
        throw new Error("Installing orchestration skills requires an unconfirmed removal.");
      }
      if (result.state !== "up-to-date") {
        throw new Error("Orchestration skills were not installed.");
      }
    },

    async close() {
      await client.close();
    },
  };
};

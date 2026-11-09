import { NetworkPolicy, Sandbox } from "microsandbox";
import {
  BLOCKED_HOST,
  CONTROLLED_HOST,
  CONTROLLED_SECRET_ENV,
  CREDENTIALS,
  PINS,
} from "./pins.mjs";
import { FAKE_SECRETS } from "./fake-secrets.mjs";

export const GUEST_PATH = `${PINS.pi.pathEntry}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`;

export function placeholderFor(env) {
  return `$MSB_${env}`;
}

export function fixedSecrets() {
  return CREDENTIALS.map(({ env, hosts }) => ({
    env,
    value: FAKE_SECRETS[env],
    hosts,
  }));
}

function addSecret(builder, { env, value, hosts }) {
  return builder.secret((secret) =>
    hosts
      .reduce(
        (current, host) => current.allow(host),
        secret
          .env(env)
          .value(value)
          .placeholder(placeholderFor(env))
          .requireTlsIdentity(true)
          .substituteInHeaders(true)
          .substituteInQuery(false)
          .substituteInBody(false),
      ),
  );
}

export function buildSandboxBuilder(options) {
  let builder = Sandbox.builder(options.name)
    .image(PINS.image.ref)
    .cpus(options.cpus ?? PINS.resources.cpus)
    .memory(options.memoryMiB ?? PINS.resources.memoryMiB)
    .detached(true)
    .workdir("/workspace")
    .env("PATH", GUEST_PATH)
    .env("PASEO_LISTEN", PINS.child.listen)
    .labels(options.labels ?? {});

  if (options.init === "auto") {
    builder = builder.init("auto");
  } else {
    builder = builder.init(PINS.init.fallback.cmd, PINS.init.fallback.args);
  }

  if (options.hostPort !== null && options.hostPort !== undefined) {
    builder = builder.portBind("127.0.0.1", options.hostPort, PINS.resources.guestPort);
  }

  for (const entry of fixedSecrets()) {
    builder = addSecret(builder, entry);
  }

  if (options.includeControlledSecret) {
    builder = addSecret(builder, {
      env: CONTROLLED_SECRET_ENV,
      value: FAKE_SECRETS[CONTROLLED_SECRET_ENV],
      hosts: [CONTROLLED_HOST],
    });
    builder = builder.interceptTls();
    builder = builder.network((network) =>
      network
        .policy(NetworkPolicy.fromProfiles(["public", "host"]))
        .tls((tls) =>
          tls
            .upstreamCaCertFor(CONTROLLED_HOST, options.controlledCaPath)
            .upstreamCaCertFor(BLOCKED_HOST, options.controlledCaPath),
        ),
    );
  } else {
    builder = builder.network((network) => network.policy(NetworkPolicy.fromProfiles(["public"])));
  }

  return builder;
}

export async function buildSandboxConfig(options) {
  return buildSandboxBuilder(options).build();
}

export function inspectConfig(config) {
  const secrets = config.network?.secrets?.secrets ?? [];
  return {
    labels: config.labels ?? {},
    cpus: config.resources?.cpus ?? null,
    memoryMiB: config.resources?.memoryMib ?? null,
    init: config.init ?? null,
    ports: config.network?.ports ?? [],
    env: (config.env ?? []).map((entry) => entry.key ?? entry.name ?? null),
    secrets: secrets.map((entry) => ({
      envVar: entry.envVar,
      placeholder: entry.placeholder,
      allowedHosts: entry.allowedHosts,
      substitution: entry.substitution,
      requireTlsIdentity: entry.requireTlsIdentity,
    })),
    policy: config.network?.policy ?? null,
    tls: {
      enabled: config.network?.tls?.enabled ?? null,
      scopedUpstreamCaCert: config.network?.tls?.scopedUpstreamCaCert ?? [],
    },
  };
}

export function assertConfigContract(config, options = {}) {
  const summary = inspectConfig(config);
  if (summary.cpus !== PINS.resources.cpus || summary.memoryMiB !== PINS.resources.memoryMiB) {
    throw new Error("fixed CPU or memory does not match the pins");
  }
  if (summary.init?.cmd !== PINS.init.fallback.cmd) {
    throw new Error("sandbox init does not match the fallback pin");
  }
  if (options.hostPort !== null && options.hostPort !== undefined) {
    const port = summary.ports.find((entry) => entry.guestPort === PINS.resources.guestPort);
    if (!port) throw new Error("guest port is not published");
    if (port.hostBind !== "127.0.0.1") throw new Error("published port is not loopback-only");
  }
  if (summary.env.includes("PASEO_PASSWORD")) {
    throw new Error("PASEO_PASSWORD must not be set");
  }
  for (const { env, hosts } of CREDENTIALS) {
    const secret = summary.secrets.find((entry) => entry.envVar === env);
    if (!secret) throw new Error(`missing secret ${env}`);
    if (secret.placeholder !== placeholderFor(env)) {
      throw new Error(`unexpected placeholder for ${env}`);
    }
    if (!secret.substitution?.headers || secret.substitution?.query || secret.substitution?.body) {
      throw new Error(`secret ${env} is not header-only`);
    }
    const allowed = secret.allowedHosts.map((entry) => entry.exact).sort();
    if (JSON.stringify(allowed) !== JSON.stringify([...hosts].sort())) {
      throw new Error(`allowed hosts differ for ${env}`);
    }
  }
  if (options.includeControlledSecret) {
    const controlled = summary.secrets.find((entry) => entry.envVar === CONTROLLED_SECRET_ENV);
    if (!controlled) throw new Error("controlled secret is missing");
    if (!controlled.substitution?.headers || controlled.substitution?.query || controlled.substitution?.body) {
      throw new Error("controlled secret is not header-only");
    }
  }
  return summary;
}

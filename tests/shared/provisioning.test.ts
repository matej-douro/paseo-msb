import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BASE_STEPS,
  CLAUDE_CODE_VERSION,
  GH_LINUX_AMD64_SHA256,
  GH_LINUX_ARM64_SHA256,
  GH_VERSION,
  INTEGRATION_CATALOG,
  INTEGRATION_IDS,
  LLM_IDS,
  PI_NEURALWATT_SOURCE,
  PI_NEURALWATT_VERSION,
  PROVISIONING_CREDENTIAL_NAMES,
  PROVISIONING_PI_VERSION,
  PROVIDER_CATALOG,
  PROVIDER_IDS,
  VM_SETUP_SKILL_CONTENT,
  VM_SETUP_SKILL_MARKER,
  VM_SETUP_SKILL_SUBDIRS,
  availableCredentialSet,
  buildProvisionScript,
  canonicalizePlan,
  catalogFingerprint,
  integrationAvailability,
  isProvisionSuccess,
  parseProvisionStatus,
  paseoProviderIds,
  planHash,
  plannedSteps,
  providerAvailability,
  provisionMaterializeSpec,
  provisionStatusPath,
  provisionStatusReadSpec,
  requiredCredentialsForPlan,
  resolveProvisionPlan,
  type CanonicalPlan,
  type ProvisioningCredential,
  type ProvisionPlanInput,
} from "../../shared/provisioning";

const ALL_CREDENTIALS = availableCredentialSet(PROVISIONING_CREDENTIAL_NAMES);

function resolve(input: ProvisionPlanInput, credentials = ALL_CREDENTIALS) {
  const result = resolveProvisionPlan(input, credentials);
  if (!result.ok) throw new Error(`Expected a valid plan: ${result.message}`);
  return result;
}

const PI_NEURALWATT_GH: ProvisionPlanInput = {
  providers: [{ provider: "pi", llms: ["neuralwatt"] }],
  integrations: ["github-cli"],
};

describe("provisioning catalog", () => {
  it("exposes the agreed providers, LLM options, and integrations", () => {
    expect(PROVIDER_CATALOG.map((entry) => entry.id)).toEqual([...PROVIDER_IDS]);
    expect(INTEGRATION_CATALOG.map((entry) => entry.id)).toEqual([...INTEGRATION_IDS]);
    expect(PROVIDER_CATALOG.find((entry) => entry.id === "claude")?.llms.map((llm) => llm.id)).toEqual(
      ["anthropic-api-key", "anthropic-oauth"],
    );
    expect(PROVIDER_CATALOG.find((entry) => entry.id === "pi")?.llms.map((llm) => llm.id)).toEqual([
      "anthropic-api-key",
      "openai-api-key",
      "gemini-api-key",
      "neuralwatt",
    ]);
  });

  it("declares only known credentials and unique step ids", () => {
    const credentials = new Set<string>(PROVISIONING_CREDENTIAL_NAMES);
    const stepIds = new Set<string>();

    for (const step of BASE_STEPS) {
      expect(stepIds.has(step.id)).toBe(false);
      stepIds.add(step.id);
    }

    for (const provider of PROVIDER_CATALOG) {
      expect(provider.paseoProviderId).toBe(provider.id);
      for (const step of provider.steps) {
        expect(stepIds.has(step.id)).toBe(false);
        stepIds.add(step.id);
      }
      for (const llm of provider.llms) {
        for (const credential of llm.requiredCredentials) {
          expect(credentials.has(credential)).toBe(true);
        }
        for (const step of llm.steps) {
          expect(stepIds.has(step.id)).toBe(false);
          stepIds.add(step.id);
        }
      }
    }

    for (const integration of INTEGRATION_CATALOG) {
      for (const credential of integration.requiredCredentials) {
        expect(credentials.has(credential)).toBe(true);
      }
      for (const step of integration.steps) {
        expect(stepIds.has(step.id)).toBe(false);
        stepIds.add(step.id);
      }
    }
  });

  it("keeps the agreed pins in the step definitions", () => {
    const script = buildProvisionScript(
      resolve({
        providers: [
          { provider: "claude", llms: ["anthropic-api-key"] },
          { provider: "pi", llms: ["anthropic-api-key", "openai-api-key", "gemini-api-key", "neuralwatt"] },
        ],
        integrations: ["github-cli"],
      }).plan,
    ).script;

    expect(script).toContain(`bash -s ${CLAUDE_CODE_VERSION}`);
    expect(script).toContain(`pi-coding-agent@${PROVISIONING_PI_VERSION}`);
    expect(script).toContain(`${PI_NEURALWATT_SOURCE}@${PI_NEURALWATT_VERSION}`);
    expect(script).toContain(`gh_${GH_VERSION}_linux_arm64.tar.gz`);
    expect(script).toContain(`gh_${GH_VERSION}_linux_amd64.tar.gz`);
    expect(script).toContain(GH_LINUX_ARM64_SHA256);
    expect(script).toContain(GH_LINUX_AMD64_SHA256);
    expect(script).toContain(
      `install -m 0755 "$tmp/\${asset%.tar.gz}/bin/gh" "/home/paseo/.local/bin/gh"`,
    );
  });
});

describe("provider and integration availability", () => {
  it("greys Claude out without an Anthropic credential and always offers Pi", () => {
    const claude = providerAvailability("claude", availableCredentialSet([]));
    const pi = providerAvailability("pi", availableCredentialSet([]));

    expect(claude.available).toBe(false);
    expect(claude.reason).toContain("ANTHROPIC_API_KEY");
    expect(claude.reason).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(claude.llms.map((llm) => llm.available)).toEqual([false, false]);

    expect(pi.available).toBe(true);
    expect(pi.reason).toBeNull();
    expect(pi.llms.find((llm) => llm.id === "neuralwatt")?.missing).toEqual([
      "NEURALWATT_API_KEY",
    ]);
  });

  it("enables only the auth option whose credential exists", () => {
    const apiKey = providerAvailability(
      "claude",
      availableCredentialSet(["ANTHROPIC_API_KEY"]),
    );
    expect(apiKey.available).toBe(true);
    expect(apiKey.llms).toEqual([
      { id: "anthropic-api-key", available: true, missing: [] },
      {
        id: "anthropic-oauth",
        available: false,
        missing: ["CLAUDE_CODE_OAUTH_TOKEN"],
      },
    ]);

    const oauth = providerAvailability(
      "claude",
      availableCredentialSet(["CLAUDE_CODE_OAUTH_TOKEN"]),
    );
    expect(oauth.available).toBe(true);
    expect(oauth.llms.find((llm) => llm.id === "anthropic-oauth")?.available).toBe(true);
  });

  it("requires GH_TOKEN for the GitHub CLI integration", () => {
    expect(integrationAvailability("github-cli", availableCredentialSet([]))).toEqual({
      id: "github-cli",
      available: false,
      reason: "Set GH_TOKEN to enable GitHub CLI.",
      missing: ["GH_TOKEN"],
    });
    expect(
      integrationAvailability("github-cli", availableCredentialSet(["GH_TOKEN"])),
    ).toEqual({
      id: "github-cli",
      available: true,
      reason: null,
      missing: [],
    });
  });

  it("makes Paseo tools available without a credential", () => {
    expect(integrationAvailability("paseo-tools", availableCredentialSet([]))).toEqual({
      id: "paseo-tools",
      available: true,
      reason: null,
      missing: [],
    });
  });
});

describe("plan resolution", () => {
  it("derives only the selected credentials", () => {
    const result = resolve(PI_NEURALWATT_GH);
    expect(result.requiredCredentials).toEqual(["NEURALWATT_API_KEY", "GH_TOKEN"]);
    expect(paseoProviderIds(result.plan)).toEqual(["pi"]);
  });

  it("supports Claude-only and Claude with OAuth", () => {
    expect(
      resolve({
        providers: [{ provider: "claude", llms: ["anthropic-api-key"] }],
        integrations: [],
      }).requiredCredentials,
    ).toEqual(["ANTHROPIC_API_KEY"]);

    expect(
      resolve({
        providers: [{ provider: "claude", llms: ["anthropic-oauth"] }],
        integrations: [],
      }).requiredCredentials,
    ).toEqual(["CLAUDE_CODE_OAUTH_TOKEN"]);
  });

  it("rejects Claude with more than one auth option", () => {
    const result = resolveProvisionPlan(
      {
        providers: [{ provider: "claude", llms: ["anthropic-api-key", "anthropic-oauth"] }],
        integrations: [],
      },
      ALL_CREDENTIALS,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("invalid_request");
  });

  it("supports Paseo tools without adding credentials", () => {
    const result = resolve(
      {
        providers: [{ provider: "pi", llms: ["anthropic-api-key"] }],
        integrations: ["paseo-tools"],
      },
      availableCredentialSet(["ANTHROPIC_API_KEY"]),
    );

    expect(result.requiredCredentials).toEqual(["ANTHROPIC_API_KEY"]);
    expect(result.plan.integrations).toEqual(["paseo-tools"]);
  });

  it("rejects plans with no provider, duplicate providers, duplicate LLMs, or foreign LLMs", () => {
    const invalidPlans = [
      { providers: [], integrations: ["github-cli"] },
      {
        providers: [
          { provider: "pi", llms: ["neuralwatt"] },
          { provider: "pi", llms: ["openai-api-key"] },
        ],
        integrations: [],
      },
      {
        providers: [{ provider: "pi", llms: ["neuralwatt", "neuralwatt"] }],
        integrations: [],
      },
      {
        providers: [{ provider: "pi", llms: ["anthropic-oauth"] }],
        integrations: [],
      },
      {
        providers: [{ provider: "claude", llms: [] }],
        integrations: [],
      },
      {
        providers: [{ provider: "pi", llms: ["neuralwatt"] }],
        integrations: ["github-cli", "github-cli"],
      },
    ];

    for (const plan of invalidPlans) {
      const result = resolveProvisionPlan(plan, ALL_CREDENTIALS);
      expect(result.ok, JSON.stringify(plan)).toBe(false);
    }
  });

  it("reports missing credentials instead of falling back to stored values", () => {
    const result = resolveProvisionPlan(
      PI_NEURALWATT_GH,
      availableCredentialSet(["ANTHROPIC_API_KEY"]),
    );
    expect(result).toEqual({
      ok: false,
      code: "missing_credentials",
      message: "One or more selected provisioning options are unavailable.",
      missing: ["NEURALWATT_API_KEY", "GH_TOKEN"],
    });
  });

  it("canonicalizes order for stable hashing", () => {
    const left = resolve({
      providers: [
        { provider: "pi", llms: ["neuralwatt", "openai-api-key"] },
        { provider: "claude", llms: ["anthropic-api-key"] },
      ],
      integrations: ["github-cli"],
    }).plan;
    const right = resolve({
      providers: [
        { provider: "claude", llms: ["anthropic-api-key"] },
        { provider: "pi", llms: ["openai-api-key", "neuralwatt"] },
      ],
      integrations: ["github-cli"],
    }).plan;

    expect(canonicalizePlan(left)).toEqual(canonicalizePlan(right));
    expect(planHash(left)).toBe(planHash(right));
    expect(planHash(left)).toMatch(/^[0-9a-f]{16}$/);
    expect(catalogFingerprint()).toMatch(/^[0-9a-f]{16}$/);
  });

  it("changes the hash when the plan changes", () => {
    const base = resolve(PI_NEURALWATT_GH).plan;
    const withMore = resolve({
      providers: [{ provider: "pi", llms: ["neuralwatt", "openai-api-key"] }],
      integrations: ["github-cli"],
    }).plan;

    expect(planHash(base)).not.toBe(planHash(withMore));
  });
});

describe("provision script", () => {
  it("renders a deterministic, content-addressed script", () => {
    const plan = resolve(PI_NEURALWATT_GH).plan;
    const first = buildProvisionScript(plan);
    const second = buildProvisionScript(plan);

    expect(first.script).toBe(second.script);
    expect(first.planHash).toBe(second.planHash);
    expect(first.path).toBe(`/home/paseo/.paseo-msb/provision-${first.planHash}.sh`);
    expect(first.argv).toEqual(["/bin/sh", first.path, first.planHash]);
    expect(first.steps.map((step) => step.id)).toEqual([
      "vm-setup-skill",
      "pi-install",
      "pi-neuralwatt-install",
      "github-cli-install",
    ]);
  });

  it("installs the provider before its LLM extension and integrations last", () => {
    const steps = plannedSteps(resolve(PI_NEURALWATT_GH).plan);
    expect(steps.map((step) => step.id)).toEqual([
      "vm-setup-skill",
      "pi-install",
      "pi-neuralwatt-install",
      "github-cli-install",
    ]);
    expect(steps[0]?.source).toEqual({ kind: "base" });
    expect(steps[2]?.source).toEqual({
      kind: "llm",
      provider: "pi",
      llm: "neuralwatt",
    });
    expect(steps[3]?.source).toEqual({
      kind: "integration",
      integration: "github-cli",
    });
  });

  it("installs the VM setup skill into both skill roots for every plan", () => {
    const plan = resolve(PI_NEURALWATT_GH).plan;
    const provision = buildProvisionScript(plan);
    const base = plannedSteps(plan)[0];

    expect(base?.id).toBe("vm-setup-skill");
    expect(base?.source).toEqual({ kind: "base" });
    for (const subdir of VM_SETUP_SKILL_SUBDIRS) {
      expect(base?.probe).toContain(`"$HOME/${subdir}/SKILL.md"`);
      expect(base?.action).toContain(`"$HOME/${subdir}"`);
      expect(provision.script).toContain(`$HOME/${subdir}`);
    }
    expect(provision.script).toContain(VM_SETUP_SKILL_MARKER);
    expect(provision.script).toContain("chmod 600");
  });

  it("writes the VM setup skill into both skill roots", () => {
    const step = plannedSteps(resolve(PI_NEURALWATT_GH).plan)[0];
    const home = mkdtempSync(join(tmpdir(), "paseo-msb-skill-"));
    const env = { ...process.env, HOME: home };

    try {
      const before = spawnSync("sh", ["-c", step?.probe ?? ""], { env, encoding: "utf8" });
      expect(before.status).not.toBe(0);

      const action = spawnSync("sh", ["-c", step?.action ?? ""], { env, encoding: "utf8" });
      expect(action.stderr).toBe("");
      expect(action.status).toBe(0);

      const probe = spawnSync("sh", ["-c", step?.probe ?? ""], { env, encoding: "utf8" });
      expect(probe.status).toBe(0);

      for (const subdir of VM_SETUP_SKILL_SUBDIRS) {
        const path = join(home, subdir, "SKILL.md");
        expect(readFileSync(path, "utf8")).toBe(VM_SETUP_SKILL_CONTENT);
        expect(statSync(path).mode & 0o777).toBe(0o600);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("rewrites a stale marker and keeps the file mode", () => {
    const step = plannedSteps(resolve(PI_NEURALWATT_GH).plan)[0];
    const home = mkdtempSync(join(tmpdir(), "paseo-msb-skill-"));
    const env = { ...process.env, HOME: home };

    try {
      expect(spawnSync("sh", ["-c", step?.action ?? ""], { env }).status).toBe(0);
      const path = join(home, VM_SETUP_SKILL_SUBDIRS[0], "SKILL.md");
      writeFileSync(path, readFileSync(path, "utf8").replace(/<!-- .* -->/, "<!-- stale -->"));

      expect(spawnSync("sh", ["-c", step?.probe ?? ""], { env }).status).not.toBe(0);
      expect(spawnSync("sh", ["-c", step?.action ?? ""], { env }).status).toBe(0);
      expect(spawnSync("sh", ["-c", step?.probe ?? ""], { env }).status).toBe(0);
      expect(statSync(path).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("renders every step probe and action as valid POSIX shell", () => {
    const plan = resolve({
      providers: [
        { provider: "claude", llms: ["anthropic-api-key"] },
        { provider: "pi", llms: ["neuralwatt"] },
      ],
      integrations: ["github-cli"],
    }).plan;

    for (const step of plannedSteps(plan)) {
      for (const snippet of [step.probe, step.action]) {
        const result = spawnSync("sh", ["-n", "-c", snippet], { encoding: "utf8" });
        expect(result.stderr).toBe("");
        expect(result.status).toBe(0);
      }
    }
  });

  it("keeps a runtime-only integration out of the provision script", () => {
    const plan = resolve({
      providers: [{ provider: "pi", llms: ["anthropic-api-key"] }],
      integrations: ["paseo-tools"],
    }).plan;
    const withoutIntegration = resolve({
      providers: [{ provider: "pi", llms: ["anthropic-api-key"] }],
      integrations: [],
    }).plan;

    expect(plannedSteps(plan).map((step) => step.id)).toEqual([
      "vm-setup-skill",
      "pi-install",
    ]);
    expect(planHash(plan)).not.toBe(planHash(withoutIntegration));
  });

  it("builds a Claude script that disables auto-update", () => {
    const script = buildProvisionScript(
      resolve({
        providers: [{ provider: "claude", llms: ["anthropic-oauth"] }],
        integrations: [],
      }).plan,
    ).script;

    expect(script).toContain("https://claude.ai/install.sh");
    expect(script).toContain(CLAUDE_CODE_VERSION);
    expect(script).toContain("DISABLE_AUTOUPDATER");
    expect(script).toContain("claude-settings");
    expect(script).toContain('STATUS_FILE="$STATE_DIR/status.json"');
  });

  it("never embeds credential values or placeholders", () => {
    const script = buildProvisionScript(
      resolve({
        providers: [
          { provider: "claude", llms: ["anthropic-api-key"] },
          { provider: "pi", llms: ["anthropic-api-key", "openai-api-key", "gemini-api-key", "neuralwatt"] },
        ],
        integrations: ["github-cli"],
      }).plan,
    ).script;

    expect(script).not.toContain("$MSB_");
    expect(script).not.toContain("sk-");
    expect(script).not.toContain("SECRET");
  });

  it("installs the status trap before the plan-hash guard", () => {
    const script = buildProvisionScript(resolve(PI_NEURALWATT_GH).plan).script;
    const trapAt = script.indexOf("trap finalize EXIT");
    const guardAt = script.indexOf(`if [ "\${1:-}" != "$PLAN_HASH" ]`);

    expect(trapAt).toBeGreaterThan(-1);
    expect(guardAt).toBeGreaterThan(-1);
    expect(trapAt).toBeLessThan(guardAt);
  });

  it("serializes concurrent runs with the guest lock", () => {
    const script = buildProvisionScript(resolve(PI_NEURALWATT_GH).plan).script;
    const lockAt = script.indexOf("flock -w 900 9");
    const truncateAt = script.indexOf(': > "$STATUS_LINES"');
    const firstStepAt = script.indexOf("run_step '");

    expect(lockAt).toBeGreaterThan(-1);
    expect(truncateAt).toBeGreaterThan(-1);
    expect(firstStepAt).toBeGreaterThan(-1);
    expect(lockAt).toBeLessThan(truncateAt);
    expect(lockAt).toBeLessThan(firstStepAt);
  });

  it("is valid POSIX shell", () => {
    const plan = resolve({
      providers: [
        { provider: "claude", llms: ["anthropic-api-key"] },
        { provider: "pi", llms: ["neuralwatt"] },
      ],
      integrations: ["github-cli"],
    }).plan;
    const { script } = buildProvisionScript(plan);
    const directory = mkdtempSync(join(tmpdir(), "paseo-msb-provision-"));
    const path = join(directory, "provision.sh");

    try {
      writeFileSync(path, script);
      const result = spawnSync("sh", ["-n", path], { encoding: "utf8" });
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("materializes the script with a non-conflicting here-document", () => {
    const provision = buildProvisionScript(resolve(PI_NEURALWATT_GH).plan);
    const spec = provisionMaterializeSpec(provision);

    expect(spec.command).toBe("sh");
    expect(spec.args).toHaveLength(2);
    expect(spec.args[0]).toBe("-c");
    expect(spec.args[1]).toContain("<<'PASEO_MSB_PROVISION_SCRIPT'");
    expect(spec.args[1]).toContain(provision.script.trim());
    expect(provision.script).not.toContain("PASEO_MSB_PROVISION_SCRIPT");
  });

  it("reads the status file without a bare cat so the expected miss stays out of logs", () => {
    const spec = provisionStatusReadSpec();

    expect(spec.command).toBe("sh");
    expect(spec.args).toEqual(["-c", 'test -f "$1" && cat "$1"', "sh", provisionStatusPath()]);
  });

  it("rejects duplicate step ids instead of silently collapsing them", () => {
    const plan = resolve(PI_NEURALWATT_GH).plan;
    const duplicated: CanonicalPlan = {
      providers: [
        { provider: "pi", llms: ["neuralwatt"] },
        { provider: "pi", llms: ["neuralwatt"] },
      ],
      integrations: plan.integrations,
    };

    expect(() => plannedSteps(duplicated)).toThrow(/Duplicate provisioning step id/);
  });
});

describe("provision status", () => {
  it("accepts the script's success shape and rejects anything else", () => {
    const status = parseProvisionStatus({
      planHash: "0123456789abcdef",
      ok: true,
      steps: [
        { id: "pi-install", status: "ok", exitCode: 0 },
        { id: "pi-neuralwatt-install", status: "skipped", exitCode: 0 },
      ],
      failedStep: null,
      error: null,
    });

    expect(status).not.toBeNull();
    expect(isProvisionSuccess(status!, "0123456789abcdef")).toBe(true);
    expect(isProvisionSuccess(status!, "another-plan")).toBe(false);
    expect(parseProvisionStatus({ ...status, steps: [{ id: "", status: "ok", exitCode: 0 }] })).toBeNull();
    expect(
      parseProvisionStatus({ ...status, steps: [{ id: "x", status: "done", exitCode: 0 }] }),
    ).toBeNull();
  });

  it("requires failedStep to be null for success", () => {
    const status = parseProvisionStatus({
      planHash: "0123456789abcdef",
      ok: false,
      steps: [{ id: "pi-install", status: "failed", exitCode: 1 }],
      failedStep: "pi-install",
      error: "provisioning step pi-install failed",
    });

    expect(status).not.toBeNull();
    expect(isProvisionSuccess(status!, "0123456789abcdef")).toBe(false);
  });
});

describe("credential and LLM id sets", () => {
  it("covers every catalog option", () => {
    const llmIds = new Set<string>(LLM_IDS);
    for (const provider of PROVIDER_CATALOG) {
      for (const llm of provider.llms) expect(llmIds.has(llm.id)).toBe(true);
    }
  });

  it("uses only known credentials in a maximal plan", () => {
    const plan = resolve({
      providers: [
        { provider: "claude", llms: ["anthropic-api-key"] },
        { provider: "pi", llms: ["anthropic-api-key", "openai-api-key", "gemini-api-key", "neuralwatt"] },
      ],
      integrations: ["github-cli"],
    }).plan;

    const known = new Set<string>(PROVISIONING_CREDENTIAL_NAMES);
    const required: readonly ProvisioningCredential[] = requiredCredentialsForPlan(plan);
    for (const credential of required) expect(known.has(credential)).toBe(true);
  });
});

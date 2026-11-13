import {
  PROVISIONING_GUEST_HOME,
  PROVISIONING_GUEST_PATH,
  PROVISIONING_STATE_DIR,
  type IntegrationId,
  type LlmId,
  type ProviderId,
  type ProvisionStep,
  integrationEntry,
  providerEntry,
} from "./catalog";
import { canonicalizePlan, planHash, type CanonicalPlan } from "./plan";
import { shellQuote } from "./shell";

export type PlannedStepSource =
  | { readonly kind: "provider"; readonly provider: ProviderId }
  | { readonly kind: "llm"; readonly provider: ProviderId; readonly llm: LlmId }
  | { readonly kind: "integration"; readonly integration: IntegrationId };

export interface PlannedStep extends ProvisionStep {
  readonly source: PlannedStepSource;
}

export interface ProvisionScript {
  readonly planHash: string;
  /** Absolute guest path of the content-addressed script. */
  readonly path: string;
  /** Exact detached-job argv. The parent also matches this for recovery. */
  readonly argv: readonly string[];
  readonly script: string;
  readonly steps: readonly PlannedStep[];
}

export interface ProvisionExecSpec {
  readonly command: string;
  readonly args: readonly string[];
}

const SCRIPT_DELIMITER = "PASEO_MSB_PROVISION_SCRIPT";

/**
 * Composes provider base steps, then their selected LLM steps, then
 * integrations. Provider and LLM order comes from the canonical plan, so the
 * rendered script is deterministic for a given selection.
 */
export function plannedSteps(plan: CanonicalPlan): readonly PlannedStep[] {
  const canonical = canonicalizePlan(plan);
  const steps: PlannedStep[] = [];
  const seen = new Set<string>();

  const add = (step: ProvisionStep, source: PlannedStepSource) => {
    if (seen.has(step.id)) {
      throw new Error(`Duplicate provisioning step id "${step.id}".`);
    }
    seen.add(step.id);
    steps.push({ ...step, source });
  };

  for (const selection of canonical.providers) {
    const provider = providerEntry(selection.provider);
    for (const step of provider.steps) {
      add(step, { kind: "provider", provider: selection.provider });
    }
    for (const llm of selection.llms) {
      const entry = provider.llms.find((candidate) => candidate.id === llm);
      if (!entry) {
        throw new Error(`Provider "${selection.provider}" does not offer LLM option "${llm}".`);
      }
      for (const step of entry.steps) {
        add(step, { kind: "llm", provider: selection.provider, llm });
      }
    }
  }

  for (const integration of canonical.integrations) {
    for (const step of integrationEntry(integration).steps) {
      add(step, { kind: "integration", integration });
    }
  }

  return steps;
}

export function provisionScriptPath(hash: string): string {
  return `${PROVISIONING_STATE_DIR}/provision-${hash}.sh`;
}

export function provisionStatusPath(): string {
  return `${PROVISIONING_STATE_DIR}/status.json`;
}

export function provisionArgv(hash: string): readonly string[] {
  return ["/bin/sh", provisionScriptPath(hash), hash];
}

export function buildProvisionScript(plan: CanonicalPlan): ProvisionScript {
  const canonical = canonicalizePlan(plan);
  const hash = planHash(canonical);
  const steps = plannedSteps(canonical);
  return {
    planHash: hash,
    path: provisionScriptPath(hash),
    argv: provisionArgv(hash),
    script: renderProvisionScript(hash, steps),
    steps,
  };
}

/**
 * Returns an ExecSpec that writes the script into the guest. The parent runs
 * this once before launching the detached provision job.
 */
export function provisionMaterializeSpec(provision: ProvisionScript): ProvisionExecSpec {
  const body = [
    `mkdir -p ${shellQuote(PROVISIONING_STATE_DIR)}`,
    `cat > ${shellQuote(provision.path)} <<'${SCRIPT_DELIMITER}'`,
    provision.script.replace(/\n$/, ""),
    SCRIPT_DELIMITER,
    `chmod 700 ${shellQuote(provision.path)}`,
  ].join("\n");

  return { command: "sh", args: ["-c", body] };
}

function renderProvisionScript(hash: string, steps: readonly PlannedStep[]): string {
  const lines = [
    "#!/bin/sh",
    "set -u",
    "umask 077",
    `HOME=${shellQuote(PROVISIONING_GUEST_HOME)}`,
    `PATH=${shellQuote(PROVISIONING_GUEST_PATH)}`,
    "export HOME PATH",
    `STATE_DIR=${shellQuote(PROVISIONING_STATE_DIR)}`,
    'STATUS_FILE="$STATE_DIR/status.json"',
    'STATUS_LINES="$STATE_DIR/status.lines"',
    `PLAN_HASH=${shellQuote(hash)}`,
    "FAILED_STEP=''",
    "record() { printf '%s\\t%s\\t%s\\n' \"$1\" \"$2\" \"$3\" >> \"$STATUS_LINES\"; }",
    "finalize() {",
    "  code=$?",
    '  node - "$PLAN_HASH" "$STATUS_LINES" "$STATUS_FILE" "$FAILED_STEP" <<\'PASEO_MSB_STATUS\'',
    'const fs = require("node:fs");',
    "const [planHash, linesPath, outPath, failedStep] = process.argv.slice(2);",
    'const raw = fs.existsSync(linesPath) ? fs.readFileSync(linesPath, "utf8") : "";',
    "const steps = raw",
    '  .split("\\n")',
    "  .filter((line) => line.length > 0)",
    "  .map((line) => {",
    '    const parts = line.split("\\t");',
    "    return { id: parts[0], status: parts[1], exitCode: parts[2] ? Number(parts[2]) : null };",
    "  });",
    'const ok = failedStep === "" && steps.every((step) => step.status !== "failed");',
    "const payload = {",
    "  planHash,",
    "  ok,",
    "  steps,",
    '  failedStep: failedStep === "" ? null : failedStep,',
    '  error: failedStep === "" ? null : "provisioning step " + failedStep + " failed",',
    "};",
    'fs.writeFileSync(outPath, JSON.stringify(payload) + "\\n", { mode: 0o600 });',
    "fs.chmodSync(outPath, 0o600);",
    "PASEO_MSB_STATUS",
    '  exit "$code"',
    "}",
    "trap finalize EXIT",
    'mkdir -p "$STATE_DIR" || { FAILED_STEP="setup"; exit 1; }',
    ': > "$STATUS_LINES" || { FAILED_STEP="setup"; exit 1; }',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional shell parameter expansion
    'if [ "${1:-}" != "$PLAN_HASH" ]; then',
    '  FAILED_STEP="plan-hash"',
    "  exit 1",
    "fi",
    "run_step() {",
    '  step_id="$1"',
    '  step_probe="$2"',
    '  step_action="$3"',
    '  if sh -c "$step_probe" >/dev/null 2>&1; then',
    '    record "$step_id" skipped 0',
    "    return 0",
    "  fi",
    '  if sh -c "$step_action"; then',
    '    if sh -c "$step_probe" >/dev/null 2>&1; then',
    '      record "$step_id" ok 0',
    "      return 0",
    "    fi",
    '    record "$step_id" failed 1',
    '    FAILED_STEP="$step_id"',
    "    exit 1",
    "  fi",
    "  step_code=$?",
    '  record "$step_id" failed "$step_code"',
    '  FAILED_STEP="$step_id"',
    "  exit 1",
    "}",
  ];

  for (const step of steps) {
    lines.push(
      `run_step ${shellQuote(step.id)} ${shellQuote(step.probe)} ${shellQuote(step.action)}`,
    );
  }

  return `${lines.join("\n")}\n`;
}

import { FAKE_SECRET_MARKERS } from "./fake-secrets.mjs";

export const ACCEPTANCE = [
  {
    id: "pins",
    title: "Pinned versions and digest",
    prefixes: ["pins."],
    runtimeRequired: false,
  },
  {
    id: "guest",
    runtimeRequired: true,
    title: "Guest Node, npm, init, non-root Pi, PATH",
    prefixes: ["guest.", "init."],
  },
  {
    id: "port",
    runtimeRequired: true,
    title: "Loopback publishing and release",
    prefixes: ["port."],
  },
  {
    id: "persistence",
    runtimeRequired: true,
    title: "Detached survival, stable IDs, labels, config, logs, jobs",
    prefixes: ["persist."],
  },
  {
    id: "parent",
    runtimeRequired: true,
    title: "Registration, routed online, refresh, removal",
    prefixes: ["parent."],
  },
  {
    id: "secrets",
    runtimeRequired: true,
    title: "Header-only substitution and blocked destinations",
    prefixes: ["secrets."],
  },
];

function trimDetail(value) {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

export class Report {
  constructor(meta) {
    this.meta = meta;
    this.checks = [];
    this.startedAt = new Date().toISOString();
  }

  add(id, title, status, options = {}) {
    const check = {
      id,
      title,
      status,
      kind: options.kind ?? "runtime",
      detail: trimDetail(options.detail),
      evidence: options.evidence ?? undefined,
      blocker: options.blocker ?? undefined,
    };
    this.checks.push(check);
    return check;
  }

  pass(id, title, options = {}) {
    return this.add(id, title, "pass", options);
  }

  staticPass(id, title, options = {}) {
    return this.add(id, title, "static-pass", { ...options, kind: "static" });
  }

  contractPass(id, title, options = {}) {
    return this.add(id, title, "pass", { ...options, kind: "contract" });
  }

  fail(id, title, options = {}) {
    return this.add(id, title, "fail", options);
  }

  blocked(id, title, options = {}) {
    return this.add(id, title, "blocked", options);
  }

  skip(id, title, options = {}) {
    return this.add(id, title, "skip", options);
  }

  groupStatus(prefixes) {
    const checks = this.checks.filter((check) => prefixes.some((prefix) => check.id.startsWith(prefix)));
    if (checks.length === 0) return "blocked";
    if (checks.some((check) => check.status === "fail")) return "fail";
    if (checks.some((check) => check.status === "blocked")) return "blocked";
    if (checks.every((check) => check.kind === "static" || check.status === "pass")) {
      return checks.some((check) => check.kind === "runtime") ? "pass" : "static-only";
    }
    return "blocked";
  }

  acceptance() {
    return ACCEPTANCE.map((group) => {
      const status = this.groupStatus(group.prefixes);
      return {
        ...group,
        status: status === "static-only" && !group.runtimeRequired ? "pass" : status,
      };
    });
  }

  runtimeVerified() {
    return this.acceptance().every((group) => group.status === "pass");
  }

  redact(text) {
    let value = text;
    for (const marker of FAKE_SECRET_MARKERS) {
      value = value.split(marker).join("<redacted-fake-secret>");
    }
    return value;
  }

  hasFakeSecretLeak(text) {
    return FAKE_SECRET_MARKERS.some((marker) => text.includes(marker));
  }

  finalize() {
    this.finishedAt = new Date().toISOString();
    const acceptance = this.acceptance();
    const counts = this.checks.reduce(
      (accumulator, check) => {
        accumulator[check.status] = (accumulator[check.status] ?? 0) + 1;
        return accumulator;
      },
      { pass: 0, "static-pass": 0, fail: 0, blocked: 0, skip: 0 },
    );
    const blockers = this.checks
      .filter((check) => check.status === "blocked" || check.status === "fail")
      .map((check) => ({
        id: check.id,
        status: check.status,
        blocker: check.blocker ?? check.detail,
      }));
    const result = {
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      meta: this.meta,
      acceptance,
      runtimeVerified: acceptance.every((group) => group.status === "pass"),
      counts,
      blockers,
      checks: this.checks,
    };
    let json = JSON.stringify(result, null, 2);
    if (this.hasFakeSecretLeak(json)) {
      result.checks.push({
        id: "secrets.no-leak",
        title: "Fake secret values stay out of the report",
        status: "fail",
        kind: "static",
        detail: "A fake secret marker reached the report; values were redacted before output.",
      });
      result.counts.fail += 1;
      result.runtimeVerified = false;
      result.acceptance = acceptance.map((group) =>
        group.prefixes.some((prefix) => "secrets.no-leak".startsWith(prefix))
          ? { ...group, status: "fail" }
          : group,
      );
      json = this.redact(JSON.stringify(result, null, 2));
    }
    return { result, json: json + "\n" };
  }
}

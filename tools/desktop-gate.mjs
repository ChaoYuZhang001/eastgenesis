#!/usr/bin/env node
// 桌面端确定性发布闸门：把本地协议、Provider 恢复和前端回归汇总为一份脱敏证据。
// 默认不读取真实凭据、不启动真实供应商；显式 --include-real 才把环境变量传给双 Provider smoke。
import { spawn } from "node:child_process";

const jsonOutput = process.argv.includes("--json");
const includeBundle = process.argv.includes("--include-bundle");
const includePackage = process.argv.includes("--include-package");
const includeReal = process.argv.includes("--include-real");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

const stages = [];

function safeError(error) {
  if (!error || typeof error !== "object") return "unknown error";
  const message = error.message;
  return typeof message === "string" ? message.slice(0, 240) : "command failed";
}

function parseJson(stdout) {
  const text = stdout.trim();
  if (!text) throw new Error("command returned no JSON");
  return JSON.parse(text);
}

function summarizeEvidence(name, value) {
  if (name === "fixture") {
    return {
      schemaVersion: value.schemaVersion ?? null,
      scenarios: Array.isArray(value.scenarios) ? value.scenarios.length : 0,
      passedScenarios: Array.isArray(value.scenarios) ? value.scenarios.filter((s) => s?.passed).length : 0,
    };
  }
  if (name === "provider" || name === "provider-real") {
    return {
      schemaVersion: value.schemaVersion ?? null,
      mode: value.mode ?? null,
      scenarios: Array.isArray(value.scenarios) ? value.scenarios.length : 0,
      passedScenarios: Array.isArray(value.scenarios) ? value.scenarios.filter((s) => s?.passed).length : 0,
      recovery: Array.isArray(value.recovery) ? value.recovery.length : 0,
      passedRecovery: Array.isArray(value.recovery) ? value.recovery.filter((s) => s?.passed).length : 0,
      providerPassed: value.passed === true,
    };
  }
  if (name === "routing") {
    return {
      schemaVersion: value.schemaVersion ?? null,
      gate: value.gate ?? null,
      routingAccuracy: value.evaluation?.primary?.routingAccuracy ?? null,
      holdoutRoutingAccuracy: value.evaluation?.holdout?.routingAccuracy ?? null,
      total: value.evaluation?.primary?.total ?? null,
      checks: value.checks ?? null,
      routingPassed: value.passed === true,
    };
  }
  if (name === "package") {
    return {
      schemaVersion: value.schemaVersion ?? null,
      restartCycles: value.restartCycles ?? 0,
      launches: Array.isArray(value.launches) ? value.launches.length : 0,
      checks: value.checks ?? null,
      packagePassed: value.passed === true,
    };
  }
  return undefined;
}

async function runCommand(name, args, { json = false, required = true } = {}) {
  const startedAt = Date.now();
  const result = await new Promise((resolve) => {
    const child = spawn(pnpm, args, { cwd: process.cwd(), env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => resolve({ code: null, signal: null, stdout, stderr, error }));
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr, error: null }));
  });

  const row = {
    name,
    command: ["pnpm", ...args].join(" "),
    required,
    status: result.code === 0 ? "passed" : "failed",
    exitCode: result.code,
    signal: result.signal,
    durationMs: Date.now() - startedAt,
  };
  if (result.error) row.error = safeError(result.error);
  if (json && result.code === 0) {
    try {
      const evidence = parseJson(result.stdout);
      row.evidence = summarizeEvidence(name, evidence);
      if (evidence?.passed === false) row.status = "failed";
    } catch (error) {
      row.status = "failed";
      row.error = `invalid JSON evidence: ${safeError(error)}`;
    }
  }
  stages.push(row);
  return row;
}

async function runIncludedStage(name, args) {
  return runCommand(name, args, { required: true });
}

await runCommand("fixture", ["--silent", "desktop:fixture:smoke", "--", "--json"], { json: true });
await runCommand("provider", ["--silent", "provider:matrix", "--", "--json"], { json: true });
if (includeReal) {
  await runCommand("provider-real", ["--silent", "provider:matrix", "--", "--real", "--json"], { json: true });
} else {
  stages.push({ name: "provider-real", required: false, status: "not_run", reason: "use --include-real with explicit primary/fallback environment variables" });
}
await runCommand("routing", ["--silent", "routing:gate", "--", "--json"], { json: true });
await runCommand("typecheck", ["typecheck"]);
await runCommand("test", ["test"]);
await runCommand("build", ["build"]);

if (includeBundle) {
  await runIncludedStage("bundle", ["desktop:bundle:smoke"]);
} else {
  stages.push({ name: "bundle", required: false, status: "not_run", reason: "use --include-bundle after a desktop bundle exists" });
}

if (includePackage) {
  if (process.platform !== "darwin") {
    stages.push({ name: "package", required: false, status: "not_run", reason: "package smoke currently requires macOS" });
  } else {
    await runCommand("package", ["--silent", "desktop:package:smoke", "--", "--json"], { json: true, required: true });
  }
} else {
  stages.push({ name: "package", required: false, status: "not_run", reason: "use --include-package for the native QA package smoke" });
}

const requiredFailures = stages.filter((stage) => stage.required && stage.status !== "passed");
const report = {
  schemaVersion: 1,
  gate: "desktop-deterministic",
  generatedAt: new Date().toISOString(),
  passed: requiredFailures.length === 0,
  stages,
  evidenceBoundary: {
    proven: ["local stream protocol fixtures", "production adapter error normalization", "task-level fallback and partial-output policy", "deterministic routing quality replay", "frontend typecheck/tests/build", ...(includeReal ? ["explicit real Provider stream connectivity smoke"] : [])],
    excluded: ["real provider availability or SLA", "real Tauri WebView interaction", "code signing/notarization", "Windows/Linux native install and upgrade"],
  },
};

if (jsonOutput) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`desktop gate ${report.passed ? "passed" : "failed"}`);
  for (const stage of stages) {
    const suffix = stage.status === "not_run" ? ` (${stage.reason})` : ` (${stage.durationMs ?? 0} ms)`;
    console.log(`${stage.status === "passed" ? "PASS" : stage.status === "not_run" ? "SKIP" : "FAIL"} ${stage.name}${suffix}`);
  }
}

if (!report.passed) process.exitCode = 1;

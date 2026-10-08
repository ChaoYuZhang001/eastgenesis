#!/usr/bin/env node
// 无外网的受控双 Provider smoke：用 loopback fixture 驱动 provider:matrix --real，
// 让 CI 验证真实模式的配置、脱敏和 routedLlm 恢复组合，但不读取真实凭据。
import { writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";

const args = process.argv.slice(2);
const jsonOutput = args.includes("--json");
const outputIndex = args.indexOf("--output");
const output = outputIndex >= 0 ? args[outputIndex + 1] : undefined;
if (outputIndex >= 0 && (!output || output.startsWith("--"))) throw new Error("--output 需要一个文件路径");

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
let baseUrl;
const boundary = {
  proven: [
    "loopback fixture 驱动的 real_opt_in 双 Provider 流式 smoke",
    "受控 primary 故障后的真实模式 fallback 组合",
    "部分输出后停止真实模式 fallback 链",
  ],
  excluded: [
    "真实供应商账号、真实 primary 上游故障和真实网络 SLA",
    "真实桌面 WebView、跨平台安装升级和签名公证",
  ],
};

function safeFailure(reason, diagnostic) {
  return {
    schemaVersion: 1,
    matrix: "provider-recovery",
    mode: "real_opt_in",
    passed: false,
    scenarios: [],
    recovery: [],
    recoveryStatus: "failed",
    evidenceBoundary: boundary,
    failure: reason,
    ...(diagnostic ? { diagnostic } : {}),
  };
}

function sanitizeDiagnostic(value) {
  return value
    .replaceAll(/https?:\/\/127\.0\.0\.1:\d+/g, "<loopback>")
    .replaceAll(/(?:[A-Za-z]:)?[^;\s]*(?:\\|\/)[^;\s]*/g, "<path>")
    .trim()
    .slice(-400);
}

function classifyFailure(...values) {
  const text = values.filter(Boolean).join("\n");
  if (/EADDRINUSE|address already in use/i.test(text)) return "loopback fixture port unavailable";
  if (/spawn .*ENOENT|not recognized|cannot find/i.test(text)) return "provider matrix executable unavailable";
  if (/fixture exited before readiness/i.test(text)) return "loopback fixture exited before readiness";
  if (/fixture did not report a loopback address/i.test(text)) return "loopback fixture did not report its address";
  if (/readiness timeout|did not become ready/i.test(text)) return "loopback fixture readiness timeout";
  if (/JSON|parse/i.test(text)) return "provider matrix returned invalid JSON";
  return reasonFromExit(text);
}

function reasonFromExit(text) {
  return text.trim() ? "provider matrix process failed" : "controlled recovery process failed";
}

async function waitForFixture(child, readOutput) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("fixture exited before readiness");
    const match = readOutput().match(/desktop-stream-fixture listening on (http:\/\/127\.0\.0\.1:\d+)/);
    if (match) baseUrl = match[1];
    if (!baseUrl) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      continue;
    }
    try {
      const response = await fetch(`${baseUrl}/staged/v1/models`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return;
    } catch {
      // The fixture may need a short time to bind its loopback port.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("fixture readiness timeout");
}

function close(child) {
  if (child.exitCode !== null) return Promise.resolve();
  child.kill("SIGTERM");
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 2_000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
  });
}

async function run() {
  let fixtureOutput = "";
  let matrixStderr = "";
  const fixture = spawn(process.execPath, ["tools/desktop-stream-fixture.mjs"], {
    env: { ...process.env, EG_FIXTURE_PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  fixture.stdout.setEncoding("utf8");
  fixture.stderr.setEncoding("utf8");
  fixture.stdout.on("data", (chunk) => { fixtureOutput += chunk; });
  fixture.stderr.on("data", (chunk) => { fixtureOutput += chunk; });
  try {
    await waitForFixture(fixture, () => fixtureOutput);
    const env = {
      ...process.env,
      EG_MATRIX_PROTOCOL: "openai",
      EG_MATRIX_BASE_URL: `${baseUrl}/staged/v1`,
      EG_MATRIX_API_KEY: "synthetic-primary-key",
      EG_MATRIX_MODEL: "fixture-model",
      EG_MATRIX_FALLBACK_PROTOCOL: "openai",
      EG_MATRIX_FALLBACK_BASE_URL: `${baseUrl}/staged/v1`,
      EG_MATRIX_FALLBACK_API_KEY: "synthetic-fallback-key",
      EG_MATRIX_FALLBACK_MODEL: "fixture-model",
    };
    const child = spawn(pnpm, ["--silent", "provider:matrix", "--", "--real", "--json"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      // Windows exposes pnpm as a .cmd shim; Node needs a shell to launch it.
      shell: process.platform === "win32",
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { matrixStderr += chunk; });
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    const exitCode = await new Promise((resolve) => child.once("close", resolve));
    let report;
    try {
      report = JSON.parse(stdout);
    } catch {
      report = safeFailure("provider matrix did not return JSON");
    }
    if (exitCode !== 0 || report?.passed !== true || report?.recoveryStatus !== "partial") {
      report = { ...safeFailure("controlled recovery assertions failed"), ...(report && typeof report === "object" ? { observed: { passed: report.passed === true, recoveryStatus: report.recoveryStatus ?? null } } : {}) };
    }
    // The wrapper itself only emits the matrix report; never include the synthetic
    // base URL or key in the saved artifact.
    if (JSON.stringify(report).includes(baseUrl) || JSON.stringify(report).includes("synthetic-")) {
      report = safeFailure("redaction boundary failed");
    }
    return report;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const diagnostic = sanitizeDiagnostic(`${detail}\n${fixtureOutput}\n${matrixStderr}`);
    throw new Error(`${classifyFailure(detail, fixtureOutput, matrixStderr)}${diagnostic ? `: ${diagnostic}` : ""}`);
  } finally {
    await close(fixture);
  }
}

const report = await run().catch((error) => {
  const reason = error instanceof Error ? error.message : "controlled recovery process failed";
  return safeFailure(reason, sanitizeDiagnostic(String(error)));
});
const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (output) await writeFile(output, serialized, "utf8");
if (jsonOutput || output) {
  if (jsonOutput && !output) process.stdout.write(serialized);
} else {
  console.log(`provider controlled recovery ${report.passed ? "passed" : "failed"}`);
}
if (!report.passed) process.exitCode = 1;

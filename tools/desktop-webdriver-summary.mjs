#!/usr/bin/env node
// 将 Linux / Windows 原生 WebView smoke 的每场景 JSON 汇总成一份稳定的
// 机器可读边界。只复制固定的状态字段，不把 stdout、路径或驱动日志带入汇总。
import { readFile, writeFile } from "node:fs/promises";

const args = process.argv.slice(2);
const outputIndex = args.indexOf("--output");
const output = outputIndex >= 0 ? args[outputIndex + 1] : undefined;
if (outputIndex >= 0 && (!output || output.startsWith("--"))) throw new Error("--output 需要一个文件路径");
const files = args.filter((arg, index) => arg !== "--output" && index !== outputIndex + 1 && !arg.startsWith("--"));
const expected = new Set(["staged", "slow-first-token", "truncated", "idle-cancel"]);
const errors = [];
const records = [];

for (const file of files) {
  const label = file.split(/[\\/]/).pop() || "webdriver evidence";
  let value;
  try {
    value = JSON.parse(await readFile(file, "utf8"));
  } catch {
    errors.push(`${label}: JSON 无法读取`);
    continue;
  }
  const scenario = value?.checks?.fixtureScenario;
  if (!expected.has(scenario)) {
    errors.push(`${label}: 缺少合法 fixtureScenario`);
    continue;
  }
  if (records.some((record) => record.scenario === scenario)) {
    errors.push(`重复场景：${scenario}`);
    continue;
  }
  const checks = value.checks;
  const required = scenario === "truncated"
    ? ["partialOutputPreserved", "terminalFailureVisible"]
    : scenario === "idle-cancel"
      ? ["cancelControl", "cancelledResult"]
      : ["streamingFirstChunk", "completedResult"];
  const requiredBase = ["nativeWebDriverSession", "documentTitle", "taskInput", "routePreview", "submitState"];
  if (value.passed !== true || !checks || requiredBase.some((key) => checks[key] !== true) || required.some((key) => checks[key] !== true)) {
    errors.push(`${scenario}: smoke 未通过固定检查`);
  }
  records.push({
    scenario,
    passed: value.passed === true && requiredBase.every((key) => checks?.[key] === true) && required.every((key) => checks?.[key] === true),
    ...(Number.isFinite(checks?.firstChunkLatencyMs) ? { firstChunkLatencyMs: checks.firstChunkLatencyMs } : {}),
    ...(Number.isFinite(checks?.firstOutputLatencyMs) ? { firstOutputLatencyMs: checks.firstOutputLatencyMs } : {}),
    checks: Object.fromEntries(required.map((key) => [key, checks?.[key] === true])),
  });
}

for (const scenario of expected) if (!records.some((record) => record.scenario === scenario)) errors.push(`缺少场景：${scenario}`);

const report = {
  schemaVersion: 1,
  kind: "desktop-webdriver-suite",
  passed: errors.length === 0 && records.length === expected.size,
  scenarios: [...records].sort((a, b) => [...expected].indexOf(a.scenario) - [...expected].indexOf(b.scenario)),
  ...(errors.length ? { errors: errors.slice(0, 20) } : {}),
  evidenceBoundary: {
    proven: reportProven(),
    excluded: ["real Provider", "filesystem dialog", "ledger crash recovery", "code signing/notarization"],
  },
};

function reportProven() {
  return ["native WebDriver session", "Tauri WebView DOM", "route preview and task submission", "streaming success/partial-output/cancellation controls"];
}

const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (output) await writeFile(output, serialized, "utf8");
else process.stdout.write(serialized);
if (!report.passed) process.exitCode = 1;

#!/usr/bin/env node
// 将 Linux / Windows 原生 WebView smoke 的每场景 JSON 汇总成一份稳定的
// 机器可读边界。只复制固定的状态字段，不把 stdout、路径或驱动日志带入汇总。
import { readFile, writeFile } from "node:fs/promises";
import { BODY_DELTA_METRIC, BODY_DELTA_SOURCE, TERMINAL_METRIC, TERMINAL_SOURCE, normalizeReportedMeasurement, describeLatencySamples } from "./desktop-stream-measurement.mjs";
import { sanitizeReportedProviderIpcTiming } from "./desktop-ipc-timing.mjs";

const args = process.argv.slice(2);
const outputIndex = args.indexOf("--output");
const output = outputIndex >= 0 ? args[outputIndex + 1] : undefined;
if (outputIndex >= 0 && (!output || output.startsWith("--"))) throw new Error("--output 需要一个文件路径");
const outputValueIndex = outputIndex >= 0 ? outputIndex + 1 : -1;
const files = args.filter((arg, index) => arg !== "--output" && index !== outputValueIndex && !arg.startsWith("--"));
const expected = new Set(["staged", "slow-first-token", "truncated", "idle-cancel"]);
const errors = [];
const records = [];

for (const [fileIndex, file] of files.entries()) {
  // 输入文件名可能包含临时目录、Provider 标识或其它本机信息；错误证据只使用固定序号。
  const label = `输入文件 ${fileIndex + 1}`;
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
    measurements: {
      firstBodyDelta: normalizeReportedMeasurement(checks?.firstBodyDeltaMeasurement, BODY_DELTA_METRIC, BODY_DELTA_SOURCE, scenario === "truncated" ? checks?.firstOutputLatencyMs : checks?.firstChunkLatencyMs),
      terminalObserved: normalizeReportedMeasurement(checks?.terminalObservedMeasurement, TERMINAL_METRIC, TERMINAL_SOURCE, checks?.terminalObservedLatencyMs),
      nativeStreamIpc: sanitizeReportedProviderIpcTiming(checks?.nativeIpcTimingMeasurement),
    },
    checks: Object.fromEntries(required.map((key) => [key, checks?.[key] === true])),
  });
}

for (const scenario of expected) if (!records.some((record) => record.scenario === scenario)) errors.push(`缺少场景：${scenario}`);

const report = {
  schemaVersion: 1,
  kind: "desktop-webdriver-suite",
  passed: errors.length === 0 && records.length === expected.size,
  scenarios: [...records].sort((a, b) => [...expected].indexOf(a.scenario) - [...expected].indexOf(b.scenario)),
  timing: {
    metric: "webview-qa-fixture-descriptive-measurements",
    combinedScenarioPercentiles: false,
    byScenario: [...records].sort((a, b) => [...expected].indexOf(a.scenario) - [...expected].indexOf(b.scenario)).map((record) => ({
      scenario: record.scenario,
      firstBodyDelta: describeLatencySamples([record.measurements.firstBodyDelta]),
      terminalObserved: describeLatencySamples([record.measurements.terminalObserved]),
      nativeStreamIpc: record.measurements.nativeStreamIpc,
    })),
    interpretation: "按合成 fixture 场景分别记录点击命令前到任务 store 首个正文增量及终态文本观测的描述样本；n=1 不计算分位数，不构成性能分布基线；不代表首帧、模型首 token、真实 Provider、冷暖启动或资源基线",
  },
  ...(errors.length ? { errors: errors.slice(0, 20) } : {}),
  evidenceBoundary: {
    proven: reportProven(),
    excluded: ["real Provider", "filesystem dialog", "ledger crash recovery", "code signing/notarization", "first paint or model first-token measurement", "cold/warm startup or resource baseline"],
  },
};

function reportProven() {
  return ["native WebDriver session", "Tauri WebView DOM", "route preview and task submission", "streaming success/partial-output/cancellation controls"];
}

const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (output) await writeFile(output, serialized, "utf8");
else process.stdout.write(serialized);
if (!report.passed) process.exitCode = 1;

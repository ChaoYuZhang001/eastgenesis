#!/usr/bin/env node
// 路由质量确定性门禁：只回放脱敏标注样例，不调用 Provider、不读取 Key、不保存任务正文。
import { spawn } from "node:child_process";

const jsonOutput = process.argv.includes("--json");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const MIN_ROUTING_ACCURACY = 0.7;

function run(command, flags = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(pnpm, ["--silent", "eg", command, ...flags, "--json"], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code !== 0) reject(new Error(`${command} exit=${code ?? "null"}${signal ? ` signal=${signal}` : ""}`));
      else {
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error(`${command} returned invalid JSON`));
        }
      }
    });
  });
}

const evaluation = await run("eval-routing");
const holdout = await run("eval-routing", ["--holdout"]);
const benchmark = await run("bench");
const report = evaluation?.report;
const holdoutReport = holdout?.report;
const scenarios = Array.isArray(benchmark?.scenarios) ? benchmark.scenarios : [];
const routingAccuracy = typeof report?.routingAccuracy === "number" ? report.routingAccuracy : 0;
const holdoutRoutingAccuracy = typeof holdoutReport?.routingAccuracy === "number" ? holdoutReport.routingAccuracy : 0;
const smartRows = scenarios.flatMap((scenario) => (Array.isArray(scenario.rows) ? scenario.rows.filter((row) => row?.model === null).map((row) => ({
  scenario: scenario.id,
  strategy: row.strategy,
  hardOk: row.hardOk,
  survive: row.survive,
})) : []));
const checks = {
  routingAccuracy: routingAccuracy >= MIN_ROUTING_ACCURACY,
  holdoutRoutingAccuracy: holdoutRoutingAccuracy >= MIN_ROUTING_ACCURACY,
  smartRouteHardCapabilities: smartRows.length > 0 && smartRows.every((row) => row.hardOk === 1),
  smartRouteProviderRecovery: smartRows.length > 0 && smartRows.every((row) => row.survive === 1),
};
const passed = Object.values(checks).every(Boolean);
const output = {
  schemaVersion: 1,
  gate: "routing-quality",
  passed,
  thresholds: { routingAccuracy: MIN_ROUTING_ACCURACY, holdoutRoutingAccuracy: MIN_ROUTING_ACCURACY, smartRouteHardCapabilities: 1, smartRouteProviderRecovery: 1 },
  evaluation: {
    primary: {
      total: Number(report?.total ?? 0),
      routingAccuracy,
      typeAccuracy: Number(report?.typeAccuracy ?? 0),
      strictAccuracy: Number(report?.strictAccuracy ?? 0),
      failureCount: Array.isArray(report?.failures) ? report.failures.length : 0,
    },
    holdout: {
      total: Number(holdoutReport?.total ?? 0),
      routingAccuracy: holdoutRoutingAccuracy,
      typeAccuracy: Number(holdoutReport?.typeAccuracy ?? 0),
      strictAccuracy: Number(holdoutReport?.strictAccuracy ?? 0),
      failureCount: Array.isArray(holdoutReport?.failures) ? holdoutReport.failures.length : 0,
    },
  },
  scenarios: smartRows,
  checks,
  evidenceBoundary: {
    proven: ["deterministic labeled routing replay", "hard capability selection floor", "fallback-chain coverage under configured Provider scenarios"],
    excluded: ["real Provider quality or latency", "real task answer quality", "real WebView behavior", "production routing SLA"],
  },
};

if (jsonOutput) console.log(JSON.stringify(output, null, 2));
else {
  console.log(`routing gate ${passed ? "passed" : "failed"}: ${(routingAccuracy * 100).toFixed(1)}% routing accuracy`);
  for (const [name, ok] of Object.entries(checks)) console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
}
if (!passed) process.exitCode = 1;

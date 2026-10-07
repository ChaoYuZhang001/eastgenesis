#!/usr/bin/env node
// 校验跨进程目标恢复证据，只证明结构和脱敏边界，不外推为 WebView 或 Provider 通过。
import { readFile } from "node:fs/promises";
import { validateGoalRecoveryEvidence } from "./goal-recovery-evidence.mjs";

const source = process.argv[2] ?? "-";

function readStdin() {
  return new Promise((resolve, reject) => {
    let value = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { value += chunk; });
    process.stdin.once("end", () => resolve(value));
    process.stdin.once("error", reject);
  });
}

let evidence;
let parseError = null;
try {
  evidence = JSON.parse(source === "-" ? await readStdin() : await readFile(source, "utf8"));
} catch {
  parseError = "输入不是合法 JSON";
}

const result = parseError ? { valid: false, errors: [parseError] } : validateGoalRecoveryEvidence(evidence);
const report = {
  schemaVersion: 1,
  valid: result.valid,
  source: source === "-" ? "stdin" : "file",
  ...(result.valid
    ? {
        kind: evidence.kind,
        goalStatus: evidence.goalStatus,
        taskId: evidence.taskId,
        runCalls: evidence.runCalls,
        ledgerState: evidence.ledgerState,
        boundary: "结构和脱敏边界通过；不证明真实 WebView、Provider 或桌面安装验收",
      }
    : { errors: result.errors }),
};
console.log(JSON.stringify(report, null, 2));
if (!result.valid) process.exitCode = 1;

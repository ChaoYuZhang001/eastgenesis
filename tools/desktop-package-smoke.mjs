#!/usr/bin/env node
// Mac QA 包的启动/接线烟测。它不操作 webview，不验证真实 Provider，
// 只证明打包后的二进制能启动、保留流式/QA 接线，并且一次受控退出后可以再次启动。
import { access } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { spawn } from "node:child_process";

const execFileAsync = promisify(execFile);
// Tauri 的 `--features qa-faults` 不改变 bundle 名称；默认使用最近一次
// `pnpm tauri:build:mac:qa` 生成的 EastGenesis Desktop.app。也可显式传入路径。
const packageArg = process.argv.slice(2).find((arg) => arg !== "--" && !arg.startsWith("-"));
const packageBinary = packageArg ?? "target/release/bundle/macos/EastGenesis Desktop.app/Contents/MacOS/eastgenesis-desktop";
const RESTART_CYCLES = 2;
const jsonOutput = process.argv.includes("--json");

if (process.platform !== "darwin") {
  throw new Error("desktop:package:smoke currently requires macOS; use a native runner for other platforms");
}

await access(packageBinary);
const symbols = await execFileAsync("strings", [packageBinary]);
for (const symbol of ["provider_stream", "EASTGENESIS_QA_FAULT_POINT"]) {
  if (!symbols.stdout.includes(symbol)) throw new Error(`QA package is missing ${symbol}`);
}

const launches = [];
for (let cycle = 1; cycle <= RESTART_CYCLES; cycle++) {
  const startedAt = performance.now();
  const child = spawn(packageBinary, [], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  let exited = false;
  let exitResult = null;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  child.once("exit", (code, signal) => {
    exited = true;
    exitResult = { code, signal };
  });

  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 4_000);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", () => {
        clearTimeout(timer);
        reject(new Error(`QA package exited before startup window (cycle ${cycle}): ${JSON.stringify(exitResult)}`));
      });
    });
    if (exited) throw new Error(`QA package was not alive after startup window (cycle ${cycle}): ${JSON.stringify(exitResult)}`);
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
    if (exitResult?.signal !== "SIGTERM" && exitResult?.code !== 143 && exitResult?.code !== -15) {
      throw new Error(`QA package did not exit from SIGTERM (cycle ${cycle}): ${JSON.stringify(exitResult)}`);
    }
    launches.push({ cycle, startupMs: Math.round(performance.now() - startedAt), exit: exitResult });
  } finally {
    if (!exited) child.kill("SIGKILL");
    if (output.trim()) process.stderr.write(output);
  }
}

const report = {
  schemaVersion: 1,
  kind: "desktop-package-smoke",
  passed: true,
  platform: process.platform,
  packageBinary,
  restartCycles: RESTART_CYCLES,
  checks: {
    providerStreamSymbol: true,
    qaFaultSymbol: true,
    restartableProcess: launches.length === RESTART_CYCLES,
    controlledTermination: launches.every((launch) => launch.exit.signal === "SIGTERM" || launch.exit.code === 143 || launch.exit.code === -15),
  },
  launches,
  evidenceBoundary: {
    proven: ["QA bundle contains provider stream and fault injection symbols", "native process survives the startup window", "a controlled exit can be followed by a second startup"],
    excluded: ["real WebView DOM interaction", "SQLite session recovery", "tool side-effect recovery", "real Provider availability", "signing/notarization"],
  },
};

if (jsonOutput) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`desktop package smoke passed (${RESTART_CYCLES} restart cycles; qa-faults build expected): ${packageBinary}`);
  for (const launch of launches) console.log(`- cycle ${launch.cycle}: startup window ${launch.startupMs}ms, exit ${JSON.stringify(launch.exit)}`);
}

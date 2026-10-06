#!/usr/bin/env node
// Mac QA 包的启动/接线烟测。它不操作 webview，不验证真实 Provider，
// 只证明打包后的二进制能启动、保留流式/QA 接线并可受控退出。
import { access } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { spawn } from "node:child_process";

const execFileAsync = promisify(execFile);
// Tauri 的 `--features qa-faults` 不改变 bundle 名称；默认使用最近一次
// `pnpm tauri:build:mac:qa` 生成的 EastGenesis Desktop.app。也可显式传入路径。
const packageBinary = process.argv[2] ?? "target/release/bundle/macos/EastGenesis Desktop.app/Contents/MacOS/eastgenesis-desktop";

if (process.platform !== "darwin") {
  throw new Error("desktop:package:smoke currently requires macOS; use a native runner for other platforms");
}

await access(packageBinary);
const symbols = await execFileAsync("strings", [packageBinary]);
for (const symbol of ["provider_stream", "EASTGENESIS_QA_FAULT_POINT"]) {
  if (!symbols.stdout.includes(symbol)) throw new Error(`QA package is missing ${symbol}`);
}

const child = spawn(packageBinary, [], { stdio: ["ignore", "pipe", "pipe"] });
let output = "";
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => { output += chunk; });
child.stderr.on("data", (chunk) => { output += chunk; });

let exited = false;
let exitResult = null;
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
      reject(new Error(`QA package exited before startup window: ${JSON.stringify(exitResult)}`));
    });
  });
  if (exited) throw new Error(`QA package was not alive after startup window: ${JSON.stringify(exitResult)}`);
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
  if (exitResult?.signal !== "SIGTERM" && exitResult?.code !== 143 && exitResult?.code !== -15) {
    throw new Error(`QA package did not exit from SIGTERM: ${JSON.stringify(exitResult)}`);
  }
  console.log(`desktop package smoke passed (qa-faults build expected): ${packageBinary}`);
} finally {
  if (!exited) child.kill("SIGKILL");
  if (output.trim()) process.stderr.write(output);
}

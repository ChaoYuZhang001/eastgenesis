#!/usr/bin/env node
// Mac QA 包的启动/接线烟测。它不操作 webview，不验证真实 Provider，
// 只证明打包后的二进制能启动、保留流式/QA 接线，一次受控退出后可以再次启动，
// 并在隔离 HOME 中保留 Tauri SQLite 的结构；不操作 webview、不提交任务。
import { access, mkdtemp, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

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
const databaseChecks = [];
const sessionRowChecks = [];
const isolatedHome = await mkdtemp(join(tmpdir(), "eastgenesis-package-smoke-"));
const databasePath = join(isolatedHome, "Library", "Application Support", "com.eastgenesis.desktop", "eastgenesis.db");

async function inspectDatabase(cycle) {
  await access(databasePath);
  const query = "SELECT (SELECT value FROM app_meta WHERE key = 'schema_version') AS schema_version, EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sessions') AS sessions, EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tool_invocations') AS tool_invocations, EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'tool_invocations_lease') AS lease_index;";
  const result = await execFileAsync("sqlite3", ["-readonly", "-json", databasePath, query]);
  const row = JSON.parse(result.stdout.trim())[0];
  const check = {
    cycle,
    schemaVersion: Number(row?.schema_version),
    sessions: Number(row?.sessions) === 1,
    toolInvocations: Number(row?.tool_invocations) === 1,
    leaseIndex: Number(row?.lease_index) === 1,
  };
  if (check.schemaVersion !== 7 || !check.sessions || !check.toolInvocations || !check.leaseIndex) {
    throw new Error(`SQLite schema check failed (cycle ${cycle}): ${JSON.stringify(check)}`);
  }
  databaseChecks.push(check);
}

async function seedSessionSentinel() {
  await execFileAsync("sqlite3", [databasePath, "INSERT OR REPLACE INTO sessions (id, title, turns, created_at, updated_at) VALUES ('qa-restart-sentinel', 'QA restart sentinel', '[]', 1, 1);"]);
}

async function inspectSessionSentinel() {
  const result = await execFileAsync("sqlite3", ["-readonly", "-json", databasePath, "SELECT COUNT(*) AS n FROM sessions WHERE id = 'qa-restart-sentinel' AND deleted_at IS NULL;"]);
  const row = JSON.parse(result.stdout.trim())[0];
  const present = Number(row?.n) === 1;
  if (!present) throw new Error("SQLite session sentinel was not preserved across restart");
  sessionRowChecks.push({ present });
}

try {
  for (let cycle = 1; cycle <= RESTART_CYCLES; cycle++) {
    const startedAt = performance.now();
    const child = spawn(packageBinary, [], { env: { ...process.env, HOME: isolatedHome }, stdio: ["ignore", "pipe", "pipe"] });
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
      await inspectDatabase(cycle);
      if (cycle === 1) await seedSessionSentinel();
      if (cycle === RESTART_CYCLES) await inspectSessionSentinel();
      launches.push({ cycle, startupMs: Math.round(performance.now() - startedAt), exit: exitResult });
    } finally {
      if (!exited) child.kill("SIGKILL");
      if (output.trim()) process.stderr.write(output);
    }
  }
} finally {
  await rm(isolatedHome, { recursive: true, force: true });
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
    sqliteSchema: databaseChecks.length === RESTART_CYCLES && databaseChecks.every((check) => check.schemaVersion === 7),
    sqliteTables: databaseChecks.length === RESTART_CYCLES && databaseChecks.every((check) => check.sessions && check.toolInvocations && check.leaseIndex),
    sqliteSessionRow: sessionRowChecks.length === 1 && sessionRowChecks[0].present,
  },
  launches,
  database: { isolatedHome: true, checks: databaseChecks, sessionRow: sessionRowChecks },
  evidenceBoundary: {
    proven: ["QA bundle contains provider stream and fault injection symbols", "native process survives the startup window", "a controlled exit can be followed by a second startup", "Tauri SQLite schema 7 and recovery ledger tables persist across the isolated restart", "a synthetic session row remains in SQLite after the second process"],
    excluded: ["real WebView DOM interaction", "UI hydration of the persisted session", "task event recovery with a killed UI", "tool side-effect recovery", "real Provider availability", "signing/notarization"],
  },
};

if (jsonOutput) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`desktop package smoke passed (${RESTART_CYCLES} restart cycles; qa-faults build expected): ${packageBinary}`);
  for (const launch of launches) console.log(`- cycle ${launch.cycle}: startup window ${launch.startupMs}ms, exit ${JSON.stringify(launch.exit)}`);
}

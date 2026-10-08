#!/usr/bin/env node
// 把已通过脱敏校验的桌面证据封装成可归档的黄金路径记录。
// 该工具只增加场景/平台/构建元数据，不把记录解释成 WebView 或 Provider 已通过。
import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const args = process.argv.slice(2);
const valueFlags = new Set(["--input", "--output", "--scenario", "--platform", "--arch", "--build"]);
const options = new Map();
let positional;
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--") continue;
  if (valueFlags.has(arg)) {
    const value = args[++i];
    if (value === undefined || value.startsWith("--")) throw new Error(`${arg} 需要一个值`);
    options.set(arg, value);
  } else if (arg.startsWith("--")) {
    throw new Error(`未知参数：${arg}`);
  } else if (positional === undefined) {
    positional = arg;
  } else {
    throw new Error(`只能指定一个输入文件：${positional}`);
  }
}
const inputPath = options.get("--input") ?? positional ?? "-";
const outputPath = options.get("--output");
const scenario = options.get("--scenario");
const platform = options.get("--platform");
const arch = options.get("--arch") ?? process.arch;
const build = options.get("--build");

const scenarios = new Set(["staged", "slow-first-token", "truncated", "idle-cancel", "ledger-recovery", "directory-picker", "provider-failure"]);
const platforms = new Set(["macos", "windows", "linux"]);
const safeToken = (name, value) => {
  if (!value || !/^[A-Za-z0-9._+-]{1,120}$/.test(value)) throw new Error(`${name} 必须是 1-120 个安全标识字符`);
  return value;
};

if (!scenarios.has(scenario)) throw new Error(`--scenario 必须是：${[...scenarios].join(", ")}`);
if (!platforms.has(platform)) throw new Error(`--platform 必须是：${[...platforms].join(", ")}`);
safeToken("--arch", arch);
safeToken("--build", build);

async function readStdin() {
  let raw = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) raw += chunk;
  return raw;
}

const raw = inputPath === "-" ? await readStdin() : await readFile(inputPath, "utf8");
let evidence;
try {
  evidence = JSON.parse(raw);
} catch {
  throw new Error("输入不是合法 JSON");
}

const root = path.dirname(fileURLToPath(import.meta.url));
const validator = path.join(root, "desktop-evidence-validate.mjs");
const validation = await new Promise((resolve) => {
  const child = spawn(process.execPath, [validator], { cwd: path.dirname(root), stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.once("error", (error) => resolve({ code: 1, stdout, stderr: error.message }));
  child.once("close", (code) => resolve({ code, stdout, stderr }));
  child.stdin.end(raw);
});

if (validation.code !== 0) {
  if (validation.stdout.trim()) process.stderr.write(validation.stdout);
  if (validation.stderr.trim()) process.stderr.write(validation.stderr);
  process.exitCode = validation.code ?? 1;
} else {
  const record = {
    schemaVersion: 1,
    kind: "desktop-acceptance-record",
    recordedAt: new Date().toISOString(),
    scenario,
    environment: { platform, arch, build },
    evidence,
    boundary: "脱敏证据和人工记录元数据；不证明真实 WebView、Provider、签名或安装升级通过",
  };
  const serialized = JSON.stringify(record, null, 2);
  if (outputPath) await writeFile(outputPath, `${serialized}\n`, "utf8");
  else console.log(serialized);
}

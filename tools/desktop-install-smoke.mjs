#!/usr/bin/env node
// Linux package smoke: unpack a deb into an isolated prefix, verify its
// metadata/payload/dependencies, and start the installed binary in an
// isolated HOME. This deliberately does not call dpkg -i, mutate the host,
// claim an upgrade, or claim an AppImage/Windows/macOS install.
import { access, chmod, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { hasProcessExited, stopDetachedProcess } from "./desktop-process-cleanup.mjs";

const execFileAsync = promisify(execFile);
const args = process.argv.slice(2);
const jsonOutput = args.includes("--json") || args.includes("--output");
const outputPath = valueOf("--output");
const packageArg = valueOf("--package");
const format = (valueOf("--format") ?? "deb").toLowerCase();

function valueOf(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function fail(stage, detail = undefined) {
  const error = new Error(stage);
  error.stage = stage;
  error.detail = detail;
  throw error;
}

function reportFor({ passed, checks, packageInfo, install, errors = [] }) {
  return {
    schemaVersion: 1,
    kind: "desktop-install-smoke",
    passed,
    platform: "linux",
    format: "deb",
    checks,
    package: packageInfo,
    install,
    ...(errors.length ? { errors: errors.slice(0, 10) } : {}),
    evidenceBoundary: {
      proven: passed ? [
        "a Debian package was inspected without mutating the host package database",
        "the package payload was extracted under an isolated prefix",
        "the extracted binary dependencies were resolved on the Linux runner",
        "the extracted installed binary started and initialized its isolated SQLite database",
        "the process was terminated in a controlled way",
      ] : [],
      excluded: [
        "system dpkg installation or uninstall",
        "AppImage/RPM installation",
        "old-version to new-version upgrade",
        "automatic update or rollback",
        "real Provider availability",
        "signing/notarization",
      ],
    },
  };
}

async function command(name, commandArgs, stage) {
  try {
    return await execFileAsync(name, commandArgs, { maxBuffer: 4 * 1024 * 1024 });
  } catch (error) {
    fail(stage, error);
  }
}

async function findDeb() {
  const root = resolve("target/release/bundle/deb");
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    fail("package_missing");
  }
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".deb")) continue;
    const path = join(root, entry.name);
    const info = await stat(path).catch(() => null);
    if (info?.size > 0) candidates.push(path);
  }
  if (candidates.length !== 1) fail(candidates.length === 0 ? "package_missing" : "package_ambiguous");
  return candidates[0];
}

async function runProcess(binary, env, root) {
  const display = env.DISPLAY;
  const wrapper = !display ? "/usr/bin/xvfb-run" : null;
  if (wrapper) {
    try {
      await access(wrapper);
    } catch {
      fail("display_missing");
    }
  }
  const commandName = wrapper ?? binary;
  const commandArgs = wrapper
    ? ["--auto-servernum", "--server-args=-screen 0 1440x900x24", binary]
    : [];
  const child = spawn(commandName, commandArgs, {
    env,
    cwd: root,
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
  });
  let spawnError;
  child.once("error", (error) => { spawnError = error; });
  await new Promise((resolve) => setTimeout(resolve, 500));
  if (spawnError || hasProcessExited(child)) {
    // The caller does not receive the handle until this function returns.
    // An early wrapper exit can leave descendants; clean them before failing.
    if (child.pid) {
      try { await stopDetachedProcess(child); } catch {
        try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
      }
    }
    fail("process_start");
  }
  return child;
}

async function findDatabase(root) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const result = await command("find", [root, "-type", "f", "-name", "eastgenesis.db", "-print", "-quit"], "database_probe");
    const path = result.stdout.trim();
    if (path) return path;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  fail("database_timeout");
}

async function sqliteCheck(database) {
  // Python is present on the GitHub Ubuntu runner; unlike sqlite3, it is not
  // an extra package dependency of the desktop workflow.
  const script = [
    "import json, sqlite3, sys",
    "db = sqlite3.connect(sys.argv[1])",
    "row = db.execute(\"SELECT (SELECT value FROM app_meta WHERE key='schema_version') AS schema_version, EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='sessions') AS sessions, EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='tool_invocations') AS tool_invocations\").fetchone()",
    "print(json.dumps({'schemaVersion': int(row[0] or 0), 'sessions': bool(row[1]), 'toolInvocations': bool(row[2])}))",
  ].join(";");
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const result = await execFileAsync("python3", ["-c", script, database], { maxBuffer: 1024 * 1024 });
      const value = JSON.parse(result.stdout.trim());
      if (value.schemaVersion === 7 && value.sessions && value.toolInvocations) return value;
    } catch {
      // SQLite is created before migrations finish; keep polling until the
      // process either exposes schema 7 or the startup window expires.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  fail("database_schema");
}

let root;
let child;
let result;
try {
  if (process.platform !== "linux") fail("platform_unsupported");
  if (format !== "deb") fail("format_unsupported");
  const packagePath = packageArg ? resolve(packageArg) : await findDeb();
  try {
    await access(packagePath);
  } catch {
    fail("package_missing");
  }
  const packageStat = await stat(packagePath);
  if (!packageStat.isFile() || packageStat.size === 0) fail("package_empty");
  const metadataFormat = "--showformat=" + "${Package}\\n${Version}\\n${Architecture}\\n";
  const metadata = await command("dpkg-deb", ["--show", metadataFormat, packagePath], "package_metadata");
  const [name, version, architecture] = metadata.stdout.trim().split("\n");
  if (!name || !version || !architecture) fail("package_metadata");
  const listing = await command("dpkg-deb", ["--contents", packagePath], "package_contents");
  const binaryEntry = listing.stdout
    .split(/\r?\n/)
    .map((line) => line.match(/(?:^|\s)(?:\.\/)?(usr\/bin\/[^\s/]+)\s*$/i))
    .map((match) => match?.[1])
    .find((path) => path && /eastgenesis/i.test(path));
  if (!binaryEntry) fail("payload_missing");

  root = await mkdtemp(join(tmpdir(), "eastgenesis-install-smoke-"));
  const prefix = join(root, "prefix");
  await command("mkdir", ["-p", prefix], "package_extract");
  await command("dpkg-deb", ["--extract", packagePath, prefix], "package_extract");
  const binary = join(prefix, ...binaryEntry.split("/"));
  await access(binary).catch(() => fail("binary_missing"));
  await chmod(binary, 0o755).catch(() => fail("binary_permissions"));
  const ldd = await command("ldd", [binary], "dependencies");
  if (/not found/i.test(ldd.stdout)) fail("dependencies_missing");

  const home = join(root, "home");
  const runtime = join(root, "runtime");
  const config = join(home, ".config");
  const data = join(home, ".local", "share");
  const cache = join(home, ".cache");
  await command("mkdir", ["-p", home, runtime, config, data, cache], "isolated_home");
  await chmod(runtime, 0o700).catch(() => fail("isolated_home"));
  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: config,
    XDG_DATA_HOME: data,
    XDG_CACHE_HOME: cache,
    XDG_RUNTIME_DIR: runtime,
    EASTGENESIS_QA_ISOLATED_PROFILE: "1",
    EASTGENESIS_QA_PROVIDER_BASE_URL: "http://127.0.0.1:1",
    EASTGENESIS_QA_PROVIDER_MODEL: "fixture-model",
    EASTGENESIS_QA_PROVIDER_PROTOCOL: "openai",
  };
  child = await runProcess(binary, env, root);
  const database = await findDatabase(root);
  const databaseCheck = await sqliteCheck(database);
  const termination = await stopDetachedProcess(child);
  if (!termination.controlledCleanup) fail("process_termination");
  child = null;
  result = reportFor({
    passed: true,
    checks: { packageMetadata: true, packagePayload: true, dependencies: true, binaryStart: true, sqliteSchema: true, controlledTermination: true },
    packageInfo: { name, version, architecture, bytes: packageStat.size },
    install: { mode: "deb-extract", isolatedPrefix: true, systemPackageDatabaseChanged: false, database: databaseCheck, termination },
  });
} catch (error) {
  if (child) {
    try { process.kill(-child.pid, "SIGKILL"); } catch { /* best effort cleanup */ }
  }
  result = reportFor({
    passed: false,
    checks: {},
    packageInfo: { format: "deb" },
    install: { mode: "deb-extract", isolatedPrefix: true, systemPackageDatabaseChanged: false },
    errors: [error?.stage ?? "unknown"],
  });
  process.exitCode = 1;
} finally {
  if (root) await rm(root, { recursive: true, force: true });
}

const serialized = `${JSON.stringify(result, null, 2)}\n`;
if (outputPath) await writeFile(outputPath, serialized, "utf8");
if (jsonOutput) process.stdout.write(serialized);
else console.log(`Linux deb install smoke ${result.passed ? "passed" : "failed"} (mode=${result.install.mode})`);

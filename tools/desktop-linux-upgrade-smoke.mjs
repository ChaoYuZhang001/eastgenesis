#!/usr/bin/env node
// Real dpkg install/upgrade/uninstall, restricted to a disposable GitHub Linux
// runner. The two QA builds use the same source with different bundle versions;
// this proves package upgrade/data retention, not a schema-changing release.
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { access, chmod, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { hasProcessExited, stopDetachedProcess } from "./desktop-process-cleanup.mjs";

const exec = promisify(execFile);
const args = process.argv.slice(2);
const option = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const output = option("--output");
const checks = {};
const errors = [];
const packages = [];
let root;
let child;
let ownedPackage = false;
let installedName;
let databaseCheck;
let cleanup;
let installedPaths;
let systemInstallAttempted = false;
let cleanupVerified = false;
const launches = [];
function fail(stage) { const error = new Error(stage); error.stage = stage; throw error; }
async function command(binary, commandArgs, stage, extra = {}) {
  try { return await exec(binary, commandArgs, { timeout: 120_000, maxBuffer: 4 * 1024 * 1024, ...extra }); }
  catch { fail(stage); }
}
const pause = () => new Promise((done) => setTimeout(done, 150));

async function metadata(path) {
  const info = await stat(path).catch(() => fail("package_missing"));
  if (!info.isFile() || info.size === 0) fail("package_empty");
  const result = await command("dpkg-deb", ["--show", "--showformat=${Package}\\n${Version}\\n${Architecture}\\n", path], "package_metadata");
  const [name, version, architecture] = result.stdout.trim().split("\n");
  if (name !== "east-genesis-desktop" || !/^\d+\.\d+\.\d+$/.test(version) || !["amd64", "arm64"].includes(architecture)) fail("package_identity");
  return { name, version, architecture, bytes: info.size };
}

async function packageFor(version) {
  const directory = resolve("target/release/bundle/deb");
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => fail("package_missing"));
  const matches = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".deb")) continue;
    const path = join(directory, entry.name);
    const info = await metadata(path);
    if (info.version === version) matches.push({ path, info });
  }
  if (matches.length !== 1) fail("package_selection");
  return matches[0];
}

async function registeredVersion() {
  const result = await command("dpkg-query", ["--show", "--showformat=${Status}\\n${Version}\\n", installedName], "registered_package");
  const [status, version] = result.stdout.trim().split("\n");
  if (status !== "install ok installed") fail("registered_package");
  return version;
}

async function installedBinary() {
  const result = await command("dpkg-query", ["--listfiles", installedName], "installed_payload");
  const files = result.stdout.trim().split("\n");
  const binary = files.find((file) => /^\/usr\/bin\/[^/]*eastgenesis[^/]*$/.test(file));
  const desktop = files.find((file) => /^\/usr\/share\/applications\/[^/]+\.desktop$/.test(file));
  if (!binary || !desktop) fail("installed_payload");
  await access(binary).catch(() => fail("installed_payload"));
  await access(desktop).catch(() => fail("desktop_entry"));
  if (binary !== installedPaths.binary || desktop !== installedPaths.desktop) fail("installed_payload_identity");
  const resultLdd = await command("ldd", [binary], "dependencies");
  if (/not found/i.test(resultLdd.stdout)) fail("dependencies_missing");
  checks.desktopEntry = true;
  checks.dependencies = true;
  return binary;
}

async function assertPackageAbsent() {
  let status = "";
  try { status = (await exec("dpkg-query", ["--show", "--showformat=${db:Status-Status}", installedName])).stdout.trim(); }
  catch (error) { if (error?.code !== 1) fail("uninstall_probe"); }
  if (status && status !== "not-installed") fail("uninstall_registered");
  for (const path of Object.values(installedPaths)) {
    try { await stat(path); fail("uninstall_payload"); }
    catch (error) {
      if (error?.stage) throw error;
      if (error?.code !== "ENOENT") fail("uninstall_payload_probe");
    }
  }
  cleanupVerified = true;
}

async function installedProcessAlive(binary, pgid) {
  // Inspect executable identity only for this detached group. Do not emit
  // process command lines, executable paths, environment values or PIDs.
  const script = [
    "import json, os, subprocess, sys",
    "rows = subprocess.check_output(['ps','-eo','pid=,pgid=,stat='], text=True).splitlines()",
    "matches = []",
    "for line in rows:",
    "    row = line.split()",
    "    if len(row) != 3 or row[1] != sys.argv[2] or row[2].startswith('Z'): continue",
    "    try: matches.append(os.readlink('/proc/' + row[0] + '/exe') == os.path.realpath(sys.argv[1]))",
    "    except FileNotFoundError: pass",
    "print(json.dumps({'matched': any(matches)}))",
  ].join("\n");
  const result = await command("python3", ["-c", script, binary, String(pgid)], "installed_process_identity");
  try { return JSON.parse(result.stdout).matched === true; } catch { fail("installed_process_identity"); }
}

async function sqlite(database, seed = false) {
  const script = [
    "import json, sqlite3, sys",
    "db = sqlite3.connect(sys.argv[1])",
    ...(seed ? ["db.execute(\"INSERT OR REPLACE INTO sessions (id,title,turns,created_at,updated_at) VALUES ('qa-upgrade-sentinel','QA upgrade sentinel','[]',1,1)\")", "db.commit()"] : []),
    "row = db.execute(\"SELECT (SELECT value FROM app_meta WHERE key='schema_version'), EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='tool_invocations'), EXISTS(SELECT 1 FROM sessions WHERE id='qa-upgrade-sentinel' AND deleted_at IS NULL)\").fetchone()",
    "print(json.dumps({'schemaVersion': int(row[0] or 0), 'toolInvocations': bool(row[1]), 'sessionSentinel': bool(row[2])}))",
  ].join(";");
  const result = await exec("python3", ["-c", script, database], { timeout: 5_000, maxBuffer: 1024 * 1024 });
  return JSON.parse(result.stdout.trim());
}

async function launch(binary, version, env) {
  child = spawn("/usr/bin/xvfb-run", ["--auto-servernum", "--server-args=-screen 0 1440x900x24", binary], {
    detached: true, cwd: root, env, stdio: "ignore",
  });
  let spawnError = false;
  child.once("error", () => { spawnError = true; });
  const deadline = Date.now() + 30_000;
  let identitySince;
  let database;
  let value;
  while (Date.now() < deadline) {
    if (spawnError || hasProcessExited(child)) fail("installed_process_start");
    const matched = await installedProcessAlive(binary, child.pid);
    if (!matched) identitySince = undefined;
    else identitySince ??= Date.now();
    const found = await command("find", [root, "-type", "f", "-name", "eastgenesis.db", "-print", "-quit"], "database_probe");
    database = found.stdout.trim();
    if (database) {
      try { value = await sqlite(database); } catch { /* migrations may still run */ }
      if (value?.schemaVersion === 7 && value.toolInvocations && identitySince && Date.now() - identitySince >= 4_000) break;
    }
    await pause();
  }
  if (value?.schemaVersion !== 7 || !value.toolInvocations || !identitySince || Date.now() - identitySince < 4_000) fail("installed_startup_window");
  const termination = await stopDetachedProcess(child);
  child = null;
  if (!termination.controlledCleanup) fail("process_cleanup");
  launches.push({ version, schemaVersion: value.schemaVersion, installedProcessIdentity: true, stableProcessWindowMs: 4_000, controlledCleanup: true });
  return { database, value };
}

try {
  if (process.platform !== "linux") fail("platform_unsupported");
  if (process.env.GITHUB_ACTIONS !== "true" || process.env.RUNNER_OS !== "Linux" || process.env.RUNNER_ENVIRONMENT !== "github-hosted") fail("disposable_runner_required");
  const baselineVersion = option("--baseline-version");
  const upgradeVersion = option("--upgrade-version");
  if (!baselineVersion || !upgradeVersion || baselineVersion === upgradeVersion) fail("distinct_versions_required");
  const baseline = await packageFor(baselineVersion);
  const upgradeArg = option("--upgrade-package");
  const upgrade = upgradeArg ? { path: resolve(upgradeArg), info: await metadata(resolve(upgradeArg)) } : await packageFor(upgradeVersion);
  if (upgrade.info.version !== upgradeVersion) fail("upgrade_package_version");
  if (baseline.info.name !== upgrade.info.name || baseline.info.architecture !== upgrade.info.architecture) fail("package_identity_mismatch");
  await command("dpkg", ["--compare-versions", upgrade.info.version, "gt", baseline.info.version], "upgrade_version_order");
  packages.push({ role: "baseline", ...baseline.info }, { role: "upgrade", ...upgrade.info });
  installedName = baseline.info.name;
  const contents = await command("dpkg-deb", ["--contents", baseline.path], "package_contents");
  const payload = contents.stdout.split(/\r?\n/).map((line) => line.match(/(?:^|\s)(?:\.\/)?(usr\/(?:bin\/[^\s/]+|share\/applications\/[^/]+\.desktop))\s*$/)?.[1]).filter(Boolean);
  const payloadBinary = payload.find((file) => /^usr\/bin\/[^/]*eastgenesis[^/]*$/.test(file));
  const payloadDesktop = payload.find((file) => /^usr\/share\/applications\/[^/]+\.desktop$/.test(file));
  if (!payloadBinary || !payloadDesktop) fail("package_payload");
  installedPaths = { binary: `/${payloadBinary}`, desktop: `/${payloadDesktop}` };
  try {
    await exec("dpkg-query", ["--show", installedName], { maxBuffer: 1024 * 1024 });
    fail("existing_package_refused");
  } catch (error) {
    if (error?.stage) throw error;
    if (error?.code !== 1) fail("existing_package_probe");
  }
  await command("sudo", ["-n", "true"], "sudo_unavailable");
  await access("/usr/bin/xvfb-run").catch(() => fail("display_missing"));
  root = await mkdtemp(join(tmpdir(), "eastgenesis-dpkg-upgrade-"));
  const home = join(root, "home");
  const runtime = join(root, "runtime");
  const config = join(home, ".config");
  const data = join(home, ".local", "share");
  const cache = join(home, ".cache");
  for (const directory of [home, runtime, config, data, cache]) await mkdir(directory, { recursive: true });
  await chmod(runtime, 0o700);
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: config, XDG_DATA_HOME: data, XDG_CACHE_HOME: cache, XDG_RUNTIME_DIR: runtime, EASTGENESIS_QA_ISOLATED_PROFILE: "1",
    EASTGENESIS_QA_PROVIDER_BASE_URL: "http://127.0.0.1:1", EASTGENESIS_QA_PROVIDER_MODEL: "fixture-model", EASTGENESIS_QA_PROVIDER_PROTOCOL: "openai" };
  // From this point onward only the package absent at entry is ours to purge,
  // including a partially configured dpkg install.
  ownedPackage = true;
  systemInstallAttempted = true;
  await command("sudo", ["-n", "dpkg", "--install", baseline.path], "baseline_install");
  if (await registeredVersion() !== baseline.info.version) fail("baseline_version");
  checks.baselineInstalled = true;
  const first = await launch(await installedBinary(), baseline.info.version, env);
  await sqlite(first.database, true).catch(() => fail("sentinel_seed"));
  checks.baselineLaunched = true;
  await command("sudo", ["-n", "dpkg", "--install", upgrade.path], "upgrade_install");
  if (await registeredVersion() !== upgrade.info.version) fail("upgrade_version");
  checks.newerVersionInstalled = true;
  const second = await launch(await installedBinary(), upgrade.info.version, env);
  if (second.database !== first.database || !second.value.sessionSentinel) fail("upgrade_data_retention");
  databaseCheck = second.value;
  checks.upgradeLaunched = true;
  checks.sessionRetained = true;
  checks.sqliteSchema = true;
  await command("sudo", ["-n", "dpkg", "--purge", installedName], "uninstall");
  await assertPackageAbsent();
  ownedPackage = false;
  checks.uninstalled = true;
  const retained = await sqlite(second.database).catch(() => fail("uninstall_data_retention"));
  if (!retained.sessionSentinel) fail("uninstall_data_retention");
  checks.uninstallRetainsUserData = true;
} catch (error) {
  errors.push(error?.stage ?? "unknown");
} finally {
  if (child?.pid) {
    try { cleanup = await stopDetachedProcess(child); }
    catch { try { process.kill(-child.pid, "SIGKILL"); } catch {} errors.push("failure_process_cleanup"); }
  }
  if (ownedPackage) {
    try { await command("sudo", ["-n", "dpkg", "--purge", installedName], "failure_uninstall"); await assertPackageAbsent(); ownedPackage = false; }
    catch { errors.push("failure_uninstall"); }
  }
  if (root) await rm(root, { recursive: true, force: true }).catch(() => errors.push("profile_cleanup"));
}
const required = ["baselineInstalled", "baselineLaunched", "newerVersionInstalled", "upgradeLaunched", "sessionRetained", "sqliteSchema", "desktopEntry", "dependencies", "uninstalled", "uninstallRetainsUserData"];
const passed = errors.length === 0 && required.every((key) => checks[key] === true);
const report = { schemaVersion: 1, kind: "desktop-linux-upgrade-smoke", platform: "linux", format: "deb", passed, checks, packages,
  install: { mode: "dpkg-system", disposableRunner: systemInstallAttempted, isolatedUserData: systemInstallAttempted, systemInstallAttempted, systemPackageDatabaseChanged: checks.baselineInstalled === true, cleanupVerified, database: databaseCheck, launches },
  ...(cleanup ? { cleanup } : {}), ...(errors.length ? { errors } : {}),
  evidenceBoundary: { proven: passed ? ["actual dpkg installation and upgrade between two QA bundle versions", "both installed versions start with SQLite schema 7", "synthetic session survives upgrade and purge", "installed executable and desktop entry exist before uninstall"] : [],
    excluded: ["code or schema changes between releases", "desktop menu click or WebView task execution", "real Provider", "automatic updater or rollback", "other Linux distributions or package formats", "production release signing"] } };
const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (output) await writeFile(output, serialized);
if (args.includes("--json") || output) process.stdout.write(serialized);
else console.log(`Linux dpkg upgrade smoke ${passed ? "passed" : "failed"}`);
if (!passed) process.exitCode = 1;

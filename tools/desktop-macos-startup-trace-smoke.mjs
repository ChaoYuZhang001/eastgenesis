// Actual macOS startup trace acceptance, one fresh owned app copy per guard
// case. These are functional observations, not launch-performance samples.
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { constants } from "node:fs";
import { access, lstat, open, readdir, readFile, readlink, realpath, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join, relative, isAbsolute, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { stopDetachedProcess, hasProcessExited } from "./desktop-process-cleanup.mjs";

const exec = promisify(execFile);
const options = Object.fromEntries(process.argv.slice(2).map((argument) => {
  const separator = argument.indexOf("=");
  if (separator < 0) throw new Error("arguments_require_equals");
  return [argument.slice(0, separator), argument.slice(separator + 1)];
}));
const repo = resolve(fileURLToPath(new URL("..", import.meta.url)));
const sourceBundle = resolve(options["--app-bundle"] ?? join(repo, "target/release/bundle/macos/EastGenesis Desktop.app"));
const binaryRelative = "Contents/MacOS/eastgenesis-desktop";
const sourceBinary = join(sourceBundle, binaryRelative);
const sourceBinaryDirectory = join(sourceBundle, "Contents/MacOS");
const sourceDataDirectory = join(dirname(sourceBundle), "eg-qa-appdata");
const manifestPath = resolve(options["--compiled-source-manifest"] ?? "/tmp/eastgenesis-startup-trace-build-manifest.json");
const output = resolve(options["--output"] ?? "/tmp/eastgenesis-startup-trace-native.json");
const parserPath = join(repo, "tools/desktop-startup-trace.mjs");
const cleanupPath = join(repo, "tools/desktop-process-cleanup.mjs");
const expectedParser = options["--expected-parser-sha256"] ?? "fbf3f2a139071150fc70a4ead3691c5e5ad0f621c4ecf518a4a302f0b49a3bed";
const totalBudgetMs = Number(options["--timeout-ms"] ?? 120_000);
const stableObservationMs = 1_100;
const REQUIRED_NATIVE = ["native_started", "native_state_ready"];
const REQUIRED_FRONTEND = ["document_start", "frontend_entry", "backend_tauri", "sql_import_started", "sql_import_resolved", "db_load_resolved", "schema_read_resolved", "frontend_ready"];
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const hash = async (path) => digest(await readFile(path));
const exists = async (path) => { try { await access(path); return true; } catch { return false; } };
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
function fail(code) { throw Object.assign(new Error(code), { stage: code }); }
function requireThat(condition, code) { if (!condition) fail(code); }
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
let workDeadline = Infinity, traceParser, ownedRoot;
const liveApps = new Set();
const report = {
  schemaVersion: 1, kind: "macos-isolated-qa-startup-trace", startedAt: new Date().toISOString(),
  passed: false, runCompleted: false,
  budgets: { totalMs: totalBudgetMs, cleanupReserveMs: 15_000, perRoundWaitMs: 30_000, stableObservationMs, pollMs: 100 },
  isolation: { copiedOwnedBundles: true, freshHomePerRound: true, appdataPrecreated: false, sqliteAccess: "readonly", settingsSeeded: false,
    providerKeyEnvironmentInherited: false, privateConfigurationRead: false, providerTarget: "unreachable synthetic loopback",
    appStdio: "ignore", axUsed: false, dataRootResolution: "app_bundle_parent/eg-qa-appdata", traceSidecarResolution: "executable_directory",
    dataRootRule: { implementation: "Tauri 2.12.0 PathResolver::app_binary_dir", source: "tauri-2.12.0/src/path/desktop.rs:321-334", macosRule: "directory containing the .app bundle" } },
  evidenceBoundary: { proven: [], excluded: ["startup performance", "AX or pixel UI readiness", "Windows", "root cause inference from absent stage",
    "real Provider", "signing/notarization", "ordinary release binary acceptance", "JavaScript injection independently of the compiled guard source"],
    traceCompleteMeaning: "parser complete means structurally valid snapshot; required native/frontend stages and physical schema 7 are checked separately" },
  rounds: [
    { name: "diagnostics_enabled", plannedSampleCount: 1, status: "not_run", guards: { diagnosticsFlag: true, mandatoryInstallIsolation: true, isolatedProfile: true, validLowercaseUuid: true } },
    { name: "diagnostics_flag_absent", plannedSampleCount: 1, status: "not_run", guards: { diagnosticsFlag: false, mandatoryInstallIsolation: true, isolatedProfile: true, validLowercaseUuid: true } },
  ],
};

async function sourceHashes(expected) {
  requireThat(expected && typeof expected === "object" && !Array.isArray(expected) && Object.keys(expected).length >= 286, "full_source_manifest_required");
  for (const name of ["Cargo.lock", "src-tauri/Cargo.toml", "src-tauri/src/qa_startup_diagnostics.rs", "src/lib/qa-startup.ts", "src/lib/db.ts", "src/platform/tauri-backend.ts", "src/stores/app.ts", "src-tauri/tauri.windows.install.qa.conf.json"]) {
    requireThat(/^[a-f0-9]{64}$/.test(expected[name] ?? ""), "required_source_input_missing");
  }
  for (const [name, sha] of Object.entries(expected)) requireThat(!isAbsolute(name) && !relative(repo, resolve(repo, name)).startsWith("..") && /^[a-f0-9]{64}$/.test(sha), "source_manifest_entry_invalid");
  return Object.fromEntries(await Promise.all(Object.keys(expected).map(async (name) => [name, await hash(join(repo, name))])));
}
async function bundleSnapshot(directory) {
  const entries = {};
  async function walk(current) {
    for (const name of (await readdir(current)).sort()) {
      const path = join(current, name), metadata = await lstat(path), key = relative(directory, path);
      if (metadata.isSymbolicLink()) {
        const target = await realpath(path);
        requireThat(!relative(directory, target).startsWith("..") && !isAbsolute(relative(directory, target)), "bundle_symlink_outside_owned_copy");
        entries[key] = { kind: "symlink", sha256: digest(await readlink(path)) };
      } else if (metadata.isDirectory()) await walk(path);
      else if (metadata.isFile()) entries[key] = { kind: "file", sha256: await hash(path) };
      else fail("bundle_entry_invalid");
    }
  }
  await walk(directory);
  return entries;
}
async function originalMembersSnapshot(copy, baseline) {
  const result = {};
  for (const [name, expected] of Object.entries(baseline)) {
    const path = join(copy, name), metadata = await lstat(path);
    requireThat(expected.kind === "symlink" ? metadata.isSymbolicLink() : metadata.isFile() && !metadata.isSymbolicLink(), "copy_member_type_changed");
    result[name] = { kind: expected.kind, sha256: expected.kind === "symlink" ? digest(await readlink(path)) : await hash(path) };
  }
  return result;
}
async function sidecars(directory) { return (await readdir(directory)).filter((name) => /^eg-qa-startup-.*\.jsonl$/.test(name)); }
function alive(child) { return child && !hasProcessExited(child); }
async function assertOwnParent(child) {
  requireThat(alive(child) && child.pid > 0, "owned_app_spawn_failed");
  const { stdout } = await exec("ps", ["-p", String(child.pid), "-o", "ppid="], { timeout: 1_000, maxBuffer: 1_024 });
  requireThat(Number(stdout.trim()) === process.pid, "owned_app_parent_mismatch");
}
async function readSchema(db) {
  if (!await exists(db)) return { status: "database_missing", version: null };
  try {
    const { stdout } = await exec("sqlite3", ["-readonly", "-batch", "-noheader", db, "SELECT value FROM app_meta WHERE key='schema_version'"], { timeout: 1_000, maxBuffer: 4_096 });
    const text = stdout.trim();
    const version = /^\d{1,3}$/.test(text) ? Number(text) : null;
    return { status: version === 7 ? "schema_ready" : "schema_not_ready", version };
  } catch (error) {
    const stderr = String(error.stderr ?? "");
    if (/no such table: app_meta/.test(stderr)) return { status: "schema_table_pending", version: null };
    if (/database is locked/.test(stderr)) return { status: "sqlite_locked", version: null };
    fail("sqlite_read_failed");
  }
}
const unobserved = (runId, reason) => traceParser.validateStartupTraceReport({ status: "unobserved", reason, runId, records: [] });
async function readTrace(path, runId) {
  let metadata;
  try { metadata = await lstat(path); }
  catch (error) { return { projected: unobserved(runId, error.code === "ENOENT" ? "missing" : "read_failed"), bytes: null, sha256: null }; }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > traceParser.MAX_TRACE_BYTES) return { projected: unobserved(runId, "invalid"), bytes: metadata.size, sha256: null };
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    requireThat(opened.isFile() && opened.dev === metadata.dev && opened.ino === metadata.ino, "trace_identity_changed");
    const bytes = Buffer.alloc(traceParser.MAX_TRACE_BYTES + 1);
    let size = 0;
    while (size < bytes.length) {
      const read = await handle.read(bytes, size, bytes.length - size, null);
      if (read.bytesRead === 0) break;
      size += read.bytesRead;
    }
    const current = await lstat(path);
    if (!current.isFile() || current.isSymbolicLink() || current.dev !== opened.dev || current.ino !== opened.ino || size > traceParser.MAX_TRACE_BYTES) return { projected: unobserved(runId, "invalid"), bytes: size, sha256: null };
    let text;
    try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, size)); }
    catch { return { projected: unobserved(runId, "invalid"), bytes: size, sha256: digest(bytes.subarray(0, size)) }; }
    return { projected: traceParser.parseStartupTraceText(text, runId), bytes: size, sha256: digest(bytes.subarray(0, size)) };
  } catch { return { projected: unobserved(runId, "read_failed"), bytes: null, sha256: null }; }
  finally { if (handle) await handle.close(); }
}
function requiredStagesObserved(trace) {
  return trace.status === "observed" && REQUIRED_NATIVE.every((stage) => trace.records.some((record) => record.stage === stage && record.source === "native"))
    && REQUIRED_FRONTEND.every((stage) => trace.records.some((record) => record.stage === stage && record.source === "frontend"));
}

async function roundRun(round, index, baseline) {
  const directory = join(ownedRoot, `round-${index + 1}`), home = join(directory, "profile"), copy = join(directory, "Owned QA.app");
  const binary = join(copy, binaryRelative), binaryDirectory = join(copy, "Contents/MacOS"), dataRoot = join(directory, "eg-qa-appdata");
  const db = join(dataRoot, "eastgenesis.db");
  const runId = randomUUID(); const tracePath = join(binaryDirectory, `eg-qa-startup-${runId}.jsonl`);
  round.startedAt = new Date().toISOString(); round.runId = runId; round.attemptCount = 1; round.schemaReadStates = {};
  let child;
  try {
    await mkdir(home, { recursive: true }); await mkdir(join(home, "Downloads"));
    await exec("ditto", [sourceBundle, copy], { timeout: Math.min(15_000, workDeadline - Date.now()), maxBuffer: 4_096 });
    round.binding = { copyBinaryStartSha256: await hash(binary), copyOriginalMembersStart: await originalMembersSnapshot(copy, baseline) };
    requireThat(round.binding.copyBinaryStartSha256 === report.binding.expectedBinarySha256 && same(round.binding.copyOriginalMembersStart, baseline), "owned_app_copy_start_mismatch");
    round.freshAppdataBeforeLaunch = !await exists(dataRoot);
    round.noTraceBeforeLaunch = (await sidecars(binaryDirectory)).length === 0;
    requireThat(round.freshAppdataBeforeLaunch && round.noTraceBeforeLaunch, "fresh_copied_app_required");
    const env = { HOME: home, PATH: process.env.PATH, TMPDIR: tmpdir(), LANG: "en_US.UTF-8",
      EASTGENESIS_QA_ISOLATED_PROFILE: "1", EASTGENESIS_QA_INSTALL_ISOLATION_REQUIRED: "1", EASTGENESIS_QA_STARTUP_RUN_ID: runId,
      EASTGENESIS_QA_PROVIDER_BASE_URL: "http://127.0.0.1:1", EASTGENESIS_QA_PROVIDER_MODEL: "fixture-model", EASTGENESIS_QA_PROVIDER_PROTOCOL: "openai" };
    if (round.guards.diagnosticsFlag) env.EASTGENESIS_QA_STARTUP_DIAGNOSTICS = "1";
    child = spawn(binary, [], { env, cwd: directory, detached: true, stdio: ["ignore", "ignore", "ignore"] });
    child.on("error", () => {}); liveApps.add(child);
    await assertOwnParent(child); round.ownedParentVerified = true; round.ownedAppPid = child.pid; round.ownedParentPid = process.pid;
    const until = Math.min(workDeadline, Date.now() + report.budgets.perRoundWaitMs);
    let ready = false;
    while (Date.now() < until) {
      requireThat(alive(child), "owned_app_early_exit");
      const schema = await readSchema(db); round.schema = schema;
      round.schemaReadStates[schema.status] = (round.schemaReadStates[schema.status] ?? 0) + 1;
      const read = await readTrace(tracePath, runId); round.trace = read.projected; round.traceFileBytes = read.bytes; round.traceFileSha256 = read.sha256;
      if (schema.version === 7 && (round.guards.diagnosticsFlag ? requiredStagesObserved(round.trace) : round.trace.status === "unobserved" && round.trace.reason === "missing")) { ready = true; break; }
      await pause(report.budgets.pollMs);
    }
    requireThat(ready, "startup_required_observations_missing");
    const observationStart = Date.now(); await pause(stableObservationMs);
    requireThat(alive(child), "owned_app_not_alive_after_ready");
    round.liveAppBeforeCleanup = true; round.stableObservationMs = Date.now() - observationStart;
    round.schema = await readSchema(db);
    const finalTrace = await readTrace(tracePath, runId); round.trace = finalTrace.projected; round.traceFileBytes = finalTrace.bytes; round.traceFileSha256 = finalTrace.sha256;
    round.sidecarCountBeforeCleanup = (await sidecars(binaryDirectory)).length;
    requireThat(round.schema.version === 7 && await exists(dataRoot), "physical_schema_not_ready");
    if (round.guards.diagnosticsFlag) requireThat(requiredStagesObserved(round.trace) && round.sidecarCountBeforeCleanup === 1, "enabled_trace_contract");
    else requireThat(round.trace.status === "unobserved" && round.trace.reason === "missing" && round.sidecarCountBeforeCleanup === 0, "guard_off_sidecar_written");
    round.appdataCreatedByActualApp = true;
    round.binding.copyBinaryEndSha256 = await hash(binary);
    round.binding.copyOriginalMembersEnd = await originalMembersSnapshot(copy, baseline);
    round.binding.unchanged = round.binding.copyBinaryStartSha256 === round.binding.copyBinaryEndSha256 && same(round.binding.copyOriginalMembersStart, round.binding.copyOriginalMembersEnd);
    requireThat(round.binding.unchanged, "owned_app_code_changed");
    round.status = "passed";
  } catch (error) {
    round.status = "failed"; round.failure = { code: /^[a-z0-9_]{1,100}$/.test(error.stage ?? "") ? error.stage : "round_harness_error" };
  } finally {
    round.requiredStagesApply = round.guards.diagnosticsFlag;
    const records = round.trace?.records ?? [];
    round.requiredNativeStages = REQUIRED_NATIVE.map((stage) => ({ stage, observed: records.some((record) => record.stage === stage && record.source === "native") }));
    round.requiredFrontendStages = REQUIRED_FRONTEND.map((stage) => ({ stage, observed: records.some((record) => record.stage === stage && record.source === "frontend") }));
    if (child) {
      round.appAliveAtCleanupEntry = alive(child);
      try { round.cleanup = await stopDetachedProcess(child, { graceMs: 2_000, killMs: 2_000 }); liveApps.delete(child); }
      catch (error) {
        round.cleanup = { controlledCleanup: false, code: error.stage ?? "cleanup_failed", processAlreadyExited: !alive(child), groupCleanupUnverified: true };
      }
    }
    if (round.binding && await exists(copy)) {
      try {
        round.binding.copyBinaryEndSha256 = await hash(binary);
        round.binding.copyOriginalMembersEnd = await originalMembersSnapshot(copy, baseline);
        round.binding.unchanged = round.binding.copyBinaryStartSha256 === round.binding.copyBinaryEndSha256 && same(round.binding.copyOriginalMembersStart, round.binding.copyOriginalMembersEnd);
        if (!round.binding.unchanged) { round.status = "failed"; round.failure ??= { code: "owned_app_code_changed" }; }
      } catch { round.binding.unchanged = false; round.binding.endReadFailed = true; round.status = "failed"; round.failure ??= { code: "copy_end_read_failed" }; }
    }
    if (!child || !liveApps.has(child)) {
      try { await rm(directory, { recursive: true, force: true }); round.profileAndAppCopyRemoved = true; }
      catch { round.profileAndAppCopyRemoved = false; }
    } else round.profileAndAppCopyRemoved = false;
    round.finishedAt = new Date().toISOString();
    round.passed = round.status === "passed" && round.cleanup?.controlledCleanup === true && round.profileAndAppCopyRemoved === true;
    if (!round.passed && round.status === "passed") round.status = "failed";
  }
}

try {
  requireThat(process.platform === "darwin", "macos_required");
  requireThat(Number.isInteger(totalBudgetMs) && totalBudgetMs >= 60_000 && totalBudgetMs <= 120_000, "bounded_total_budget");
  requireThat(output.endsWith(".json"), "json_output_required");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  requireThat(manifest.passed === true && manifest.sourceUnchanged === true, "qa_build_not_passed");
  const expectedBinary = options["--expected-binary-sha256"];
  requireThat(/^[a-f0-9]{64}$/.test(expectedBinary ?? "") && expectedBinary === manifest.binarySha256, "compiled_binary_binding");
  workDeadline = Date.now() + totalBudgetMs - report.budgets.cleanupReserveMs;
  report.binding = { evidenceType: "worktree_isolated_qa_build_manifest", formalReleaseBinding: false, expectedBinarySha256: expectedBinary,
    binaryStartSha256: await hash(sourceBinary), manifestStartSha256: await hash(manifestPath), expectedSourceHashes: manifest.sourceHashes,
    sourceInputs: manifest.sourceInputs, sourceStartHashes: await sourceHashes(manifest.sourceHashes),
    harnessStartSha256: await hash(new URL(import.meta.url)), expectedParserSha256: expectedParser, parserStartSha256: await hash(parserPath), cleanupHelperStartSha256: await hash(cleanupPath) };
  requireThat(report.binding.binaryStartSha256 === expectedBinary && same(report.binding.sourceStartHashes, manifest.sourceHashes) && Object.keys(manifest.sourceHashes).length === manifest.sourceInputs, "compiled_source_start_mismatch");
  traceParser = await import(`${pathToFileURL(parserPath).href}?binding=${report.binding.parserStartSha256}`);
  requireThat(report.binding.parserStartSha256 === expectedParser && await hash(parserPath) === report.binding.parserStartSha256 && traceParser.MAX_TRACE_BYTES === 32 * 1024, "parser_start_binding");
  report.binding.sourceAppdataAbsentStart = !await exists(sourceDataDirectory);
  requireThat(report.binding.sourceAppdataAbsentStart && (await sidecars(sourceBinaryDirectory)).length === 0, "source_bundle_not_clean");
  const baseline = await bundleSnapshot(sourceBundle); report.binding.sourceBundleStart = baseline;
  ownedRoot = await realpath(await mkdtemp(join(tmpdir(), "eg-startup-trace-")));
  for (let index = 0; index < report.rounds.length; index++) {
    if (liveApps.size || Date.now() >= workDeadline) { report.rounds[index].blockedReason = liveApps.size ? "prior_app_cleanup_incomplete" : "qa_work_budget_exceeded"; break; }
    await roundRun(report.rounds[index], index, baseline);
  }
  report.runCompleted = report.rounds.every((round) => round.attemptCount === 1 && round.finishedAt);
} catch (error) {
  report.failure = { code: /^[a-z0-9_]{1,100}$/.test(error.stage ?? "") ? error.stage : "binding_or_harness_error" };
} finally {
  report.cleanup = { longLivedHelperStarted: false, remainingOwnedApps: liveApps.size };
  for (const child of liveApps) {
    try { await stopDetachedProcess(child, { graceMs: 2_000, killMs: 2_000 }); liveApps.delete(child); }
    catch { report.cleanup.finalAppCleanupFailed = true; }
  }
  report.cleanup.remainingOwnedApps = liveApps.size;
  if (report.binding) {
    try {
      Object.assign(report.binding, { binaryEndSha256: await hash(sourceBinary), manifestEndSha256: await hash(manifestPath),
        sourceEndHashes: await sourceHashes(report.binding.expectedSourceHashes), sourceBundleEnd: await bundleSnapshot(sourceBundle),
        sourceAppdataAbsentEnd: !await exists(sourceDataDirectory),
        harnessEndSha256: await hash(new URL(import.meta.url)), parserEndSha256: await hash(parserPath), cleanupHelperEndSha256: await hash(cleanupPath) });
      report.binding.unchanged = report.binding.binaryStartSha256 === report.binding.binaryEndSha256 && report.binding.manifestStartSha256 === report.binding.manifestEndSha256
        && same(report.binding.sourceStartHashes, report.binding.sourceEndHashes) && same(report.binding.sourceBundleStart, report.binding.sourceBundleEnd)
        && report.binding.harnessStartSha256 === report.binding.harnessEndSha256 && report.binding.parserStartSha256 === report.binding.parserEndSha256
        && report.binding.cleanupHelperStartSha256 === report.binding.cleanupHelperEndSha256
        && report.binding.sourceAppdataAbsentStart === true && report.binding.sourceAppdataAbsentEnd === true;
    } catch { report.binding.unchanged = false; report.binding.endReadFailed = true; }
  }
  if (ownedRoot && !liveApps.size) { try { await rm(ownedRoot, { recursive: true, force: true }); report.cleanup.ownedRootRemoved = true; } catch { report.cleanup.ownedRootRemoved = false; } }
  report.passed = report.runCompleted && report.rounds.every((round) => round.passed === true) && report.binding?.unchanged === true
    && report.cleanup.remainingOwnedApps === 0 && report.cleanup.ownedRootRemoved === true;
  if (report.passed) report.evidenceBoundary.proven = ["actual isolated macOS QA startup delivers fixed native and frontend trace phases", "actual copied app creates SQLite schema 7",
    "same isolated QA configuration with diagnostics flag absent reaches schema 7 without a sidecar", "owned copied app code and original build inputs remain hash bound"];
  report.finishedAt = new Date().toISOString(); report.elapsedMs = Date.parse(report.finishedAt) - Date.parse(report.startedAt);
  if (await exists(output)) {
    const previous = await readFile(output), previousSha256 = digest(previous);
    await writeFile(output.replace(/\.json$/, `.previous-${previousSha256.slice(0, 12)}.json`), previous); report.previousReportSha256 = previousSha256;
  }
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ passed: report.passed, runCompleted: report.runCompleted, rounds: report.rounds.map((round) => ({ name: round.name, status: round.status, passed: round.passed ?? false, failure: round.failure?.code ?? round.blockedReason ?? null })),
    sourceInputs: report.binding?.sourceInputs ?? null, bindingUnchanged: report.binding?.unchanged ?? false, elapsedMs: report.elapsedMs, failure: report.failure ?? null }));
  process.exitCode = report.passed ? 0 : 1;
}

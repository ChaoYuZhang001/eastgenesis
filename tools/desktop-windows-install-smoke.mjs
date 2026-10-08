// Real NSIS install/reinstall/uninstall evidence, limited to disposable hosted
// Windows runners. AppDirectoriesOverride in the QA build is mandatory: merely
// changing APPDATA does not redirect Windows Known Folders used by Tauri.
import { access, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { validateStartupTraceReport } from "./desktop-startup-trace.mjs";

const execFileAsync = promisify(execFile);
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
export const QA_DATA_DIRECTORY = "eg-qa-appdata";
export const NSIS_PAYLOAD_BINDING_STRATEGY = "tauri_cli_2_12_0_nsis_bundle_type_patch";
export const NSIS_PAYLOAD_CLI_VERSION = "2.12.0";
const BUNDLE_TYPE_UNKNOWN = Buffer.from("__TAURI_BUNDLE_TYPE_VAR_UNK", "ascii");
const BUNDLE_TYPE_NSIS = Buffer.from("__TAURI_BUNDLE_TYPE_VAR_NSS", "ascii");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const REQUIRED_CHECKS = [
  "hostedRunner", "noExistingInstallation", "sourceBinaryIsolationProbe", "qaDataIsolation", "webView2Present",
  "nsisInstall", "installedPayload", "installedRegistry", "installedBinaryStart", "installedBinaryStable",
  "sqliteSchema", "sessionSentinelSeeded", "controlledTermination",
  "samePackageReinstall", "repairedPayload", "sessionSentinelPreserved",
  "nsisUninstall", "installedBinaryRemoved", "uninstallRegistryRemoved", "cleanup",
];
const ERROR_STAGES = new Set([
  "platform_unsupported", "runner_unsupported", "arguments_invalid", "package_missing",
  "package_ambiguous", "package_invalid", "qa_config_missing", "qa_isolation_missing", "qa_probe_unsupported", "qa_probe_failed",
  "runtime_missing", "helper_failed", "helper_report_invalid", "existing_installation",
  "existing_configuration", "existing_process", "webview2_missing", "isolated_root",
  "reparse_point", "package_metadata", "payload_binding_invalid", "nsis_install", "payload_missing", "payload_mismatch",
  "installed_registry", "process_start", "process_job", "process_termination", "database_timeout",
  "database_schema", "session_sentinel", "same_package_reinstall", "uninstall_missing",
  "nsis_uninstall", "uninstall_payload", "uninstall_registry", "cleanup_failed", "output_write", "unknown",
]);
const STARTUP_FAILURE_STAGES = new Set(["process_start", "process_job", "database_timeout", "reparse_point", "isolated_root", "unknown"]);
const PROBE_FAILURE_STAGES = new Set([
  "path_guard", "process_job", "command_wait", "command_exit", "output_read", "output_parse", "output_shape",
  "sqlite_open", "schema_query", "schema_result", "seed_write", "sentinel_query", "sqlite_close", "output_write", "mode_invalid",
]);
const STARTUP_DIAGNOSTIC_FIELDS = [
  "cycle", "outcome", "failureStage", "elapsedMs", "stableWindowPassed", "databaseExists",
  "schemaProbeAttempts", "schemaProbeFailures", "schemaProbeState", "lastProbeFailureStage",
  "rootProcessAlive", "rootWindowPresent", "jobActiveProcessCount",
];

const PROCESS_JOB_STAGES = new Set([
  "job_create", "job_limit", "stdio_create", "environment_block", "process_create",
  "job_assign", "process_lookup", "process_handle", "process_resume", "unknown",
]);
const WIN32_JOB_STAGES = new Set(["job_create", "job_limit", "stdio_create", "process_create", "job_assign", "process_resume"]);
function validateProcessJobFailure(value) {
  if (value === null) return null;
  const uint32 = (n) => Number.isSafeInteger(n) && n >= 0 && n <= 0xffff_ffff;
  const int32 = (n) => Number.isSafeInteger(n) && n >= -0x8000_0000 && n <= 0x7fff_ffff;
  const keys = ["stage", "win32Error", "hresult", "suspendCount"];
  if (!value || typeof value !== "object" || Object.keys(value).length !== keys.length || Object.keys(value).some((key) => !keys.includes(key))
    || !PROCESS_JOB_STAGES.has(value.stage) || value.win32Error !== null && !uint32(value.win32Error)
    || value.hresult !== null && !int32(value.hresult) || value.suspendCount !== null && !uint32(value.suspendCount)
    || value.win32Error !== null && (!WIN32_JOB_STAGES.has(value.stage) || value.hresult !== null)
    || value.hresult !== null && (value.win32Error !== null || value.suspendCount !== null)
    || value.suspendCount !== null && (value.stage !== "process_resume" || value.suspendCount === 1)
    || value.stage === "process_resume" && value.win32Error !== null && value.suspendCount !== 0xffff_ffff
    || value.suspendCount === 0xffff_ffff && value.win32Error === null
    || value.suspendCount !== null && value.suspendCount !== 0xffff_ffff && (value.win32Error !== null || value.hresult !== null)
    || value.stage !== "process_resume" && value.suspendCount !== null
    || value.win32Error === null && value.hresult === null && value.suspendCount === null) throw new Error("helper_report_invalid");
  return Object.fromEntries(keys.map((key) => [key, value[key]]));
}

const PROCESS_START_ROLES = new Set(["installed_app", "sqlite_schema_probe", "sqlite_seed", "sqlite_sentinel", "startup_trace_reader", "nsis_install", "nsis_uninstall", "unknown"]);
const PATH_INPUT_FIELDS = ["charLength", "containsNul", "containsCrLf", "containsQuote", "edgeWhitespace", "rooted", "pathForm", "exists", "fullPathComparison"];
const COMMAND_INPUT_FIELDS = ["charLength", "containsNul", "containsCrLf", "quotedApplicationPrefix"];
function validateProcessStartInputFacts(value) {
  if (value === null) return null;
  const exact = (entry, fields) => entry !== null && typeof entry === "object" && !Array.isArray(entry)
    && Object.keys(entry).length === fields.length && Object.keys(entry).every((key) => fields.includes(key));
  const length = (n) => n === null || Number.isSafeInteger(n) && n >= 0 && n <= 65535;
  const flag = (v) => v === null || typeof v === "boolean";
  const path = (entry) => exact(entry, PATH_INPUT_FIELDS) && length(entry.charLength)
    && ["containsNul", "containsCrLf", "containsQuote", "edgeWhitespace", "rooted", "exists"].every((key) => flag(entry[key]))
    && ["drive_absolute", "drive_relative", "unc", "device", "root_relative", "relative", "unknown"].includes(entry.pathForm)
    && ["same", "different", "failed", "unknown"].includes(entry.fullPathComparison);
  if (!exact(value, ["launchRole", "application", "cwd", "command"]) || !PROCESS_START_ROLES.has(value.launchRole)
    || !path(value.application) || !path(value.cwd) || !exact(value.command, COMMAND_INPUT_FIELDS)
    || !length(value.command.charLength) || !["containsNul", "containsCrLf", "quotedApplicationPrefix"].every((key) => flag(value.command[key]))) throw new Error("helper_report_invalid");
  const project = (entry, fields) => Object.fromEntries(fields.map((key) => [key, entry[key]]));
  return { launchRole: value.launchRole, application: project(value.application, PATH_INPUT_FIELDS),
    cwd: project(value.cwd, PATH_INPUT_FIELDS), command: project(value.command, COMMAND_INPUT_FIELDS) };
}

function validateStartupDiagnostics(value = []) {
  const boundedInteger = (number, maximum) => Number.isSafeInteger(number) && number >= 0 && number <= maximum;
  const nullableBoolean = (flag) => flag === null || typeof flag === "boolean";
  if (!Array.isArray(value) || value.length > 2) throw new Error("helper_report_invalid");
  const traceRunIds = new Set();
  return value.map((entry, index) => {
    const tracePresent = entry != null && Object.hasOwn(entry, "startupTrace");
    const jobFailurePresent = entry != null && Object.hasOwn(entry, "processJobFailure");
    const inputFactsPresent = entry != null && Object.hasOwn(entry, "processStartInputFacts");
    if (!entry || typeof entry !== "object" || Object.keys(entry).length !== STARTUP_DIAGNOSTIC_FIELDS.length + Number(tracePresent) + Number(jobFailurePresent) + Number(inputFactsPresent)
      || Object.keys(entry).some((name) => !STARTUP_DIAGNOSTIC_FIELDS.includes(name) && name !== "startupTrace" && name !== "processJobFailure" && name !== "processStartInputFacts")
      || entry.cycle !== index + 1 || !["database_ready", "failed"].includes(entry.outcome)
      || entry.failureStage !== null && !STARTUP_FAILURE_STAGES.has(entry.failureStage)
      || !boundedInteger(entry.elapsedMs, 600_000) || typeof entry.stableWindowPassed !== "boolean"
      || ![entry.databaseExists, entry.rootProcessAlive, entry.rootWindowPresent].every(nullableBoolean)
      || !boundedInteger(entry.schemaProbeAttempts, 10_000) || !boundedInteger(entry.schemaProbeFailures, entry.schemaProbeAttempts)
      || !["not_attempted", "pending", "ready", "failed"].includes(entry.schemaProbeState)
      || entry.lastProbeFailureStage !== null && !PROBE_FAILURE_STAGES.has(entry.lastProbeFailureStage)
      || entry.jobActiveProcessCount !== null && !boundedInteger(entry.jobActiveProcessCount, 0xffff_ffff)
      || entry.rootProcessAlive === true && entry.jobActiveProcessCount === 0
      || (entry.schemaProbeAttempts === 0) !== (entry.schemaProbeState === "not_attempted")
      || (entry.schemaProbeFailures === 0) !== (entry.lastProbeFailureStage === null)
      || entry.schemaProbeState === "failed" && entry.schemaProbeFailures === 0
      || entry.schemaProbeState === "ready" && (entry.schemaProbeAttempts < 1 || entry.schemaProbeFailures >= entry.schemaProbeAttempts)
      || entry.outcome === "database_ready" && (entry.failureStage !== null || entry.schemaProbeState !== "ready" || entry.databaseExists !== true || entry.rootProcessAlive !== true || !entry.stableWindowPassed)
      || entry.outcome === "failed" && entry.failureStage === null) throw new Error("helper_report_invalid");
    let processJobFailure;
    if (jobFailurePresent) {
      processJobFailure = validateProcessJobFailure(entry.processJobFailure);
      if ((processJobFailure !== null) !== (entry.outcome === "failed" && entry.failureStage === "process_job")) throw new Error("helper_report_invalid");
    }
    let processStartInputFacts;
    if (inputFactsPresent) {
      if (entry.outcome !== "failed" || entry.failureStage !== "process_job" || !processJobFailure) throw new Error("helper_report_invalid");
      processStartInputFacts = validateProcessStartInputFacts(entry.processStartInputFacts);
    }
    let startupTrace;
    if (tracePresent) {
      try { startupTrace = validateStartupTraceReport(entry.startupTrace); }
      catch { throw new Error("helper_report_invalid"); }
      if (traceRunIds.has(startupTrace.runId)) throw new Error("helper_report_invalid");
      traceRunIds.add(startupTrace.runId);
    }
    return { ...Object.fromEntries(STARTUP_DIAGNOSTIC_FIELDS.map((name) => [name, entry[name]])), ...(tracePresent ? { startupTrace } : {}), ...(jobFailurePresent ? { processJobFailure } : {}), ...(inputFactsPresent ? { processStartInputFacts } : {}) };
  });
}

export function prerequisiteFailure(platform, env) {
  if (platform !== "win32") return "platform_unsupported";
  if (env.GITHUB_ACTIONS !== "true" || env.RUNNER_ENVIRONMENT !== "github-hosted" || env.RUNNER_OS !== "Windows") return "runner_unsupported";
  return null;
}

export function parseArguments(args) {
  const parsed = { json: false };
  for (let index = 0; index < args.length; index++) {
    const name = args[index];
    if (name === "--") continue;
    if (name === "--json") { parsed.json = true; continue; }
    if (!["--package", "--output", "--qa-config"].includes(name) || !args[index + 1] || args[index + 1].startsWith("--")) throw new Error("arguments_invalid");
    const key = name.slice(2);
    if (Object.hasOwn(parsed, key)) throw new Error("arguments_invalid");
    parsed[key] = args[++index];
  }
  return parsed;
}

export function qaConfigIsIsolated(config) {
  return config?.app?.appDirectoriesOverride === `./${QA_DATA_DIRECTORY}`;
}

// Tauri CLI 2.12.0 saves the original executable, patches the first UNK token
// to NSS for makensis, then restores the original. Compare the whole installed
// file with those exact expected bytes, never with a version or marker alone.
// https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.12.0/crates/tauri-bundler/src/bundle.rs#L90-L96
export function expectedNsisPayloadBinding(sourceBytes, cliVersion) {
  if (cliVersion !== NSIS_PAYLOAD_CLI_VERSION || !Buffer.isBuffer(sourceBytes)
    || sourceBytes[0] !== 0x4d || sourceBytes[1] !== 0x5a
    || BUNDLE_TYPE_UNKNOWN.length !== BUNDLE_TYPE_NSIS.length) throw new Error("payload_binding_invalid");
  const offset = sourceBytes.indexOf(BUNDLE_TYPE_UNKNOWN);
  if (offset < 0 || sourceBytes.indexOf(BUNDLE_TYPE_UNKNOWN, offset + BUNDLE_TYPE_UNKNOWN.length) >= 0) throw new Error("payload_binding_invalid");
  const expectedBytes = Buffer.from(sourceBytes);
  BUNDLE_TYPE_NSIS.copy(expectedBytes, offset);
  return {
    strategy: NSIS_PAYLOAD_BINDING_STRATEGY,
    cliVersion,
    sourceSha256: sha256(sourceBytes),
    expectedNsisSha256: sha256(expectedBytes),
    installedSha256: null,
    repairedSha256: null,
  };
}

function validatePayloadBinding(value, checks) {
  if (value == null) {
    if (["sourceBinaryIsolationProbe", "installedPayload", "repairedPayload"].some((name) => checks[name] === true)) throw new Error("helper_report_invalid");
    return null;
  }
  const fields = ["strategy", "cliVersion", "sourceSha256", "expectedNsisSha256", "installedSha256", "repairedSha256"];
  const isDigest = (digest) => typeof digest === "string" && /^[a-f0-9]{64}$/.test(digest);
  if (typeof value !== "object" || Object.keys(value).length !== fields.length || Object.keys(value).some((name) => !fields.includes(name))
    || value.strategy !== NSIS_PAYLOAD_BINDING_STRATEGY || value.cliVersion !== NSIS_PAYLOAD_CLI_VERSION
    || !isDigest(value.sourceSha256) || !isDigest(value.expectedNsisSha256) || value.sourceSha256 === value.expectedNsisSha256
    || [value.installedSha256, value.repairedSha256].some((digest) => digest !== null && !isDigest(digest))
    || checks.installedPayload === true && value.installedSha256 !== value.expectedNsisSha256
    || checks.repairedPayload === true && (value.installedSha256 !== value.expectedNsisSha256 || value.repairedSha256 !== value.expectedNsisSha256)) throw new Error("helper_report_invalid");
  return Object.fromEntries(fields.map((name) => [name, value[name]]));
}

export function makeReport({ passed = false, checks = {}, stages = [], errors = [], launches = [], payloadBinding = null, startupDiagnostics, attempts = { install: false, reinstall: false, uninstall: false } } = {}) {
  return {
    schemaVersion: 1,
    kind: "desktop-windows-install-smoke",
    platform: "windows",
    format: "nsis",
    passed,
    checks,
    stages,
    launches,
    payloadBinding,
    ...(startupDiagnostics !== undefined ? { startupDiagnostics: validateStartupDiagnostics(startupDiagnostics) } : {}),
    install: {
      mode: "nsis-install-reinstall-uninstall",
      isolatedPrefix: checks.nsisInstall === true,
      isolatedAppDirectories: checks.sourceBinaryIsolationProbe === true,
      // An installer dispatch with no observed registration result is unknown;
      // it must not be reported as either a proved change or a proved no-op.
      systemPackageDatabaseChanged: checks.installedRegistry === true || checks.uninstallRegistryRemoved === true ? true : attempts.install === false ? false : null,
      attempts: { install: attempts.install, reinstall: attempts.reinstall, uninstall: attempts.uninstall },
      sameVersionReinstall: checks.samePackageReinstall === true,
      crossVersionUpgrade: false,
      knownFoldersRegistryChanged: false,
    },
    ...(errors.length ? { errors } : {}),
    evidenceBoundary: {
      proven: passed ? [
        "the generated NSIS package installed into an isolated prefix on a disposable hosted Windows runner",
        "the source executable reported the exact QA root from its own embedded Tauri configuration before app startup",
        "installed and repaired executable SHA256 matched the entire expected NSIS payload after the pinned Tauri bundle-type patch",
        "the installed executable started with QA app directories inside its install prefix",
        "both installed executable launches survived at least four seconds with their process jobs assigned before execution",
        "SQLite schema 7 and a synthetic session sentinel survived repair using the same package",
        "the installed executable and its process tree terminated under explicit process control",
        "the generated NSIS uninstaller removed the installed executable and uninstall registration",
      ] : [],
      excluded: [
        "production default Known Folder storage or migration",
        "old-version to new-version upgrade",
        "automatic update or rollback",
        "MSI or per-machine installation",
        "normal user machine installation or UAC experience",
        "UI hydration of the persisted session",
        "real Provider availability",
        "tool side-effect recovery",
        "code signing or SmartScreen reputation",
      ],
    },
  };
}

// Only fixed checks, fixed vocabulary and validated SHA256 digests are publishable.
// Never forward arbitrary PowerShell output, exception text, paths or usernames.
export function validateHelperReport(value) {
  if (!value || typeof value !== "object" || value.schemaVersion !== 1 || typeof value.passed !== "boolean") throw new Error("helper_report_invalid");
  if (!value.checks || Object.keys(value.checks).some((name) => !REQUIRED_CHECKS.includes(name) || typeof value.checks[name] !== "boolean")) throw new Error("helper_report_invalid");
  if (!Array.isArray(value.stages) || value.stages.some((name) => !REQUIRED_CHECKS.includes(name))) throw new Error("helper_report_invalid");
  if (!Array.isArray(value.errors) || value.errors.some((name) => !ERROR_STAGES.has(name))) throw new Error("helper_report_invalid");
  if (!value.attempts || Object.keys(value.attempts).length !== 3 || ["install", "reinstall", "uninstall"].some((name) => typeof value.attempts[name] !== "boolean")) throw new Error("helper_report_invalid");
  if ((value.attempts.reinstall || value.attempts.uninstall) && !value.attempts.install) throw new Error("helper_report_invalid");
  if ((value.checks.nsisInstall === true || value.checks.installedRegistry === true || value.launches?.length > 0) && !value.attempts.install
    || value.checks.samePackageReinstall === true && !value.attempts.reinstall
    || (value.checks.nsisUninstall === true || value.checks.uninstallRegistryRemoved === true) && !value.attempts.uninstall) throw new Error("helper_report_invalid");
  if (!Array.isArray(value.launches) || value.launches.length > 2 || value.launches.some((launch, index) =>
    !launch || launch.cycle !== index + 1 || typeof launch.graceful !== "boolean" || typeof launch.forced !== "boolean" || launch.processTreeGone !== true
    || launch.graceful === launch.forced || !Number.isSafeInteger(launch.stableWindowMs) || launch.stableWindowMs < 4000
    || launch.survivedStableWindow !== true || launch.jobAssignedBeforeExecution !== true)) throw new Error("helper_report_invalid");
  if (value.passed && (REQUIRED_CHECKS.some((name) => value.checks[name] !== true || !value.stages.includes(name)) || value.launches.length !== 2 || value.errors.length !== 0)) throw new Error("helper_report_invalid");
  const payloadBinding = validatePayloadBinding(value.payloadBinding, value.checks);
  const diagnosticsPresent = Object.hasOwn(value, "startupDiagnostics");
  const startupDiagnostics = validateStartupDiagnostics(value.startupDiagnostics);
  if (startupDiagnostics.length > 0 && !value.attempts.install
    || startupDiagnostics.length === 2 && (!value.attempts.reinstall || startupDiagnostics[0].outcome !== "database_ready")
    || value.passed && diagnosticsPresent && (startupDiagnostics.length !== 2
      || startupDiagnostics.some((entry, index) => entry.outcome !== "database_ready" || entry.cycle !== value.launches[index]?.cycle))) throw new Error("helper_report_invalid");
  return makeReport({
    passed: value.passed,
    checks: Object.fromEntries(REQUIRED_CHECKS.filter((name) => Object.hasOwn(value.checks, name)).map((name) => [name, value.checks[name]])),
    stages: [...value.stages],
    errors: [...value.errors],
    attempts: value.attempts,
    payloadBinding,
    ...(diagnosticsPresent ? { startupDiagnostics } : {}),
    launches: value.launches.map(({ cycle, graceful, forced, processTreeGone, stableWindowMs, survivedStableWindow, jobAssignedBeforeExecution }) => ({
      cycle, graceful, forced, processTreeGone, stableWindowMs, survivedStableWindow, jobAssignedBeforeExecution,
    })),
  });
}

async function findPackage() {
  const root = resolve("target/release/bundle/nsis");
  const entries = await readdir(root, { withFileTypes: true }).catch(() => { throw new Error("package_missing"); });
  const candidates = entries.filter((entry) => entry.isFile() && /-setup\.exe$/i.test(entry.name));
  if (candidates.length !== 1) throw new Error(candidates.length ? "package_ambiguous" : "package_missing");
  return join(root, candidates[0].name);
}

async function runSmoke(options) {
  const failure = prerequisiteFailure(process.platform, process.env);
  if (failure) throw new Error(failure);
  const packagePath = options.package ? resolve(options.package) : await findPackage();
  const file = await lstat(packagePath).catch(() => { throw new Error("package_missing"); });
  if (!file.isFile() || file.isSymbolicLink() || file.size < 1024 || !/\.exe$/i.test(packagePath)) throw new Error("package_invalid");
  const header = await readFile(packagePath);
  if (header[0] !== 0x4d || header[1] !== 0x5a) throw new Error("package_invalid");
  const configPath = resolve(options["qa-config"] ?? "src-tauri/tauri.windows.install.qa.conf.json");
  const config = await readFile(configPath, "utf8").then(JSON.parse).catch(() => { throw new Error("qa_config_missing"); });
  if (!qaConfigIsIsolated(config)) throw new Error("qa_isolation_missing");
  const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  await access(powershell).catch(() => { throw new Error("runtime_missing"); });
  let root;
  let helperDispatched = false;
  try {
    root = await realpath(await mkdtemp(join(tmpdir(), "eastgenesis-windows-install-")));
    const inputPath = join(root, "input.json");
    const outputPath = join(root, "result.json");
    const sourceBinary = resolve("target/release/eastgenesis-desktop.exe");
    // Bind the known transformation to the installed CLI, not just a declared
    // dependency range. A future CLI upgrade needs a fresh source review.
    let cli;
    try { cli = JSON.parse(await readFile(createRequire(import.meta.url).resolve("@tauri-apps/cli/package.json"), "utf8")); }
    catch { throw new Error("payload_binding_invalid"); }
    if (cli.name !== "@tauri-apps/cli") throw new Error("payload_binding_invalid");
    const sourceBytes = await readFile(sourceBinary).catch(() => { throw new Error("payload_binding_invalid"); });
    const payloadBinding = expectedNsisPayloadBinding(sourceBytes, cli.version);
    await mkdir(join(root, "profile"));
    await writeFile(inputPath, JSON.stringify({ packagePath, installDirectory: join(root, "installed"), profileDirectory: join(root, "profile"), sourceBinary, dataDirectory: QA_DATA_DIRECTORY, payloadBinding,
      nodeBinary: process.execPath, startupTraceReader: join(scriptDirectory, "desktop-startup-trace.mjs") }), "utf8");
    // The helper has its own bounded per-stage waits and finally cleanup. This
    // outer cap is longer so it does not interrupt uninstall/cleanup on failure.
    helperDispatched = true;
    try {
      await execFileAsync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", join(scriptDirectory, "desktop-windows-install-smoke.ps1"), "-InputFile", inputPath, "-OutputFile", outputPath], { maxBuffer: 1024 * 1024, timeout: 600_000, windowsHide: true });
    } catch {
      // A helper failure may still have written a redacted failure report.
    }
    const report = await readFile(outputPath, "utf8").then((text) => JSON.parse(text.replace(/^\uFEFF/, ""))).catch(() => { throw new Error("helper_failed"); });
    return validateHelperReport(report);
  } catch (error) {
    // If the helper produced no usable report after dispatch, its installer
    // side effects are unknown; do not invent a proved no-op on this path.
    if (error instanceof Error) error.helperDispatched = helperDispatched;
    throw error;
  } finally {
    if (root) await rm(root, { recursive: true, force: true }).catch(() => {
      const error = new Error("cleanup_failed");
      error.helperDispatched = helperDispatched;
      throw error;
    });
  }
}

export async function main(args = process.argv.slice(2)) {
  let options = { json: args.includes("--json") };
  let report;
  try {
    options = parseArguments(args);
    report = await runSmoke(options);
  } catch (error) {
    report = makeReport({
      errors: [ERROR_STAGES.has(error?.message) ? error.message : "unknown"],
      ...(error?.helperDispatched ? { attempts: { install: null, reinstall: null, uninstall: null } } : {}),
    });
  }
  if (options.output) {
    try { await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`, "utf8"); }
    catch {
      // Output I/O failure must not erase observed native operations.
      report = { ...report, passed: false, errors: [...(report.errors ?? []), "output_write"], evidenceBoundary: { ...report.evidenceBoundary, proven: [] } };
    }
  }
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (options.json || options.output) process.stdout.write(serialized);
  else console.log(`Windows NSIS install smoke ${report.passed ? "passed" : "failed"}`);
  if (!report.passed) process.exitCode = 1;
  return report;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main();

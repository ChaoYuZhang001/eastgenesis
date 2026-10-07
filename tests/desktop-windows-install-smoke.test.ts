// @vitest-environment node
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Script } from "node:vm";
import { createHash } from "node:crypto";
import { createServer } from "vite";
import { describe, expect, it } from "vitest";
import {
  REQUIRED_CHECKS,
  NSIS_PAYLOAD_CLI_VERSION,
  NSIS_PAYLOAD_BINDING_STRATEGY,
  expectedNsisPayloadBinding,
  makeReport,
  parseArguments,
  prerequisiteFailure,
  qaConfigIsIsolated,
  validateHelperReport,
  type StartupDiagnostic,
  type ProcessJobFailure,
  type ProcessStartInputFacts,
} from "../tools/desktop-windows-install-smoke.mjs";

const pristineSource = Buffer.from("MZ\0synthetic-body\0__TAURI_BUNDLE_TYPE_VAR_NSS\0__TAURI_BUNDLE_TYPE_VAR_UNK\0footer");
const expectedPayload = Buffer.from("MZ\0synthetic-body\0__TAURI_BUNDLE_TYPE_VAR_NSS\0__TAURI_BUNDLE_TYPE_VAR_NSS\0footer");
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function successFixture() {
  const payloadBinding = expectedNsisPayloadBinding(pristineSource, NSIS_PAYLOAD_CLI_VERSION);
  return {
    schemaVersion: 1,
    passed: true,
    checks: Object.fromEntries(REQUIRED_CHECKS.map((name) => [name, true])),
    stages: [...REQUIRED_CHECKS],
    errors: [],
    attempts: { install: true, reinstall: true, uninstall: true },
    payloadBinding: { ...payloadBinding, installedSha256: payloadBinding.expectedNsisSha256, repairedSha256: payloadBinding.expectedNsisSha256 },
    launches: [
      { cycle: 1, graceful: true, forced: false, processTreeGone: true, stableWindowMs: 4000, survivedStableWindow: true, jobAssignedBeforeExecution: true },
      { cycle: 2, graceful: false, forced: true, processTreeGone: true, stableWindowMs: 4005, survivedStableWindow: true, jobAssignedBeforeExecution: true },
    ],
  };
}

function startupDiagnostic(patch: Partial<StartupDiagnostic> = {}): StartupDiagnostic {
  return {
    cycle: 1, outcome: "failed", failureStage: "database_timeout", elapsedMs: 34_000, stableWindowPassed: true,
    databaseExists: false, schemaProbeAttempts: 0, schemaProbeFailures: 0, schemaProbeState: "not_attempted", lastProbeFailureStage: null,
    rootProcessAlive: true, rootWindowPresent: true, jobActiveProcessCount: 4,
    ...patch,
  };
}

function startupFailureFixture(startupDiagnostics: unknown[]) {
  const fixture = successFixture();
  const checks = Object.fromEntries(["hostedRunner", "noExistingInstallation", "sourceBinaryIsolationProbe", "webView2Present", "nsisInstall", "installedPayload", "installedRegistry", "nsisUninstall", "installedBinaryRemoved", "uninstallRegistryRemoved"].map((name) => [name, true]));
  return {
    ...fixture, passed: false, checks, stages: Object.keys(checks), errors: ["database_timeout"], launches: [],
    attempts: { install: true, reinstall: false, uninstall: true },
    payloadBinding: { ...fixture.payloadBinding, repairedSha256: null }, startupDiagnostics,
  };
}

describe("Windows NSIS install smoke safety and evidence boundary", () => {
  it("remains importable through Vite after a Windows CRLF checkout", async () => {
    const source = await readFile(resolve("tools/desktop-windows-install-smoke.mjs"), "utf8");
    const server = await createServer({
      configFile: false,
      appType: "custom",
      server: { middlewareMode: true, hmr: false, watch: null },
    });
    try {
      const windowsSource = source.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n");
      const transformed = await server.ssrTransform(windowsSource, null, "/tools/desktop-windows-install-smoke.mjs");
      expect(transformed).not.toBeNull();
      // vite-node evaluates SSR output inside an async function; a hoisted
      // import before an unstripped CRLF shebang makes that function invalid.
      expect(() => new Script(`'use strict';async()=>{${transformed!.code}\n}`)).not.toThrow();
    } finally {
      await server.close();
    }
  });

  it("permits only explicit disposable hosted Windows runners", () => {
    const hosted = { GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "github-hosted", RUNNER_OS: "Windows" };
    expect(prerequisiteFailure("win32", hosted)).toBeNull();
    expect(prerequisiteFailure("darwin", hosted)).toBe("platform_unsupported");
    expect(prerequisiteFailure("linux", hosted)).toBe("platform_unsupported");
    expect(prerequisiteFailure("win32", { ...hosted, RUNNER_ENVIRONMENT: "self-hosted" })).toBe("runner_unsupported");
    expect(prerequisiteFailure("win32", { ...hosted, RUNNER_ENVIRONMENT: undefined })).toBe("runner_unsupported");
    expect(prerequisiteFailure("win32", { ...hosted, GITHUB_ACTIONS: "false" })).toBe("runner_unsupported");
    expect(prerequisiteFailure("win32", { ...hosted, RUNNER_OS: "Linux" })).toBe("runner_unsupported");
  });

  it("requires the dedicated QA app directory rather than relying on environment redirects", () => {
    expect(qaConfigIsIsolated({ app: { appDirectoriesOverride: "./eg-qa-appdata" } })).toBe(true);
    for (const override of [undefined, "./", "../eg-qa-appdata", "eg-qa-appdata", "C:\\shared-data", { config: "./eg-qa-appdata" }]) {
      expect(qaConfigIsIsolated({ app: { appDirectoriesOverride: override } })).toBe(false);
    }
    expect(qaConfigIsIsolated(null)).toBe(false);
  });

  it("requires supported binary dispatch and embedded-config proof before any NSIS attempt", async () => {
    const [helper, entry, probe, library] = await Promise.all([
      readFile(resolve("tools/desktop-windows-install-smoke.ps1"), "utf8"),
      readFile(resolve("src-tauri/src/main.rs"), "utf8"),
      readFile(resolve("src-tauri/src/qa_install_probe.rs"), "utf8"),
      readFile(resolve("src-tauri/src/lib.rs"), "utf8"),
    ]);
    const marker = "EASTGENESIS_QA_INSTALL_ISOLATION_PROBE_SUPPORTED_V1_6F725CB3";
    expect(helper).toContain(marker);
    expect(probe).toContain(`*b"${marker}"`);
    expect(probe).toContain("#[used]");
    expect(probe).toContain("std::hint::black_box(&PROBE_SUPPORT_BYTES)");
    const markerGate = helper.indexOf(".Contains($marker)");
    const probeDispatch = helper.lastIndexOf("Invoke-IsolationProbe");
    const installDispatch = helper.indexOf("$handle = Start-Controlled $configuration.packagePath");
    expect(markerGate).toBeGreaterThan(0);
    expect(probeDispatch).toBeGreaterThan(markerGate);
    expect(installDispatch).toBeGreaterThan(probeDispatch);
    expect(helper).not.toContain("UTF8.GetString($sourceBytes).Contains('eg-qa-appdata')");
    expect(helper).toContain("$childEnvironment['EASTGENESIS_QA_INSTALL_ISOLATION_REQUIRED'] = '1'");
    expect(helper).toContain("$info.UseShellExecute = $false");
    expect(helper).toContain("$info.RedirectStandardOutput = $true");
    expect(helper).toContain("Record-Check 'sourceBinaryIsolationProbe'");
    expect(helper).toContain("$payloadBinding = Get-NsisPayloadBinding $sourceBytes");
    expect(helper.indexOf("$payloadBinding = Get-NsisPayloadBinding $sourceBytes")).toBeLessThan(probeDispatch);
    expect(helper).toContain("$sourceHash = $payloadBinding.sourceSha256");
    expect(helper).toContain("$payloadBinding.installedSha256 -cne $payloadBinding.expectedNsisSha256");
    expect(helper).toContain("$payloadBinding.repairedSha256 -cne $payloadBinding.expectedNsisSha256");
    expect(helper).not.toContain("Hash -ne $sourceHash) { throw 'payload_mismatch'");
    expect(entry.indexOf("qa_install_probe::early_exit_code()")).toBeLessThan(entry.indexOf("mcp_files::run_cli"));
    expect(entry.indexOf("qa_install_probe::early_exit_code()")).toBeLessThan(entry.indexOf("eastgenesis_desktop_lib::run()"));
    expect(probe).toContain("tauri::generate_context!()");
    expect(library).toContain("let context = qa_install_probe::embedded_context()");
    expect(library).toContain(".build(context)");
    expect(library).not.toContain("tauri::generate_context!()");
    expect(probe).toContain("context.config()");
    expect(probe).not.toMatch(/Builder::|KeyringStore|CustomProviderStore|app_config_dir/);
  });

  it("models only the pinned bundler patch and leaves source bytes unchanged", async () => {
    const before = Buffer.from(pristineSource);
    expect(expectedNsisPayloadBinding(pristineSource, "2.12.0")).toEqual({
      strategy: NSIS_PAYLOAD_BINDING_STRATEGY,
      cliVersion: "2.12.0",
      sourceSha256: digest(pristineSource),
      expectedNsisSha256: digest(expectedPayload),
      installedSha256: null,
      repairedSha256: null,
    });
    expect(pristineSource.equals(before)).toBe(true);
    const pkg = JSON.parse(await readFile(resolve("package.json"), "utf8"));
    expect(pkg.devDependencies["@tauri-apps/cli"]).toBe(NSIS_PAYLOAD_CLI_VERSION);
  });

  it("fails closed on missing or repeated markers and an unreviewed CLI version", () => {
    for (const bytes of [Buffer.from("MZ\0no-bundle-marker"), expectedPayload,
      Buffer.concat([pristineSource, Buffer.from("__TAURI_BUNDLE_TYPE_VAR_UNK")]),
      Buffer.from("wrong-header\0__TAURI_BUNDLE_TYPE_VAR_UNK")]) {
      expect(() => expectedNsisPayloadBinding(bytes, "2.12.0")).toThrow("payload_binding_invalid");
    }
    for (const version of [undefined, "2.12.1", "2.13.0", "^2.12.0"]) {
      expect(() => expectedNsisPayloadBinding(pristineSource, version)).toThrow("payload_binding_invalid");
    }
  });

  it("still rejects changes to any installed byte outside the intentional marker patch", () => {
    for (let offset = 0; offset < expectedPayload.length; offset++) {
      const changed = Buffer.from(expectedPayload);
      changed[offset] ^= 1;
      const fixture = successFixture();
      fixture.payloadBinding.installedSha256 = digest(changed);
      expect(() => validateHelperReport(fixture)).toThrow("helper_report_invalid");
    }
  });

  it("binds both install and repair proof to the whole expected payload digest", () => {
    const fixture = successFixture();
    expect(validateHelperReport(fixture).payloadBinding).toEqual(fixture.payloadBinding);
    for (const patchedField of ["installedSha256", "repairedSha256"] as const) {
      expect(() => validateHelperReport({ ...fixture, payloadBinding: { ...fixture.payloadBinding, [patchedField]: digest(pristineSource) } }))
        .toThrow("helper_report_invalid");
      expect(() => validateHelperReport({ ...fixture, payloadBinding: { ...fixture.payloadBinding, [patchedField]: null } }))
        .toThrow("helper_report_invalid");
    }
    const mismatch = { ...fixture, passed: false, checks: { hostedRunner: true, sourceBinaryIsolationProbe: true, nsisInstall: true }, stages: ["hostedRunner", "sourceBinaryIsolationProbe", "nsisInstall"], launches: [], errors: ["payload_mismatch"], attempts: { install: true, reinstall: false, uninstall: false },
      payloadBinding: { ...fixture.payloadBinding, installedSha256: digest(pristineSource), repairedSha256: null } };
    expect(validateHelperReport(mismatch)).toMatchObject({ passed: false, payloadBinding: mismatch.payloadBinding, evidenceBoundary: { proven: [] } });
  });

  it("rejects malformed binding metadata instead of forwarding unknown fields", () => {
    const fixture = successFixture();
    for (const binding of [undefined, null, {},
      { ...fixture.payloadBinding, cliVersion: "2.13.0" },
      { ...fixture.payloadBinding, strategy: "accept-any-installed-file" },
      { ...fixture.payloadBinding, sourceSha256: fixture.payloadBinding.expectedNsisSha256 },
      { ...fixture.payloadBinding, expectedNsisSha256: "private-config-path" },
      { ...fixture.payloadBinding, privatePath: "private-config-path" }]) {
      expect(() => validateHelperReport({ ...fixture, payloadBinding: binding })).toThrow("helper_report_invalid");
    }
  });

  it("rejects unsupported, missing and duplicate CLI arguments", () => {
    expect(parseArguments(["--", "--json", "--package", "fixture-setup.exe", "--qa-config", "fixture-config.json", "--output", "report.json"]))
      .toMatchObject({ json: true, package: "fixture-setup.exe", "qa-config": "fixture-config.json", output: "report.json" });
    for (const args of [["--package"], ["--package", "--json"], ["--allow-user-machine"], ["--package", "a.exe", "--package", "b.exe"]]) {
      expect(() => parseArguments(args)).toThrow("arguments_invalid");
    }
  });

  it("publishes only fixed checks and termination evidence from native helper results", () => {
    const fixture = successFixture();
    const report = validateHelperReport({
      ...fixture,
      username: "private-user-name",
      absolutePath: "C:\\Users\\private-user-name\\private-config",
      launches: fixture.launches.map((launch) => ({ ...launch, stdout: "sensitive native output", argv: "private-provider-url" })),
    });
    expect(report).toMatchObject({
      passed: true,
      kind: "desktop-windows-install-smoke",
      install: { mode: "nsis-install-reinstall-uninstall", crossVersionUpgrade: false, knownFoldersRegistryChanged: false },
    });
    expect(JSON.stringify(report)).not.toMatch(/private-user-name|sensitive native output|private-provider-url/);
  });

  it("distinguishes an absent database, an incomplete schema and a failed schema probe", () => {
    const cases = [
      startupDiagnostic(),
      startupDiagnostic({ databaseExists: true, schemaProbeAttempts: 3, schemaProbeState: "pending" }),
      startupDiagnostic({ databaseExists: true, schemaProbeAttempts: 3, schemaProbeFailures: 3, schemaProbeState: "failed", lastProbeFailureStage: "schema_query" }),
    ];
    for (const diagnostic of cases) {
      const report = validateHelperReport(startupFailureFixture([diagnostic]));
      expect(report).toMatchObject({ passed: false, errors: ["database_timeout"], startupDiagnostics: [diagnostic], evidenceBoundary: { proven: [] } });
    }
  });

  it("preserves pre-cleanup root and job observations without inventing unknown values", () => {
    for (const diagnostic of [
      startupDiagnostic({ failureStage: "process_start", elapsedMs: 1200, stableWindowPassed: false, rootProcessAlive: false, rootWindowPresent: false, jobActiveProcessCount: 2 }),
      startupDiagnostic({ databaseExists: null, rootProcessAlive: null, rootWindowPresent: null, jobActiveProcessCount: null }),
    ]) {
      expect(validateHelperReport(startupFailureFixture([diagnostic]))).toMatchObject({ startupDiagnostics: [diagnostic] });
    }
  });

  it("rejects sensitive, unbounded and contradictory startup diagnostics", () => {
    const patches: Record<string, unknown>[] = [
      { path: "C:\\Users\\private-user\\provider-config" }, { stderr: "private native error" },
      { lastProbeFailureStage: "C:\\Users\\private-user", schemaProbeFailures: 1, schemaProbeAttempts: 1 },
      { rootProcessAlive: "private-command-line" }, { rootWindowPresent: 1 }, { elapsedMs: -1 }, { elapsedMs: 600_001 },
      { schemaProbeAttempts: 10_001 }, { schemaProbeAttempts: 1.5 }, { schemaProbeFailures: 1 },
      { jobActiveProcessCount: -1 }, { jobActiveProcessCount: 0x1_0000_0000 }, { jobActiveProcessCount: 1.5 },
      { jobActiveProcessCount: 0 },
      { cycle: 2 }, { schemaProbeState: "startup_slow" }, { failureStage: null },
      { outcome: "database_ready", failureStage: null, databaseExists: true, schemaProbeState: "ready", schemaProbeAttempts: 1, rootProcessAlive: null },
      { outcome: "database_ready", failureStage: null, databaseExists: true, schemaProbeState: "ready", schemaProbeAttempts: 1, rootProcessAlive: false },
      { outcome: "database_ready", failureStage: null, databaseExists: true, schemaProbeState: "ready", schemaProbeAttempts: 0 },
      { outcome: "database_ready", failureStage: null, databaseExists: true, schemaProbeState: "ready", schemaProbeAttempts: 1, schemaProbeFailures: 1, lastProbeFailureStage: "schema_query" },
    ];
    for (const patch of patches) {
      expect(() => validateHelperReport(startupFailureFixture([{ ...startupDiagnostic(), ...patch }]))).toThrow("helper_report_invalid");
    }
    expect(() => validateHelperReport(startupFailureFixture([startupDiagnostic(), startupDiagnostic({ cycle: 2 }), startupDiagnostic({ cycle: 2 })])))
      .toThrow("helper_report_invalid");
    const missingField: Record<string, unknown> = { ...startupDiagnostic() };
    delete missingField.rootWindowPresent;
    expect(() => validateHelperReport(startupFailureFixture([missingField]))).toThrow("helper_report_invalid");
  });

  it("keeps legacy reports readable and accepts only consistent successful startup observations", () => {
    expect(validateHelperReport(successFixture())).not.toHaveProperty("startupDiagnostics");
    expect(() => validateHelperReport({ ...successFixture(), startupDiagnostics: [] })).toThrow("helper_report_invalid");
    expect(() => validateHelperReport({ ...successFixture(), startupDiagnostics: [startupDiagnostic()] })).toThrow("helper_report_invalid");
    const ready = startupDiagnostic({ outcome: "database_ready", failureStage: null, databaseExists: true, schemaProbeAttempts: 1, schemaProbeState: "ready" });
    expect(() => validateHelperReport({ ...successFixture(), startupDiagnostics: [ready] })).toThrow("helper_report_invalid");
    expect(validateHelperReport({ ...successFixture(), startupDiagnostics: [ready, { ...ready, cycle: 2 }] }))
      .toMatchObject({ passed: true, startupDiagnostics: [ready, { ...ready, cycle: 2 }] });
    expect(() => validateHelperReport({ ...startupFailureFixture([ready]), attempts: { install: false, reinstall: false, uninstall: false }, checks: {}, stages: [], payloadBinding: null }))
      .toThrow("helper_report_invalid");
    expect(() => validateHelperReport(startupFailureFixture([ready, { ...ready, cycle: 2 }]))).toThrow("helper_report_invalid");
  });

  it("captures each isolated startup trace before cleanup without extending the database wait", async () => {
    const helper = (await readFile(resolve("tools/desktop-windows-install-smoke.ps1"), "utf8")).replace(/\r\n/g, "\n");
    const controlledEnvironment = helper.slice(helper.indexOf("function Get-ControlledEnvironment"), helper.indexOf("function Invoke-IsolationProbe"));
    expect(controlledEnvironment).toContain("if ($null -ne $script:startupTraceRunId)");
    expect(controlledEnvironment).toContain("$childEnvironment['EASTGENESIS_QA_STARTUP_DIAGNOSTICS'] = '1'");
    expect(controlledEnvironment).toContain("$childEnvironment['EASTGENESIS_QA_STARTUP_RUN_ID'] = $script:startupTraceRunId");
    const start = helper.slice(helper.indexOf("function Start-App"), helper.indexOf("function Check-Registration"));
    expect(start).toContain("[Guid]::NewGuid().ToString('D').ToLowerInvariant()");
    expect(start).toContain("$deadline = [DateTime]::UtcNow.AddSeconds(30)");
    expect(start).toContain("$diagnostic.startupTrace = Capture-StartupTrace $runId");
    expect(start.indexOf("Capture-StartupTrace $runId")).toBeLessThan(start.indexOf("$script:startupTraceRunId = $null"));
    expect(start.indexOf("$script:startupTraceRunId = $null")).toBeLessThan(start.indexOf("Capture-StartupState $diagnostic"));
    expect(start).not.toContain("Stop-App");
    const capture = helper.slice(helper.indexOf("function Capture-StartupTrace"), helper.indexOf("function Start-App"));
    expect(capture).toContain('Join-Path $configuration.installDirectory "eg-qa-startup-$RunId.jsonl"');
    expect(capture).toContain("Wait-Command $reader 3000");
    expect(capture).toContain("$script:stage = $savedStage");
    expect(capture).not.toMatch(/New-Item|Sqlite-Probe|CreateDirectory|\$dataRoot/);
  });

  it("executes the actual embedded Python probe with fixed schema success and redacted query failure", async () => {
    const helper = (await readFile(resolve("tools/desktop-windows-install-smoke.ps1"), "utf8")).replace(/\r\n/g, "\n");
    const embedded = /\$pythonScript = Join-Path[^\n]*\n  @'\n([\s\S]*?)\n'@ \| Set-Content -LiteralPath \$pythonScript/.exec(helper)?.[1];
    expect(embedded).toBeDefined();
    const directory = await mkdtemp(join(tmpdir(), "eastgenesis-sqlite-probe-"));
    const python = process.platform === "win32" ? "python" : "python3";
    try {
      const script = join(directory, "actual-probe.py");
      const good = join(directory, "schema-ready.db");
      const incomplete = join(directory, "missing-app-meta.db");
      await writeFile(script, embedded!, "utf8");
      const fixture = spawnSync(python, ["-c", `import sqlite3,sys
db=sqlite3.connect(sys.argv[1])
db.executescript("CREATE TABLE app_meta(key TEXT, value TEXT); INSERT INTO app_meta VALUES('schema_version','7'); CREATE TABLE sessions(id TEXT); CREATE TABLE tool_invocations(id TEXT); CREATE INDEX tool_invocations_lease ON tool_invocations(id);")
db.close()
sqlite3.connect(sys.argv[2]).close()`, good, incomplete], { encoding: "utf8", timeout: 5000 });
      expect(fixture.error).toBeUndefined();
      expect(fixture.status).toBe(0);
      expect(fixture.stderr).toBe("");
      for (const [database, status, expected] of [
        [good, 0, { schemaVersion: 7, sessions: true, toolInvocations: true, leaseIndex: true }],
        [incomplete, 1, { probeFailureStage: "schema_query" }],
      ] as const) {
        const output = join(directory, `result-${status}.json`);
        const result = spawnSync(python, [script, database, "schema", output], { encoding: "utf8", timeout: 5000 });
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(status);
        expect(result.stdout).toBe("");
        expect(result.stderr).toBe("");
        const text = await readFile(output, "utf8");
        expect(JSON.parse(text)).toEqual(expected);
        expect(text).not.toContain(database);
        expect(text).not.toMatch(/OperationalError|no such table|Traceback/);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refuses a claimed pass when real uninstall or repair checks are absent", () => {
    for (const missing of ["sourceBinaryIsolationProbe", "nsisInstall", "repairedPayload", "sessionSentinelPreserved", "installedBinaryRemoved", "uninstallRegistryRemoved", "cleanup"]) {
      const fixture = successFixture();
      delete fixture.checks[missing];
      expect(() => validateHelperReport(fixture)).toThrow("helper_report_invalid");
    }
    expect(() => validateHelperReport({ ...successFixture(), stages: [] })).toThrow("helper_report_invalid");
  });

  it("records dispatch attempts without inventing a registry change on early failures", () => {
    const earlyFailure = { schemaVersion: 1, passed: false, checks: {}, stages: [], errors: ["qa_probe_unsupported"], launches: [], attempts: { install: false, reinstall: false, uninstall: false } };
    expect(validateHelperReport(earlyFailure)).toMatchObject({ install: { systemPackageDatabaseChanged: false, attempts: earlyFailure.attempts } });
    expect(validateHelperReport({ ...earlyFailure, errors: ["payload_binding_invalid"] }))
      .toMatchObject({ passed: false, errors: ["payload_binding_invalid"], payloadBinding: null, install: { systemPackageDatabaseChanged: false, attempts: earlyFailure.attempts } });
    expect(validateHelperReport({ ...earlyFailure, errors: ["nsis_install"], attempts: { ...earlyFailure.attempts, install: true } }))
      .toMatchObject({ install: { systemPackageDatabaseChanged: null, attempts: { install: true, reinstall: false, uninstall: false } } });
    expect(validateHelperReport({ ...earlyFailure, errors: ["process_start"], attempts: { ...earlyFailure.attempts, install: true }, checks: { nsisInstall: true, installedRegistry: true } }))
      .toMatchObject({ install: { systemPackageDatabaseChanged: true, isolatedPrefix: true } });
    for (const attempts of [undefined, {}, { install: true }, { install: "true", reinstall: false, uninstall: false }, { ...earlyFailure.attempts, reinstall: true }, { ...earlyFailure.attempts, leakedPath: "private-profile" }]) {
      expect(() => validateHelperReport({ ...earlyFailure, attempts })).toThrow("helper_report_invalid");
    }
    expect(() => validateHelperReport({ ...successFixture(), attempts: earlyFailure.attempts })).toThrow("helper_report_invalid");
  });

  it("refuses unknown failure labels which could expose paths or provider configuration", () => {
    expect(() => validateHelperReport({ ...successFixture(), passed: false, errors: ["C:\\Users\\private-user\\provider-secret"] }))
      .toThrow("helper_report_invalid");
    expect(() => validateHelperReport({ ...successFixture(), checks: { ...successFixture().checks, "private-path": true } }))
      .toThrow("helper_report_invalid");
  });

  it("does not describe forced termination as graceful or accept a remaining process tree", () => {
    const fixture = successFixture();
    expect(() => validateHelperReport({ ...fixture, launches: [{ cycle: 1, graceful: true, forced: true, processTreeGone: true }] }))
      .toThrow("helper_report_invalid");
    expect(() => validateHelperReport({ ...fixture, launches: [{ cycle: 1, graceful: false, forced: true, processTreeGone: false }] }))
      .toThrow("helper_report_invalid");
  });

  it("requires both repaired process startup stability and assignment before execution", () => {
    for (const patch of [
      { stableWindowMs: 3999 },
      { stableWindowMs: undefined },
      { survivedStableWindow: false },
      { jobAssignedBeforeExecution: false },
    ]) {
      const fixture = successFixture();
      fixture.launches[1] = { ...fixture.launches[1], ...patch } as typeof fixture.launches[1];
      expect(() => validateHelperReport(fixture)).toThrow("helper_report_invalid");
    }
  });

  it("preserves a redacted failure without claiming installation proof", () => {
    const report = validateHelperReport({ schemaVersion: 1, passed: false, checks: { hostedRunner: true }, stages: ["hostedRunner"], errors: ["existing_configuration"], launches: [], attempts: { install: false, reinstall: false, uninstall: false } });
    expect(report).toMatchObject({ passed: false, errors: ["existing_configuration"], evidenceBoundary: { proven: [] }, install: { isolatedPrefix: false, isolatedAppDirectories: false, sameVersionReinstall: false, systemPackageDatabaseChanged: false, attempts: { install: false, reinstall: false, uninstall: false } } });
    const boundary = makeReport().evidenceBoundary as { excluded: string[] };
    expect(boundary.excluded).toContain("old-version to new-version upgrade");
    expect(boundary.excluded).toContain("production default Known Folder storage or migration");
  });

  it("projects only typed process-job failures and retains old failure reports", () => {
    const cases: ProcessJobFailure[] = [
      { stage: "job_create", win32Error: 5, hresult: null, suspendCount: null },
      { stage: "job_limit", win32Error: 87, hresult: null, suspendCount: null },
      { stage: "stdio_create", win32Error: 2, hresult: null, suspendCount: null },
      { stage: "process_create", win32Error: 193, hresult: null, suspendCount: null },
      { stage: "job_assign", win32Error: 5, hresult: null, suspendCount: null },
      { stage: "process_resume", win32Error: 6, hresult: null, suspendCount: 0xffff_ffff },
      { stage: "process_resume", win32Error: null, hresult: null, suspendCount: 0 },
      { stage: "process_resume", win32Error: null, hresult: null, suspendCount: 2 },
      ...(["environment_block", "process_lookup", "process_handle", "process_resume", "unknown"] as const)
        .map((stage) => ({ stage, win32Error: null, hresult: -2146233088, suspendCount: null })),
    ];
    for (const processJobFailure of cases) {
      const diagnostic = startupDiagnostic({ failureStage: "process_job", processJobFailure });
      const fixture = { ...startupFailureFixture([diagnostic]), errors: ["process_job"] };
      const report = validateHelperReport(fixture);
      expect(report).toMatchObject({ passed: false, errors: ["process_job"], startupDiagnostics: [diagnostic], evidenceBoundary: { proven: [] } });
      expect(report.startupDiagnostics).not.toBe(fixture.startupDiagnostics);
      expect((report.startupDiagnostics as StartupDiagnostic[])[0].processJobFailure).not.toBe(processJobFailure);
    }
    expect(validateHelperReport(startupFailureFixture([startupDiagnostic()])))
      .toMatchObject({ passed: false, errors: ["database_timeout"] });
  });

  it("rejects leaked fields, unknown stages, unbounded numbers and impossible native tuples", () => {
    const base = { stage: "process_create", win32Error: 193, hresult: null, suspendCount: null };
    for (const processJobFailure of [
      undefined, {}, { ...base, message: "private exception path" }, { ...base, stage: "private-path" },
      { ...base, win32Error: -1 }, { ...base, win32Error: 0x1_0000_0000 }, { ...base, win32Error: 1.5 },
      { ...base, win32Error: "193" }, { ...base, win32Error: null },
      { ...base, hresult: -2146233088 }, { ...base, win32Error: null, hresult: -0x8000_0001 },
      { ...base, win32Error: null, hresult: 0x8000_0000 }, { ...base, win32Error: null, hresult: 1.5 },
      { ...base, stage: "environment_block" }, { ...base, suspendCount: 0 },
      { ...base, stage: "process_resume", suspendCount: null },
      { ...base, stage: "process_resume", suspendCount: 1 }, { ...base, stage: "process_resume", suspendCount: 0 },
      { ...base, stage: "process_resume", suspendCount: 0x1_0000_0000 },
      { ...base, stage: "process_resume", win32Error: null, suspendCount: 0xffff_ffff },
      { ...base, stage: "process_resume", win32Error: null, hresult: -2146233088, suspendCount: 2 },
    ]) {
      const diagnostic = { ...startupDiagnostic({ failureStage: "process_job" }), processJobFailure };
      expect(() => validateHelperReport({ ...startupFailureFixture([diagnostic]), errors: ["process_job"] })).toThrow("helper_report_invalid");
    }
  });

  it("allows null launch diagnostics only outside process_job, including normal lifecycle success", () => {
    const ready = startupDiagnostic({ outcome: "database_ready", failureStage: null, databaseExists: true, schemaProbeAttempts: 1, schemaProbeState: "ready", processJobFailure: null });
    expect(validateHelperReport({ ...successFixture(), startupDiagnostics: [ready, { ...ready, cycle: 2 }] })).toMatchObject({ passed: true });
    const failure: ProcessJobFailure = { stage: "job_assign", win32Error: 5, hresult: null, suspendCount: null };
    for (const diagnostic of [
      startupDiagnostic({ failureStage: "process_job", processJobFailure: null }),
      startupDiagnostic({ processJobFailure: failure }), { ...ready, processJobFailure: failure },
    ]) expect(() => validateHelperReport(startupFailureFixture([diagnostic]))).toThrow("helper_report_invalid");
  });


  describe("process start input facts", () => {
    const facts = (): ProcessStartInputFacts => ({
      launchRole: "sqlite_schema_probe",
      application: { charLength: 31, containsNul: false, containsCrLf: false, containsQuote: false, edgeWhitespace: false, rooted: true, pathForm: "drive_absolute", exists: true, fullPathComparison: "same" },
      cwd: { charLength: 52, containsNul: false, containsCrLf: false, containsQuote: false, edgeWhitespace: false, rooted: true, pathForm: "drive_absolute", exists: true, fullPathComparison: "same" },
      command: { charLength: 186, containsNul: false, containsCrLf: false, quotedApplicationPrefix: true },
    });
    const fixture = (inputFacts: unknown) => ({ ...startupFailureFixture([{
      ...startupDiagnostic({ failureStage: "process_job", databaseExists: true, schemaProbeAttempts: 1, schemaProbeFailures: 1, schemaProbeState: "failed", lastProbeFailureStage: "process_job",
        processJobFailure: { stage: "process_create", win32Error: 123, hresult: null, suspendCount: null } }),
      processStartInputFacts: inputFacts,
    }]), errors: ["process_job"] });

    it("projects fixed actual-input shapes without upgrading failed startup evidence", () => {
      const input = facts();
      const report = validateHelperReport(fixture(input));
      expect(report).toMatchObject({ passed: false, errors: ["process_job"], startupDiagnostics: [{ processStartInputFacts: input }], evidenceBoundary: { proven: [] } });
      const projected = (report.startupDiagnostics as StartupDiagnostic[])[0].processStartInputFacts!;
      expect(projected).not.toBe(input);
      expect(projected.application).not.toBe(input.application);
      expect(projected.cwd).not.toBe(input.cwd);
      expect(projected.command).not.toBe(input.command);
      input.application.charLength = 999;
      expect(projected.application.charLength).toBe(31);
    });

    it("retains legacy omitted facts and represents unavailable new facts as null", () => {
      const older = fixture(null);
      const diagnostic = older.startupDiagnostics[0];
      delete (diagnostic as Record<string, unknown>).processStartInputFacts;
      expect((validateHelperReport(older).startupDiagnostics as StartupDiagnostic[])[0]).not.toHaveProperty("processStartInputFacts");
      expect(validateHelperReport(fixture(null))).toMatchObject({ passed: false, startupDiagnostics: [{ processStartInputFacts: null }] });
    });

    it("accepts fixed unknown observations and the exact length recording boundaries", () => {
      const unknown = facts();
      unknown.launchRole = "unknown";
      for (const input of [unknown.application, unknown.cwd]) Object.assign(input, { charLength: null, containsNul: null, containsCrLf: null, containsQuote: null, edgeWhitespace: null, rooted: null, pathForm: "unknown", exists: null, fullPathComparison: "unknown" });
      Object.assign(unknown.command, { charLength: null, containsNul: null, containsCrLf: null, quotedApplicationPrefix: null });
      expect(validateHelperReport(fixture(unknown))).toMatchObject({ passed: false, startupDiagnostics: [{ processStartInputFacts: unknown }] });
      for (const charLength of [0, 65535]) {
        const input = facts(); input.application.charLength = charLength; input.cwd.charLength = charLength; input.command.charLength = charLength;
        expect(validateHelperReport(fixture(input))).toMatchObject({ passed: false });
      }
    });

    const invalidFacts: [string, (input: ProcessStartInputFacts) => unknown][] = [
      ["raw top-level application text", input => ({ ...input, rawApplication: "synthetic sensitive path" })],
      ["raw application field", input => ({ ...input, application: { ...input.application, path: "synthetic sensitive path" } })],
      ["raw cwd field", input => ({ ...input, cwd: { ...input.cwd, directory: "synthetic sensitive path" } })],
      ["raw command field", input => ({ ...input, command: { ...input.command, text: "synthetic sensitive command" } })],
      ["raw environment", input => ({ ...input, environment: "synthetic sensitive environment" })],
      ["raw exception", input => ({ ...input, message: "synthetic sensitive exception" })],
      ["unknown role", input => ({ ...input, launchRole: "synthetic sensitive path" })],
      ["unknown path form", input => ({ ...input, application: { ...input.application, pathForm: "synthetic sensitive path" } })],
      ["unknown normalization", input => ({ ...input, cwd: { ...input.cwd, fullPathComparison: "synthetic sensitive path" } })],
      ["wrong flag type", input => ({ ...input, command: { ...input.command, containsNul: "false" } })],
      ["wrong exists type", input => ({ ...input, cwd: { ...input.cwd, exists: 1 } })],
      ["missing application", input => ({ launchRole: input.launchRole, cwd: input.cwd, command: input.command })],
      ["array application", input => ({ ...input, application: [] })],
      ["null command", input => ({ ...input, command: null })],
      ["empty object", () => ({})], ["present undefined", () => undefined],
    ];
    for (const [name, mutate] of invalidFacts) it(`rejects ${name}`, () => {
      expect(() => validateHelperReport(fixture(mutate(facts())))).toThrow("helper_report_invalid");
    });
    for (const slot of ["application", "cwd", "command"] as const) {
      for (const charLength of [-1, 65536, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "31"]) it(`rejects ${slot} length ${String(charLength)}`, () => {
        const input = facts();
        const malformed = { ...input, [slot]: { ...input[slot], charLength } };
        expect(() => validateHelperReport(fixture(malformed))).toThrow("helper_report_invalid");
      });
    }
    it("rejects facts attached to another failure or successful lifecycle", () => {
      expect(() => validateHelperReport(startupFailureFixture([{ ...startupDiagnostic(), processStartInputFacts: facts() }]))).toThrow("helper_report_invalid");
      const ready = startupDiagnostic({ outcome: "database_ready", failureStage: null, databaseExists: true, schemaProbeAttempts: 1, schemaProbeState: "ready", processJobFailure: null });
      expect(() => validateHelperReport({ ...successFixture(), startupDiagnostics: [{ ...ready, processStartInputFacts: facts() }, { ...ready, cycle: 2 }] })).toThrow("helper_report_invalid");
    });
  });

  it("retains suspended job containment while capturing native errors before cleanup", async () => {
    const helper = (await readFile(resolve("tools/desktop-windows-install-smoke.ps1"), "utf8")).replace(/\r\n/g, "\n");
    const native = helper.slice(helper.indexOf("public sealed class LaunchFailure"), helper.indexOf("'@ | Out-Null"));
    expect(native).toContain('int code = Marshal.GetLastWin32Error();');
    expect(native).toContain('new LaunchFailure(stage, unchecked((uint)code), null, suspendCount, inputFacts)');
    const start = native.slice(native.indexOf("public static Process Start"));
    for (const stage of ["stdio_create", "environment_block", "process_create", "job_assign", "process_lookup", "process_handle", "process_resume"]) expect(start).toContain('"' + stage + '"');
    expect(start.indexOf("true, 0x404")).toBeLessThan(start.indexOf("AssignProcessToJobObject(job, info.Process)"));
    expect(start.indexOf("AssignProcessToJobObject(job, info.Process)")).toBeLessThan(start.indexOf("IntPtr retainedHandle = managed.Handle"));
    expect(start.indexOf("IntPtr retainedHandle = managed.Handle")).toBeLessThan(start.indexOf("uint suspendCount = ResumeThread(info.Thread)"));
    expect(start).toContain('if (suspendCount == uint.MaxValue) throw LaunchFailure.Win32(stage, suspendCount, inputFacts);');
    expect(start).toContain('if (suspendCount != 1) throw new LaunchFailure(stage, null, null, suspendCount, inputFacts);');
    expect(start).toContain('if (created && !resumed) { TerminateProcess(info.Process, 1);');
    expect(native).toContain('info.Basic.Flags = 0x2000');
    expect(native).not.toMatch(/0x0?1000000|0x0?800|\.Message|\.StackTrace/);
    const controlled = helper.slice(helper.indexOf("function Start-Controlled"), helper.indexOf("function Wait-Command"));
    expect(controlled.indexOf("try {")).toBeLessThan(controlled.indexOf("::CreateControlledJob()"));
    expect(controlled).toContain('stage = $failure.FailureStage; win32Error = $failure.Win32Error');
    expect(controlled).toContain('hresult = $failure.ManagedHResult; suspendCount = $failure.SuspendCount');
  });

  it("stops launch infrastructure failures without weakening the external schema gate", async () => {
    const helper = (await readFile(resolve("tools/desktop-windows-install-smoke.ps1"), "utf8")).replace(/\r\n/g, "\n");
    const start = helper.slice(helper.indexOf("function Start-App"), helper.indexOf("function Check-Registration"));
    expect(start).toContain("if ($script:lastProbeFailureStage -eq 'process_job') { $script:stage = 'process_job'; throw }");
    expect(start).toContain("$deadline = [DateTime]::UtcNow.AddSeconds(30)");
    expect(start).toContain("$probe = Sqlite-Probe 'schema'");
    expect(start).toContain('$probe.schemaVersion -eq 7 -and $probe.sessions -and $probe.toolInvocations -and $probe.leaseIndex');
    expect(start.indexOf('$diagnostic.processJobFailure = $script:lastProcessJobFailure')).toBeLessThan(start.indexOf('Capture-StartupTrace $runId'));
    expect(start).not.toMatch(/frontend_ready|schema_read_resolved/);
  });

  it("CLI fails closed on ordinary hosts without exposing the supplied package path", () => {
    const privateLikePath = "C:\\Users\\synthetic-private-user\\provider-key-secret.exe";
    const child = spawnSync(process.execPath, [resolve("tools/desktop-windows-install-smoke.mjs"), "--package", privateLikePath, "--json"], {
      encoding: "utf8",
      env: { ...process.env, GITHUB_ACTIONS: "false", RUNNER_ENVIRONMENT: "self-hosted" },
    });
    expect(child.status).toBe(1);
    expect(child.stderr).toBe("");
    expect(child.stdout).not.toContain(privateLikePath);
    expect(JSON.parse(child.stdout)).toMatchObject({ passed: false, errors: [process.platform === "win32" ? "runner_unsupported" : "platform_unsupported"] });
  });

  it("does not expose an unavailable output path in native exception text", () => {
    const privateLikePath = resolve("missing-synthetic-private-parent/report.json");
    const child = spawnSync(process.execPath, [resolve("tools/desktop-windows-install-smoke.mjs"), "--output", privateLikePath, "--json"], {
      encoding: "utf8",
      env: { ...process.env, GITHUB_ACTIONS: "false", RUNNER_ENVIRONMENT: "self-hosted" },
    });
    expect(child.status).toBe(1);
    expect(child.stderr).toBe("");
    expect(child.stdout).not.toContain(privateLikePath);
    expect(JSON.parse(child.stdout)).toMatchObject({ passed: false, errors: [process.platform === "win32" ? "runner_unsupported" : "platform_unsupported", "output_write"], install: { systemPackageDatabaseChanged: false } });
  });
});

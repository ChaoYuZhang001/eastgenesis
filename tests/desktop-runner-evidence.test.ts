// @vitest-environment node
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { REQUIRED_CHECKS as windowsInstallChecks } from "../tools/desktop-windows-install-smoke.mjs";

const validator = resolve(process.cwd(), "tools/desktop-runner-evidence-validate.mjs");

const writeJson = (root: string, name: string, value: unknown) => {
  const file = join(root, name);
  writeFileSync(file, `${JSON.stringify(value)}\n`, "utf8");
  return file;
};

function evidenceSet(root: string, platform: "linux" | "macos" | "windows", packageBinary?: string, includeInstall = false) {
  const provider = writeJson(root, "provider.json", {
    schemaVersion: 1,
    matrix: "provider-recovery",
    mode: "local_fixture",
    passed: true,
    scenarios: Array.from({ length: 15 }, () => ({ passed: true })),
    recovery: Array.from({ length: 4 }, () => ({ passed: true })),
    recoveryStatus: "passed",
  });
  const controlled = writeJson(root, "controlled.json", {
    schemaVersion: 1,
    matrix: "provider-recovery",
    mode: "real_opt_in",
    passed: true,
    scenarios: [{ passed: true }, { passed: true }],
    recovery: [
      { name: "real_fallback_without_partial", passed: true },
      { name: "real_stop_after_partial", passed: true },
    ],
    recoveryStatus: "partial",
  });
  const routing = writeJson(root, "routing.json", { schemaVersion: 1, gate: "routing-quality", passed: true });
  const golden = writeJson(root, "golden.json", { schemaVersion: 1, gate: "golden-task-routing", passed: true, fixture: { total: 30 } });
  const goal = writeJson(root, "goal.json", {
    schemaVersion: 1,
    kind: "goal-recovery-crash-smoke",
    passed: true,
    goalStatus: "completed",
    taskId: "task-process-crash-window",
    runCalls: 0,
    ledgerState: "applied",
    evidenceBoundary: { proven: ["checkpoint"], excluded: ["real WebView"] },
  });
  const goalValidation = writeJson(root, "goal-validation.json", { schemaVersion: 1, valid: true });
  const args = [
    "--platform", platform,
    "--provider", provider,
    "--controlled", controlled,
    "--routing", routing,
    "--golden", golden,
    "--goal", goal,
    "--goal-validation", goalValidation,
    "--json",
  ];
  if (platform !== "macos") {
    const webdriver = writeJson(root, "webdriver.json", {
      schemaVersion: 1,
      kind: "desktop-webdriver-suite",
      passed: true,
      scenarios: Array.from({ length: 4 }, () => ({ passed: true })),
    });
    const environment = join(root, "webdriver-environment.txt");
    writeFileSync(environment, "runner_os=Linux\ntauri_driver=2.1.0\n", "utf8");
    args.push("--webdriver", webdriver, "--environment", environment);
    if (includeInstall) {
      const install = writeJson(root, "install.json", {
        schemaVersion: 1,
        kind: "desktop-install-smoke",
        platform: "linux",
        format: "deb",
        passed: true,
        checks: { packageMetadata: true, packagePayload: true, dependencies: true, binaryStart: true, sqliteSchema: true, controlledTermination: true },
        package: { name: "eastgenesis-desktop", version: "0.1.0", architecture: "amd64", bytes: 123 },
        install: { mode: "deb-extract", isolatedPrefix: true, systemPackageDatabaseChanged: false },
      });
      args.push("--install", install);
    }
  } else {
    const packageValue = {
      schemaVersion: 1,
      kind: "desktop-package-smoke",
      passed: true,
      checks: { restartableProcess: true, sqliteSchema: true, sqliteTables: true },
      ...(packageBinary ? { packageBinary } : {}),
    };
    args.push("--package", writeJson(root, "package.json", packageValue));
  }
  return args;
}

describe("desktop runner evidence validator", () => {
  it("accepts the complete Linux evidence set", () => {
    const root = mkdtempSync(join(tmpdir(), "eastgenesis-runner-evidence-"));
    try {
      const result = spawnSync(process.execPath, [validator, ...evidenceSet(root, "linux")], { encoding: "utf8" });
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ kind: "desktop-runner-evidence", platform: "linux", passed: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(["valid", "missing_uninstall", "false_upgrade", "live_tree", "missing_file"])("checks real Windows installation evidence: %s", (scenario) => {
    const root = mkdtempSync(join(tmpdir(), "eastgenesis-runner-windows-install-"));
    try {
      const install = {
        schemaVersion: 1, kind: "desktop-windows-install-smoke", platform: "windows", format: "nsis", passed: true,
        checks: Object.fromEntries(windowsInstallChecks.map((key) => [key, scenario !== "missing_uninstall" || key !== "nsisUninstall"])),
        install: { mode: "nsis-install-reinstall-uninstall", isolatedPrefix: true, isolatedAppDirectories: true, sameVersionReinstall: true, crossVersionUpgrade: scenario === "false_upgrade", knownFoldersRegistryChanged: false },
        launches: [1, 2].map((cycle) => ({ cycle, graceful: false, forced: true, processTreeGone: scenario !== "live_tree", stableWindowMs: 4_000, survivedStableWindow: true, jobAssignedBeforeExecution: true })),
      };
      const file = scenario === "missing_file" ? join(root, "missing.json") : writeJson(root, "windows-install.json", install);
      const result = spawnSync(process.execPath, [validator, ...evidenceSet(root, "windows"), "--windows-install", file], { encoding: "utf8" });
      expect(result.status).toBe(scenario === "valid" ? 0 : 1);
      expect(JSON.parse(result.stdout).passed).toBe(scenario === "valid");
      expect(result.stdout).not.toContain(root);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("accepts isolated deb install evidence when the release gate requires it", () => {
    const root = mkdtempSync(join(tmpdir(), "eastgenesis-runner-evidence-install-"));
    try {
      const result = spawnSync(process.execPath, [validator, ...evidenceSet(root, "linux", undefined, true)], { encoding: "utf8" });
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ kind: "desktop-runner-evidence", platform: "linux", passed: true, checks: { installMode: true, installChecks: true } });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(["valid", "missing_uninstall", "same_version", "extract_only", "missing_file"])("checks real Linux upgrade evidence: %s", (scenario) => {
    const root = mkdtempSync(join(tmpdir(), "eastgenesis-runner-upgrade-"));
    try {
      const upgrade = {
        schemaVersion: 1, kind: "desktop-linux-upgrade-smoke", platform: "linux", format: "deb", passed: true,
        checks: { baselineInstalled: true, baselineLaunched: true, newerVersionInstalled: true, upgradeLaunched: true, sessionRetained: true, sqliteSchema: true, desktopEntry: true, dependencies: true, uninstalled: scenario !== "missing_uninstall", uninstallRetainsUserData: true },
        packages: [{ role: "baseline", name: "east-genesis-desktop", version: "0.1.0", architecture: "amd64" }, { role: "upgrade", name: "east-genesis-desktop", version: scenario === "same_version" ? "0.1.0" : "0.1.1", architecture: "amd64" }],
        install: { mode: scenario === "extract_only" ? "deb-extract" : "dpkg-system", disposableRunner: true, isolatedUserData: true, systemPackageDatabaseChanged: true, cleanupVerified: true, database: { schemaVersion: 7, sessionSentinel: true, toolInvocations: true }, launches: ["0.1.0", "0.1.1"].map((version) => ({ version, installedProcessIdentity: true, stableProcessWindowMs: 4_000, controlledCleanup: true })) },
      };
      const file = scenario === "missing_file" ? join(root, "missing.json") : writeJson(root, "upgrade.json", upgrade);
      const result = spawnSync(process.execPath, [validator, ...evidenceSet(root, "linux"), "--upgrade", file], { encoding: "utf8" });
      expect(result.status).toBe(scenario === "valid" ? 0 : 1);
      expect(JSON.parse(result.stdout).passed).toBe(scenario === "valid");
      expect(result.stdout).not.toContain(root);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("rejects an absolute package path without echoing the path", () => {
    const root = mkdtempSync(join(tmpdir(), "eastgenesis-runner-evidence-invalid-"));
    const secretPath = "/private/tmp/provider-sk-secret/EastGenesis.app";
    try {
      const result = spawnSync(process.execPath, [validator, ...evidenceSet(root, "macos", secretPath)], { encoding: "utf8" });
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({ platform: "macos", passed: false });
      expect(result.stdout).not.toContain(secretPath);
      expect(result.stdout).toContain("redaction");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

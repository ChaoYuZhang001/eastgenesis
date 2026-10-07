#!/usr/bin/env node
// 校验单个平台 workflow 生成的桌面证据集合。
// 只输出固定的 kind/status/checks，不回显输入路径、正文、Provider 地址或凭据。
import { readFile, writeFile } from "node:fs/promises";
import { validateGoalRecoveryEvidence } from "./goal-recovery-evidence.mjs";
import { REQUIRED_CHECKS as windowsInstallChecks } from "./desktop-windows-install-smoke.mjs";

const args = process.argv.slice(2);
const valueOf = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const platform = (valueOf("--platform") ?? process.platform).toLowerCase().replaceAll("-", "");
const output = valueOf("--output");
const jsonOutput = args.includes("--json") || Boolean(output);
if (!["linux", "windows", "macos", "darwin"].includes(platform)) throw new Error("--platform 仅支持 linux、windows 或 macos");
const normalizedPlatform = platform === "darwin" ? "macos" : platform;

const files = {
  provider: valueOf("--provider"),
  controlled: valueOf("--controlled"),
  routing: valueOf("--routing"),
  golden: valueOf("--golden"),
  goal: valueOf("--goal"),
  goalValidation: valueOf("--goal-validation"),
  webdriver: valueOf("--webdriver"),
  package: valueOf("--package"),
  install: valueOf("--install"),
  upgrade: valueOf("--upgrade"),
  windowsInstall: valueOf("--windows-install"),
  environment: valueOf("--environment"),
};

const errors = [];
const checks = {};
const parsed = {};

async function readJson(kind) {
  const source = files[kind];
  if (!source) {
    errors.push(`${kind}: 缺少产物`);
    checks[kind] = false;
    return null;
  }
  try {
    const value = JSON.parse(await readFile(source, "utf8"));
    parsed[kind] = value;
    return value;
  } catch {
    errors.push(`${kind}: JSON 无效`);
    checks[kind] = false;
    return null;
  }
}

async function readText(kind) {
  const source = files[kind];
  if (!source) {
    errors.push(`${kind}: 缺少产物`);
    checks[kind] = false;
    return null;
  }
  try {
    const value = await readFile(source, "utf8");
    if (!value.trim()) throw new Error("empty");
    parsed[kind] = value;
    return value;
  } catch {
    errors.push(`${kind}: 文本产物无效`);
    checks[kind] = false;
    return null;
  }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function allPassed(rows) {
  return Array.isArray(rows) && rows.length > 0 && rows.every((row) => row?.passed === true);
}

function check(kind, passed, message) {
  checks[kind] = passed;
  if (!passed) errors.push(message);
}

function validateCommon(kind, value, expectedValue, field = "kind") {
  check(`${kind}Shape`, isObject(value) && value.schemaVersion === 1 && value[field] === expectedValue, `${kind}: schema 或标识不匹配`);
  check(`${kind}Passed`, value?.passed === true, `${kind}: passed 必须为 true`);
}

function validateNoSecrets() {
  const forbiddenKeys = new Set(["packageBinary", "apiKey", "authorization", "baseUrl", "url", "path", "filePath", "file_paths", "tool_args", "tool_output", "raw_event_text"]);
  const secretPattern = /(?:bearer\s+|sk-[a-z0-9]{8,}|x-api-key\s*[:=]|https?:\/\/)/i;
  const visit = (value) => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!isObject(value)) return;
    for (const [key, child] of Object.entries(value)) {
      if (forbiddenKeys.has(key)) throw new Error("forbidden key");
      if (typeof child === "string" && secretPattern.test(child)) throw new Error("secret-like value");
      visit(child);
    }
  };
  try {
    visit(parsed);
    check("redaction", true, "");
  } catch {
    check("redaction", false, "证据包含禁止字段或疑似敏感值");
  }
}

const provider = await readJson("provider");
validateCommon("provider", provider, "provider-recovery", "matrix");
check("providerScenarios", provider?.mode === "local_fixture" && Array.isArray(provider?.scenarios) && provider.scenarios.length === 15 && allPassed(provider.scenarios), "provider: 本地 15 个场景未全部通过");
check("providerRecovery", provider?.recoveryStatus === "passed" && Array.isArray(provider?.recovery) && provider.recovery.length === 4 && allPassed(provider.recovery), "provider: 4 个恢复场景未全部通过");

const controlled = await readJson("controlled");
validateCommon("controlled", controlled, "provider-recovery", "matrix");
const controlledNames = new Set(["real_fallback_without_partial", "real_stop_after_partial"]);
check("controlledScenarios", controlled?.mode === "real_opt_in" && Array.isArray(controlled?.scenarios) && controlled.scenarios.length === 2 && allPassed(controlled.scenarios), "controlled: 双 Provider smoke 未全部通过");
check("controlledRecovery", controlled?.recoveryStatus === "partial" && Array.isArray(controlled?.recovery) && controlled.recovery.length === 2 && controlled.recovery.every((row) => row?.passed === true && controlledNames.has(row.name)), "controlled: 受控恢复证据不完整");

const routing = await readJson("routing");
validateCommon("routing", routing, "routing-quality", "gate");

const golden = await readJson("golden");
validateCommon("golden", golden, "golden-task-routing", "gate");
check("goldenTasks", golden?.fixture?.total === 30, "golden: 任务数量不是 30");

const goal = await readJson("goal");
const goalResult = validateGoalRecoveryEvidence(goal);
check("goalRecovery", goalResult.valid, "goal: 跨进程恢复证据无效");

const goalValidation = await readJson("goalValidation");
check("goalValidation", goalValidation?.valid === true, "goalValidation: 脱敏校验未通过");

const webdriverRequired = normalizedPlatform === "linux" || normalizedPlatform === "windows";
if (webdriverRequired) {
  const webdriver = await readJson("webdriver");
  validateCommon("webdriver", webdriver, "desktop-webdriver-suite");
  check("webdriverScenarios", Array.isArray(webdriver?.scenarios) && webdriver.scenarios.length === 4 && allPassed(webdriver.scenarios), "webdriver: 四个场景未全部通过");
  await readText("environment");
} else {
  checks.webdriver = true;
  checks.environment = true;
}

if (normalizedPlatform === "macos") {
  const packageEvidence = await readJson("package");
  validateCommon("package", packageEvidence, "desktop-package-smoke");
  check("packageChecks", isObject(packageEvidence?.checks) && Object.values(packageEvidence.checks).every((value) => value === true) && !Object.hasOwn(packageEvidence, "packageBinary"), "package: QA 包检查不完整或含本机路径");
} else {
  checks.package = true;
}

// Installation evidence is opt-in so old/manual evidence sets remain
// readable, but the release workflow passes --install on Linux and therefore
// fails closed when the extracted-package smoke is missing or incomplete.
if (normalizedPlatform === "linux" && files.install) {
  const install = await readJson("install");
  validateCommon("install", install, "desktop-install-smoke");
  check("installFormat", install?.platform === "linux" && install?.format === "deb", "install: 不是 Linux deb 证据");
  check("installMode", install?.install?.mode === "deb-extract" && install?.install?.isolatedPrefix === true && install?.install?.systemPackageDatabaseChanged === false, "install: 必须是隔离 deb 解包证据");
  check("installChecks", isObject(install?.checks) && Object.values(install.checks).length > 0 && Object.values(install.checks).every((value) => value === true), "install: 安装烟测检查未全部通过");
} else {
  checks.install = true;
}

if (normalizedPlatform === "linux" && files.upgrade) {
  const upgrade = await readJson("upgrade");
  validateCommon("upgrade", upgrade, "desktop-linux-upgrade-smoke");
  const required = ["baselineInstalled", "baselineLaunched", "newerVersionInstalled", "upgradeLaunched", "sessionRetained", "sqliteSchema", "desktopEntry", "dependencies", "uninstalled", "uninstallRetainsUserData"];
  check("upgradeChecks", required.every((key) => upgrade?.checks?.[key] === true), "upgrade: 安装、升级、数据保留或卸载检查缺失");
  check("upgradeMode", upgrade?.platform === "linux" && upgrade?.format === "deb" && upgrade?.install?.mode === "dpkg-system" && upgrade?.install?.disposableRunner === true && upgrade?.install?.isolatedUserData === true && upgrade?.install?.systemPackageDatabaseChanged === true && upgrade?.install?.cleanupVerified === true, "upgrade: 必须是一次性 runner 的真实 dpkg 证据并验证清理");
  const baseline = upgrade?.packages?.find((row) => row.role === "baseline");
  const newer = upgrade?.packages?.find((row) => row.role === "upgrade");
  const versionParts = (value) => typeof value === "string" && /^\d+\.\d+\.\d+$/.test(value) ? value.split(".").map(Number) : null;
  const before = versionParts(baseline?.version);
  const after = versionParts(newer?.version);
  const differentVersion = before && after && after.some((value, index) => value > before[index] && after.slice(0, index).every((part, i) => part === before[i]));
  check("upgradeVersions", Array.isArray(upgrade?.packages) && upgrade.packages.length === 2 && baseline?.name === newer?.name && baseline?.architecture === newer?.architecture && Boolean(differentVersion), "upgrade: 同一产品的递增版本证据缺失");
  check("upgradeDatabase", upgrade?.install?.database?.schemaVersion === 7 && upgrade?.install?.database?.sessionSentinel === true && upgrade?.install?.database?.toolInvocations === true, "upgrade: SQLite 和会话哨兵未验收");
  check("upgradeLaunches", Array.isArray(upgrade?.install?.launches) && upgrade.install.launches.length === 2 && [baseline, newer].every((pkg, index) => upgrade.install.launches[index]?.version === pkg?.version && upgrade.install.launches[index]?.installedProcessIdentity === true && upgrade.install.launches[index]?.stableProcessWindowMs >= 4_000 && upgrade.install.launches[index]?.controlledCleanup === true), "upgrade: 两个已安装版本的实际进程身份和存活窗口未验收");
} else {
  checks.upgrade = true;
}

if (normalizedPlatform === "windows" && files.windowsInstall) {
  const install = await readJson("windowsInstall");
  validateCommon("windowsInstall", install, "desktop-windows-install-smoke");
  check("windowsInstallChecks", windowsInstallChecks.every((key) => install?.checks?.[key] === true), "windowsInstall: 真实安装、修复、保留或卸载检查缺失");
  check("windowsInstallMode", install?.platform === "windows" && install?.format === "nsis" && install?.install?.mode === "nsis-install-reinstall-uninstall" && install?.install?.isolatedPrefix === true && install?.install?.isolatedAppDirectories === true && install?.install?.sameVersionReinstall === true && install?.install?.crossVersionUpgrade === false && install?.install?.knownFoldersRegistryChanged === false, "windowsInstall: 必须是隔离 NSIS 同包修复证据");
  check("windowsInstallLaunches", Array.isArray(install?.launches) && install.launches.length === 2 && install.launches.every((launch, index) => launch.cycle === index + 1 && typeof launch.graceful === "boolean" && typeof launch.forced === "boolean" && launch.graceful !== launch.forced && launch.processTreeGone === true && Number.isSafeInteger(launch.stableWindowMs) && launch.stableWindowMs >= 4_000 && launch.survivedStableWindow === true && launch.jobAssignedBeforeExecution === true), "windowsInstall: 两轮实际进程存活、先绑定进程树和退出记录缺失");
} else {
  checks.windowsInstall = true;
}

validateNoSecrets();
const report = {
  schemaVersion: 1,
  kind: "desktop-runner-evidence",
  platform: normalizedPlatform,
  passed: errors.length === 0 && Object.values(checks).every(Boolean),
  checks,
  ...(errors.length ? { errors: errors.slice(0, 20) } : {}),
  evidenceBoundary: {
    proven: ["required CI evidence files exist and pass their fixed schemas", "platform-specific WebDriver/package evidence is present when applicable", "uploaded JSON passes the shared redaction boundary"],
    excluded: ["real Provider availability or SLA", "real macOS WebView interaction", "installation/upgrade success beyond the recorded package smoke"],
  },
};

const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (output) await writeFile(output, serialized, "utf8");
if (jsonOutput) process.stdout.write(serialized);
else console.log(`desktop runner evidence ${report.passed ? "passed" : "failed"} (${normalizedPlatform})`);
if (!report.passed) process.exitCode = 1;

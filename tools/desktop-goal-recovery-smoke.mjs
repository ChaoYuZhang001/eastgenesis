// macOS-only real Tauri/WebView fault recovery. The app creates every goal,
// task and ledger record; SQLite is opened read-only for assertions only.
import { createServer } from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, stat, access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { stopDetachedProcess, hasProcessExited } from "./desktop-process-cleanup.mjs";

const options = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const at = arg.indexOf("=");
  return [arg.slice(0, at), arg.slice(at + 1)];
}));
const app = resolve(options["--app"] ?? "target/release/bundle/macos/EastGenesis Desktop.app/Contents/MacOS/eastgenesis-desktop");
const output = resolve(options["--output"] ?? "reports/desktop-goal-recovery-macos.json");
const allPoints = ["after_ledger_started", "after_tool_before_ledger_commit", "unknown_after_external_sandbox_removal"];
const points = options["--scenario"] ? allPoints.filter((p) => p === options["--scenario"]) : allPoints;
const leaseMs = 30_000;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
function fail(stage) { const e = new Error(stage); e.stage = stage; throw e; }
function requireThat(value, stage) { if (!value) fail(stage); }
async function waitFor(fn, stage, ms = 15_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await fn()) return; await pause(100); }
  fail(stage);
}
const exists = async (file) => access(file).then(() => true, () => false);
async function fingerprint(file) {
  const s = await stat(file);
  return { inode: s.ino, mtimeMs: s.mtimeMs, digest: createHash("sha256").update(await readFile(file)).digest("hex") };
}
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
let lastAxFailure;

// The synthetic planner knows only fixed sandbox-relative paths. No request
// bodies, provider addresses, raw AX content, task IDs or file paths are logged.
async function fixture() {
  const counts = { plan: 0, args: 0, stream: 0, jsonProbes: 0 };
  const server = createServer((req, res) => {
    const chunks = []; let bytes = 0;
    req.on("data", (chunk) => { bytes += chunk.length; if (bytes < 1_048_576) chunks.push(chunk); else req.destroy(); });
    req.on("end", () => {
      if (req.url?.endsWith("/models")) {
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify({ data: [{ id: "gpt-5.6-luna", object: "model" }] }));
      }
      let body; try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return res.writeHead(400).end(); }
      const planner = body.messages?.some((m) => m.role === "system" && m.content?.includes("任务规划器"));
      const generatingArgs = body.messages?.some((m) => m.role === "system" && m.content?.includes("你为工具生成调用参数"));
      const args = { src: "~/Downloads/source.txt", dst: "~/Downloads/target.txt" };
      const text = planner ? JSON.stringify({ steps: [{ goal: "移动隔离沙箱文件；依据：固定测试输入", tool: "mcp__files__move_file", args }] }) : generatingArgs ? JSON.stringify(args) : "已移动文件到 ~/Downloads/target.txt，固定目标已完成。";
      if (planner) counts.plan++;
      if (generatingArgs) counts.args++;
      if (!planner && !generatingArgs && body.stream !== true) counts.jsonProbes++;
      if (body.stream === true) {
        counts.stream++;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`);
        return res.end('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ model: "gpt-5.6-luna", choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 } }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, counts, base: `http://127.0.0.1:${server.address().port}/v1` };
}

function ax(pid, content) {
  try {
    return execFileSync("osascript", ["-e", `tell application "System Events"
tell (first process whose unix id is ${pid})
set frontmost to true
tell window 1
try
set value of attribute "AXMinimized" to false
perform action "AXRaise"
end try
set allElements to entire contents
${content}
end tell
end tell
end tell`], { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (e) {
    const code = String(e.stderr ?? "").match(/\((-?\d+)\)\s*$/)?.[1];
    lastAxFailure = code ? `ax_operation_${code.replace("-", "minus")}` : "ax_operation";
    fail(lastAxFailure);
  }
}
function click(pid, label, role = "Button") {
  const result = ax(pid, `set chosen to missing value
repeat with e in allElements
try
if (role of e as text) contains ${JSON.stringify(role)} and (name of e as text) starts with ${JSON.stringify(label)} then
set chosen to e
exit repeat
end if
end try
end repeat
if chosen is missing value then return "missing"
click chosen
return "clicked"`);
  requireThat(result === "clicked", `ax_click_${label === "目标" ? "goal_mode" : label === "批准" ? "approve" : label === "继续" ? "resume" : "control"}`);
}
function hasLabel(pid, label) {
  try {
    return ax(pid, `repeat with e in allElements
try
if (name of e as text) is ${JSON.stringify(label)} then return "found"
end try
end repeat
return "missing"`) === "found";
  } catch { return false; }
}
async function stableLabel(pid, label, stage, onRestoreDismissed) {
  let stable = 0;
  await waitFor(async () => {
    if (!hasLabel(pid, label)) {
      stable = 0;
      // AppKit can show its own restore-windows alert after a real abort.
      // Match only the test PID's exact "do not reopen" choice, never Restore.
      for (const choice of ["Don't Reopen", "Don’t Reopen", "不重新打开", "不要重新打开"]) {
        if (hasLabel(pid, choice)) { click(pid, choice); onRestoreDismissed?.(); break; }
      }
      return false;
    }
    stable++;
    if (stable < 2) { await pause(250); return false; }
    return true;
  }, stage);
}
function pasteTask(pid) {
  const text = "把 ~/Downloads/source.txt 移动到 ~/Downloads/target.txt";
  execFileSync("pbcopy", [], { input: text });
  const result = ax(pid, `set chosen to missing value
repeat with e in allElements
try
if (role of e as text) contains "TextArea" then
set chosen to e
exit repeat
end if
end try
end repeat
if chosen is missing value then return "missing"
click chosen
delay 0.2
keystroke "v" using command down
delay 0.2
if (value of chosen as text) is ${JSON.stringify(text)} then return "pasted"
return "missing"`);
  requireThat(result === "pasted", "ax_task_input");
}
function readDatabase(db) {
  try {
    const goals = JSON.parse(execFileSync("sqlite3", ["-readonly", "-json", db, "SELECT status, rounds FROM goals WHERE status != 'deleted'"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
    const ledger = JSON.parse(execFileSync("sqlite3", ["-readonly", "-json", db, "SELECT task_id, state, lease_expires_at FROM tool_invocations"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
    const goal = goals[0]; const rounds = goal ? JSON.parse(goal.rounds) : []; const round = rounds.at(-1);
    return { goal, round, ledger, events: round?.task_checkpoint?.events ?? [] };
  } catch { return null; }
}
function startApp(home, base, point) {
  // A synthetic official-compatible name supplies tool_use capability metadata;
  // every HTTP request still terminates at this script's loopback server.
  const env = { HOME: home, PATH: process.env.PATH, TMPDIR: tmpdir(), LANG: "en_US.UTF-8", EASTGENESIS_QA_ISOLATED_PROFILE: "1", EASTGENESIS_QA_PROVIDER_BASE_URL: base, EASTGENESIS_QA_PROVIDER_MODEL: "gpt-5.6-luna", EASTGENESIS_QA_PROVIDER_PROTOCOL: "openai", EASTGENESIS_QA_LEDGER_LEASE_MS: String(leaseMs), ...(point ? { EASTGENESIS_QA_FAULT_POINT: point } : {}) };
  const child = spawn(app, [], { env, detached: true, stdio: ["ignore", "ignore", "ignore"] });
  return child;
}
async function cleanup(child) {
  if (!child?.pid) return;
  try { await stopDetachedProcess(child, { graceMs: 1_000, killMs: 2_000 }); }
  catch (e) { if (e.stage !== "process_early_exit") throw e; }
}

async function scenario(point, f) {
  const result = { scenario: point, status: "not_run", assertions: {} };
  lastAxFailure = undefined;
  const home = await mkdtemp(join(tmpdir(), "eg-goal-ax-"));
  const sandbox = join(home, "Downloads");
  const src = join(sandbox, "source.txt"); const dst = join(sandbox, "target.txt");
  const db = join(home, "Library/Application Support/com.eastgenesis.desktop/eastgenesis.db");
  const providerConfig = join(home, "Library/Application Support/com.eastgenesis.desktop/providers.json");
  let child;
  let restoreDialogsDismissed = 0;
  const unknown = point === "unknown_after_external_sandbox_removal";
  try {
    await mkdir(sandbox); await writeFile(src, "synthetic goal recovery input\n");
    requireThat(!await exists(providerConfig), "fresh_profile_no_provider_config");
    const original = await fingerprint(src);
    console.log(`desktop goal ${point}: launch`);
    child = startApp(home, f.base, unknown ? "after_tool_before_ledger_commit" : point);
    await stableLabel(child.pid, "添加", "initial_window_ready", () => { restoreDialogsDismissed++; });
    click(child.pid, "添加");
    await pause(200);
    // The goal mode menu is exposed as an AXMenuItem in this WebView.
    click(child.pid, "目标", "MenuItem");
    await waitFor(() => hasLabel(child.pid, "移除目标模式"), "goal_mode_ready");
    pasteTask(child.pid); await pause(200); click(child.pid, "提交任务");
    await waitFor(() => hasLabel(child.pid, "开始"), "goal_created");
    click(child.pid, "开始");
    await waitFor(() => hasLabel(child.pid, "批准"), "tool_confirmation");
    click(child.pid, "批准");
    await waitFor(() => hasProcessExited(child), "fault_exit");
    requireThat(child.signalCode === "SIGABRT", "real_fault_abort");
    const crashed = readDatabase(db);
    requireThat(crashed?.ledger.length === 1 && crashed.ledger[0].state === "started", "started_ledger");
    const taskId = crashed.round?.task_id;
    requireThat(taskId && crashed.round.task_checkpoint?.id === taskId, "durable_task_checkpoint");
    requireThat(crashed.events.some((e) => e.type === "plan") && crashed.events.some((e) => e.type === "gate"), "durable_plan_and_args");
    const beforeTool = point === "after_ledger_started";
    requireThat(await exists(src) === beforeTool && await exists(dst) === !beforeTool, "crash_window_file_state");
    const crashFingerprint = await fingerprint(beforeTool ? src : dst);
    requireThat(equal(original, crashFingerprint), "single_move_preserves_identity");
    const expiry = crashed.ledger[0].lease_expires_at;
    result.assertions = { crashIsRealProcessAbort: child.signalCode === "SIGABRT", sqliteStarted: true, checkpointBeforeSideEffect: true, taskIdentityPreservedAtCrash: true, correctCrashWindow: true };
    requireThat(crashed.events.filter((e) => e.type === "llm").every((e) => e.profileId?.startsWith("custom:qa/")), "fixture_only_model_calls");
    Object.assign(result.assertions, { isolatedQaKeychain: true, noInheritedKeyEnvironment: true, freshProfileNoProviderConfig: true, capturedModelCallsUseFixture: true });
    if (unknown) {
      // Deliberately remove only the temporary output after a proven real
      // app move. This is external state disturbance, not an app side effect.
      await rm(dst);
      result.assertions.externalSandboxOutputRemovedByHarness = true;
    }
    await cleanup(child); child = startApp(home, f.base);
    await stableLabel(child.pid, "继续", "restart_resume_entry", () => { restoreDialogsDismissed++; });
    requireThat(Date.now() + 1_000 < expiry, "active_lease_window");
    click(child.pid, "继续");
    await waitFor(() => {
      const r = readDatabase(db);
      return r?.goal.status === "paused" && r.round?.task_checkpoint?.status === "needs_user" && r.ledger.length === 1 && r.events.some((e) => e.type === "probe" && e.detail?.includes("另一个运行实例"));
    }, "active_lease_needs_user");
    requireThat(unknown ? !await exists(src) && !await exists(dst) : equal(crashFingerprint, await fingerprint(beforeTool ? src : dst)), "active_lease_no_side_effect");
    requireThat(readDatabase(db).round.task_id === taskId, "active_lease_same_task");
    Object.assign(result.assertions, { activeLeaseNeedsUser: true, activeLeaseNoReplay: true, activeLeaseSameTask: true });
    console.log(`desktop goal ${point}: active lease blocked; awaiting QA expiry`);
    await waitFor(() => Date.now() > expiry + 50, "qa_lease_expiry", leaseMs + 2_000);
    click(child.pid, "继续");
    if (unknown) {
      await waitFor(() => {
        const r = readDatabase(db);
        return r?.goal.status === "paused" && r.round?.task_checkpoint?.status === "needs_user" && r.ledger[0]?.state === "unknown";
      }, "unknown_probe_needs_user");
      const r = readDatabase(db);
      requireThat(r.round.task_id === taskId && r.events.some((e) => e.type === "probe" && e.state === "unknown"), "unknown_same_task_probe");
      requireThat(!await exists(src) && !await exists(dst) && !hasLabel(child.pid, "批准"), "unknown_not_replayed");
      requireThat(!await exists(providerConfig) && r.events.filter((e) => e.type === "llm").every((e) => e.profileId?.startsWith("custom:qa/")), "isolated_fixture_only_recovery");
      Object.assign(result.assertions, { sameTaskAfterRecovery: true, unknownProbeNeedsUser: true, sqliteUnknown: true, noApprovalToReplay: true, sandboxFilesNotRecreated: true, noDuplicateSideEffect: true });
      result.goalStatus = r.goal.status;
      result.status = "passed";
      console.log(`desktop goal ${point}: passed`);
      return result;
    }
    if (beforeTool) {
      await waitFor(() => hasLabel(child.pid, "批准"), "recovery_confirmation");
      click(child.pid, "批准");
    }
    await waitFor(() => {
      const r = readDatabase(db);
      return r?.ledger[0]?.state === "applied" && r.round?.task_checkpoint?.status === "completed";
    }, "recovery_applied");
    const resumed = readDatabase(db);
    requireThat(!await exists(providerConfig) && resumed.events.filter((e) => e.type === "llm").every((e) => e.profileId?.startsWith("custom:qa/")), "isolated_fixture_only_recovery");
    requireThat(resumed.round.task_id === taskId && resumed.round.task_checkpoint.id === taskId, "resumed_same_task");
    requireThat(!await exists(src) && await exists(dst), "final_move_state");
    requireThat(equal(original, await fingerprint(dst)), "final_identity_unchanged");
    const expectedProbe = beforeTool ? "not_applied" : "applied";
    requireThat(resumed.events.some((e) => e.type === "probe" && e.state === expectedProbe), "recovery_probe");
    const toolResults = resumed.events.filter((e) => e.type === "tool_result");
    requireThat(toolResults.length === (beforeTool ? 1 : 0), "recovery_tool_result_count");
    Object.assign(result.assertions, { sameTaskAfterRecovery: true, recoveredProbe: expectedProbe, sqliteApplied: true, sourceAbsentTargetPresent: true, artifactIdentityUnchanged: true, noDuplicateSideEffect: true, recoveryToolResults: toolResults.length });
    // The goal judge may defer to the user. Confirm only after the independent
    // filesystem and ledger assertions above prove the fixed sandbox goal.
    if (hasLabel(child.pid, "确认已完成")) {
      click(child.pid, "确认已完成");
      await waitFor(() => readDatabase(db)?.goal.status === "completed", "verified_goal_confirmation");
      result.assertions.goalCompletionConfirmedFromVerifiedArtifact = true;
    }
    result.goalStatus = readDatabase(db).goal.status;
    result.status = "passed";
    console.log(`desktop goal ${point}: passed`);
  } catch (e) {
    result.status = "failed"; result.failedStage = e.stage ?? "unexpected_failure";
    result.observedProcess = { exitCode: child?.exitCode ?? null, signalCode: child?.signalCode ?? null };
    if (lastAxFailure) result.lastAxFailure = lastAxFailure;
    result.observedKnownDialogChoices = ["Don't Reopen", "Don’t Reopen", "不重新打开", "不要重新打开", "Reopen", "重新打开", "Ignore", "忽略", "Allow", "允许", "Don't Allow", "不允许"].filter((label) => hasLabel(child.pid, label));
    try { result.observedAxElementCount = Number(ax(child.pid, "return count of allElements")); } catch { /* never dump raw AX content */ }
    try { result.observedAxRoleCounts = JSON.parse(ax(child.pid, `set resultText to "["
repeat with e in allElements
try
if resultText is not "[" then set resultText to resultText & ","
set resultText to resultText & "\\\"" & (role of e as text) & "\\\""
end try
end repeat
return resultText & "]"`)).reduce((counts, role) => ({ ...counts, [role]: (counts[role] ?? 0) + 1 }), {}); } catch { /* roles only, no content */ }
    const r = readDatabase(db);
    if (r) result.observed = { goalStatus: r.goal?.status ?? "none", roundStatus: r.round?.status ?? "none", taskStatus: r.round?.task_checkpoint?.status ?? "none", ledgerStates: r.ledger.map((l) => l.state), eventTypes: [...new Set(r.events.map((e) => e.type))], probeStates: r.events.filter((e) => e.type === "probe").map((e) => e.state) };
  }
  finally { result.restoreDialogsDismissed = restoreDialogsDismissed; try { await cleanup(child); result.controlledCleanup = true; } catch { result.controlledCleanup = false; result.status = "failed"; result.failedStage = "cleanup"; } await rm(home, { recursive: true, force: true }); }
  return result;
}

const report = { schemaVersion: 1, kind: "desktop-goal-fault-recovery", platform: "macos", architecture: process.arch, createdAt: new Date().toISOString(), appIdentifier: "com.eastgenesis.desktop", appVersion: "0.1.0", qaLeaseMs: leaseMs, productionLeaseMs: 600_000, scenarios: [], evidenceBoundary: { proven: [], excluded: ["production ten-minute immediate takeover", "real provider", "Windows or Linux runtime", "arbitrary filesystem crash durability", "all duplicate tool call attempts", "arbitrary external service side effect probes", "automatic goal completion judgement accuracy"] } };
let f;
try {
  requireThat(process.platform === "darwin", "macos_required");
  report.osVersion = execFileSync("sw_vers", ["-productVersion"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  report.osBuild = execFileSync("sw_vers", ["-buildVersion"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  requireThat(points.length > 0, "unknown_scenario");
  const plist = resolve(app, "../../Info.plist");
  report.appIdentifier = execFileSync("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleIdentifier", plist], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  report.appVersion = execFileSync("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleShortVersionString", plist], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  requireThat(report.appIdentifier === "com.eastgenesis.desktop", "qa_app_identifier");
  report.sourceRevision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  report.sourceWorkingTreeChangesIncluded = true;
  const sourceFiles = ["src/agent/runtime.ts", "src/lib/engine.ts", "src/lib/recovery.ts", "src/stores/tasks.ts", "src/platform/types.ts", "src/platform/tauri-backend.ts", "src-tauri/src/lib.rs", "src-tauri/src/keychain.rs"];
  const sourceDigest = createHash("sha256");
  for (const file of sourceFiles) { sourceDigest.update(file); sourceDigest.update(await readFile(file)); }
  report.recoverySourceSha256 = sourceDigest.digest("hex");
  report.recoverySourceFiles = sourceFiles;
  report.harnessSha256 = createHash("sha256").update(await readFile(new URL(import.meta.url))).digest("hex");
  report.binarySha256 = createHash("sha256").update(await readFile(app)).digest("hex");
  f = await fixture();
  for (const point of points) report.scenarios.push(await scenario(point, f));
  report.fixtureRequestCounts = f.counts;
  requireThat(report.binarySha256 === createHash("sha256").update(await readFile(app)).digest("hex"), "bundle_changed_during_run");
  report.passed = report.scenarios.every((r) => r.status === "passed");
  if (report.passed) report.evidenceBoundary.proven = ["real Tauri WebView creates goal and same-task checkpoint", "real builtin MCP move under temporary HOME Downloads", "real process abort in selected ledger windows", "active lease stops with needs_user and no side effect", "expired QA lease uses actual file probes", "same task recovery without duplicate move side effect", "all recorded model calls use isolated loopback fixture", ...(points.includes("unknown_after_external_sandbox_removal") ? ["unknown after explicit sandbox state disturbance stops with needs_user"] : [])];
} catch (e) { report.passed = false; report.failedStage = e.stage ?? "unexpected_failure"; }
finally {
  if (f) await new Promise((r) => f.server.close(r));
  report.finishedAt = new Date().toISOString();
  execFileSync("pbcopy", [], { input: "" });
  await mkdir(resolve(output, ".."), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ passed: report.passed, scenarios: report.scenarios.map(({ scenario, status, failedStage }) => ({ scenario, status, failedStage })) }));
}
if (!report.passed) process.exitCode = 1;

// Real macOS picker/context/root sandbox smoke. App state is created through
// its UI; SQLite/file-roots are read-only assertion sources, never seeded.
import { createServer } from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, stat, access, rm, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { stopDetachedProcess } from "./desktop-process-cleanup.mjs";

const options = Object.fromEntries(process.argv.slice(2).map((arg) => { const at = arg.indexOf("="); return [arg.slice(0, at), arg.slice(at + 1)]; }));
const app = resolve(options["--app"] ?? "target/release/bundle/macos/EastGenesis Desktop.app/Contents/MacOS/eastgenesis-desktop");
const output = resolve(options["--output"] ?? "/tmp/eastgenesis-native-picker.json");
// A caller must bind the app produced by its build; omission never skips checks.
const expectedBinary = options["--expected-binary-sha256"];
const compiledRevision = options["--compiled-source-revision"];
const boundFiles = [
  "crates/eg-core/src/file_roots.rs", "crates/eg-core/src/mcp_service.rs", "src-tauri/src/lib.rs",
  "src/platform/types.ts", "src/platform/tauri-backend.ts", "src/stores/mcp.ts",
  "src/components/settings/FileRoots.tsx",
];
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
function fail(stage) { const e = new Error(stage); e.stage = stage; throw e; }
function requireThat(value, stage) { if (!value) fail(stage); }
async function waitFor(fn, stage, ms = 15_000) { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return; await pause(100); } fail(stage); }
const exists = async (path) => access(path).then(() => true, () => false);
const hash = async (path) => createHash("sha256").update(await readFile(path)).digest("hex");
const fingerprint = async (path) => { const s = await stat(path); return { inode: s.ino, mtimeMs: s.mtimeMs, digest: await hash(path) }; };
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
async function sourceBinding() {
  if (compiledRevision) requireThat(/^[a-f0-9]{7,40}$/.test(compiledRevision), "compiled_source_revision_required");
  const hashes = {};
  for (const file of boundFiles) {
    const bytes = compiledRevision ? execFileSync("git", ["show", `${compiledRevision}:EastGenesis/${file}`], { stdio: ["ignore", "pipe", "pipe"] }) : await readFile(file);
    hashes[file] = createHash("sha256").update(bytes).digest("hex");
  }
  return { mode: compiledRevision ? "git_show_compiled_revision" : "working_tree_after_build", revision: compiledRevision ?? execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), files: hashes };
}
let lastAxFailure, nativeTarget;
function nativeButton(pid, label, perform = false) {
  try {
    return execFileSync("osascript", ["-e", `tell application "System Events"
tell (first process whose unix id is ${pid})
set frontmost to true
repeat with w in windows
try
if exists button ${JSON.stringify(label)} of w then
if not enabled of button ${JSON.stringify(label)} of w then return "disabled"
${perform ? `click button ${JSON.stringify(label)} of w` : ""}
return "found"
end if
end try
repeat with s in sheets of w
try
if exists button ${JSON.stringify(label)} of s then
if not enabled of button ${JSON.stringify(label)} of s then return "disabled"
${perform ? `click button ${JSON.stringify(label)} of s` : ""}
return "found"
end if
set nodes to UI elements of s
repeat 6 times
set nextNodes to {}
repeat with e in nodes
try
set elementRole to role of e as text
if elementRole is "AXButton" and (name of e as text) is ${JSON.stringify(label)} then
if not enabled of e then return "disabled"
${perform ? "click e" : ""}
return "found"
end if
if elementRole is in {"AXGroup", "AXSplitGroup", "AXUnknown", "AXSheet", "AXPopover"} then set nextNodes to nextNodes & (UI elements of e)
end try
end repeat
set nodes to nextNodes
end repeat
end try
end repeat
end repeat
return "missing"
end tell
end tell`], { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch { return "missing"; }
}
function nativeOwnedInput(pid, target, diagnostic = false) {
  try {
    return execFileSync("osascript", ["-e", `tell application "System Events"
tell (first process whose unix id is ${pid})
set textFieldCount to 0
set comboCount to 0
set textAreaCount to 0
set targetMatches to 0
repeat with w in windows
repeat with s in sheets of w
set nodes to UI elements of s
repeat 8 times
set nextNodes to {}
repeat with e in nodes
try
set r to role of e as text
if r is "AXTextField" then set textFieldCount to textFieldCount + 1
if r is "AXComboBox" then set comboCount to comboCount + 1
if r is "AXTextArea" then set textAreaCount to textAreaCount + 1
if r is in {"AXTextField", "AXComboBox", "AXTextArea"} and (value of e as text) is in {${JSON.stringify(target)}, ${JSON.stringify(`${target}/`)}} then
${diagnostic ? "set targetMatches to targetMatches + 1" : 'return "matched"'}
end if
if r is in {"AXGroup", "AXSplitGroup", "AXUnknown", "AXSheet", "AXPopover"} then set nextNodes to nextNodes & (UI elements of e)
end try
end repeat
set nodes to nextNodes
end repeat
end repeat
end repeat
${diagnostic ? 'return (textFieldCount as text) & ":" & (comboCount as text) & ":" & (textAreaCount as text) & ":" & (targetMatches as text)' : 'return "missing"'}
end tell
end tell`], { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch { return "unavailable"; }
}
function ax(pid, body, native = false) {
  const scope = native ? `set panel to missing value
repeat with w in windows
try
if (name of w as text) is "选择文件夹" then set panel to w
if exists sheet 1 of w then set panel to sheet 1 of w
end try
end repeat
if panel is missing value then return "missing"
tell panel` : "tell window 1";
  try {
    return execFileSync("osascript", ["-e", `tell application "System Events"
tell (first process whose unix id is ${pid})
set frontmost to true
${scope}
set allElements to entire contents
${body}
end tell
end tell
end tell`], { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (e) { const code = String(e.stderr ?? "").match(/\((-?\d+)\)\s*$/)?.[1]; lastAxFailure = code ? `ax_${code.replace("-", "minus")}` : "ax_operation"; fail(lastAxFailure); }
}
function has(pid, label, native = false) {
  if (native) return nativeButton(pid, label) === "found";
  try { return ax(pid, `repeat with e in allElements
try
if (name of e as text) is ${JSON.stringify(label)} then return "found"
end try
end repeat
return "missing"`, native) === "found"; } catch { return false; }
}
function click(pid, label, role = "Button", native = false) {
  if (native) return requireThat(nativeButton(pid, label, true) === "found", "native_fixed_button");
  const result = ax(pid, `repeat with e in allElements
try
if (role of e as text) contains ${JSON.stringify(role)} and (name of e as text) starts with ${JSON.stringify(label)} then
click e
return "clicked"
end if
end try
end repeat
return "missing"`, native);
  requireThat(result === "clicked", native ? "native_fixed_button" : "fixed_ui_control");
}
function hasControl(pid, label, role = "Button") {
  try { return ax(pid, `repeat with e in allElements
try
if (role of e as text) contains ${JSON.stringify(role)} and (name of e as text) starts with ${JSON.stringify(label)} then return "found"
end try
end repeat
return "missing"`) === "found"; } catch { return false; }
}
function keys(pid, body) {
  try { execFileSync("osascript", ["-e", `tell application "System Events"
tell (first process whose unix id is ${pid})
set frontmost to true
${body}
end tell
end tell`], { timeout: 5_000, stdio: ["ignore", "pipe", "pipe"] }); } catch { fail("fixed_keyboard_action"); }
}
function paste(pid, value, role = "TextArea", label) {
  execFileSync("pbcopy", [], { input: value });
  const result = ax(pid, `repeat with e in allElements
try
if (role of e as text) contains ${JSON.stringify(role)} ${label ? `and (name of e as text) is ${JSON.stringify(label)}` : ""} then
click e
keystroke "a" using command down
keystroke "v" using command down
delay 0.2
if (value of e as text) is ${JSON.stringify(value)} then return "pasted"
end if
end try
end repeat
return "missing"`);
  requireThat(result === "pasted", "fixed_input");
}
async function ready(pid, label) {
  let stable = 0;
  await waitFor(async () => {
    if (has(pid, label)) { if (++stable === 2) return true; await pause(250); return false; }
    stable = 0;
    for (const choice of ["Don't Reopen", "Don’t Reopen", "不重新打开", "不要重新打开"]) if (has(pid, choice)) { click(pid, choice); break; }
    return false;
  }, "stable_window_entry");
}
async function picker(pid, target) {
  nativeTarget = target;
  await waitFor(() => ["Open", "打开", "Choose", "选择"].some((s) => has(pid, s, true)), "native_picker_open");
  if (target === null) {
    const cancel = ["Cancel", "取消"].find((s) => has(pid, s, true));
    requireThat(cancel, "native_cancel_button"); click(pid, cancel, "Button", true); await pause(250); return;
  }
  execFileSync("pbcopy", [], { input: target });
  keys(pid, `key code 5 using {command down, shift down}
delay 0.8
keystroke "a" using command down
keystroke "v" using command down
delay 0.8`);
  await waitFor(() => nativeOwnedInput(pid, target) === "matched", "native_owned_path_input");
  keys(pid, `key code 36
delay 0.8`);
  await waitFor(() => ["Open", "打开", "Choose", "选择"].some((s) => has(pid, s, true)), "native_choose_enabled");
  const choose = ["Open", "打开", "Choose", "选择"].find((s) => has(pid, s, true));
  requireThat(choose, "native_choose_button"); click(pid, choose, "Button", true);
  await waitFor(() => !["Open", "打开", "Choose", "选择"].some((s) => has(pid, s, true)), "native_selection_closed");
  await pause(300);
}
function rows(db, sql) { try { return JSON.parse(execFileSync("sqlite3", ["-readonly", "-json", db, sql], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })); } catch { return []; } }
function turns(db) { return rows(db, "SELECT turns FROM sessions WHERE deleted_at IS NULL ORDER BY updated_at DESC").flatMap((r) => JSON.parse(r.turns)); }
async function extras(file) { if (!await exists(file)) return []; return JSON.parse(await readFile(file, "utf8")); }
async function fixture() {
  let current = { steps: [] }; const counts = { plan: 0, args: 0, stream: 0, json: 0 };
  const server = createServer((req, res) => {
    const chunks = []; req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      if (req.url?.endsWith("/models")) { res.setHeader("content-type", "application/json"); return res.end(JSON.stringify({ data: [{ id: "gpt-5.6-luna", object: "model" }] })); }
      let body; try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return res.writeHead(400).end(); }
      const plan = body.messages?.some((m) => m.role === "system" && m.content?.includes("任务规划器"));
      const args = body.messages?.some((m) => m.role === "system" && m.content?.includes("你为工具生成调用参数"));
      const requestedTool = args ? body.messages?.find((m) => m.role === "user")?.content?.match(/^工具：([^\n]+)/)?.[1] : undefined;
      const argumentStep = current.steps.find((s) => s.tool === requestedTool) ?? current.steps[0];
      const text = plan ? JSON.stringify(current) : args ? JSON.stringify(argumentStep?.args ?? {}) : "已完成隔离文件测试。";
      if (plan) counts.plan++; if (args) counts.args++;
      if (body.stream) { counts.stream++; res.writeHead(200, { "content-type": "text/event-stream" }); return res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`); }
      counts.json++; res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 } }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, counts, base: `http://127.0.0.1:${server.address().port}/v1`, set: (steps) => { current = { steps }; } };
}

const steps = ["workdir_cancel", "workdir_context", "project_context", "ungranted_write_denied", "settings_cancel", "explicit_root_grant", "authorized_read_write", "outside_write_denied", "symlink_read_denied", "symlink_write_denied", "root_removed", "removed_root_write_denied", "default_downloads_retained"];
const report = { schemaVersion: 1, kind: "desktop-native-picker-sandbox", platform: "macos", appVersion: "0.1.0", appIdentifier: "com.eastgenesis.desktop", createdAt: new Date().toISOString(), scenarios: steps.map((name) => ({ scenario: name, status: "not_run" })), evidenceBoundary: { proven: [], excluded: ["real Provider", "Windows/Linux native picker", "file-root persistence failure injection in this UI run", "signing/notarization", "all filesystem adversarial races"] } };
let home, child, f, stage;
async function check(name, run) { stage = name; const assertions = await run(); Object.assign(report.scenarios.find((s) => s.scenario === name), { status: "passed", assertions }); console.log(`native picker ${name}: passed`); }
try {
  requireThat(process.platform === "darwin", "macos_required");
  requireThat(/^[a-f0-9]{64}$/.test(expectedBinary ?? ""), "expected_binary_sha256_required");
  requireThat(await hash(app) === expectedBinary, "protected_binary_binding");
  report.binarySha256 = expectedBinary;
  report.harnessSha256 = await hash(new URL(import.meta.url));
  report.sourceRevision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  report.compiledSource = await sourceBinding();
  report.sourceWorkingTreeChangesIncluded = !compiledRevision;
  report.osVersion = execFileSync("sw_vers", ["-productVersion"], { encoding: "utf8" }).trim();
  report.architecture = process.arch;
  home = await realpath(await mkdtemp(join(tmpdir(), "eg-picker-")));
  const allowed = join(home, "Documents/allowed"), outside = join(home, "Documents/outside"), downloads = join(home, "Downloads");
  await Promise.all([mkdir(allowed, { recursive: true }), mkdir(outside, { recursive: true }), mkdir(downloads)]);
  const unchanged = join(allowed, "unchanged.txt"), outputFile = join(allowed, "authorized.txt"), outsideFile = join(outside, "protected.txt");
  await writeFile(unchanged, "synthetic unchanged input\n"); await writeFile(outsideFile, "synthetic outside input\n"); await symlink(outside, join(allowed, "escape"));
  const initial = await fingerprint(unchanged), outsideInitial = await fingerprint(outsideFile);
  const dir = join(home, "Library/Application Support/com.eastgenesis.desktop"), db = join(dir, "eastgenesis.db"), rootFile = join(dir, "file-roots.json");
  f = await fixture();
  const env = { HOME: home, PATH: process.env.PATH, TMPDIR: tmpdir(), LANG: "en_US.UTF-8", EASTGENESIS_QA_ISOLATED_PROFILE: "1", EASTGENESIS_QA_PROVIDER_BASE_URL: f.base, EASTGENESIS_QA_PROVIDER_MODEL: "gpt-5.6-luna", EASTGENESIS_QA_PROVIDER_PROTOCOL: "openai" };
  child = spawn(app, [], { env, detached: true, stdio: ["ignore", "ignore", "ignore"] });
  await ready(child.pid, "添加");
  async function workdir() { click(child.pid, "添加"); click(child.pid, "工作目录", "MenuItem"); await pause(150); click(child.pid, "选择其他文件夹…", "MenuItem"); await waitFor(() => has(child.pid, "文件夹路径"), "workdir_dialog"); click(child.pid, "选择…"); }
  await check("workdir_cancel", async () => { await workdir(); await picker(child.pid, null); requireThat(has(child.pid, "文件夹路径") && !has(child.pid, `移除工作目录 ${allowed}`), "workdir_cancel_unchanged"); click(child.pid, "取消"); return { realNativeCancel: true, noContextChange: true, noRootGrant: (await extras(rootFile)).length === 0 }; });
  await check("workdir_context", async () => { await workdir(); await picker(child.pid, allowed); await waitFor(() => has(child.pid, `移除工作目录 ${allowed}`), "workdir_selected_ui"); requireThat((await extras(rootFile)).length === 0, "workdir_no_grant"); return { realNativeSelection: true, selectedContextVisible: true, rootsUnchanged: true }; });
  if (options["--stop-after"] === "workdir") { report.diagnosticOnly = true; throw Object.assign(new Error("diagnostic stop"), { stage: "diagnostic_stop" }); }
  await check("project_context", async () => {
    click(child.pid, "项目"); await waitFor(() => has(child.pid, "新建项目"), "projects_entry"); click(child.pid, "新建项目");
    paste(child.pid, "隔离选择器项目", "TextField", "名称"); click(child.pid, "选择…"); await picker(child.pid, allowed);
    await waitFor(() => has(child.pid, `移除 ${allowed}`), "project_context_selected_ui"); click(child.pid, "保存");
    await waitFor(() => rows(db, "SELECT context_folders FROM projects WHERE deleted_at IS NULL").some((p) => JSON.parse(p.context_folders).includes(allowed)), "project_sqlite_persistence");
    await waitFor(() => hasControl(child.pid, "隔离选择器项目"), "project_selected_ui");
    requireThat((await extras(rootFile)).length === 0, "project_no_grant"); return { realNativeSelection: true, projectVisible: true, sqliteContextPersisted: true, rootsUnchanged: true };
  });
  const write = (path) => ({ goal: "写入隔离测试文件；依据：合成输入", tool: "mcp__files__write_file", args: { path, content: "已完成隔离文件测试。", overwrite: true } });
  const read = (path) => ({ goal: "读取并确认隔离文件内容", tool: "mcp__files__read_file", args: { path } });
  async function task(name, plan, denied) {
    const before = new Set(turns(db).map((t) => t.id)); f.set(plan); click(child.pid, "新任务"); await ready(child.pid, "添加"); paste(child.pid, `隔离测试 ${name}：读取或写入指定文件`); click(child.pid, "提交任务");
    let approved = 0;
    await waitFor(() => { if (has(child.pid, "批准")) { click(child.pid, "批准"); approved++; } return turns(db).some((t) => !before.has(t.id) && t.status !== "running"); }, "real_task_terminal", 30_000);
    const turn = turns(db).find((t) => !before.has(t.id)); requireThat(turn, "real_task_record");
    const results = turn.events.filter((e) => e.type === "tool_result");
    report.lastObservedTask = { status: turn.status, resultOk: results.map((e) => e.ok), pathDenied: results.some((e) => !e.ok && /path_not_allowed|不在允许访问的目录内/.test(e.content)) };
    const calls = turn.events.filter((e) => e.type === "llm");
    requireThat(calls.length > 0 && calls.every((e) => e.profileId?.startsWith("custom:qa/")), "fixture_only_task");
    if (denied) requireThat(turn.status !== "completed" && results.some((e) => !e.ok && /path_not_allowed|不在允许访问的目录内/.test(e.content)), "rust_sandbox_denial");
    else requireThat(turn.status === "completed" && results.length === plan.length && results.every((e) => e.ok), "authorized_tools_completed");
    return { taskCreatedThroughUi: true, sqliteTerminalRecord: true, sqliteTerminalStatus: turn.status, toolResultOk: results.map((e) => e.ok), pathDenied: report.lastObservedTask.pathDenied, approvalClicks: approved, onlySyntheticFixtureProfile: true, rustSandboxDenied: denied, successfulToolResults: results.filter((e) => e.ok).length };
  }
  await check("ungranted_write_denied", async () => { const r = await task("ungranted", [write("~/Documents/allowed/unchanged.txt")], true), after = await fingerprint(unchanged); requireThat(equal(initial, after), "ungranted_file_unchanged"); return { ...r, fileUnchanged: true, fingerprint: { before: initial, after } }; });
  async function settings() { click(child.pid, "设置"); await waitFor(() => has(child.pid, "MCP 服务器"), "settings_mcp_entry"); click(child.pid, "MCP 服务器"); await waitFor(() => has(child.pid, "选择…"), "file_roots_picker_entry"); }
  await check("settings_cancel", async () => { await settings(); click(child.pid, "选择…"); await picker(child.pid, null); requireThat((await extras(rootFile)).length === 0, "settings_cancel_unchanged"); return { realNativeCancel: true, rootsUnchanged: true }; });
  await check("explicit_root_grant", async () => { click(child.pid, "选择…"); await picker(child.pid, allowed); await waitFor(async () => equal(await extras(rootFile), ["~/Documents/allowed"]), "explicit_root_persisted"); await waitFor(() => has(child.pid, "运行中"), "builtin_reconnected"); requireThat(has(child.pid, "默认") && !has(child.pid, "移除 ~/Downloads"), "fixed_default_retained"); return { realNativeSelection: true, onlyExplicitRootAdded: true, builtinUiRunning: true, defaultRootFixed: true }; });
  await check("authorized_read_write", async () => { const r = await task("authorized", [write("~/Documents/allowed/authorized.txt"), read("~/Documents/allowed/authorized.txt")], false); requireThat(await readFile(outputFile, "utf8") === "已完成隔离文件测试。", "authorized_artifact"); return { ...r, realArtifactVerified: true, artifactSha256: await hash(outputFile) }; });
  await check("outside_write_denied", async () => { const r = await task("outside", [write("~/Documents/outside/protected.txt")], true), after = await fingerprint(outsideFile); requireThat(equal(outsideInitial, after), "outside_unchanged"); return { ...r, outsideFileUnchanged: true, fingerprint: { before: outsideInitial, after } }; });
  await check("symlink_read_denied", async () => { const r = await task("link-read", [read("~/Documents/allowed/escape/protected.txt")], true), after = await fingerprint(outsideFile); requireThat(equal(outsideInitial, after), "symlink_read_unchanged"); return { ...r, canonicalEscapeDenied: true, outsideFileUnchanged: true, fingerprint: { before: outsideInitial, after } }; });
  await check("symlink_write_denied", async () => { const r = await task("link-write", [write("~/Documents/allowed/escape/protected.txt")], true), after = await fingerprint(outsideFile); requireThat(equal(outsideInitial, after), "symlink_write_unchanged"); return { ...r, canonicalEscapeDenied: true, outsideFileUnchanged: true, fingerprint: { before: outsideInitial, after } }; });
  await check("root_removed", async () => { await settings(); requireThat(equal(await extras(rootFile), ["~/Documents/allowed"]), "owned_root_only"); click(child.pid, "移除 ~/Documents/allowed"); await waitFor(async () => (await extras(rootFile)).length === 0, "root_removal_persisted"); await waitFor(() => has(child.pid, "运行中"), "builtin_reconnected_after_removal"); requireThat(has(child.pid, "默认") && !has(child.pid, "移除 ~/Downloads"), "default_root_after_removal"); return { extraRootRemoved: true, builtinReconnected: true, defaultRootFixed: true }; });
  await check("removed_root_write_denied", async () => { const original = await fingerprint(outputFile), r = await task("removed", [write("~/Documents/allowed/authorized.txt")], true), after = await fingerprint(outputFile); requireThat(equal(original, after), "removed_root_file_unchanged"); return { ...r, fileUnchanged: true, fingerprint: { before: original, after } }; });
  await check("default_downloads_retained", async () => { const r = await task("default", [write("~/Downloads/retained.txt"), read("~/Downloads/retained.txt")], false); requireThat(await readFile(join(downloads, "retained.txt"), "utf8") === "已完成隔离文件测试。", "default_downloads_artifact"); return { ...r, defaultRootStillUsable: true, realArtifactVerified: true, artifactSha256: await hash(join(downloads, "retained.txt")) }; });
  requireThat(!await exists(join(dir, "providers.json")), "no_persisted_provider"); requireThat(await hash(app) === expectedBinary, "binary_unchanged");
  requireThat(equal(report.compiledSource.files, (await sourceBinding()).files), "source_binding_unchanged");
  requireThat(report.harnessSha256 === await hash(new URL(import.meta.url)), "harness_binding_unchanged");
  report.passed = report.scenarios.every((s) => s.status === "passed");
  if (report.passed) report.evidenceBoundary.proven = ["real native picker selection and cancel", "workdir/project context does not grant file access", "explicit settings root grants and reconnects builtin MCP", "real authorized file read/write", "Rust canonical sandbox denies outside and symlink escape", "root removal revokes access and retains fixed Downloads"];
} catch (e) {
  report.passed = false; report.failedStage = e.stage ?? "unexpected_failure";
  if (stage && !report.diagnosticOnly) Object.assign(report.scenarios.find((s) => s.scenario === stage), { status: "failed", failedStage: report.failedStage });
  if (lastAxFailure) report.lastAxFailure = lastAxFailure;
  if (child?.pid) {
    report.observedFixedUiLabels = ["选择…", "选择中…", "文件夹路径", "工作目录", "取消"].filter((s) => has(child.pid, s));
    report.observedNativeButtons = ["Open", "打开", "Choose", "选择", "Cancel", "取消"].filter((s) => nativeButton(child.pid, s) === "found");
    if (nativeTarget) {
      const diagnostic = nativeOwnedInput(child.pid, nativeTarget, true);
      if (diagnostic !== "unavailable") {
        const diagnostics = diagnostic.split(":").map(Number);
        report.nativeFieldDiagnostics = { textFields: diagnostics[0], comboBoxes: diagnostics[1], textAreas: diagnostics[2], ownedTargetMatches: diagnostics[3] };
      } else report.nativeFieldDiagnostics = { unavailable: true };
    }
    try { report.observedWindowShape = execFileSync("osascript", ["-e", `tell application "System Events"
tell (first process whose unix id is ${child.pid})
set windowCount to count of windows
set sheetCount to 0
repeat with w in windows
set sheetCount to sheetCount + (count of sheets of w)
end repeat
return (windowCount as text) & ":" & (sheetCount as text)
end tell
end tell`], { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "pipe"] }).trim(); } catch { report.observedWindowShape = "unavailable"; }
  }
}
finally {
  if (f) { report.fixtureRequestCounts = f.counts; await new Promise((r) => f.server.close(r)); }
  if (child?.pid) { try { await stopDetachedProcess(child, { graceMs: 1_000, killMs: 2_000 }); report.controlledCleanup = true; } catch { report.controlledCleanup = false; report.passed = false; } }
  if (home) await rm(home, { recursive: true, force: true });
  execFileSync("pbcopy", [], { input: "" }); report.finishedAt = new Date().toISOString(); await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ passed: report.passed, failedStage: report.failedStage, scenarios: report.scenarios.map(({ scenario, status }) => ({ scenario, status })) }));
}
if (!report.passed && !report.diagnosticOnly) process.exitCode = 1;

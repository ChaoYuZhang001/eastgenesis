// Real, owned-PID macOS QA acceptance for GET-only discovery and explicit,
// cancellable model checks. SQLite is an assertion source opened read-only.
import { createServer } from "node:http";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import { mkdtemp, mkdir, readFile, writeFile, access, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { stopDetachedProcess, hasProcessExited } from "./desktop-process-cleanup.mjs";

const exec = promisify(execFile);
const options = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const at = arg.indexOf("=");
  if (at < 0) throw new Error("arguments_require_equals");
  return [arg.slice(0, at), arg.slice(at + 1)];
}));
const repo = resolve(fileURLToPath(new URL("..", import.meta.url)));
const app = resolve(options["--app"] ?? join(repo, "target/release/bundle/macos/EastGenesis Desktop.app/Contents/MacOS/eastgenesis-desktop"));
const manifestPath = resolve(options["--compiled-source-manifest"] ?? "/tmp/eastgenesis-model-discovery-build-manifest.json");
const output = resolve(options["--output"] ?? "/tmp/eastgenesis-model-discovery-native.json");
const qaBudgetMs = Number(options["--timeout-ms"] ?? 120_000);
const stableObservationMs = 1_100;
const models = ["gpt-5.6-luna", ...Array.from({ length: 7 }, (_, i) => `qa-directory-${i + 1}`)];
const hash = async (path) => createHash("sha256").update(await readFile(path)).digest("hex");
const exists = async (path) => { try { await access(path); return true; } catch { return false; } };
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
function fail(stage) { const error = new Error(stage); error.stage = stage; throw error; }
function requireThat(ok, stage) { if (!ok) fail(stage); }
let deadline = Infinity;
let appChild, helperChild, home, fixture;
let currentStage = "binding";
const report = {
  schemaVersion: 1, kind: "macos-native-model-discovery", startedAt: new Date().toISOString(),
  passed: false, runCompleted: false, stages: [], actions: [], assertions: {},
  budgets: { totalMs: qaBudgetMs, axActionMs: 5_000, stableObservationMs, heldSocketObservationMs: 1_500 },
  isolation: { freshHome: false, freshAppData: false, privateConfigurationRead: false, providerKeyEnvironmentInherited: false,
    sqliteAccess: "readonly", settingsSeeded: false, taskSubmitted: false, provider: "owned synthetic loopback custom:qa" },
  evidenceBoundary: { excluded: ["real Provider", "remote compute or billing after cancellation", "model quality or full task capability", "Windows/Linux", "signing/notarization", "startup performance"] },
};

// The helper is compiled into an owned temporary directory. Its source and
// executable are hash-bound; no old frozen observer or harness is edited.
const swiftSource = String.raw`
import Foundation
import AppKit
import ApplicationServices
func stamp() -> Double { Date().timeIntervalSince1970 * 1000 }
func emit(_ object: [String: Any]) {
  if let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]), let line = String(data: data, encoding: .utf8) { print(line); fflush(stdout) }
}
func value(_ e: AXUIElement, _ attr: String) -> CFTypeRef? {
  var result: CFTypeRef?
  return AXUIElementCopyAttributeValue(e, attr as CFString, &result) == .success ? result : nil
}
func text(_ e: AXUIElement, _ attr: String) -> String { value(e, attr) as? String ?? "" }
func labels(_ e: AXUIElement) -> [String] { [text(e, kAXTitleAttribute), text(e, kAXDescriptionAttribute), text(e, kAXValueAttribute)] }
func frame(_ e: AXUIElement) -> CGRect? {
  guard let position = value(e, kAXPositionAttribute), let size = value(e, kAXSizeAttribute), CFGetTypeID(position) == AXValueGetTypeID(), CFGetTypeID(size) == AXValueGetTypeID() else { return nil }
  var p = CGPoint.zero; var s = CGSize.zero
  guard AXValueGetValue(position as! AXValue, .cgPoint, &p), AXValueGetValue(size as! AXValue, .cgSize, &s), s.width > 0, s.height > 0 else { return nil }
  return CGRect(origin: p, size: s)
}
func visible(_ e: AXUIElement, _ window: CGRect?) -> Bool {
  guard let rect = frame(e), let window else { return false }
  return window.contains(rect) && (value(e, "AXHidden") as? Bool) != true
}
let trusted = AXIsProcessTrusted()
emit(["event": "helper_ready", "trusted": trusted, "wallTimeMs": stamp()])
guard trusted else { exit(2) }
while let line = readLine() {
  guard let data = line.data(using: .utf8), let command = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
    let token = command["token"] as? String, let pidNumber = command["pid"] as? Int, pidNumber > 0,
    let op = command["op"] as? String, ["startup", "observe", "press"].contains(op) else { emit(["event": "protocol_error"]); continue }
  let pid = pid_t(pidNumber); let app = AXUIElementCreateApplication(pid)
  AXUIElementSetMessagingTimeout(app, 0.025)
  NSRunningApplication(processIdentifier: pid)?.activate(options: [])
  let required = command["required"] as? [String] ?? []
  let label = command["label"] as? String ?? ""
  let until = stamp() + 4_600
  var success = false; var actionWall: Double? = nil; var scrollIssued = false; var lastSeen = Array(repeating: false, count: required.count)
  var lastComplete = false; var inputSeen = false; var webAreaSeen = false; var splashSeen = false; var buttonSeen = false; var buttonEnabled = false
  while stamp() < until {
    let windows = value(app, kAXWindowsAttribute) as? [AXUIElement] ?? []
    let window = windows.first.flatMap { frame($0) }
    var queue: [(AXUIElement, CGRect?)] = windows.map { ($0, frame($0)) }; var index = 0; let scanUntil = min(until, stamp() + 300)
    var seen = Array(repeating: false, count: required.count)
    var complete = true; var input = false; var web = false; var splash = false; var chosen: AXUIElement? = nil
    while index < queue.count {
      if index >= 4096 || stamp() > scanUntil { complete = false; break }
      let e = queue[index].0; let clip = queue[index].1; index += 1
      let role = text(e, kAXRoleAttribute); let names = labels(e)
      if role == "AXWebArea" { web = true }
      if role == kAXTextAreaRole && names.contains("任务描述") && visible(e, clip) && value(e, kAXEnabledAttribute) as? Bool == true { input = true }
      if names.contains("从想法，到成果") || (role == kAXImageRole && names.contains("EastGenesis 标志")) { splash = true }
      for i in required.indices where !seen[i] {
        if names.contains(where: { $0.contains(required[i]) }) {
          if visible(e, clip) { seen[i] = true }
          else if !scrollIssued && AXUIElementPerformAction(e, "AXScrollToVisible" as CFString) == .success { scrollIssued = true }
        }
      }
      if op == "press", role == kAXButtonRole || role == kAXPopUpButtonRole || role == "AXRadioButton", names.contains(label) {
        buttonSeen = true; buttonEnabled = value(e, kAXEnabledAttribute) as? Bool == true
        if buttonEnabled {
          if visible(e, clip) { chosen = e }
          else if !scrollIssued && AXUIElementPerformAction(e, "AXScrollToVisible" as CFString) == .success { scrollIssued = true }
        }
      }
      var childClip = clip
      if role == kAXScrollAreaRole, let scrollFrame = frame(e), let clip { childClip = clip.intersection(scrollFrame) }
      if let children = value(e, kAXChildrenAttribute) as? [AXUIElement] { queue.append(contentsOf: children.map { ($0, childClip) }) }
      if chosen != nil || (op == "observe" && seen.allSatisfy({ $0 })) { break }
    }
    lastSeen = seen; lastComplete = complete; inputSeen = input; webAreaSeen = web; splashSeen = splash
    if let chosen {
      actionWall = stamp()
      success = AXUIElementPerformAction(chosen, kAXPressAction as CFString) == .success
      break
    }
    if op == "observe", seen.allSatisfy({ $0 }) { success = true; break }
    if op == "startup", complete, input, web, !splash, window != nil { success = true; break }
    RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.03))
  }
  var result: [String: Any] = ["event": "result", "token": token, "success": success, "wallTimeMs": stamp(), "requiredSeen": lastSeen,
    "scanBudgetComplete": lastComplete, "inputSeen": inputSeen, "webAreaSeen": webAreaSeen, "splashMarkerSeen": splashSeen,
    "buttonSeen": buttonSeen, "buttonEnabled": buttonEnabled, "scrollActionIssued": scrollIssued,
    "ownedAppActive": NSRunningApplication(processIdentifier: pid)?.isActive == true]
  if let actionWall { result["actionWallTimeMs"] = actionWall }
  emit(result)
}
`;

async function sourceHashes(expected) {
  const entries = Object.entries(expected);
  requireThat(entries.length > 25, "full_source_manifest_required");
  for (const [name, digest] of entries) {
    requireThat(typeof name === "string" && !isAbsolute(name) && !relative(repo, resolve(repo, name)).startsWith("..") && /^[a-f0-9]{64}$/.test(digest), "source_manifest_entry");
  }
  return Object.fromEntries(await Promise.all(entries.map(async ([name]) => [name, await hash(join(repo, name))])));
}
async function waitFor(predicate, stage, maxMs = 5_000) {
  const until = Math.min(deadline, Date.now() + maxMs);
  while (Date.now() < until) {
    if (appChild) requireThat(!hasProcessExited(appChild), "owned_app_early_exit");
    if (await predicate()) return;
    await pause(25);
  }
  fail(stage);
}
async function stage(name, work) {
  currentStage = name;
  const result = { name, startedAt: new Date().toISOString(), passed: false };
  report.stages.push(result);
  await work(result);
  result.passed = true; result.finishedAt = new Date().toISOString();
}
function appAlive() { return appChild && !hasProcessExited(appChild); }
async function ownPid(child) {
  requireThat(child?.pid > 0 && !hasProcessExited(child), "owned_pid_missing");
  const { stdout } = await exec("ps", ["-p", String(child.pid), "-o", "ppid="], { timeout: 1_000, maxBuffer: 1_024 });
  requireThat(Number(stdout.trim()) === process.pid, "owned_parent_pid");
}
let helperReady;
const pending = new Map();
function startHelper(path) {
  let readyResolve, readyReject;
  helperReady = new Promise((done, reject) => { readyResolve = done; readyReject = reject; });
  helperChild = spawn(path, [], { detached: true, stdio: ["pipe", "pipe", "ignore"] });
  createInterface({ input: helperChild.stdout }).on("line", (line) => {
    let event; try { event = JSON.parse(line); } catch { readyReject(new Error("ax_protocol")); return; }
    if (event.event === "helper_ready") { readyResolve(event); return; }
    const waiter = pending.get(event.token);
    if (waiter) { pending.delete(event.token); clearTimeout(waiter.timer); waiter.resolve(event); }
  });
  helperChild.on("error", () => readyReject(new Error("ax_helper_spawn")));
  helperChild.on("exit", () => {
    readyReject(new Error("ax_helper_early_exit"));
    for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error("ax_helper_early_exit")); }
    pending.clear();
  });
}
let nextToken = 0;
async function ax(op, name, fields = {}) {
  requireThat(appAlive() && !hasProcessExited(helperChild), "ax_owned_live_processes");
  const startedWall = Date.now();
  const token = String(++nextToken);
  const event = await new Promise((done, reject) => {
    const timer = setTimeout(() => { pending.delete(token); reject(Object.assign(new Error("ax_action_timeout"), { stage: "ax_action_timeout" })); }, Math.min(5_000, deadline - Date.now()));
    pending.set(token, { timer, resolve: done, reject });
    helperChild.stdin.write(`${JSON.stringify({ token, pid: appChild.pid, op, ...fields })}\n`);
  });
  const returnedWall = Date.now();
  const action = { name, operation: op, success: event.success === true, elapsedMs: returnedWall - startedWall,
    ownedPid: true, ownedAppActive: event.ownedAppActive === true, requiredSeen: event.requiredSeen,
    scanBudgetComplete: event.scanBudgetComplete, scrollActionIssued: event.scrollActionIssued,
    buttonSeen: event.buttonSeen, buttonEnabled: event.buttonEnabled };
  if (event.actionWallTimeMs !== undefined) {
    action.actionWallTimeMs = event.actionWallTimeMs;
    action.actionTimestampWithinNodeBounds = event.actionWallTimeMs >= startedWall - 1 && event.actionWallTimeMs <= returnedWall + 1;
    requireThat(action.actionTimestampWithinNodeBounds, "ax_action_timestamp_bounds");
  }
  report.actions.push(action);
  requireThat(action.success && action.ownedAppActive, `ax_${name}`);
  return { event, startedWall, returnedWall };
}
async function readCache(db) {
  if (!await exists(db)) return null;
  let stdout;
  try { ({ stdout } = await exec("sqlite3", ["-readonly", "-json", db, "SELECT value FROM app_meta WHERE key = 'settings:model_cache'"], { timeout: 1_000, maxBuffer: 128 * 1024 })); }
  catch (error) {
    if (/database is locked/.test(String(error.stderr ?? ""))) { report.sqliteLockedRetries = (report.sqliteLockedRetries ?? 0) + 1; return null; }
    fail("sqlite_read_failed");
  }
  try {
    const rows = JSON.parse(stdout || "[]");
    return rows.length ? JSON.parse(rows[0].value)["custom:qa"] ?? null : null;
  } catch { fail("sqlite_cache_invalid"); }
}
function cacheEvidence(entry) {
  const summary = entry?.probeSummary;
  const count = (value) => Number.isSafeInteger(value) && value >= 0 && value <= models.length ? value : null;
  return { modelCount: entry?.models?.length ?? null, modelsMatchSyntheticDirectory: JSON.stringify(entry?.models) === JSON.stringify(models),
    fetchedAtPresent: Number.isFinite(entry?.fetchedAt), probedAtPresent: Number.isFinite(entry?.probedAt),
    unavailableCount: entry?.unavailable?.length ?? 0, summary: summary ? {
      total: count(summary.total), probed: count(summary.probed), ok: count(summary.ok), missing: count(summary.missing),
      unknown: count(summary.unknown), notProbed: count(summary.notProbed),
      stopReason: [null, "cancelled", "timeout", "budget"].includes(summary.stopReason) ? summary.stopReason : "invalid",
    } : null };
}
async function launch(env) {
  appChild = spawn(app, [], { env, detached: true, stdio: ["ignore", "ignore", "ignore"] });
  await ownPid(appChild);
  await ax("startup", "startup_ready");
}
async function settings() {
  await ax("press", "open_settings", { label: "设置" });
  await ax("press", "open_custom_providers", { label: "自定义中转站" });
}
async function makeFixture() {
  const posts = [], sockets = new Set(); let gets = 0, unexpected = 0, mode = "quick", cleanupStarted = false;
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/v1/models") { gets++; res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ data: models.map((id) => ({ id })) })); return; }
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") { unexpected++; res.writeHead(404); res.end(); return; }
    let body = "";
    req.on("data", (chunk) => { body += chunk.toString("utf8"); if (body.length > 8_192) req.destroy(); });
    req.on("end", () => {
      let data; try { data = JSON.parse(body); } catch { unexpected++; res.writeHead(400); res.end(); return; }
      const record = { batch: mode, originStage: currentStage, receivedAt: Date.now(), modelIndex: models.indexOf(data.model), maxTokens: data.max_tokens === 1 ? 1 : null,
        streamTrue: data.stream === true, userTestTextMatches: data.messages?.length === 1 && data.messages[0]?.role === "user" && data.messages[0]?.content === "hi",
        payloadKeysValid: JSON.stringify(Object.keys(data).sort()) === JSON.stringify(["max_tokens", "messages", "model"]), headersAt: null, bodyEndedByFixture: false,
        responseClosedAt: null, socketClosedAt: null, peerEndAt: null, closeBeforeCleanup: null };
      posts.push(record);
      req.socket.on("end", () => { record.peerEndAt = Date.now(); });
      req.socket.on("close", () => { record.socketClosedAt = Date.now(); record.closeBeforeCleanup = !cleanupStarted; });
      res.on("close", () => { record.responseClosedAt = Date.now(); });
      const response = JSON.stringify({ id: "qa_check", model: data.model, choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] });
      res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(response) });
      res.flushHeaders(); record.headersAt = Date.now();
      if (mode === "hold") { res.write('{"id":'); record.partialBodyBytes = 6; }
      else { record.bodyEndedByFixture = true; res.end(response); }
    });
  });
  server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  return { base: `http://127.0.0.1:${server.address().port}/v1`, posts, get gets() { return gets; }, get unexpected() { return unexpected; },
    setHold() { mode = "hold"; }, beginCleanup() { cleanupStarted = true; },
    async close() { cleanupStarted = true; for (const socket of sockets) socket.destroy(); await new Promise((done) => server.close(done)); return { closed: true, remainingOwnedSockets: sockets.size }; } };
}

try {
  requireThat(process.platform === "darwin", "macos_required");
  requireThat(Number.isInteger(qaBudgetMs) && qaBudgetMs >= 60_000 && qaBudgetMs <= 120_000, "bounded_total_budget");
  requireThat(output.endsWith(".json"), "json_output_required");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  requireThat(manifest.passed === true, "qa_build_not_passed");
  const expectedBinary = options["--expected-binary-sha256"] ?? manifest.binarySha256;
  requireThat(/^[a-f0-9]{64}$/.test(expectedBinary ?? "") && expectedBinary === manifest.binarySha256, "compiled_binary_binding");
  deadline = Date.now() + qaBudgetMs;
  report.binding = { manifestStartSha256: await hash(manifestPath), expectedBinarySha256: expectedBinary,
    binaryStartSha256: await hash(app), sourceInputs: manifest.sourceInputs, expectedSourceHashes: manifest.sourceHashes,
    sourceStartHashes: await sourceHashes(manifest.sourceHashes), harnessStartSha256: await hash(new URL(import.meta.url)),
    cleanupHelperStartSha256: await hash(new URL("./desktop-process-cleanup.mjs", import.meta.url)),
    swiftSourceSha256: createHash("sha256").update(swiftSource).digest("hex"), evidenceType: "worktree_qa_build_manifest", formalReleaseBinding: false };
  requireThat(report.binding.binaryStartSha256 === expectedBinary, "binary_start_mismatch");
  requireThat(JSON.stringify(report.binding.sourceStartHashes) === JSON.stringify(manifest.sourceHashes), "compiled_source_start_mismatch");
  requireThat(Object.keys(manifest.sourceHashes).length === manifest.sourceInputs, "source_input_count");
  home = await realpath(await mkdtemp(join(tmpdir(), "eg-discovery-ax-")));
  const appData = join(home, "Library/Application Support/com.eastgenesis.desktop");
  const db = join(appData, "eastgenesis.db"), providerConfig = join(appData, "providers.json");
  await mkdir(join(home, "Downloads"), { recursive: true });
  report.isolation.freshHome = true; report.isolation.freshAppData = !await exists(appData);
  requireThat(report.isolation.freshAppData, "fresh_profile_required");
  const swiftPath = join(home, "owned-ax-helper.swift"), helperPath = join(home, "owned-ax-helper");
  await writeFile(swiftPath, swiftSource);
  currentStage = "owned_ax_helper_prepare";
  try { await exec("swiftc", ["-O", swiftPath, "-o", helperPath], { timeout: Math.min(60_000, deadline - Date.now()), maxBuffer: 16 * 1024 }); }
  catch { fail("swift_compile_failed"); }
  report.binding.swiftExecutableStartSha256 = await hash(helperPath);
  startHelper(helperPath);
  const ready = await Promise.race([helperReady, pause(5_000).then(() => fail("ax_helper_ready_timeout"))]);
  report.axTrusted = ready.trusted === true;
  requireThat(report.axTrusted, "ax_permission_unavailable");
  await ownPid(helperChild);
  fixture = await makeFixture();
  const env = { HOME: home, PATH: process.env.PATH, TMPDIR: tmpdir(), LANG: "en_US.UTF-8",
    EASTGENESIS_QA_ISOLATED_PROFILE: "1", EASTGENESIS_QA_PROVIDER_BASE_URL: fixture.base,
    EASTGENESIS_QA_PROVIDER_MODEL: models[0], EASTGENESIS_QA_PROVIDER_PROTOCOL: "openai" };
  await stage("startup_get_only", async (result) => {
    await launch(env);
    await waitFor(async () => (await readCache(db))?.models?.length === models.length && fixture.gets >= 1, "startup_directory_missing");
    const observationStarted = Date.now(); await pause(stableObservationMs);
    requireThat(appAlive() && fixture.posts.length === 0, "startup_post_inference");
    result.stableObservationMs = Date.now() - observationStarted; result.directoryGets = fixture.gets; result.postRequests = fixture.posts.length;
    result.sqlite = cacheEvidence(await readCache(db));
    requireThat(result.sqlite.modelsMatchSyntheticDirectory && !result.sqlite.probedAtPresent && result.sqlite.summary === null, "startup_cache_not_get_only");
  });
  await stage("cost_notice_and_get_controls", async (result) => {
    await settings();
    await ax("observe", "cost_notice_before_inference", { required: ["实际费用由服务决定", "停止不能撤回已发送请求", "HTTP 成功不证明模型质量"] });
    result.costNoticeObservedBeforeFirstPost = fixture.posts.length === 0;
    const firstGet = fixture.gets;
    await ax("press", "refresh_models", { label: "刷新模型列表" });
    await waitFor(() => fixture.gets > firstGet, "refresh_directory_get_missing");
    await ax("observe", "refresh_finished", { required: ["刷新模型列表"] });
    const secondGet = fixture.gets;
    await ax("press", "test_connection", { label: "测试连接" });
    await waitFor(() => fixture.gets > secondGet, "connection_directory_get_missing");
    await ax("observe", "connection_finished", { required: ["模型目录连接正常", "尚未检查推理调用"] });
    const started = Date.now(); await pause(stableObservationMs);
    requireThat(appAlive() && fixture.posts.length === 0, "get_controls_post_inference");
    result.stableObservationMs = Date.now() - started; result.refreshDirectoryGets = secondGet - firstGet; result.connectionDirectoryGets = fixture.gets - secondGet; result.postRequests = fixture.posts.length;
    result.sqlite = cacheEvidence(await readCache(db));
    requireThat(result.costNoticeObservedBeforeFirstPost && result.sqlite.summary === null && !result.sqlite.probedAtPresent, "get_controls_check_state");
  });
  await stage("explicit_success_and_persist", async (result) => {
    await ax("press", "explicit_check_success", { label: "检查模型调用（可能计费）" });
    await waitFor(async () => (await readCache(db))?.probeSummary?.ok === models.length, "explicit_success_cache_missing");
    result.sqlite = cacheEvidence(await readCache(db));
    requireThat(fixture.posts.length === models.length && result.sqlite.summary.probed === models.length && result.sqlite.summary.unknown === 0 && result.sqlite.summary.notProbed === 0, "explicit_success_counts");
    result.posts = fixture.posts.length;
  });
  await stage("initialized_profile_relaunch_get_only", async (result) => {
    result.previousAppCleanup = await stopDetachedProcess(appChild, { graceMs: 2_000, killMs: 2_000 }); appChild = undefined;
    const beforePosts = fixture.posts.length;
    await launch(env);
    const started = Date.now(); await pause(stableObservationMs);
    requireThat(appAlive() && fixture.posts.length === beforePosts, "relaunch_automatic_check");
    result.stableObservationMs = Date.now() - started; result.additionalPostRequests = fixture.posts.length - beforePosts;
    result.sqlite = cacheEvidence(await readCache(db));
    requireThat(result.sqlite.summary?.ok === models.length && result.sqlite.probedAtPresent, "success_statistics_not_persisted");
    await settings();
  });
  await stage("headers_body_hold_ax_cancel", async (result) => {
    fixture.setHold();
    await ax("press", "explicit_check_hold", { label: "检查模型调用（可能计费）" });
    await waitFor(() => fixture.posts.filter((post) => post.batch === "hold").length >= 4, "held_four_requests_missing");
    const held = fixture.posts.filter((post) => post.batch === "hold");
    requireThat(held.length === 4 && held.every((post) => post.headersAt && !post.bodyEndedByFixture && post.partialBodyBytes === 6 && !post.socketClosedAt), "held_headers_body_open");
    await pause(100);
    const stop = await ax("press", "stop_explicit_check", { label: "停止检查" });
    const actionWall = stop.event.actionWallTimeMs;
    requireThat(Number.isFinite(actionWall), "stop_action_clock_missing");
    await waitFor(() => held.every((post) => post.socketClosedAt && post.responseClosedAt), "native_check_socket_not_closed", 1_500);
    await waitFor(async () => (await readCache(db))?.probeSummary?.stopReason === "cancelled", "cancel_statistics_not_persisted");
    const started = Date.now(); await pause(stableObservationMs);
    requireThat(appAlive(), "cancel_app_exited_before_observation");
    result.preCleanupLiveApp = true; result.stableObservationMs = Date.now() - started;
    result.socketCloseAfterAxActionMs = held.map((post) => post.socketClosedAt - actionWall);
    result.peerEndAfterAxActionMs = held.map((post) => post.peerEndAt === null ? null : post.peerEndAt - actionWall);
    result.headersPrecededAxStop = held.every((post) => post.headersAt < actionWall);
    result.allSocketsClosedBeforeAnyCleanup = held.every((post) => post.closeBeforeCleanup === true);
    result.noReplacementRequests = fixture.posts.filter((post) => post.batch === "hold").length === 4;
    result.sqlite = cacheEvidence(await readCache(db));
    requireThat(result.headersPrecededAxStop && result.allSocketsClosedBeforeAnyCleanup && result.noReplacementRequests, "cancel_live_socket_contract");
    requireThat(result.sqlite.modelsMatchSyntheticDirectory && result.sqlite.summary.total === 8 && result.sqlite.summary.probed === 4 && result.sqlite.summary.ok === 0 && result.sqlite.summary.missing === 0 && result.sqlite.summary.unknown === 4 && result.sqlite.summary.notProbed === 4, "cancel_statistics_contract");
    await ax("observe", "cancel_summary_visible", { required: ["不确定 4", "未发起 4", "已停止"] });
  });
  requireThat(fixture.posts.every((post) => post.modelIndex >= 0 && post.maxTokens === 1 && !post.streamTrue && post.userTestTextMatches && post.payloadKeysValid), "explicit_post_payload_contract");
  requireThat(fixture.unexpected === 0 && !await exists(providerConfig), "isolated_provider_contract");
  requireThat(Date.now() <= deadline, "qa_work_budget_exceeded");
  report.assertions = { startupNonemptyDirectoryPostZero: true, getOnlyRefreshAndConnectionTest: true, priorCostNoticeObserved: true,
    explicitChecksOnly: true, oneTokenNoStreamPayload: true, successStatisticsPersistedAcrossRelaunch: true,
    heldHeadersAndBodyBeforeStop: true, peerSocketsClosedWhileAppAliveBeforeCleanup: true, noReplacementAfterCancel: true,
    cancelledUnknownAndNotStartedCountsPersisted: true, cancelledSummaryVisibleInUi: true, providerConfigNotPersisted: true };
  report.runCompleted = true;
} catch (error) {
  report.failure = { stage: currentStage, code: /^[a-z0-9_]{1,100}$/.test(error?.stage ?? error?.message ?? "") ? (error.stage ?? error.message) : "harness_error" };
} finally {
  fixture?.beginCleanup();
  if (fixture) report.fixture = { directoryGets: fixture.gets, postRequests: fixture.posts.length, unexpectedRequests: fixture.unexpected,
    startupProbeCount: fixture.posts.filter((post) => post.originStage === "startup_get_only").length,
    nonProbePostCount: fixture.posts.filter((post) => post.maxTokens !== 1 || !post.userTestTextMatches || post.streamTrue).length,
    actualTaskSubmitCount: fixture.posts.filter((post) => post.maxTokens !== 1 || !post.userTestTextMatches || post.streamTrue).length,
    actualTaskSubmitEvidence: "owned AX action list never presses task submit; every observed inference POST is classified by bounded probe fields",
    posts: fixture.posts.map((post) => ({ ...post })) };
  report.cleanup = {};
  for (const [name, child] of [["app", appChild], ["axHelper", helperChild]]) {
    if (!child) continue;
    try { report.cleanup[name] = await stopDetachedProcess(child, { graceMs: 2_000, killMs: 2_000 }); }
    catch (error) { report.cleanup[name] = { controlledCleanup: false, code: error.stage ?? "cleanup_failed" }; }
  }
  if (fixture) { try { report.cleanup.fixture = await fixture.close(); } catch { report.cleanup.fixture = { closed: false }; } }
  if (report.binding) {
    try {
      report.binding.binaryEndSha256 = await hash(app);
      report.binding.manifestEndSha256 = await hash(manifestPath);
      report.binding.sourceEndHashes = await sourceHashes(report.binding.expectedSourceHashes);
      report.binding.harnessEndSha256 = await hash(new URL(import.meta.url));
      report.binding.cleanupHelperEndSha256 = await hash(new URL("./desktop-process-cleanup.mjs", import.meta.url));
      if (home && await exists(join(home, "owned-ax-helper"))) report.binding.swiftExecutableEndSha256 = await hash(join(home, "owned-ax-helper"));
      report.binding.unchanged = report.binding.binaryStartSha256 === report.binding.binaryEndSha256 && report.binding.manifestStartSha256 === report.binding.manifestEndSha256
        && JSON.stringify(report.binding.sourceStartHashes) === JSON.stringify(report.binding.sourceEndHashes)
        && report.binding.harnessStartSha256 === report.binding.harnessEndSha256 && report.binding.cleanupHelperStartSha256 === report.binding.cleanupHelperEndSha256
        && report.binding.swiftExecutableStartSha256 === report.binding.swiftExecutableEndSha256;
    } catch { report.binding.unchanged = false; report.binding.endReadFailure = true; }
  }
  if (home) { try { await rm(home, { recursive: true, force: true }); report.cleanup.freshProfileRemoved = true; } catch { report.cleanup.freshProfileRemoved = false; } }
  report.passed = report.runCompleted && report.binding?.unchanged === true && report.cleanup.app?.controlledCleanup === true
    && report.cleanup.axHelper?.controlledCleanup === true && report.cleanup.fixture?.closed === true && report.cleanup.freshProfileRemoved === true;
  report.finishedAt = new Date().toISOString();
  report.elapsedMs = Date.parse(report.finishedAt) - Date.parse(report.startedAt);
  report.status = report.passed ? "passed" : report.failure?.code === "ax_permission_unavailable" || !report.stages.length ? "unverified" : "failed";
  if (await exists(output)) {
    const previous = await readFile(output);
    const previousSha256 = createHash("sha256").update(previous).digest("hex");
    await writeFile(output.replace(/\.json$/, `.previous-${previousSha256.slice(0, 12)}.json`), previous);
    report.previousReportSha256 = previousSha256;
  }
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ passed: report.passed, runCompleted: report.runCompleted, stageCount: report.stages.length,
    failure: report.failure ?? null, postRequests: report.fixture?.postRequests ?? null, sourceInputs: report.binding?.sourceInputs ?? null, elapsedMs: report.elapsedMs }));
  process.exitCode = report.passed ? 0 : 1;
}

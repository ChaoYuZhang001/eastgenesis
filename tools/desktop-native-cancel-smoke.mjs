// Real macOS/Tauri cancellation evidence. All task input and Stop actions use
// the owned app PID's accessibility tree; SQLite is a read-only assertion source.
// The live-app socket observation ends before either app or fixture teardown.
import { createServer } from "node:http";
import { spawn, execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, access, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { stopDetachedProcess, hasProcessExited } from "./desktop-process-cleanup.mjs";

const exec = promisify(execFile);
const options = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const at = arg.indexOf("=");
  if (at < 0) throw new Error("arguments_require_equals");
  return [arg.slice(0, at), arg.slice(at + 1)];
}));
const app = resolve(options["--app"] ?? "target/release/bundle/macos/EastGenesis Desktop.app/Contents/MacOS/eastgenesis-desktop");
const output = resolve(options["--output"] ?? "/tmp/eastgenesis-native-cancel.json");
const expectedBinary = options["--expected-binary-sha256"];
const referenceRevision = options["--compiled-source-revision"];
const compiledManifest = options["--compiled-source-manifest"];
const observationMs = Number(options["--observation-ms"] ?? 1500);
const sourceFiles = ["src-tauri/src/net.rs", "src-tauri/src/lib.rs", "src-tauri/src/keychain.rs", "src-tauri/Cargo.toml", "Cargo.lock", "src/platform/tauri-backend.ts", "src/platform/proxy-fetch.ts", "src/core/llm/http.ts", "src/stores/tasks.ts", "src/components/chat/AssistantTurn.tsx"];
const delta = "隔离取消测试：已收到的部分输出。";
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const hashBytes = (bytes) => createHash("sha256").update(bytes).digest("hex");
const hash = async (file) => hashBytes(await readFile(file));
const exists = async (file) => access(file).then(() => true, () => false);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function fail(stage) { const error = new Error(stage); error.stage = stage; throw error; }
function requireThat(value, stage) { if (!value) fail(stage); }
async function waitFor(fn, stage, timeoutMs = 15_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { if (await fn()) return; await pause(50); }
  fail(stage);
}
async function sourceSnapshot() {
  const files = {};
  for (const file of sourceFiles) files[file] = await hash(file);
  const net = await readFile("src-tauri/src/net.rs", "utf8");
  return { files, netProductionPrefixSha256: hashBytes(net.split("#[cfg(test)]")[0]) };
}
async function referenceSource() {
  if (!referenceRevision) return null;
  requireThat(/^[a-f0-9]{7,40}$/.test(referenceRevision), "reference_revision_format");
  const prefix = execFileSync("git", ["rev-parse", "--show-prefix"], { encoding: "utf8" }).trim();
  const revision = execFileSync("git", ["rev-parse", referenceRevision], { encoding: "utf8" }).trim();
  const files = {}; let net;
  for (const file of sourceFiles) {
    const bytes = execFileSync("git", ["show", `${revision}:${prefix}${file}`], { stdio: ["ignore", "pipe", "pipe"] });
    files[file] = hashBytes(bytes); if (file === "src-tauri/src/net.rs") net = bytes.toString("utf8");
  }
  return { revision, files, netProductionPrefixSha256: hashBytes(net.split("#[cfg(test)]")[0]), evidenceType: "git_content_reference", binaryCompilationBinding: "unknown_without_build_manifest" };
}

async function ax(pid, content, foundation = false) {
  try {
    const result = await exec("osascript", ["-e", `${foundation ? `use framework "Foundation"
on actionStamp()
set stampDate to current application's NSDate's |date|()
set stamp to stampDate's timeIntervalSince1970()
set stampNumber to current application's NSNumber's numberWithDouble:stamp
return stampNumber's stringValue() as text
end actionStamp
` : ""}tell application "System Events"
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
end tell`], { encoding: "utf8", timeout: 5_000 });
    return result.stdout.trim();
  } catch (error) {
    const code = String(error.stderr ?? "").match(/\((-?\d+)\)\s*$/)?.[1];
    fail(code ? `ax_${code.replace("-", "minus")}` : "ax_operation");
  }
}
async function hasText(pid, text) {
  try { return await ax(pid, `repeat with e in allElements
try
if (name of e as text) contains ${JSON.stringify(text)} then return "found"
if (value of e as text) contains ${JSON.stringify(text)} then return "found"
end try
end repeat
return "missing"`) === "found"; } catch { return false; }
}
async function click(pid, label, timestamp = false) {
  const result = await ax(pid, `set chosen to missing value
repeat with e in allElements
try
if (role of e as text) contains "Button" and (name of e as text) is ${JSON.stringify(label)} then
set chosen to e
exit repeat
end if
end try
end repeat
if chosen is missing value then return "missing"
if not enabled of chosen then return "disabled"
${timestamp ? "set clickStamp to my actionStamp()" : ""}
click chosen
return ${timestamp ? '"clicked:" & clickStamp' : '"clicked"'}`, timestamp);
  if (!timestamp) return requireThat(result === "clicked", "ax_owned_control");
  requireThat(/^clicked:\d+(\.\d+)?$/.test(result), "ax_owned_control_timestamp");
  return Number(result.slice(8)) * 1000;
}
async function pasteTask(pid) {
  const text = "把 hello 翻译成中文";
  execFileSync("pbcopy", [], { input: text });
  const result = await ax(pid, `set chosen to missing value
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
keystroke "a" using command down
keystroke "v" using command down
delay 0.2
if (value of chosen as text) is ${JSON.stringify(text)} then return "pasted"
return "missing"`);
  requireThat(result === "pasted", "ax_owned_task_input");
}
async function ready(pid) {
  let stable = 0;
  await waitFor(async () => {
    if (await hasText(pid, "添加")) return ++stable >= 2;
    stable = 0;
    for (const label of ["Don't Reopen", "Don’t Reopen", "不重新打开", "不要重新打开"]) {
      if (await hasText(pid, label)) { await click(pid, label); break; }
    }
    return false;
  }, "owned_window_ready");
}
function readTurns(db) {
  try {
    return JSON.parse(execFileSync("sqlite3", ["-readonly", "-json", db, "SELECT turns FROM sessions WHERE deleted_at IS NULL ORDER BY updated_at DESC"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })).flatMap((row) => JSON.parse(row.turns));
  } catch { return []; }
}
function taskEvidence(turn) {
  const calls = turn?.events?.filter((event) => event.type === "llm") ?? [];
  const routes = turn?.events?.filter((event) => event.type === "route" || event.type === "step_route") ?? [];
  return { status: turn?.status ?? null, streamingTextEqualsInitialDelta: turn?.streamingText === delta, streamingInterrupted: turn?.streamingInterrupted === true, completedLlmCalls: calls.length, selectedRoutes: routes.length, allSelectedRoutesSyntheticQa: routes.length > 0 && routes.every((route) => route.profileId?.startsWith("custom:qa/")), runEndStatus: turn?.events?.findLast((event) => event.type === "run_end")?.status ?? null };
}

async function fixture() {
  const counts = { models: 0, json: 0, stream: 0 };
  const sockets = new Set(); const streams = []; let teardownStartedAt = null; let idle = false;
  const server = createServer((req, res) => {
    const chunks = []; let bytes = 0;
    req.on("data", (chunk) => { bytes += chunk.length; if (bytes <= 1_048_576) chunks.push(chunk); else req.destroy(); });
    req.on("end", () => {
      if (req.url?.endsWith("/models")) { counts.models++; res.setHeader("content-type", "application/json"); return res.end(JSON.stringify({ data: [{ id: "gpt-5.6-luna", object: "model" }] })); }
      let body; try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return res.writeHead(400).end(); }
      if (body.stream !== true) {
        counts.json++; res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify({ model: "gpt-5.6-luna", choices: [{ index: 0, message: { role: "assistant", content: "合成模型可用。" }, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 } }));
      }
      counts.stream++;
      if (!idle) {
        res.writeHead(200, { "content-type": "text/event-stream", connection: "keep-alive" });
        return res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "隔离预检已完成。" }, finish_reason: null }] })}\n\ndata: [DONE]\n\n`);
      }
      const state = { requestAt: Date.now(), headersAt: null, initialDeltaAt: null, responseClosedAt: null, socketClosedAt: null, socketEndedAt: null, responseClosePhase: null, socketClosePhase: null, socket: req.socket, response: res };
      streams.push(state);
      const phase = () => teardownStartedAt ? "app_teardown_or_fixture_teardown" : "live_app_observation";
      res.once("close", () => { state.responseClosedAt = Date.now(); state.responseClosePhase = phase(); });
      req.socket.once("end", () => { state.socketEndedAt = Date.now(); });
      req.socket.once("close", () => { state.socketClosedAt = Date.now(); state.socketClosePhase = phase(); });
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.flushHeaders(); state.headersAt = Date.now();
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: delta }, finish_reason: null }] })}\n\n`); state.initialDeltaAt = Date.now();
      // Deliberately retain the unfinished response. Neither end(), destroy(),
      // a response timeout, nor a fixture kill may supply cancellation proof.
    });
  });
  server.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  server.requestTimeout = 0; server.timeout = 0;
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, counts, streams, sockets, base: `http://127.0.0.1:${server.address().port}/v1`, setIdle: () => { idle = true; }, markTeardown: () => { teardownStartedAt = Date.now(); }, teardownStartedAt: () => teardownStartedAt };
}
function streamEvidence(state, origin) {
  const relative = (at) => at === null || at === undefined ? null : at - origin;
  return { headersMs: relative(state?.headersAt), initialDeltaMs: relative(state?.initialDeltaAt), responseClosedMs: relative(state?.responseClosedAt), peerSocketEndedMs: relative(state?.socketEndedAt), peerSocketClosedMs: relative(state?.socketClosedAt), responseClosePhase: state?.responseClosePhase ?? null, socketClosePhase: state?.socketClosePhase ?? null, responseDestroyed: state?.response?.destroyed ?? null, socketDestroyed: state?.socket?.destroyed ?? null };
}

const report = { schemaVersion: 1, kind: "macos-native-provider-cancel", createdAt: new Date().toISOString(), passed: false, runCompleted: false, platform: "macos", observationMs, evidenceBoundary: { proven: [], excluded: ["real Provider", "remote compute or billing after disconnect", "Windows/Linux transport", "worker/stream registry release without a dedicated native probe", "headers-before-first-token cancellation", "late-delta discard after cancel", "signing/notarization"] }, isolation: { freshHome: false, freshAppData: false, qaIsolatedProfileRequested: true, keyEnvironmentInherited: false, privateConfigurationRead: false, ledgerSeeded: false, sqliteAccess: "readonly", provider: "owned synthetic loopback custom:qa" }, scenarios: [] };
let home, child, f;
const scenario = { scenario: "idle_after_visible_delta", status: "not_run", assertions: {} };
report.scenarios.push(scenario);
try {
  requireThat(process.platform === "darwin", "macos_required");
  requireThat(output.endsWith(".json"), "json_output_required");
  requireThat(/^[a-f0-9]{64}$/.test(expectedBinary ?? ""), "expected_binary_sha256_required");
  requireThat(Number.isInteger(observationMs) && observationMs >= 500 && observationMs <= 1500, "bounded_observation_ms");
  report.binding = { expectedBinarySha256: expectedBinary, binaryStartSha256: await hash(app), harnessStartSha256: await hash(new URL(import.meta.url)), cleanupHelperStartSha256: await hash(new URL("./desktop-process-cleanup.mjs", import.meta.url)), workingTreeStart: await sourceSnapshot(), reference: await referenceSource(), compiledSourceBinding: "unknown_without_build_manifest" };
  requireThat(report.binding.binaryStartSha256 === expectedBinary, "protected_binary_binding");
  if (compiledManifest) {
    const manifest = JSON.parse(await readFile(compiledManifest, "utf8"));
    report.binding.buildManifestSha256 = await hash(compiledManifest);
    const manifestBinary = manifest.binarySha256 ?? manifest.expectedBinarySha256;
    const files = manifest.sourceHashes ?? manifest.files;
    requireThat(manifestBinary === expectedBinary && files && sourceFiles.every((file) => /^[a-f0-9]{64}$/.test(files[file] ?? "")), "compiled_manifest_binding");
    report.binding.compiledSource = { files, evidenceType: "caller_build_manifest", manifestSha256: report.binding.buildManifestSha256 };
    report.binding.compiledSourceBinding = "caller_build_manifest_matches_binary";
  }
  report.osVersion = execFileSync("sw_vers", ["-productVersion"], { encoding: "utf8" }).trim(); report.architecture = process.arch;
  home = await realpath(await mkdtemp(join(tmpdir(), "eg-cancel-ax-")));
  const dir = join(home, "Library/Application Support/com.eastgenesis.desktop");
  const db = join(dir, "eastgenesis.db"), providerConfig = join(dir, "providers.json");
  await mkdir(join(home, "Downloads"), { recursive: true });
  report.isolation.freshHome = true; report.isolation.freshAppData = !await exists(dir);
  requireThat(report.isolation.freshAppData && !await exists(providerConfig), "fresh_profile");
  f = await fixture();
  const env = { HOME: home, PATH: process.env.PATH, TMPDIR: tmpdir(), LANG: "en_US.UTF-8", EASTGENESIS_QA_ISOLATED_PROFILE: "1", EASTGENESIS_QA_PROVIDER_BASE_URL: f.base, EASTGENESIS_QA_PROVIDER_MODEL: "gpt-5.6-luna", EASTGENESIS_QA_PROVIDER_PROTOCOL: "openai" };
  child = spawn(app, [], { env, detached: true, stdio: ["ignore", "ignore", "ignore"] });
  await ready(child.pid); await pasteTask(child.pid); await click(child.pid, "提交任务");
  await waitFor(() => readTurns(db).some((turn) => turn.status === "completed" && (turn.events ?? []).some((event) => event.type === "llm")), "ui_warmup_completed_nonempty_llm_record");
  const warmup = readTurns(db)[0];
  requireThat((warmup.events ?? []).filter((event) => event.type === "llm").every((call) => call.profileId?.startsWith("custom:qa/")), "warmup_only_synthetic_qa");
  report.isolation.warmupCreatedThroughUi = true;
  report.isolation.warmupCompletedLlmCalls = warmup.events.filter((event) => event.type === "llm").length;
  f.setIdle(); await click(child.pid, "新任务"); await ready(child.pid); await pasteTask(child.pid); await click(child.pid, "提交任务");
  await waitFor(() => f.streams.length === 1, "single_owned_stream");
  await waitFor(() => hasText(child.pid, delta), "initial_delta_visible_in_owned_ui");
  const state = f.streams[0];
  requireThat(state.headersAt && state.initialDeltaAt && !state.socketClosedAt && !state.responseClosedAt, "live_idle_source");
  await pause(100); // Let the Rust worker enter its next idle read.
  scenario.ui = { ownedPidAccess: true, taskEnteredAndSubmittedThroughUi: true, initialDeltaVisible: true };
  const stopOperationStartedAt = Date.now();
  const stopRequestedAt = await click(child.pid, "停止任务", true);
  const stopReturnedAt = Date.now();
  requireThat(stopRequestedAt >= stopOperationStartedAt && stopRequestedAt <= stopReturnedAt, "ax_click_timestamp_in_operation_bounds");
  scenario.stopControlMs = stopReturnedAt - stopOperationStartedAt;
  scenario.stopActionFromOperationStartMs = stopRequestedAt - stopOperationStartedAt;
  scenario.stopReturnedAfterActionMs = stopReturnedAt - stopRequestedAt;
  scenario.observationOrigin = "foundation_unix_milliseconds_immediately_before_owned_ax_click";
  let abortSeenAt = null;
  const observationEnd = stopRequestedAt + observationMs;
  while (Date.now() < observationEnd) {
    if (!abortSeenAt && readTurns(db).some((turn) => turn.status === "aborted")) abortSeenAt = Date.now();
    requireThat(!hasProcessExited(child), "app_must_remain_alive_during_observation");
    await pause(Math.min(25, Math.max(1, observationEnd - Date.now())));
  }
  scenario.observedMs = Date.now() - stopRequestedAt;
  const sourceSnapshotBeforeCleanup = streamEvidence(state, stopRequestedAt);
  const beforeCleanup = readTurns(db); const turn = beforeCleanup[0];
  const completedCalls = beforeCleanup.flatMap((turn) => turn.events ?? []).filter((event) => event.type === "llm");
  scenario.sqliteAbortMs = abortSeenAt ? abortSeenAt - stopRequestedAt : null;
  scenario.sqliteAbortAfterStopReturnedMs = abortSeenAt ? abortSeenAt - stopReturnedAt : null;
  scenario.sqlite = taskEvidence(turn);
  scenario.sqlite.historyCompletedLlmCalls = completedCalls.length;
  scenario.sqlite.allHistoryCompletedLlmCallsSyntheticQa = completedCalls.length > 0 && completedCalls.every((call) => call.profileId?.startsWith("custom:qa/"));
  scenario.liveAppBeforeCleanup = !hasProcessExited(child);
  scenario.sourceBeforeAnyCleanup = sourceSnapshotBeforeCleanup;
  scenario.sourceBeforeAnyCleanup.peerCloseFromStopOperationStartedMs = state.socketClosedAt ? state.socketClosedAt - stopOperationStartedAt : null;
  scenario.sourceBeforeAnyCleanup.responseCloseFromStopOperationStartedMs = state.responseClosedAt ? state.responseClosedAt - stopOperationStartedAt : null;
  scenario.assertions = { sourceHeadersAndDeltaPrecededStop: state.headersAt < stopRequestedAt && state.initialDeltaAt < stopRequestedAt, initialDeltaVisibleBeforeStop: true, appAliveBeforeCleanup: scenario.liveAppBeforeCleanup, sqliteAborted: turn?.status === "aborted", partialOutputMatchesInitialDelta: turn?.streamingText === delta && turn?.streamingInterrupted === true, nonemptyRecordedLlmCallsOnlySyntheticQa: scenario.sqlite.allHistoryCompletedLlmCallsSyntheticQa, canceledTaskSelectedRouteOnlySyntheticQa: scenario.sqlite.allSelectedRoutesSyntheticQa, responseClosedWithinWindowWhileAppAlive: !!state.responseClosedAt && state.responseClosedAt <= observationEnd && state.responseClosePhase === "live_app_observation", peerSocketClosedWithinWindowWhileAppAlive: !!state.socketClosedAt && state.socketClosedAt <= observationEnd && state.socketClosePhase === "live_app_observation", providerConfigNotPersisted: !await exists(providerConfig) };
  scenario.assertions.stoppedUiVisible = await hasText(child.pid, "已停止");
  scenario.assertions.partialOutputVisibleAfterStop = await hasText(child.pid, delta);
  const finalTurn = readTurns(db)[0];
  scenario.assertions.sqlitePartialOutputStableAfterStop = finalTurn?.status === "aborted" && finalTurn?.streamingText === delta && finalTurn?.streamingInterrupted === true;
  scenario.status = Object.values(scenario.assertions).every(Boolean) ? "passed" : "failed";
  scenario.failedAssertions = Object.entries(scenario.assertions).filter(([, value]) => !value).map(([name]) => name);
  report.runCompleted = true; report.passed = scenario.status === "passed";
  report.evidenceBoundary.proven = ["real macOS owned-PID UI submits and stops an actual native Provider stream", "readonly SQLite records aborted task and preserved partial output", "source response and socket state observed before any cleanup"];
  if (scenario.assertions.peerSocketClosedWithinWindowWhileAppAlive) report.evidenceBoundary.proven.push("peer socket closes within bounded cancellation window while app stays alive");
  else report.evidenceBoundary.proven.push("peer socket remains open through bounded cancellation window while app stays alive");
  scenario.sourceImmediatelyBeforeAppCleanup = streamEvidence(state, stopRequestedAt);
  scenario.cleanupOrigin = { stopRequestedAt };
  console.log(JSON.stringify({ runCompleted: true, passed: report.passed, failedAssertions: scenario.failedAssertions, sqliteAbortMs: scenario.sqliteAbortMs, peerClosedBeforeCleanup: scenario.assertions.peerSocketClosedWithinWindowWhileAppAlive }));
} catch (error) {
  report.failedStage = error.stage ?? "unexpected_failure"; scenario.status = "failed"; scenario.failedStage = report.failedStage;
  console.log(JSON.stringify({ runCompleted: false, passed: false, failedStage: report.failedStage }));
} finally {
  if (f) f.markTeardown();
  if (child?.pid) {
    try { await stopDetachedProcess(child, { graceMs: 1000, killMs: 2000 }); report.controlledAppCleanup = true; }
    catch (error) { report.controlledAppCleanup = false; report.cleanupFailedStage = error.stage ?? "process_cleanup"; report.passed = false; }
  }
  if (f) {
    await pause(50);
    report.teardown = { fixtureNotClosedUntilAfterAppCleanup: true, appCleanupStartedAfterObservation: true, responseClosedByAppCleanup: f.streams.some((state) => state.responseClosePhase === "app_teardown_or_fixture_teardown"), peerClosedByAppCleanup: f.streams.some((state) => state.socketClosePhase === "app_teardown_or_fixture_teardown"), streams: f.streams.map((state) => streamEvidence(state, scenario.cleanupOrigin?.stopRequestedAt ?? state.requestAt)) };
    delete scenario.cleanupOrigin;
    report.fixtureRequestCounts = f.counts;
    for (const socket of f.sockets) socket.destroy();
    await new Promise((r) => f.server.close(r));
  }
  if (home) await rm(home, { recursive: true, force: true });
  execFileSync("pbcopy", [], { input: "" });
  if (report.binding) {
    report.binding.binaryEndSha256 = await hash(app);
    report.binding.harnessEndSha256 = await hash(new URL(import.meta.url));
    report.binding.cleanupHelperEndSha256 = await hash(new URL("./desktop-process-cleanup.mjs", import.meta.url));
    report.binding.workingTreeEnd = await sourceSnapshot();
    report.binding.binaryUnchanged = report.binding.binaryStartSha256 === report.binding.binaryEndSha256;
    report.binding.harnessUnchanged = report.binding.harnessStartSha256 === report.binding.harnessEndSha256 && report.binding.cleanupHelperStartSha256 === report.binding.cleanupHelperEndSha256;
    report.binding.workingTreeUnchanged = same(report.binding.workingTreeStart, report.binding.workingTreeEnd);
    report.binding.currentFilesMatchingReference = report.binding.reference ? Object.fromEntries(sourceFiles.map((file) => [file, report.binding.workingTreeStart.files[file] === report.binding.reference.files[file]])) : null;
    if (!report.binding.binaryUnchanged || !report.binding.harnessUnchanged) { report.passed = false; report.failedStage = "artifact_changed_during_run"; }
  }
  report.finishedAt = new Date().toISOString();
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  const md = `# macOS native Provider cancellation evidence\n\nCreated: ${report.createdAt}. Finished: ${report.finishedAt}.\n\nNative transport acceptance: **${report.passed ? "passed" : "failed"}**. Harness completed: ${report.runCompleted}.\n\nBinary SHA-256: \`${report.binding?.binaryStartSha256 ?? "unavailable"}\`. Binary unchanged through run: ${report.binding?.binaryUnchanged ?? false}. Harness SHA-256: \`${report.binding?.harnessStartSha256 ?? "unavailable"}\`.\n\nThe harness launched the actual macOS QA app with a fresh HOME/appdata, an owned synthetic loopback Provider and EASTGENESIS_QA_ISOLATED_PROFILE=1. It inherited only PATH and no Provider key environment, created the task through the PID-owned accessibility tree, first completed one synthetic warmup task through the UI so recorded successful LLM calls are nonempty, then submitted the cancellation task, waited for response headers plus a visible initial delta, and clicked Stop. All recorded LLM calls and the canceled task route must be custom:qa. An interrupted simple answer has no successful llm event by design, so the warmup and canceled-route evidence are reported separately. SQLite was opened read-only; no task or ledger state was seeded.\n\n| Live-app assertion | Result |\n| --- | --- |\n${Object.entries(scenario.assertions).map(([name, value]) => `| ${name} | ${value} |`).join("\n")}\n\nThe ${report.observationMs} ms observation begins at a millisecond precision Foundation NSDate timestamp sampled after the button is located and immediately before the owned AX click. AX search/operation duration is recorded separately and cannot consume the cancellation window. The timestamp is validated to lie between the Node operation start and return. Socket close latency uses this same action origin and therefore includes the click itself. Actual observed elapsed: ${scenario.observedMs ?? "unavailable"} ms. SQLite abort observed after ${scenario.sqliteAbortMs ?? "unavailable"} ms. Stop control elapsed: ${scenario.stopControlMs ?? "unavailable"} ms.\n\nThe pre-cleanup socket/response snapshot is recorded before process cleanup. The fixture emits no further delta and never ends the idle response during observation. A close caused by app teardown cannot satisfy prompt cancellation acceptance. Pre-cleanup peer socket close: ${scenario.sourceBeforeAnyCleanup?.peerSocketClosedMs ?? "not observed"}; response close: ${scenario.sourceBeforeAnyCleanup?.responseClosedMs ?? "not observed"}. Controlled app cleanup: ${report.controlledAppCleanup ?? false}. A cleanup-induced close is recorded only as cleanup evidence.\n\nSource binding: ${report.binding?.compiledSourceBinding ?? "unknown"}. ${report.binding?.reference ? `Git content reference: \`${report.binding.reference.revision}\`; native net production-prefix SHA-256 \`${report.binding.reference.netProductionPrefixSha256}\`.` : "No Git content reference supplied."} Current source snapshots are independently hashed at start/end and do not imply they were compiled into this binary. ${report.binding?.compiledSource ? "The supplied build manifest declares the compiled source file hashes and is itself hash-bound to this report." : "Actual complete binary-to-source compilation provenance remains unknown without a build manifest."}\n\nExcluded: real Provider requests, remote compute/billing, worker/stream registry release without a dedicated native probe, headers-before-first-token cancellation, late-delta discard, Windows/Linux, signing/notarization. The JSON report contains hashes and fixed assertions, no credentials, Provider URL, request bodies, raw accessibility tree, task IDs or user paths.\n`;
  await writeFile(output.replace(/\.json$/, ".md"), md);
}
if (!report.passed) process.exitCode = 1;

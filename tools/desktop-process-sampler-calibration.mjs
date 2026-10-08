// Bounded calibration of one owned synthetic Node process, never an app baseline.
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { createInterface } from "node:readline";
import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { createOwnedProcessSampler } from "./desktop-process-measurement.mjs";

const SOURCE_FILES = ["tools/desktop-process-measurement.mjs", "tools/desktop-process-measurement.d.mts", "tests/desktop-process-measurement.test.ts", "tools/desktop-process-sampler-calibration.mjs"];
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sourceHashes = async () => Object.fromEntries(await Promise.all(SOURCE_FILES.map(async (file) => [file, sha(await readFile(resolve(ROOT, file)))])));
const exited = (child) => child.exitCode !== null || child.signalCode !== null;
const failed = (reason) => { throw new Error(reason); };

function ownedTarget() {
  const memory = Buffer.alloc(32 * 1024 * 1024, 0x71);
  const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
  const cpu = () => process.cpuUsage();
  send({ event: "ready", committedBufferBytes: memory.length });
  createInterface({ input: process.stdin }).on("line", (line) => {
    const request = JSON.parse(line);
    if (!Number.isSafeInteger(request.seq) || request.seq < 1) process.exit(2);
    if (request.command === "snapshot") send({ seq: request.seq, event: "cpu", ...cpu() });
    else if (request.command === "busy" && request.durationMs === 800) {
      const before = cpu(), start = performance.now(), deadline = start + 800;
      let iterations = 0;
      while (performance.now() < deadline) { memory[iterations % memory.length] ^= iterations & 255; iterations++; }
      const after = cpu();
      send({ seq: request.seq, event: "busy_completed", requestedWallMs: 800, observedWallMs: performance.now() - start,
        cpuDeltaUs: after.user + after.system - before.user - before.system, iterations });
    } else process.exit(2);
  });
}

function targetProtocol(child) {
  let seq = 0, readyResolve, readyReject;
  const pending = new Map();
  const ready = new Promise((resolveReady, rejectReady) => { readyResolve = resolveReady; readyReject = rejectReady; });
  const readyTimer = setTimeout(() => readyReject(new Error("target_handshake_timeout")), 3000);
  const rejectAll = () => { readyReject(new Error("target_early_exit")); for (const entry of pending.values()) entry.reject(new Error("target_early_exit")); pending.clear(); };
  child.once("exit", rejectAll); child.once("error", rejectAll);
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    try {
      if (line.length > 2048) failed("target_protocol");
      const value = JSON.parse(line);
      if (value.event === "ready" && value.committedBufferBytes === 33554432) { clearTimeout(readyTimer); readyResolve(value); return; }
      const entry = pending.get(value.seq);
      if (!entry) failed("target_protocol");
      pending.delete(value.seq);
      entry.resolve(value);
    } catch { rejectAll(); }
  });
  return { ready,
    async request(command) {
      const id = ++seq, sentAtMonotonicMs = performance.now();
      let timer;
      try {
        const value = await new Promise((resolveRequest, rejectRequest) => {
          pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
          timer = setTimeout(() => { pending.delete(id); rejectRequest(new Error("target_protocol_timeout")); }, 3000);
          child.stdin.write(`${JSON.stringify({ seq: id, ...command })}\n`);
        });
        if (command.command === "snapshot" && (value.event !== "cpu" || !Number.isSafeInteger(value.user) || value.user < 0 || !Number.isSafeInteger(value.system) || value.system < 0)) failed("target_protocol");
        return { ...value, sentAtMonotonicMs, receivedAtMonotonicMs: performance.now() };
      } finally { clearTimeout(timer); }
    },
    close() { clearTimeout(readyTimer); lines.close(); child.stdin.destroy(); },
  };
}

async function waitForExit(child, timeoutMs) {
  if (exited(child)) return;
  await new Promise((resolveExit, rejectExit) => {
    const done = () => { clearTimeout(timer); child.removeListener("exit", done); resolveExit(); };
    const timer = setTimeout(() => { child.removeListener("exit", done); rejectExit(new Error("owned_cleanup_timeout")); }, timeoutMs);
    child.once("exit", done);
  });
}

async function stopOwned(child) {
  let forced = false;
  if (!exited(child)) child.kill("SIGTERM");
  try { await waitForExit(child, 1000); }
  catch { forced = true; child.kill("SIGKILL"); await waitForExit(child, 1000); }
  return { pid: child.pid, exitObserved: exited(child), exitCode: child.exitCode, signal: child.signalCode, forced };
}

async function calibrate(output) {
  if (await access(output).then(() => true, () => false) || await access(output.replace(/\.json$/, ".md")).then(() => true, () => false)) failed("output_already_exists");
  const report = { schemaVersion: 1, kind: "macos-owned-node-frozen-sampler-calibration", recordType: "native-run-original-numeric-record",
    startedAtUtc: new Date().toISOString(), passed: false, platformExecution: { darwin: "not_run", linux: "not_run", win32: "not_run" },
    runtime: { node: process.version, platform: process.platform, architecture: process.arch },
    binding: { sourceHashesStart: await sourceHashes() },
    settings: { intervalMs: 100, durationMs: 1200, busyRequestedWallMs: 800, maxTargetCpuDeltaMs: 1000, totalBudgetMs: 60000 },
    evidenceBoundary: { independentMeasurementWindows: 1, resourceProcesses: 1, appResourceBaseline: false, fullWebViewTreeMeasured: false,
      descendantRegistrationNativeValidation: false, realProvider: false, privateConfigurationRead: false, gui: false,
      excluded: ["Linux/Windows native execution", "owner and helper resources", "unregistered descendants", "WKWebView XPC without verified parent ancestry", "EastGenesis resource or startup performance baseline"] } };
  const started = performance.now(), children = [];
  let target, protocol, sampler, measurementPromise;
  const hardDeadline = setTimeout(() => { for (const child of children) if (!exited(child)) child.kill("SIGKILL"); }, 55000);
  try {
    if (process.platform !== "darwin") failed("darwin_only_not_run");
    report.platformExecution.darwin = "executed";
    const env = Object.fromEntries(["PATH", "TMPDIR", "LANG", "LC_ALL"].filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));
    target = childProcess.spawn(process.execPath, [fileURLToPath(import.meta.url), "--owned-target"], { env, stdio: ["pipe", "pipe", "ignore"] });
    children.push(target);
    protocol = targetProtocol(target);
    report.targetHandshake = await protocol.ready;
    report.ownership = { ownerPid: process.pid, targetPid: target.pid, targetCreatedDirectly: true, helpers: [] };
    // Capture only the ChildProcess returned by the sampler's own spawn. Forward
    // arguments/return unchanged, then restore Node's builtin live binding. This
    // gives cleanup evidence without discovering or scanning unrelated PIDs.
    const originalSpawn = childProcess.spawn;
    childProcess.spawn = function (...args) { const child = originalSpawn.apply(this, args); children.push(child); report.ownership.helpers.push({ pid: child.pid, capturedOwnedSpawn: true }); return child; };
    syncBuiltinESMExports();
    try { sampler = await createOwnedProcessSampler({ rootPid: target.pid, ownerPid: process.pid }); }
    finally { childProcess.spawn = originalSpawn; syncBuiltinESMExports(); }
    if (report.ownership.helpers.length !== 1) failed("helper_ownership");
    report.scope = sampler.scope;
    const startBefore = await protocol.request({ command: "snapshot" });
    measurementPromise = sampler.measure({ intervalMs: 100, durationMs: 1200 });
    await delay(50);
    const startAfter = await protocol.request({ command: "snapshot" });
    report.busyWork = await protocol.request({ command: "busy", durationMs: 800 });
    // Reserve a quiet interval before the final native observation so the two
    // target snapshots tightly bracket each native endpoint's CPU counter.
    await delay(50);
    const endBefore = await protocol.request({ command: "snapshot" });
    report.measurement = await measurementPromise;
    const endAfter = await protocol.request({ command: "snapshot" });
    report.targetCpuBoundaries = { unit: "microseconds", startBefore, startAfter, endBefore, endAfter };
    const frames = report.measurement.samples, first = frames[0], last = frames.at(-1);
    if (report.measurement.status !== "verified" || frames.length < 2) failed("measurement_unverified");
    const wholeWindowInside = (sample, before, after) => before.receivedAtMonotonicMs <= sample.observedAtMs - sample.collectionDurationMs / 2
      && after.sentAtMonotonicMs >= sample.observedAtMs + sample.collectionDurationMs / 2;
    const cpuMs = (snapshot) => (snapshot.user + snapshot.system) / 1000;
    const lowerMs = cpuMs(endBefore) - cpuMs(startAfter), upperMs = cpuMs(endAfter) - cpuMs(startBefore);
    const midpointMs = (lowerMs + upperMs) / 2, nativeMs = report.measurement.summary.cpuDeltaMs;
    report.crossCheck = { targetOwnCpuDeltaLowerMs: lowerMs, targetOwnCpuDeltaUpperMs: upperMs, targetOwnCpuDeltaMidpointMs: midpointMs,
      nativeCpuDeltaMs: nativeMs, absoluteMidpointDifferenceMs: Math.abs(nativeMs - midpointMs), counterToleranceMs: 2,
      firstNativeCollectionBracketed: wholeWindowInside(first, startBefore, startAfter), lastNativeCollectionBracketed: wholeWindowInside(last, endBefore, endAfter),
      cpuAgreesWithinBracket: nativeMs >= lowerMs - 2 && nativeMs <= upperMs + 2,
      targetOwnCpuBelowBusyBudget: upperMs <= 1000, rssAtLeastCommittedBuffer: report.measurement.summary.sampledPeakRssBytes >= 33554432,
      identityStable: frames.every((frame) => frame.processes.length === 1 && frame.processes[0].pid === target.pid && frame.processes[0].parentPid === process.pid && frame.processes[0].identity === first.processes[0].identity) };
    if (Object.values(report.crossCheck).some((value) => typeof value === "boolean" && !value)) failed("calibration_cross_check");
    if (report.busyWork.event !== "busy_completed" || !Number.isSafeInteger(report.busyWork.cpuDeltaUs) || report.busyWork.cpuDeltaUs < 0 || report.busyWork.cpuDeltaUs > 1000000) failed("busy_budget");
    report.targetCleanup = await stopOwned(target);
    report.afterExit = [await sampler.sample(), await sampler.sample()];
    report.exitFailClosed = report.afterExit.every((sample) => sample.status === "unverified" && sample.reason === "pid_exited" && sample.rssBytes === null && sample.cpuCumulativeMs === null && sample.processes.length === 0);
    if (!report.exitFailClosed) failed("exit_not_fail_closed");
    report.passed = true;
  } catch (error) {
    const allowed = ["darwin_only_not_run", "target_handshake_timeout", "target_early_exit", "target_protocol", "target_protocol_timeout", "helper_ownership", "measurement_unverified", "calibration_cross_check", "busy_budget", "exit_not_fail_closed", "owned_cleanup_timeout", "collector_unavailable", "native_read_failed", "native_api_unavailable", "ownership_invalid"];
    report.failedStage = allowed.includes(error.message) ? error.message : "calibration_failed";
  } finally {
    if (measurementPromise) await measurementPromise.catch(() => {});
    protocol?.close();
    if (target && !exited(target)) { try { report.targetCleanup = await stopOwned(target); } catch { report.passed = false; report.failedStage = "owned_cleanup_timeout"; } }
    if (sampler) await sampler.close();
    report.helperCleanup = [];
    for (const helper of children.filter((child) => child !== target)) {
      try { await waitForExit(helper, 1000); report.helperCleanup.push({ pid: helper.pid, exitObserved: true, exitCode: helper.exitCode, signal: helper.signalCode, additionalSignalRequired: false }); }
      catch { report.passed = false; const cleanup = await stopOwned(helper).catch(() => ({ pid: helper.pid, exitObserved: false })); report.helperCleanup.push({ ...cleanup, additionalSignalRequired: true }); }
    }
    clearTimeout(hardDeadline);
    report.allOwnedChildrenExited = children.every(exited);
    if (!report.allOwnedChildrenExited) { report.passed = false; report.failedStage = "owned_cleanup_timeout"; }
    report.binding.sourceHashesEnd = await sourceHashes();
    report.binding.sourceUnchanged = SOURCE_FILES.every((file) => report.binding.sourceHashesStart[file] === report.binding.sourceHashesEnd[file]);
    if (!report.binding.sourceUnchanged) { report.passed = false; report.failedStage = "source_changed_during_run"; }
    report.finishedAtUtc = new Date().toISOString();
    report.elapsedMs = performance.now() - started;
    report.totalBudgetMet = report.elapsedMs <= 60000;
    if (!report.totalBudgetMet) report.passed = false;
    await mkdir(dirname(output), { recursive: true });
    const json = `${JSON.stringify(report, null, 2)}\n`;
    await writeFile(output, json, { flag: "wx" });
    const summary = report.measurement?.summary;
    const markdown = `# macOS 冻结 sampler 原生校准\n\n本次执行时间为 ${report.startedAtUtc} 至 ${report.finishedAtUtc}，结果 **${report.passed ? "passed" : "failed"}**。固定原始数值记录的 SHA256 为 \`${sha(json)}\`；JSON 保存每次 native sample、目标自身 CPU 边界、退出与 helper 清理事实，并绑定 sampler、类型声明、契约测试及本校准脚本的起止源码 SHA。起止源码一致：${report.binding.sourceUnchanged}。\n\n校准条件为一个本脚本直接创建的自有 Node 子进程：32 MiB 已写入 Buffer，100 ms 间隔、1,200 ms 请求窗口，单段忙循环请求 800 ms。独立测量窗口数为 1，实际采样点 ${summary?.sampleCount ?? 0}；CPU 增量 ${summary?.cpuDeltaMs ?? "unverified"} ms，一核归一化 ${summary?.cpuPercentOneCore ?? "unverified"}%，RSS 采样峰值 ${summary?.sampledPeakRssBytes ?? "unverified"} bytes。目标自身 process.cpuUsage() 前后观测给出 native 首末采样的 CPU 增量 bracket；固定 2 ms counter tolerance 单独记录。所有子进程退出：${report.allOwnedChildrenExited}；目标退出后的连续两次 sample fail closed：${report.exitFailClosed ?? false}。\n\nDarwin 本次状态为 ${report.platformExecution.darwin}；Linux/Windows 仍为 not_run。只涵盖一个登记 PID，owner/helper 不计入资源，未验证后代登记或完整 WebView 树；未登记后代与无法验证亲子归属的 WKWebView XPC excluded。RSS 是 resident bytes，CPU 使用 own user+system 累计 counter，窗口比例按一核 100% 计算。这里是 sampler 校准，不是 EastGenesis 资源、启动或三平台性能基线。此前没有运行时 SHA 绑定的摘录原样保留。\n`;
    await writeFile(output.replace(/\.json$/, ".md"), markdown, { flag: "wx" });
    console.log(JSON.stringify({ passed: report.passed, finishedAtUtc: report.finishedAtUtc, elapsedMs: report.elapsedMs, sourceUnchanged: report.binding.sourceUnchanged,
      allOwnedChildrenExited: report.allOwnedChildrenExited, exitFailClosed: report.exitFailClosed ?? null, summary, crossCheck: report.crossCheck ?? null, rawJsonSha256: sha(json) }));
  }
  return report.passed;
}

if (process.argv[2] === "--owned-target" && process.argv.length === 3) ownedTarget();
else {
  const args = process.argv.slice(2);
  if (args.length > 1 || args.length === 1 && !args[0].startsWith("--output=")) failed("arguments_invalid");
  const output = resolve(args[0]?.slice("--output=".length) ?? resolve(ROOT, "docs/evidence/macos-process-sampler-frozen-validation-2026-10-07.json"));
  if (!output.endsWith(".json")) failed("json_output_required");
  if (!await calibrate(output)) process.exitCode = 1;
}

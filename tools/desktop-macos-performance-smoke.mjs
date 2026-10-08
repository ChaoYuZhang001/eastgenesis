// Startup observations of an owned QA app. SQLite existence is profile metadata,
// never the readiness metric. AX probes do not submit any task.
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { readFile, writeFile, mkdir, mkdtemp, access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { stopDetachedProcess, hasProcessExited } from "./desktop-process-cleanup.mjs";

const exec = promisify(execFile);
const hashBytes = (bytes) => createHash("sha256").update(bytes).digest("hex");
const hash = async (file) => hashBytes(await readFile(file));
const exists = (file) => access(file).then(() => true, () => false);
const PHASES = ["fresh_profile_first_launch", "initialized_profile_relaunch"];
const METRICS = ["startup_basic_ready", "input_roundtrip_submit_enabled", "route_provider_probe_completed"];

export function parseOptions(argv) {
  const options = {};
  for (const arg of argv) {
    const split = arg.indexOf("=");
    if (split < 0) throw new Error("arguments_require_equals");
    const key = arg.slice(0, split);
    if (!(new Set(["--pairs", "--timeout-ms", "--total-timeout-ms", "--output", "--manifest", "--app", "--pilot-report", "--prior-reports"])).has(key)) throw new Error("unknown_option");
    if (key in options) throw new Error("duplicate_option");
    options[key] = arg.slice(split + 1);
  }
  const pairs = Number(options["--pairs"] ?? 1);
  const timeoutMs = Number(options["--timeout-ms"] ?? 15000);
  const totalTimeoutMs = Number(options["--total-timeout-ms"] ?? 600000);
  if (!Number.isInteger(pairs) || pairs < 1 || pairs > 20) throw new Error("pairs_must_be_1_to_20");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30000) throw new Error("sample_timeout_out_of_bounds");
  if (!Number.isInteger(totalTimeoutMs) || totalTimeoutMs < timeoutMs || totalTimeoutMs > 900000) throw new Error("total_timeout_out_of_bounds");
  return { pairs, timeoutMs, totalTimeoutMs, pollMs: 50,
    output: resolve(options["--output"] ?? "docs/evidence/macos-startup-performance-2026-10-07.json"),
    manifest: resolve(options["--manifest"] ?? "docs/evidence/macos-integrity-build-manifest-2026-10-07.json"),
    app: resolve(options["--app"] ?? "target/release/bundle/macos/EastGenesis Desktop.app/Contents/MacOS/eastgenesis-desktop"),
    pilotReport: options["--pilot-report"] ? resolve(options["--pilot-report"]) : null,
    priorReports: options["--prior-reports"] ? options["--prior-reports"].split(",").map((file) => resolve(file)) : [] };
}

export function clockWithinBounds({ observedWallMs, spawnBeforeWallMs, commandSentWallMs, receivedWallMs }) {
  return [observedWallMs, spawnBeforeWallMs, commandSentWallMs, receivedWallMs].every(Number.isFinite)
    && commandSentWallMs >= spawnBeforeWallMs && receivedWallMs >= commandSentWallMs
    && observedWallMs >= commandSentWallMs - 1 && observedWallMs <= receivedWallMs + 1;
}

export function summarizeMetric(samples, phase, metric) {
  const phaseSamples = samples.filter((sample) => sample.phase === phase);
  const values = phaseSamples.filter((sample) => sample.passed)
    .map((sample) => sample.metrics[metric]?.observationUpperBoundMs).filter(Number.isFinite).sort((a, b) => a - b);
  return { attempted: phaseSamples.length, successful: phaseSamples.filter((sample) => sample.passed).length,
    failed: phaseSamples.filter((sample) => !sample.passed).length, validMeasurements: values.length,
    minMs: values[0] ?? null, maxMs: values.at(-1) ?? null,
    meanMs: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null,
    medianMs: values.length ? (values[Math.floor((values.length - 1) / 2)] + values[Math.ceil((values.length - 1) / 2)]) / 2 : null,
    p95Ms: values.length >= 20 ? values[Math.ceil(values.length * 0.95) - 1] : null,
    p95Method: values.length >= 20 ? "nearest_rank_of_20_or_more_successful_samples" : "not_reported_below_20_successful_samples" };
}

async function fixture() {
  const counts = { models: 0, inference: 0, startupProbe: 0, actualTaskSubmit: 0, unclassifiedInference: 0, other: 0 };
  const sockets = new Set();
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/v1/models") {
      req.resume();
      counts.models++;
      res.setHeader("content-type", "application/json");
      // A fresh production profile automatically probes discovered models via
      // chat/completions. An empty discovery response avoids any inference;
      // the QA provider's explicitly injected default model remains available.
      res.end(JSON.stringify({ data: [] }));
    } else {
      if (req.url?.endsWith("/chat/completions") || req.url?.endsWith("/messages")) {
        counts.inference++;
        const chunks = []; let size = 0;
        req.on("data", (chunk) => { size += chunk.length; if (size <= 65536) chunks.push(chunk); });
        req.on("end", () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            if (size <= 65536 && body.max_tokens === 1 && body.stream !== true && body.messages?.length === 1 && body.messages[0].role === "user" && body.messages[0].content === "hi") counts.startupProbe++;
            else counts.actualTaskSubmit++;
          } catch { counts.unclassifiedInference++; }
          res.writeHead(503, { "content-type": "application/json" }).end('{"error":{"message":"startup probe does not execute tasks"}}');
        });
      } else { req.resume(); counts.other++; res.writeHead(503).end(); }
    }
  });
  server.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { counts, base: `http://127.0.0.1:${server.address().port}/v1`, async close() {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  } };
}

async function launchObserver(binary) {
  const child = spawn(binary, [], { detached: true, stdio: ["pipe", "pipe", "ignore"] });
  let current = null;
  let helloResolve, helloReject;
  const hello = new Promise((resolve, reject) => { helloResolve = resolve; helloReject = reject; });
  const helloTimeout = setTimeout(() => helloReject(new Error("observer_handshake_timeout")), 5000);
  createInterface({ input: child.stdout }).on("line", (line) => {
    let event;
    try { event = JSON.parse(line); } catch { current?.reject(new Error("observer_json_protocol")); return; }
    if (event.event === "observer_ready") { clearTimeout(helloTimeout); helloResolve(event); return; }
    if (current && event.token === current.token && event.pid === current.pid) {
      current.onEvent(event, Date.now(), performance.now());
      if (event.event === "completed" || event.event === "failed") current.resolve(event);
    } else current?.reject(new Error("observer_owned_pid_protocol"));
  });
  child.once("error", (error) => { clearTimeout(helloTimeout); helloReject(error); current?.reject(error); });
  child.once("exit", () => { clearTimeout(helloTimeout); helloReject(new Error("observer_early_exit")); current?.reject(new Error("observer_early_exit")); });
  let handshake;
  try { handshake = await hello; } catch (error) { error.observer = child; throw error; }
  if (!handshake.trusted) {
    const error = new Error("ax_permission_unavailable"); error.observer = child; throw error;
  }
  return { child, handshake, observe({ pid, token, timeoutMs, pollMs, onEvent }) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => current?.reject(new Error("observer_sample_watchdog")), timeoutMs + 3000);
      current = { pid, token, onEvent, resolve: (event) => { clearTimeout(timer); current = null; resolve(event); },
        reject: (error) => { clearTimeout(timer); current = null; reject(error); } };
      child.stdin.write(`${JSON.stringify({ command: "observe", pid, token, timeoutMs, pollMs })}\n`);
    });
  } };
}

async function run(options) {
  // Refuse collisions before any report-writing finally block can run.
  if (!options.output.endsWith(".json")) throw new Error("json_output_required");
  if (await exists(options.output) || await exists(options.output.replace(/\.json$/, ".md"))) throw new Error("output_already_exists");
  const report = { schemaVersion: 1, kind: "macos-qa-startup-performance", createdAt: new Date().toISOString(), passed: false,
    options: { pairs: options.pairs, maxSamplesPerPhase: 20, sampleTimeoutMs: options.timeoutMs, totalTimeoutMs: options.totalTimeoutMs, targetPollMs: options.pollMs },
    methodology: { origin: "Node wall+monotonic timestamp immediately before owned binary spawn", eventClock: "Foundation Date Unix milliseconds",
      wallClockComparisonToleranceMs: 1, metricsAre: "readiness observation upper bounds including probe/IPC overhead",
      nodeWallMonotonicComparisonToleranceMs: 5,
      measuredActions: ["owned app activation", "AX observer attachment and bounded tree scans", "input roundtrip for second metric", "route menu and manual submenu expansion for third metric"],
      excludedPreparation: ["Swift compilation and observer startup", "loopback startup", "fresh HOME/Downloads creation", "binding checks"],
      phases: { fresh_profile_first_launch: "first launch with new HOME/appdata and no SQLite/config seeding", initialized_profile_relaunch: "same initialized profile after controlled prior shutdown" },
      osCacheTemperature: "not controlled; phases do not imply cold/warm OS cache", p95MinimumSuccessfulSamples: 20,
      sqliteRole: "only profile initialization metadata, never WebView readiness",
      fixtureModels: "empty discovery response; configured QA default model is tested, automatic discovery success is not tested",
      loadConditions: "normal desktop session, OS/background load uncontrolled; no owned CPU busy loop or resource sampler during formal run",
      deadline: "total budget checked before each app launch; sample observer watchdog adds at most 3s, owned cleanup at most 3s per process" },
    isolation: { provider: "owned synthetic QA loopback", inheritedKeyEnvironment: false, privateConfigurationRead: false, submitActionsIssued: 0, modelSelectionActionsIssued: 0 },
    samples: [], evidenceBoundary: { excluded: ["real Provider", "resource usage", "cold/warm OS caches", "production signed build", "Windows/Linux startup", "all user profiles", "successful catalog discovery/probing", "multi-model catalog scale impact"] } };
  let observer, runtimeDir, f;
  const startedMono = performance.now();
  const observerSource = resolve("tools/desktop-macos-ready-observer.swift");
  const harness = fileURLToPath(import.meta.url);
  const sourceSnapshot = async (files) => Object.fromEntries(await Promise.all(files.map(async (file) => [file, await hash(file)])));
  const persist = async () => {
    report.isolation.automaticRoutingResetActionsIssued = report.samples.reduce((sum, sample) => sum + sample.automaticRoutingResetActionsIssued, 0);
    report.summary = Object.fromEntries(PHASES.map((phase) => [phase, Object.fromEntries(METRICS.map((metric) => [metric, summarizeMetric(report.samples, phase, metric)]))]));
    const observationFields = ["observerAttachDelayMs", "inputRoundtripAfterBasicMs", "routeProbeAfterInputMs", "maxObservationGapMs", "maxScanDurationMs", "meanScanDurationMs"];
    report.observationSummary = Object.fromEntries(PHASES.map((phase) => [phase, Object.fromEntries(observationFields.map((field) => [field,
      summarizeMetric(report.samples.map((sample) => ({ ...sample, metrics: { value: { observationUpperBoundMs: sample[field] ?? sample.scan?.[field] } } })), phase, "value")]))]));
    report.summaryPopulation = "only fully successful samples; every unsuccessful sample is retained with its failure reason";
    await mkdir(dirname(options.output), { recursive: true });
    await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`);
    const display = (n) => Number.isFinite(n) ? n.toFixed(3) : "missing";
    const rows = PHASES.flatMap((phase) => METRICS.map((metric) => {
      const s = report.summary[phase][metric];
      return `| ${phase} | ${metric} | ${s.successful}/${s.attempted} | ${display(s.minMs)} | ${display(s.medianMs)} | ${display(s.maxMs)} | ${s.p95Ms === null ? "not reported" : display(s.p95Ms)} |`;
    })).join("\n");
    const observationRows = PHASES.flatMap((phase) => observationFields.map((field) => {
      const s = report.observationSummary[phase][field];
      return `| ${phase} | ${field} | ${display(s.medianMs)} | ${display(s.maxMs)} |`;
    })).join("\n");
    const history = [];
    const collectHistory = (r) => { for (const old of r.priorRuns ?? []) { collectHistory(old.report); history.push(old.report); } };
    if (report.pilot) { collectHistory(report.pilot.report); history.push(report.pilot.report); } else collectHistory(report);
    const historyRows = history.map((r) => `| ${r.createdAt} | ${r.passed} | ${r.samples.length} | ${r.fixtureRequestCounts?.inference ?? "missing"} | ${r.failedStage ?? "none"} |`).join("\n");
    await writeFile(options.output.replace(/\.json$/, ".md"), `# macOS QA startup readiness observations

Created: ${report.createdAt}. Finished: ${report.finishedAt ?? "in progress"}. Passed: **${report.passed}**. Failed stage: ${report.failedStage ?? "none"}. Platform: ${report.platform?.osVersion ?? "unavailable"} / ${report.platform?.architecture ?? "unavailable"}.

Binary SHA-256: \`${report.binding?.binaryStartSha256 ?? "unavailable"}\`. Compiled 25-file manifest SHA-256: \`${report.binding?.compiledManifestSha256 ?? "unavailable"}\`. Harness SHA-256: \`${report.binding?.harnessStartSha256 ?? "unavailable"}\`. Swift observer source SHA-256: \`${report.binding?.observerSourceStartSha256 ?? "unavailable"}\`. Worktree QA build; no signing/release qualification claimed. Start/end hashes bind the binary, 25 production sources, manifest, observer and cleanup helper. A changed binary/source aborts further launches and makes the report fail.

The fresh-profile phase uses new HOME/appdata without database or settings seeding. Relaunch uses that same initialized profile after controlled shutdown. OS caches were not controlled. SQLite file existence is only profile metadata. Readiness comes from the owned PID's WebView AX controls, with no substitute metric when a condition is missing.

Node stamps wall and monotonic clocks immediately before binary spawn. A prestarted persistent Swift observer stamps each event using Foundation Date. Its timestamps must lie between Node command send and event receipt (1 ms wall-clock rounding tolerance); Node wall/monotonic elapsed must agree within 5 ms. The reported upper bound is the larger of Foundation elapsed plus 1 ms and Node monotonic receipt elapsed. Polling targets 50 ms, but actual scan/observation gaps determine resolution. The basic-ready event also records its scan interval and previous scan completion; tree scans that exceed the bounded traversal are incomplete and cannot establish Splash absence. No strict 100 ms cadence is claimed.

| Phase | Metric | Successful/attempted | Min ms | Median ms | Max ms | p95 ms |
| --- | --- | --- | --- | --- | --- | --- |
${rows}

The earliest basic-ready observation requires the owned active window, Splash absent, WebView present, visible enabled input and visible enabled route control. The second metric adds synthetic draft write/readback and actual submit-enabled verification. The third adds route/manual menu expansion and verifies visible QA provider plus visible enabled QA default model. These menu actions are extra interaction verification, not pure startup time. No submit/model-selection action is issued. The enabled automatic-mode menu item is then pressed to reset routing/close menus, the draft is cleared and submit disabled again before controlled owned-group termination. The reset action is observed directly; the trigger's internal mode text is not available as an AX static-text readback. Actual automaticRoutingResetActionsIssued: **${report.isolation.automaticRoutingResetActionsIssued}**; modelSelectionActionsIssued and submitActionsIssued remain **0**.

| Phase | Observation or extra action | Median ms | Maximum ms |
| --- | --- | --- | --- |
${observationRows}

Swift compilation/observer startup, fixture startup, profile directory creation and binding checks occur outside each app launch clock. Owned app activation, observer attachment, actual scans and the named interaction probes occur inside that clock. The total run budget is ${options.totalTimeoutMs} ms with ${options.timeoutMs} ms per observation, at most 20 samples per phase per run; bounded observer watchdog/cleanup can add at most 3 seconds each. All successful/failed samples are retained. Summary values use fully successful samples; p95 uses nearest rank and is omitted below 20 successful measurements. n1 pilots are never used for p95.

The synthetic fixture returns an empty /models directory to prevent production startup's automatic max_tokens=1 model probe. This tests a single explicitly configured QA default model. It excludes successful catalog discovery/probing and multi-model catalog scale effects; it is not a startup baseline for real multi-model users. Actual fixture request counts: \`${JSON.stringify(report.fixtureRequestCounts ?? {})}\`; any inference endpoint request makes the run fail. No owned CPU busy loop or resource sampler runs during formal measurement; ordinary desktop/OS background load remains uncontrolled.

Earlier pilot runs are embedded verbatim with SHA-256 bindings in JSON, including failures. The first failed pilot's one inference request is attributed to the production startup probe by source code and absence of any AX input/basic-ready event; its old fixture did not capture request-body classification, so that distinction is explicitly an inference. Later fixtures count startup probes versus task-like submissions from bounded request-body shape without persisting bodies.

| Prior run created | Passed | Retained samples | Inference requests | Failure |
| --- | --- | --- | --- | --- |
${historyRows || "| none | — | — | — | — |"}

Excluded: real Provider and remote billing, resource usage (including WK XPC processes), OS-cache cold/warm claims, signed production/release readiness, other platforms, arbitrary user profiles, successful catalog discovery/probing and model-scale impact.
`);
  };
  try {
    if (process.platform !== "darwin") throw new Error("macos_required");
    const manifestBytes = await readFile(options.manifest);
    const manifest = JSON.parse(manifestBytes);
    const files = Object.keys(manifest.sourceHashes ?? {});
    if (!manifest.buildPassed || !manifest.sourceHashesBeforeAfterMatch || files.length !== 25) throw new Error("frozen_25_source_manifest_required");
    report.binding = { binaryStartSha256: await hash(options.app), expectedBinarySha256: manifest.binarySha256,
      compiledManifestSha256: hashBytes(manifestBytes), sourceHashesStart: await sourceSnapshot(files),
      harnessStartSha256: await hash(harness), observerSourceStartSha256: await hash(observerSource), cleanupHelperStartSha256: await hash(new URL("./desktop-process-cleanup.mjs", import.meta.url)) };
    if (report.binding.binaryStartSha256 !== manifest.binarySha256 || !files.every((file) => report.binding.sourceHashesStart[file] === manifest.sourceHashes[file])) throw new Error("frozen_build_binding_mismatch");
    if (options.pairs > 1 && !options.pilotReport) throw new Error("successful_n1_pilot_required");
    report.priorRuns = [];
    for (const file of options.priorReports) {
      const bytes = await readFile(file);
      const prior = JSON.parse(bytes);
      if (prior.kind !== report.kind || !Array.isArray(prior.samples)) throw new Error("invalid_prior_report");
      report.priorRuns.push({ sha256: hashBytes(bytes), report: prior,
        interpretation: prior.fixtureRequestCounts?.inference && prior.fixtureRequestCounts.startupProbe === undefined ? {
          startupProbeCount: prior.fixtureRequestCounts.inference, actualTaskSubmitCount: 0,
          classification: "inferred from settings.load automatic model probing and all AX basic/input stages false; original fixture did not capture request bodies",
          limitation: "request-body validated classification unavailable in this historical failed pilot" } : null });
    }
    if (options.pilotReport) {
      const bytes = await readFile(options.pilotReport);
      report.pilot = { sha256: hashBytes(bytes), report: JSON.parse(bytes) };
      if (!report.pilot.report.passed || report.pilot.report.options.pairs !== 1) throw new Error("successful_n1_pilot_required");
      if (report.pilot.report.binding.harnessStartSha256 !== report.binding.harnessStartSha256 || report.pilot.report.binding.observerSourceStartSha256 !== report.binding.observerSourceStartSha256) throw new Error("pilot_harness_changed_before_formal_run");
    }
    runtimeDir = await mkdtemp(join(tmpdir(), "eg-startup-probe-"));
    const observerBinary = join(runtimeDir, "ready-observer");
    try { await exec("xcrun", ["swiftc", observerSource, "-o", observerBinary], { timeout: Math.min(60000, options.totalTimeoutMs) }); }
    catch (error) {
      report.compilerFailure = { code: typeof error.code === "number" ? error.code : "unavailable", timedOut: error.killed === true,
        diagnostics: String(error.stderr ?? "").replaceAll(observerSource, "desktop-macos-ready-observer.swift").replaceAll(runtimeDir, "owned-observer-temp").slice(0, 3000) };
      throw new Error("swift_observer_compile_failed");
    }
    report.binding.observerBinarySha256 = await hash(observerBinary);
    observer = await launchObserver(observerBinary);
    report.observer = { persistent: true, prestartedOutsideAppTiming: true, directAxTrusted: true };
    f = await fixture();
    report.platform = { osVersion: (await exec("sw_vers", ["-productVersion"])).stdout.trim(), architecture: process.arch };
    for (let pair = 1; pair <= options.pairs; pair++) {
      let fatalBindingFailure = false;
      const home = await mkdtemp(join(tmpdir(), "eg-startup-profile-"));
      await mkdir(join(home, "Downloads"));
      const profileDir = join(home, "Library/Application Support/com.eastgenesis.desktop");
      const db = join(profileDir, "eastgenesis.db");
      try {
        for (const phase of PHASES) {
          const sample = { pair, phase, passed: false, automaticRoutingResetActionsIssued: 0, metrics: {}, events: [], profile: { existedBeforeSpawn: await exists(profileDir), sqliteExistedBeforeSpawn: await exists(db) } };
          report.samples.push(sample);
          let app;
          try {
            if (options.totalTimeoutMs - (performance.now() - startedMono) < 1000) throw new Error("total_deadline");
            if (phase === PHASES[0] && sample.profile.existedBeforeSpawn) throw new Error("fresh_profile_not_fresh");
            if (phase === PHASES[1] && !sample.profile.sqliteExistedBeforeSpawn) throw new Error("initialized_profile_missing");
            const before = await sourceSnapshot(files);
            if (!files.every((file) => before[file] === manifest.sourceHashes[file])) throw new Error("source_changed_during_run");
            if (await hash(options.app) !== manifest.binarySha256) throw new Error("binary_changed_during_run");
            const env = { HOME: home, PATH: process.env.PATH, TMPDIR: tmpdir(), LANG: "en_US.UTF-8", EASTGENESIS_QA_ISOLATED_PROFILE: "1",
              EASTGENESIS_QA_PROVIDER_BASE_URL: f.base, EASTGENESIS_QA_PROVIDER_MODEL: "gpt-5.6-luna", EASTGENESIS_QA_PROVIDER_PROTOCOL: "openai" };
            const spawnBeforeWallMs = Date.now(), spawnBeforeMonoMs = performance.now();
            app = spawn(options.app, [], { env, detached: true, stdio: "ignore" });
            await new Promise((resolve, reject) => { app.once("spawn", resolve); app.once("error", reject); });
            const commandSentWallMs = Date.now();
            sample.spawn = { spawnCallToObserverCommandMs: performance.now() - spawnBeforeMonoMs, directlyOwnedChild: true };
            const remainingMs = Math.floor(options.totalTimeoutMs - (performance.now() - startedMono));
            if (remainingMs < 1000) throw new Error("total_deadline");
            const terminal = await observer.observe({ pid: app.pid, token: `${pair}-${phase}`, timeoutMs: Math.min(options.timeoutMs, remainingMs), pollMs: options.pollMs,
              onEvent(event, receivedWallMs, receivedMonoMs) {
                const { pid, token, ...safeEvent } = event;
                const nodeElapsedMs = receivedMonoMs - spawnBeforeMonoMs;
                const nodeWallMonotonicDeltaMs = (receivedWallMs - spawnBeforeWallMs) - nodeElapsedMs;
                const clockValidated = clockWithinBounds({ observedWallMs: event.wallTimeMs, spawnBeforeWallMs, commandSentWallMs, receivedWallMs }) && Math.abs(nodeWallMonotonicDeltaMs) <= 5;
                sample.events.push({ ...safeEvent, receivedWallMs, nodeElapsedMs, nodeWallMonotonicDeltaMs, clockValidated, ownedPidMatched: pid === app.pid });
                if (event.event === "automatic_routing_reset_action") sample.automaticRoutingResetActionsIssued += event.automaticRoutingResetActionsIssued;
                if (event.event === "attached") sample.observerAttachDelayMs = event.wallTimeMs - spawnBeforeWallMs;
                if (METRICS.includes(event.event)) sample.metrics[event.event] = { observationUpperBoundMs: Math.max(event.wallTimeMs - spawnBeforeWallMs + 1, nodeElapsedMs),
                  nodeReceiptUpperBoundMs: nodeElapsedMs, foundationElapsedMs: event.wallTimeMs - spawnBeforeWallMs,
                  readinessObservationIntervalMs: event.wallTimeMs - event.previousScanCompletedWallMs, clockValidated };
              } });
            sample.scan = { targetPollMs: terminal.targetPollMs, maxObservationGapMs: terminal.maxObservationGapMs, maxScanDurationMs: terminal.maxScanDurationMs,
              meanScanDurationMs: terminal.meanScanDurationMs, scanCount: terminal.scanCount, incompleteScanCount: terminal.incompleteScanCount };
            sample.conditions = terminal.conditions;
            sample.profile.sqliteExistsAfterObservation = await exists(db);
            sample.profile.providerConfigNotPersisted = !await exists(join(profileDir, "providers.json"));
            sample.passed = terminal.event === "completed" && sample.events.every((event) => event.clockValidated)
              && METRICS.every((metric) => sample.metrics[metric]?.clockValidated) && !hasProcessExited(app) && f.counts.inference === 0;
            if (!sample.passed) sample.failedStage = terminal.failedStage || "readiness_clock_or_inference_failed";
            if (sample.metrics[METRICS[0]] && sample.metrics[METRICS[1]]) sample.inputRoundtripAfterBasicMs = sample.metrics[METRICS[1]].foundationElapsedMs - sample.metrics[METRICS[0]].foundationElapsedMs;
            if (sample.metrics[METRICS[1]] && sample.metrics[METRICS[2]]) sample.routeProbeAfterInputMs = sample.metrics[METRICS[2]].foundationElapsedMs - sample.metrics[METRICS[1]].foundationElapsedMs;
          } catch (error) { sample.failedStage = error.message; fatalBindingFailure = ["source_changed_during_run", "binary_changed_during_run"].includes(error.message); }
          finally {
            if (app?.pid) {
              if (hasProcessExited(app)) { sample.passed = false; sample.failedStage ??= "owned_app_early_exit"; }
              try { sample.cleanup = await stopDetachedProcess(app, { graceMs: 1000, killMs: 2000 }); }
              catch (error) { sample.passed = false; sample.cleanupFailedStage = error.stage ?? "owned_app_cleanup"; }
            }
            await persist();
            console.log(JSON.stringify({ pair, phase, passed: sample.passed, failedStage: sample.failedStage ?? null, basicReadyMs: sample.metrics.startup_basic_ready?.observationUpperBoundMs ?? null }));
          }
          if (fatalBindingFailure) break;
        }
      } finally { await rm(home, { recursive: true, force: true }); }
      if (fatalBindingFailure || performance.now() - startedMono >= options.totalTimeoutMs) break;
    }
    report.binding.sourceHashesEnd = await sourceSnapshot(files);
    report.binding.binaryEndSha256 = await hash(options.app);
    report.binding.harnessEndSha256 = await hash(harness);
    report.binding.observerSourceEndSha256 = await hash(observerSource);
    report.binding.cleanupHelperEndSha256 = await hash(new URL("./desktop-process-cleanup.mjs", import.meta.url));
    report.binding.manifestUnchanged = await hash(options.manifest) === report.binding.compiledManifestSha256;
    report.binding.frozenSourceUnchanged = files.every((file) => report.binding.sourceHashesStart[file] === report.binding.sourceHashesEnd[file]);
    report.binding.binaryUnchanged = report.binding.binaryStartSha256 === report.binding.binaryEndSha256;
    report.binding.harnessUnchanged = report.binding.harnessStartSha256 === report.binding.harnessEndSha256 && report.binding.observerSourceStartSha256 === report.binding.observerSourceEndSha256 && report.binding.cleanupHelperStartSha256 === report.binding.cleanupHelperEndSha256;
    report.passed = report.samples.length === options.pairs * 2 && report.samples.every((sample) => sample.passed)
      && report.binding.frozenSourceUnchanged && report.binding.binaryUnchanged && report.binding.harnessUnchanged && report.binding.manifestUnchanged && f.counts.inference === 0;
    if (!report.passed) report.failedStage = "samples_or_frozen_binding_failed";
  } catch (error) {
    report.failedStage = error.message;
    if (error.observer) observer = { child: error.observer };
  } finally {
    if (observer?.child?.pid) {
      try { report.observerCleanup = await stopDetachedProcess(observer.child, { graceMs: 1000, killMs: 2000 }); }
      catch (error) { report.passed = false; report.observerCleanupFailedStage = error.stage ?? "observer_cleanup"; }
    }
    if (f) { report.fixtureRequestCounts = { ...f.counts }; await f.close(); }
    if (runtimeDir) await rm(runtimeDir, { recursive: true, force: true });
    report.finishedAt = new Date().toISOString();
    report.totalElapsedMs = performance.now() - startedMono;
    await persist();
    console.log(JSON.stringify({ passed: report.passed, attempted: report.samples.length, failedStage: report.failedStage ?? null, fixtureRequestCounts: report.fixtureRequestCounts ?? null }));
  }
  return report.passed;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { if (!await run(parseOptions(process.argv.slice(2)))) process.exitCode = 1; }
  catch (error) { console.log(JSON.stringify({ passed: false, failedStage: error.message })); process.exitCode = 1; }
}

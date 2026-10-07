// @vitest-environment node
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { measureFirstBodyDelta, measureTerminalObservation } from "../tools/desktop-stream-measurement.mjs";

const summary = resolve(process.cwd(), "tools/desktop-webdriver-summary.mjs");

function smoke(scenario: string, extra: Record<string, unknown> = {}) {
  const required = scenario === "truncated"
    ? { partialOutputPreserved: true, terminalFailureVisible: true, firstOutputLatencyMs: 65, firstBodyDeltaMeasurement: measureFirstBodyDelta("1065", 1000, 1100) }
    : scenario === "idle-cancel"
      ? { cancelControl: true, cancelledResult: true }
      : { streamingFirstChunk: true, completedResult: true, firstChunkLatencyMs: scenario === "slow-first-token" ? 310 : 120, firstBodyDeltaMeasurement: measureFirstBodyDelta(scenario === "slow-first-token" ? "1310" : "1120", 1000, 1400) };
  return {
    schemaVersion: 1,
    kind: "desktop-webdriver-smoke",
    passed: true,
    checks: {
      fixtureScenario: scenario,
      nativeWebDriverSession: true,
      documentTitle: true,
      taskInput: true,
      routePreview: true,
      submitState: true,
      ...required,
      terminalObservedMeasurement: measureTerminalObservation(1000, 1440),
      terminalObservedLatencyMs: 440,
      ...extra,
    },
    evidenceBoundary: { proven: ["native WebDriver session"], excluded: ["real Provider"] },
  };
}

describe("desktop WebDriver evidence summary", () => {
  it("keeps four functional scenarios while reporting separate descriptive timing samples", () => {
    const root = mkdtempSync(join(tmpdir(), "eastgenesis-webdriver-summary-"));
    const files = ["staged", "slow-first-token", "truncated", "idle-cancel"].map((scenario) => {
      const file = join(root, `${scenario}.json`);
      writeFileSync(file, `${JSON.stringify(smoke(scenario))}\n`, "utf8");
      return file;
    });
    try {
      const output = join(root, "summary.json");
      expect(execFileSync(process.execPath, [summary, "--output", output, ...files], { encoding: "utf8" })).toBe("");
      const report = JSON.parse(readFileSync(output, "utf8"));
      expect(report).toMatchObject({ schemaVersion: 1, kind: "desktop-webdriver-suite", passed: true });
      expect(report.scenarios).toHaveLength(4);
      expect(report.timing.combinedScenarioPercentiles).toBe(false);
      expect(report.timing.firstChunk).toBeUndefined();
      expect(report.timing.firstOutput).toBeUndefined();
      expect(report.timing.byScenario).toHaveLength(4);
      expect(report.timing.byScenario[0]).toMatchObject({ scenario: "staged", firstBodyDelta: { samplesMs: [120], sampleCount: 1, p50Ms: null, p95Ms: null, interpretation: "descriptive_sample", performanceBaseline: false } });
      expect(report.timing.byScenario[1]).toMatchObject({ scenario: "slow-first-token", firstBodyDelta: { samplesMs: [310], sampleCount: 1, p50Ms: null, p95Ms: null } });
      expect(report.timing.byScenario[2]).toMatchObject({ scenario: "truncated", firstBodyDelta: { samplesMs: [65] }, terminalObserved: { samplesMs: [440] } });
      expect(report.timing.byScenario[0].nativeStreamIpc).toMatchObject({ status: "not_recorded", reason: "observer_missing", performanceBaseline: false, channels: [] });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("marks historical timings without sources as legacy_unverified without failing old functional evidence", () => {
    const root = mkdtempSync(join(tmpdir(), "eastgenesis-webdriver-summary-legacy-"));
    try {
      const files = ["staged", "slow-first-token", "truncated", "idle-cancel"].map((scenario) => {
        const value = smoke(scenario);
        const checks = value.checks as Record<string, unknown>;
        delete checks.firstBodyDeltaMeasurement;
        delete checks.terminalObservedMeasurement;
        delete checks.terminalObservedLatencyMs;
        // This is the old truncated metric taken after the failure terminal.
        if (scenario === "truncated") checks.firstOutputLatencyMs = 440;
        const file = join(root, `${scenario}.json`);
        writeFileSync(file, JSON.stringify(value));
        return file;
      });
      const report = JSON.parse(execFileSync(process.execPath, [summary, ...files], { encoding: "utf8" }));
      expect(report.passed).toBe(true);
      expect(report.scenarios[2].measurements.firstBodyDelta).toMatchObject({ status: "legacy_unverified", source: "legacy_source_missing", origin: "unknown", legacyReportedLatencyMs: 440 });
      expect(report.timing.byScenario.every((row: { firstBodyDelta: { sampleCount: number } }) => row.firstBodyDelta.sampleCount === 0)).toBe(true);
      expect(report.timing.byScenario[2].firstBodyDelta).toMatchObject({ samplesMs: [], p50Ms: null, p95Ms: null, interpretation: "no_verified_samples" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("excludes missing or malformed timing provenance while preserving functional pass and redaction", () => {
    const root = mkdtempSync(join(tmpdir(), "eastgenesis-webdriver-summary-timing-"));
    try {
      const privateValue = "https://synthetic-private-provider.invalid/private-key";
      const files = ["staged", "slow-first-token", "truncated", "idle-cancel"].map((scenario) => {
        const extra = scenario === "staged"
          ? { firstBodyDeltaMeasurement: measureFirstBodyDelta(null, 1000, 1440), firstChunkLatencyMs: undefined,
            nativeIpcTimingMeasurement: { source: "tauri_debug_callback_map_arrival", origin: "before_webdriver_click_command", performanceBaseline: false, status: "verified", privatePayload: privateValue, channels: [{ ordinal: 1, status: "verified", headersLatencyMs: 10, firstBodyBytesLatencyMs: 20, transportTerminalLatencyMs: 30, transportTerminalKind: "done", privatePayload: privateValue }] } }
          : scenario === "truncated"
            ? { firstBodyDeltaMeasurement: { status: "verified", source: privateValue, origin: privateValue, latencyMs: 65 }, terminalObservedMeasurement: { status: "verified", source: privateValue, latencyMs: 440 } }
            : {};
        const file = join(root, `${scenario}.json`);
        writeFileSync(file, JSON.stringify(smoke(scenario, extra)));
        return file;
      });
      const serialized = execFileSync(process.execPath, [summary, ...files], { encoding: "utf8" });
      const report = JSON.parse(serialized);
      expect(report.passed).toBe(true);
      expect(report.scenarios[0].measurements.firstBodyDelta).toMatchObject({ status: "unverified", reason: "marker_missing" });
      expect(report.scenarios[2].measurements.firstBodyDelta).toMatchObject({ status: "unverified", reason: "measurement_metadata" });
      expect(report.timing.byScenario[0].firstBodyDelta.sampleCount).toBe(0);
      expect(report.timing.byScenario[2].firstBodyDelta.sampleCount).toBe(0);
      expect(report.timing.byScenario[2].terminalObserved.sampleCount).toBe(0);
      expect(report.timing.byScenario[0].nativeStreamIpc).toMatchObject({ status: "verified", channels: [{ ordinal: 1, headersLatencyMs: 10, firstBodyBytesLatencyMs: 20, transportTerminalLatencyMs: 30, transportTerminalKind: "done" }] });
      expect(serialized).not.toContain(privateValue);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed without echoing a sensitive input filename", () => {
    const root = mkdtempSync(join(tmpdir(), "eastgenesis-webdriver-summary-invalid-"));
    const secret = "provider-key-sk-secret.json";
    const file = join(root, secret);
    try {
      writeFileSync(file, "not-json\n", "utf8");
      const result = spawnSync(process.execPath, [summary, file], { encoding: "utf8" });
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({ passed: false, errors: expect.any(Array) });
      expect(result.stdout).not.toContain(secret);
      expect(result.stdout).toContain("输入文件 1");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

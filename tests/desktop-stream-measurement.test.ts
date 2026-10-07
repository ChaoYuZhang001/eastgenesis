// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  BODY_DELTA_METRIC, BODY_DELTA_SOURCE, TERMINAL_METRIC, TERMINAL_SOURCE,
  measureFirstBodyDelta, bodyDeltaReadFailure, measureTerminalObservation,
  normalizeReportedMeasurement, describeLatencySamples,
} from "../tools/desktop-stream-measurement.mjs";

describe("native WebDriver timing provenance", () => {
  it("measures the task-store delta separately from later terminal observation", () => {
    const body = measureFirstBodyDelta("1120", 1000, 1440);
    const terminal = measureTerminalObservation(1000, 1440);
    expect(body).toMatchObject({ status: "verified", origin: "before_webdriver_click_command", metric: BODY_DELTA_METRIC, source: BODY_DELTA_SOURCE, latencyMs: 120 });
    expect(terminal).toMatchObject({ status: "verified", metric: TERMINAL_METRIC, source: TERMINAL_SOURCE, latencyMs: 440 });
  });

  it("never replaces missing, malformed, old or future markers with observation time", () => {
    for (const value of [null, undefined, ""]) expect(measureFirstBodyDelta(value, 1000, 1440)).toMatchObject({ status: "unverified", reason: "marker_missing" });
    for (const value of [0, 1120, "0", "-1", "NaN", "Infinity", "1e3", " 1120 ", "1120.5", "99999999999999999999999"]) {
      const result = measureFirstBodyDelta(value, 1000, 1440);
      expect(result).toMatchObject({ status: "unverified", reason: "marker_invalid" });
      expect(result.latencyMs).toBeUndefined();
    }
    expect(measureFirstBodyDelta("999", 1000, 1440)).toMatchObject({ status: "unverified", reason: "marker_before_origin" });
    expect(measureFirstBodyDelta("1441", 1000, 1440)).toMatchObject({ status: "unverified", reason: "marker_after_observation" });
    expect(bodyDeltaReadFailure()).toMatchObject({ status: "unverified", reason: "marker_read_failed" });
  });

  it("rejects invalid clock bounds and allows a genuine zero latency", () => {
    for (const [start, end] of [[NaN, 1440], [1000, Infinity], [-1, 1440], [1440, 1000], [1000.5, 1440]]) {
      expect(measureFirstBodyDelta("1120", start, end)).toMatchObject({ status: "unverified", reason: "invalid_clock" });
      expect(measureTerminalObservation(start, end)).toMatchObject({ status: "unverified", reason: "invalid_clock" });
    }
    expect(measureFirstBodyDelta("1000", 1000, 1000).latencyMs).toBe(0);
  });

  it("requires fixed metadata and matching legacy numeric fields before counting a new sample", () => {
    const valid = measureFirstBodyDelta("1120", 1000, 1440);
    expect(normalizeReportedMeasurement(valid, BODY_DELTA_METRIC, BODY_DELTA_SOURCE, 120)).toEqual(valid);
    for (const patch of [{ source: "untrusted" }, { origin: "after_terminal" }, { metric: TERMINAL_METRIC }, { latencyMs: -1 }, { latencyMs: Infinity }, { latencyMs: 1.5 }, { status: "unknown" }]) {
      expect(normalizeReportedMeasurement({ ...valid, ...patch }, BODY_DELTA_METRIC, BODY_DELTA_SOURCE)).toMatchObject({ status: "unverified", reason: "measurement_metadata" });
    }
    expect(normalizeReportedMeasurement(valid, BODY_DELTA_METRIC, BODY_DELTA_SOURCE, 440)).toMatchObject({ status: "unverified", reason: "measurement_metadata" });
    expect(normalizeReportedMeasurement(undefined, BODY_DELTA_METRIC, BODY_DELTA_SOURCE, 440)).toMatchObject({ status: "legacy_unverified", legacyReportedLatencyMs: 440 });
  });

  it("does not calculate percentiles for one verified sample or include unverified values", () => {
    const verified = measureFirstBodyDelta("1120", 1000, 1440);
    const legacy = normalizeReportedMeasurement(undefined, BODY_DELTA_METRIC, BODY_DELTA_SOURCE, 9999);
    expect(describeLatencySamples([verified, legacy, bodyDeltaReadFailure()])).toMatchObject({ samplesMs: [120], sampleCount: 1, excludedCount: 2, p50Ms: null, p95Ms: null, percentileMethod: "not_applicable", interpretation: "descriptive_sample", performanceBaseline: false });
    expect(describeLatencySamples([legacy])).toMatchObject({ sampleCount: 0, minMs: null, maxMs: null, p50Ms: null, p95Ms: null, interpretation: "no_verified_samples" });
  });

  it("uses nearest rank only within a supplied homogeneous sample group", () => {
    const group = Array.from({ length: 20 }, (_, i) => measureFirstBodyDelta(String(1010 + i * 10), 1000, 1440));
    expect(describeLatencySamples(group)).toMatchObject({ sampleCount: 20, minMs: 10, maxMs: 200, p50Ms: 100, p95Ms: 190, percentileMethod: "nearest-rank", performanceBaseline: false });
  });
});

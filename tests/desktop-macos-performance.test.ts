// @vitest-environment node
import { describe, expect, it } from "vitest";
import { clockWithinBounds, parseOptions, summarizeMetric } from "../tools/desktop-macos-performance-smoke.mjs";

describe("macOS startup measurement evidence contracts", () => {
  it("bounds the requested sample count and each observation budget", () => {
    expect(parseOptions(["--pairs=20", "--timeout-ms=30000", "--total-timeout-ms=900000"]))
      .toMatchObject({ pairs: 20, timeoutMs: 30000, totalTimeoutMs: 900000, pollMs: 50 });
    for (const args of [["--pairs=21"], ["--pairs=0"], ["--pairs=1.5"], ["--timeout-ms=30001"], ["--timeout-ms=999"], ["--total-timeout-ms=900001"], ["--timeout-ms=15000", "--total-timeout-ms=14999"]]) {
      expect(() => parseOptions(args)).toThrow();
    }
  });

  it("refuses unknown, ambiguous and duplicate CLI arguments", () => {
    for (const args of [["--pairs", "20"], ["--pairs=1", "--pairs=2"], ["--unsafe-provider=1"]]) {
      expect(() => parseOptions(args)).toThrow();
    }
  });

  it("accepts Foundation timestamps only within the actual Node operation bounds", () => {
    const bounds = { spawnBeforeWallMs: 1000, commandSentWallMs: 1005, receivedWallMs: 1050 };
    expect(clockWithinBounds({ ...bounds, observedWallMs: 1004 })).toBe(true);
    expect(clockWithinBounds({ ...bounds, observedWallMs: 1051 })).toBe(true);
    expect(clockWithinBounds({ ...bounds, observedWallMs: 1003.9 })).toBe(false);
    expect(clockWithinBounds({ ...bounds, observedWallMs: 1051.1 })).toBe(false);
    expect(clockWithinBounds({ ...bounds, observedWallMs: NaN })).toBe(false);
    expect(clockWithinBounds({ ...bounds, commandSentWallMs: 999, observedWallMs: 1010 })).toBe(false);
    expect(clockWithinBounds({ ...bounds, receivedWallMs: 1004, observedWallMs: 1005 })).toBe(false);
  });

  it("preserves failure denominators and does not publish a p95 from the n1 pilot", () => {
    const samples = [
      { phase: "fresh", passed: true, metrics: { ready: { observationUpperBoundMs: 123 } } },
      { phase: "fresh", passed: false, metrics: { ready: { observationUpperBoundMs: 1 } } },
      { phase: "relaunch", passed: true, metrics: { ready: { observationUpperBoundMs: 9 } } },
    ];
    expect(summarizeMetric(samples, "fresh", "ready")).toMatchObject({ attempted: 2, successful: 1, failed: 1, validMeasurements: 1, medianMs: 123, p95Ms: null });
  });

  it("requires 20 valid successful measurements for the reported percentile", () => {
    const samples = Array.from({ length: 20 }, (_, i) => ({ phase: "fresh", passed: true, metrics: { ready: { observationUpperBoundMs: i + 1 } } }));
    expect(summarizeMetric(samples.slice(0, 19), "fresh", "ready").p95Ms).toBeNull();
    expect(summarizeMetric(samples, "fresh", "ready")).toMatchObject({ validMeasurements: 20, medianMs: 10.5, p95Ms: 19 });
    samples[0].metrics.ready.observationUpperBoundMs = NaN;
    expect(summarizeMetric(samples, "fresh", "ready")).toMatchObject({ successful: 20, validMeasurements: 19, p95Ms: null });
  });
});

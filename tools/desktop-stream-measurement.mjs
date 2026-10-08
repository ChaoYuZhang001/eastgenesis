// Timing vocabulary shared by the native smoke and its redacted summary.
// A task-store delta timestamp is not a first paint or a model's first token.
export const MEASUREMENT_ORIGIN = "before_webdriver_click_command";
export const BODY_DELTA_METRIC = "submit_command_to_task_store_first_body_delta";
export const BODY_DELTA_SOURCE = "dom_data_stream_first_chunk_at";
export const TERMINAL_METRIC = "submit_command_to_terminal_text_observed";
export const TERMINAL_SOURCE = "webdriver_terminal_text_observed";

const reasons = new Set(["marker_missing", "marker_invalid", "marker_read_failed", "marker_before_origin", "marker_after_observation", "invalid_clock", "measurement_metadata"]);
const timestamp = (value) => Number.isSafeInteger(value) && value > 0;
const latency = (value) => Number.isSafeInteger(value) && value >= 0;
const unverified = (metric, source, reason) => ({ status: "unverified", metric, source, origin: MEASUREMENT_ORIGIN, reason });

export function measureFirstBodyDelta(rawAttribute, submittedAt, observedAt) {
  if (!timestamp(submittedAt) || !timestamp(observedAt) || observedAt < submittedAt) return unverified(BODY_DELTA_METRIC, BODY_DELTA_SOURCE, "invalid_clock");
  if (rawAttribute === null || rawAttribute === undefined || rawAttribute === "") return unverified(BODY_DELTA_METRIC, BODY_DELTA_SOURCE, "marker_missing");
  // DOM attributes are canonical integer strings. Never let Number(null),
  // whitespace, exponent syntax or a negative value invent a timestamp.
  if (typeof rawAttribute !== "string" || !/^[1-9]\d*$/.test(rawAttribute)) return unverified(BODY_DELTA_METRIC, BODY_DELTA_SOURCE, "marker_invalid");
  const firstDeltaAt = Number(rawAttribute);
  if (!timestamp(firstDeltaAt)) return unverified(BODY_DELTA_METRIC, BODY_DELTA_SOURCE, "marker_invalid");
  if (firstDeltaAt < submittedAt) return unverified(BODY_DELTA_METRIC, BODY_DELTA_SOURCE, "marker_before_origin");
  if (firstDeltaAt > observedAt) return unverified(BODY_DELTA_METRIC, BODY_DELTA_SOURCE, "marker_after_observation");
  return { status: "verified", metric: BODY_DELTA_METRIC, source: BODY_DELTA_SOURCE, origin: MEASUREMENT_ORIGIN, latencyMs: firstDeltaAt - submittedAt };
}

export function bodyDeltaReadFailure() {
  return unverified(BODY_DELTA_METRIC, BODY_DELTA_SOURCE, "marker_read_failed");
}

export function measureTerminalObservation(submittedAt, observedAt) {
  if (!timestamp(submittedAt) || !timestamp(observedAt) || observedAt < submittedAt) return unverified(TERMINAL_METRIC, TERMINAL_SOURCE, "invalid_clock");
  return { status: "verified", metric: TERMINAL_METRIC, source: TERMINAL_SOURCE, origin: MEASUREMENT_ORIGIN, latencyMs: observedAt - submittedAt };
}

// Normalize fixed vocabulary only. Missing provenance in historical reports
// remains visible but cannot enter verified latency statistics.
export function normalizeReportedMeasurement(measurement, metric, source, legacyLatencyMs) {
  if (measurement === undefined || measurement === null) {
    return latency(legacyLatencyMs)
      ? { status: "legacy_unverified", metric, source: "legacy_source_missing", origin: "unknown", legacyReportedLatencyMs: legacyLatencyMs }
      : { status: "not_recorded", metric, source: "not_recorded", origin: "unknown" };
  }
  if (typeof measurement !== "object" || measurement.metric !== metric || measurement.source !== source || measurement.origin !== MEASUREMENT_ORIGIN) return unverified(metric, source, "measurement_metadata");
  if (measurement.status === "unverified" && reasons.has(measurement.reason) && measurement.latencyMs === undefined) return unverified(metric, source, measurement.reason);
  if (measurement.status !== "verified" || !latency(measurement.latencyMs) || legacyLatencyMs !== undefined && legacyLatencyMs !== measurement.latencyMs) return unverified(metric, source, "measurement_metadata");
  return { status: "verified", metric, source, origin: MEASUREMENT_ORIGIN, latencyMs: measurement.latencyMs };
}

export function describeLatencySamples(measurements) {
  const samplesMs = measurements.filter((measurement) => measurement.status === "verified").map((measurement) => measurement.latencyMs).filter(latency);
  const sampleCount = samplesMs.length;
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const rank = (p) => sorted[Math.max(1, Math.ceil(sampleCount * p)) - 1];
  return {
    samplesMs, sampleCount,
    minMs: sampleCount ? sorted[0] : null,
    maxMs: sampleCount ? sorted[sampleCount - 1] : null,
    p50Ms: sampleCount > 1 ? rank(0.5) : null,
    p95Ms: sampleCount > 1 ? rank(0.95) : null,
    percentileMethod: sampleCount > 1 ? "nearest-rank" : "not_applicable",
    interpretation: sampleCount === 1 ? "descriptive_sample" : sampleCount ? "descriptive_samples" : "no_verified_samples",
    performanceBaseline: false,
    excludedCount: measurements.length - sampleCount,
  };
}

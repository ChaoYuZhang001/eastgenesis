export const MEASUREMENT_ORIGIN: string;
export const BODY_DELTA_METRIC: string;
export const BODY_DELTA_SOURCE: string;
export const TERMINAL_METRIC: string;
export const TERMINAL_SOURCE: string;
export interface Measurement {
  status: "verified" | "unverified" | "legacy_unverified" | "not_recorded";
  metric: string;
  source: string;
  origin: string;
  reason?: string;
  latencyMs?: number;
  legacyReportedLatencyMs?: number;
}
export function measureFirstBodyDelta(rawAttribute: unknown, submittedAt: number, observedAt: number): Measurement;
export function bodyDeltaReadFailure(): Measurement;
export function measureTerminalObservation(submittedAt: number, observedAt: number): Measurement;
export function normalizeReportedMeasurement(measurement: unknown, metric: string, source: string, legacyLatencyMs?: unknown): Measurement;
export function describeLatencySamples(measurements: Measurement[]): {
  samplesMs: number[]; sampleCount: number; minMs: number | null; maxMs: number | null;
  p50Ms: number | null; p95Ms: number | null; percentileMethod: string;
  interpretation: string; performanceBaseline: false; excludedCount: number;
};

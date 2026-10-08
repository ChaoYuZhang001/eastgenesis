export interface StartupOptions {
  pairs: number;
  timeoutMs: number;
  totalTimeoutMs: number;
  pollMs: number;
  output: string;
  manifest: string;
  app: string;
  pilotReport: string | null;
  priorReports: string[];
}
export function parseOptions(argv: readonly string[]): StartupOptions;
export function clockWithinBounds(bounds: {
  observedWallMs: number;
  spawnBeforeWallMs: number;
  commandSentWallMs: number;
  receivedWallMs: number;
}): boolean;
export function summarizeMetric(samples: readonly {
  phase: string;
  passed: boolean;
  metrics: Record<string, { observationUpperBoundMs: number }>;
}[], phase: string, metric: string): {
  attempted: number;
  successful: number;
  failed: number;
  validMeasurements: number;
  minMs: number | null;
  maxMs: number | null;
  meanMs: number | null;
  medianMs: number | null;
  p95Ms: number | null;
  p95Method: string;
};

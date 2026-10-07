export type MeasurementPlatform = "darwin" | "linux" | "win32";
export interface ProcessAnchor { pid: number; parentPid: number; identity: string }
export interface ProcessRecord extends ProcessAnchor { cpuUserNs: string; cpuSystemNs: string; rssBytes: number }
export interface ProcessSample {
  status: "verified" | "unverified";
  observedAtMs: number;
  collectionDurationMs: number;
  processes: ProcessRecord[];
  rssBytes: number | null;
  cpuCumulativeMs: number | null;
  reason?: string;
}
export interface ProcessSummary {
  status: "verified" | "unverified";
  sampleCount: number;
  wallMs: number | null;
  cpuCumulativeStartMs: number | null;
  cpuCumulativeEndMs: number | null;
  cpuDeltaMs: number | null;
  cpuPercentOneCore: number | null;
  sampledPeakRssBytes: number | null;
  reason?: string;
}
export interface ProcessScope {
  source: string;
  collection: "explicit_owned_pid_set";
  processTreeCoverage: "unverified";
  processTreeReason: string;
  cpu: string;
  cpuCumulativeUnit: "milliseconds";
  cpuWindowUnit: "percent_of_one_logical_cpu";
  cpuWindowFormula: string;
  rssUnit: "bytes";
  rssAggregation: string;
  samplingAtomicity: string;
  excluded: string[];
}
export interface ProcessMeasurement {
  schemaVersion: 1;
  kind: "desktop-process-measurement";
  status: "verified" | "unverified";
  reason?: string;
  scope: ProcessScope;
  platformExecution: Record<MeasurementPlatform, "executed" | "not_run">;
  settings: { intervalMs: number; durationMs: number };
  samples: ProcessSample[];
  summary: ProcessSummary | null;
}
export interface OwnedProcessSampler {
  scope: ProcessScope;
  platformExecution: Record<MeasurementPlatform, "executed" | "not_run">;
  sample(): Promise<ProcessSample>;
  registerDescendant(pid: number, parentPid: number): Promise<void>;
  measure(options?: { intervalMs?: number; durationMs?: number }): Promise<ProcessMeasurement>;
  close(): Promise<void>;
}
export function processMeasurementScope(platform?: string): ProcessScope;
export function validateSamplingOptions(options?: { intervalMs?: number; durationMs?: number }): { intervalMs: number; durationMs: number };
export function validateOwnedSnapshot(anchors: ProcessAnchor[], records: unknown): ProcessRecord[];
export function summarizeProcessSamples(samples: unknown): ProcessSummary;
// Capture immediately after the harness creates its owned child. Root parent
// and owner identity are pinned too. Always close in a finally block.
export function createOwnedProcessSampler(options: { rootPid: number; ownerPid?: number; pythonExecutable?: string; platform?: MeasurementPlatform }): Promise<OwnedProcessSampler>;

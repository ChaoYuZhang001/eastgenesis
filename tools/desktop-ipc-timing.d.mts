export interface IpcTimingSnapshot {
  schemaVersion: number; source: string; status: string; reason?: string;
  channels: Array<{ ordinal: number; headersAtEpochMs: number | null; firstBodyBytesAtEpochMs: number | null; terminalAtEpochMs: number | null; terminalKind: string | null }>;
}
export function installProviderIpcTimingObserver(scope?: any): IpcTimingSnapshot;
export function normalizeProviderIpcTiming(raw: unknown, submittedAt: number, observedAt: number): {
  source: string; origin: string; interpretation: string; performanceBaseline: boolean;
  status: string; reason?: string; channels: Array<{ ordinal: number; status: string; reason?: string; headersLatencyMs?: number; firstBodyBytesLatencyMs?: number | null; transportTerminalLatencyMs?: number | null; transportTerminalKind?: string | null }>;
};
export function sanitizeReportedProviderIpcTiming(value: unknown): {
  source: string; origin: string; performanceBaseline: boolean;
  status: string; reason?: string; channels: Array<{ ordinal: number; status: string; headersLatencyMs: number; firstBodyBytesLatencyMs: number | null; transportTerminalLatencyMs: number | null; transportTerminalKind: string | null }>;
};

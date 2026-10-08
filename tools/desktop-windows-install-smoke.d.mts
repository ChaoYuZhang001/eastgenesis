import type { StartupTraceReport } from "./desktop-startup-trace.mjs";
export const QA_DATA_DIRECTORY: string;
export const NSIS_PAYLOAD_BINDING_STRATEGY: "tauri_cli_2_12_0_nsis_bundle_type_patch";
export const NSIS_PAYLOAD_CLI_VERSION: "2.12.0";
export interface NsisPayloadBinding {
  strategy: typeof NSIS_PAYLOAD_BINDING_STRATEGY;
  cliVersion: typeof NSIS_PAYLOAD_CLI_VERSION;
  sourceSha256: string;
  expectedNsisSha256: string;
  installedSha256: string | null;
  repairedSha256: string | null;
}
export type SqliteProbeFailureStage = "path_guard" | "process_job" | "command_wait" | "command_exit" | "output_read" | "output_parse" | "output_shape" | "sqlite_open" | "schema_query" | "schema_result" | "seed_write" | "sentinel_query" | "sqlite_close" | "output_write" | "mode_invalid";
export interface ProcessJobFailure {
  stage: "job_create" | "job_limit" | "stdio_create" | "environment_block" | "process_create" | "job_assign" | "process_lookup" | "process_handle" | "process_resume" | "unknown";
  win32Error: number | null;
  hresult: number | null;
  suspendCount: number | null;
}
export interface ProcessStartPathFacts {
  charLength: number | null;
  containsNul: boolean | null;
  containsCrLf: boolean | null;
  containsQuote: boolean | null;
  edgeWhitespace: boolean | null;
  rooted: boolean | null;
  pathForm: "drive_absolute" | "drive_relative" | "unc" | "device" | "root_relative" | "relative" | "unknown";
  /** File.Exists for application; Directory.Exists for cwd; best-effort observation. */
  exists: boolean | null;
  fullPathComparison: "same" | "different" | "failed" | "unknown";
}
export interface ProcessStartInputFacts {
  launchRole: "installed_app" | "sqlite_schema_probe" | "sqlite_seed" | "sqlite_sentinel" | "startup_trace_reader" | "nsis_install" | "nsis_uninstall" | "unknown";
  application: ProcessStartPathFacts;
  cwd: ProcessStartPathFacts;
  command: { charLength: number | null; containsNul: boolean | null; containsCrLf: boolean | null; quotedApplicationPrefix: boolean | null };
}
export interface StartupDiagnostic {
  cycle: 1 | 2;
  outcome: "database_ready" | "failed";
  failureStage: "process_start" | "process_job" | "database_timeout" | "reparse_point" | "isolated_root" | "unknown" | null;
  elapsedMs: number;
  stableWindowPassed: boolean;
  databaseExists: boolean | null;
  schemaProbeAttempts: number;
  schemaProbeFailures: number;
  schemaProbeState: "not_attempted" | "pending" | "ready" | "failed";
  lastProbeFailureStage: SqliteProbeFailureStage | null;
  rootProcessAlive: boolean | null;
  rootWindowPresent: boolean | null;
  jobActiveProcessCount: number | null;
  startupTrace?: StartupTraceReport;
  processJobFailure?: ProcessJobFailure | null;
  processStartInputFacts?: ProcessStartInputFacts | null;
}
export function expectedNsisPayloadBinding(sourceBytes: Buffer, cliVersion: unknown): NsisPayloadBinding;
export const REQUIRED_CHECKS: string[];
export function prerequisiteFailure(platform: string, env: Record<string, string | undefined>): string | null;
export function parseArguments(args: string[]): Record<string, string | boolean>;
export function qaConfigIsIsolated(config: unknown): boolean;
export function makeReport(options?: { passed?: boolean; checks?: Record<string, boolean>; stages?: string[]; errors?: string[]; launches?: unknown[]; payloadBinding?: NsisPayloadBinding | null; startupDiagnostics?: StartupDiagnostic[]; attempts?: { install: boolean | null; reinstall: boolean | null; uninstall: boolean | null } }): Record<string, unknown>;
export function validateHelperReport(value: unknown): Record<string, unknown>;
export function main(args?: string[]): Promise<Record<string, unknown>>;

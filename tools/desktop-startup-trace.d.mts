export const MAX_TRACE_BYTES: 32768;
export const TRACE_RECORD_LIMIT: 64;
export type NativeStartupStage = "native_started" | "builder_started" | "plugin_setup_started" | "plugin_setup_finished" | "page_started" | "page_finished" | "setup_started" | "app_config_path_resolved" | "app_config_path_failed" | "provider_store_loaded" | "provider_store_failed" | "native_state_ready" | "setup_finished" | "setup_failed" | "builder_finished" | "builder_failed" | "get_app_info_received" | "record_limit_reached" | "sql_plugin_ready" | "sql_load_entered" | "sql_connect_started" | "sql_connect_resolved" | "sql_connect_invalid_url" | "sql_connect_configuration_failed" | "sql_connect_cannot_open" | "sql_connect_locked" | "sql_connect_io_permission_denied" | "sql_connect_failed" | "sql_migration_started" | "sql_migration_resolved" | "sql_migration_version_mismatch" | "sql_migration_dirty" | "sql_migration_failed" | "sql_load_resolved";
export type FrontendStartupStage = "document_start" | "document_error" | "document_unhandled_rejection" | "frontend_entry" | "react_render_called" | "bootstrap_started" | "backend_tauri" | "backend_mock" | "backend_init_started" | "app_info_started" | "app_info_resolved" | "app_info_failed" | "sql_import_started" | "sql_import_resolved" | "sql_import_failed" | "db_load_called" | "db_load_resolved" | "db_load_failed" | "schema_read_started" | "schema_read_resolved" | "schema_read_failed" | "backend_init_resolved" | "backend_init_failed" | "frontend_ready" | "frontend_boot_failed";
export const NATIVE_STARTUP_STAGES: readonly NativeStartupStage[];
export const FRONTEND_STARTUP_STAGES: readonly FrontendStartupStage[];
export type StartupTraceRecord = {
  seq: number;
  elapsedMs: number;
} & ({ source: "native"; stage: NativeStartupStage; frontendSeq: null } | { source: "frontend"; stage: FrontendStartupStage; frontendSeq: number });
export type StartupTraceReport = {
  status: "observed";
  reason: "complete" | "record_limit";
  runId: string;
  records: StartupTraceRecord[];
} | {
  status: "unobserved";
  reason: "missing" | "invalid" | "read_failed" | "capture_failed";
  runId: string;
  records: [];
};
export function parseStartupTraceText(text: string, expectedRunId: string): StartupTraceReport;
export function validateStartupTraceReport(value: unknown): StartupTraceReport;

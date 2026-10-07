/** Optional recorder installed only by the guarded native QA plugin. */
export type QaStartupStage =
  | "frontend_entry" | "react_render_called" | "bootstrap_started" | "backend_tauri" | "backend_mock"
  | "backend_init_started" | "app_info_started" | "app_info_resolved" | "app_info_failed"
  | "sql_import_started" | "sql_import_resolved" | "sql_import_failed"
  | "db_load_called" | "db_load_resolved" | "db_load_failed"
  | "schema_read_started" | "schema_read_resolved" | "schema_read_failed"
  | "backend_init_resolved" | "backend_init_failed" | "frontend_ready" | "frontend_boot_failed";

export function recordQaStartup(stage: QaStartupStage): void {
  try {
    const recorder = typeof window === "undefined" ? undefined
      : (window as unknown as { __EG_QA_STARTUP_RECORD__?: (stage: QaStartupStage) => void }).__EG_QA_STARTUP_RECORD__;
    if (typeof recorder === "function") recorder(stage);
  } catch {
    // Diagnostics are optional and must never change startup behavior.
  }
}

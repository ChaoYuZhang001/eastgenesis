//! Bounded, fixed-vocabulary startup observations for isolated installation QA.
//! This module is absent from ordinary non-test builds. The journal is next to
//! the executable, never in app_config_dir: observing startup must not create it.

use serde::{Deserialize, Serialize};
use std::ffi::OsStr;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::Path;
#[cfg(feature = "qa-faults")]
use std::sync::OnceLock;
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tauri::utils::config::{AppDirectoriesOverride, Config};

const RECORD_LIMIT: u32 = 64;
const BYTE_LIMIT: usize = 32 * 1024;
const MAX_ELAPSED_MS: u64 = 600_000;

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Stage {
    NativeStarted,
    BuilderStarted,
    PluginSetupStarted,
    PluginSetupFinished,
    PageStarted,
    PageFinished,
    SetupStarted,
    AppConfigPathResolved,
    AppConfigPathFailed,
    ProviderStoreLoaded,
    ProviderStoreFailed,
    NativeStateReady,
    SetupFinished,
    SetupFailed,
    BuilderFinished,
    BuilderFailed,
    GetAppInfoReceived,
    SqlPluginReady,
    SqlLoadEntered,
    SqlConnectStarted,
    SqlConnectResolved,
    SqlConnectInvalidUrl,
    SqlConnectConfigurationFailed,
    SqlConnectCannotOpen,
    SqlConnectLocked,
    SqlConnectIoPermissionDenied,
    SqlConnectFailed,
    SqlMigrationStarted,
    SqlMigrationResolved,
    SqlMigrationVersionMismatch,
    SqlMigrationDirty,
    SqlMigrationFailed,
    SqlLoadResolved,
    RecordLimitReached,
    DocumentStart,
    DocumentError,
    DocumentUnhandledRejection,
    FrontendEntry,
    ReactRenderCalled,
    BootstrapStarted,
    BackendTauri,
    BackendMock,
    BackendInitStarted,
    AppInfoStarted,
    AppInfoResolved,
    AppInfoFailed,
    SqlImportStarted,
    SqlImportResolved,
    SqlImportFailed,
    DbLoadCalled,
    DbLoadResolved,
    DbLoadFailed,
    SchemaReadStarted,
    SchemaReadResolved,
    SchemaReadFailed,
    BackendInitResolved,
    BackendInitFailed,
    FrontendReady,
    FrontendBootFailed,
}

impl Stage {
    fn is_frontend(self) -> bool {
        matches!(
            self,
            Self::DocumentStart
                | Self::DocumentError
                | Self::DocumentUnhandledRejection
                | Self::FrontendEntry
                | Self::ReactRenderCalled
                | Self::BootstrapStarted
                | Self::BackendTauri
                | Self::BackendMock
                | Self::BackendInitStarted
                | Self::AppInfoStarted
                | Self::AppInfoResolved
                | Self::AppInfoFailed
                | Self::SqlImportStarted
                | Self::SqlImportResolved
                | Self::SqlImportFailed
                | Self::DbLoadCalled
                | Self::DbLoadResolved
                | Self::DbLoadFailed
                | Self::SchemaReadStarted
                | Self::SchemaReadResolved
                | Self::SchemaReadFailed
                | Self::BackendInitResolved
                | Self::BackendInitFailed
                | Self::FrontendReady
                | Self::FrontendBootFailed
        )
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Header<'a> {
    schema_version: u32,
    kind: &'static str,
    run_id: &'a str,
    record_limit: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Record {
    seq: u32,
    source: &'static str,
    stage: Stage,
    elapsed_ms: u64,
    frontend_seq: Option<u32>,
}

struct Writer {
    file: File,
    seq: u32,
    bytes: usize,
    disabled: bool,
    frontend_seen: [bool; RECORD_LIMIT as usize],
}

pub(crate) struct Recorder {
    started: Instant,
    run_id: String,
    writer: Mutex<Writer>,
}

pub(crate) fn valid_run_id(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| {
            if [8, 13, 18, 23].contains(&index) {
                byte == b'-'
            } else {
                byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
            }
        })
}

fn guarded(config: &Config, enabled: bool, required: bool, run_id: &str) -> bool {
    enabled
        && required
        && valid_run_id(run_id)
        && matches!(config.app.app_directories_override.as_ref(),
            Some(AppDirectoriesOverride::Root(root)) if root.as_os_str() == OsStr::new("./eg-qa-appdata"))
}

impl Recorder {
    fn create(binary_parent: &Path, run_id: &str) -> std::io::Result<Self> {
        let path = binary_parent.join(format!("eg-qa-startup-{run_id}.jsonl"));
        let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
        let mut header = serde_json::to_vec(&Header {
            schema_version: 1,
            kind: "desktop-qa-startup",
            run_id,
            record_limit: RECORD_LIMIT,
        })?;
        header.push(b'\n');
        file.write_all(&header)?;
        file.flush()?;
        Ok(Self {
            started: Instant::now(),
            run_id: run_id.to_owned(),
            writer: Mutex::new(Writer {
                file,
                seq: 0,
                bytes: header.len(),
                disabled: false,
                frontend_seen: [false; RECORD_LIMIT as usize],
            }),
        })
    }

    fn record(&self, mut stage: Stage, mut frontend_seq: Option<u32>) {
        if stage.is_frontend() != frontend_seq.is_some()
            || frontend_seq.is_some_and(|value| !(1..=RECORD_LIMIT).contains(&value))
        {
            return;
        }
        let Ok(mut writer) = self.writer.lock() else {
            return;
        };
        if writer.disabled || writer.seq >= RECORD_LIMIT {
            return;
        }
        if frontend_seq.is_some_and(|value| writer.frontend_seen[(value - 1) as usize]) {
            return;
        }
        let seq = writer.seq + 1;
        if seq == RECORD_LIMIT {
            stage = Stage::RecordLimitReached;
            frontend_seq = None;
        }
        let record = Record {
            seq,
            source: if frontend_seq.is_some() {
                "frontend"
            } else {
                "native"
            },
            stage,
            elapsed_ms: (self
                .started
                .elapsed()
                .as_millis()
                .min(MAX_ELAPSED_MS.into())) as u64,
            frontend_seq,
        };
        let Ok(mut bytes) = serde_json::to_vec(&record) else {
            writer.disabled = true;
            return;
        };
        bytes.push(b'\n');
        if writer.bytes + bytes.len() > BYTE_LIMIT
            || writer.file.write_all(&bytes).is_err()
            || writer.file.flush().is_err()
        {
            writer.disabled = true;
            return;
        }
        writer.seq = seq;
        writer.bytes += bytes.len();
        if let Some(value) = frontend_seq {
            writer.frontend_seen[(value - 1) as usize] = true;
        }
    }
}

#[cfg(feature = "qa-faults")]
static RECORDER: OnceLock<Arc<Recorder>> = OnceLock::new();

/// Available only after the guarded isolated startup journal was created.
/// This identity is an observation capability, never an execution permission.
#[cfg(feature = "qa-faults")]
pub(crate) fn observation_run_id() -> Option<String> {
    RECORDER.get().map(|recorder| recorder.run_id.clone())
}

#[cfg(feature = "qa-faults")]
pub(crate) fn record(stage: Stage) {
    if let Some(recorder) = RECORDER.get() {
        recorder.record(stage, None);
    }
}

// The plugin only supplies fixed enum variants, before its error is rendered
// into an IPC string. No database URL, path, SQL or original error reaches here.
#[cfg(feature = "qa-faults")]
pub(crate) fn record_sql_load(stage: tauri_plugin_sql::QaLoadStage) {
    use tauri_plugin_sql::QaLoadStage as Sql;
    record(match stage {
        Sql::PluginReady => Stage::SqlPluginReady,
        Sql::LoadEntered => Stage::SqlLoadEntered,
        Sql::ConnectStarted => Stage::SqlConnectStarted,
        Sql::ConnectResolved => Stage::SqlConnectResolved,
        Sql::ConnectInvalidUrl => Stage::SqlConnectInvalidUrl,
        Sql::ConnectConfigurationFailed => Stage::SqlConnectConfigurationFailed,
        Sql::ConnectCannotOpen => Stage::SqlConnectCannotOpen,
        Sql::ConnectLocked => Stage::SqlConnectLocked,
        Sql::ConnectIoPermissionDenied => Stage::SqlConnectIoPermissionDenied,
        Sql::ConnectFailed => Stage::SqlConnectFailed,
        Sql::MigrationStarted => Stage::SqlMigrationStarted,
        Sql::MigrationResolved => Stage::SqlMigrationResolved,
        Sql::MigrationVersionMismatch => Stage::SqlMigrationVersionMismatch,
        Sql::MigrationDirty => Stage::SqlMigrationDirty,
        Sql::MigrationFailed => Stage::SqlMigrationFailed,
        Sql::LoadResolved => Stage::SqlLoadResolved,
    });
}

#[cfg(feature = "qa-faults")]
#[tauri::command]
pub(crate) fn qa_startup_record(webview: tauri::Webview, stage: Stage, frontend_seq: u32) {
    if webview.label() != "main" || !stage.is_frontend() {
        return;
    }
    if let Some(recorder) = RECORDER.get() {
        recorder.record(stage, Some(frontend_seq));
    }
}

// Plugin initialization scripts run after Tauri's core IPC initialization. An
// absent marker cannot distinguish JS startup from IPC delivery failure.
#[cfg(feature = "qa-faults")]
const INIT_SCRIPT: &str = r#"
(() => {
  try {
    if (window !== window.top || window.__TAURI_INTERNALS__?.metadata?.currentWebview?.label !== 'main') return;
    const stages = new Set(['document_start','document_error','document_unhandled_rejection','frontend_entry','react_render_called','bootstrap_started','backend_tauri','backend_mock','backend_init_started','app_info_started','app_info_resolved','app_info_failed','sql_import_started','sql_import_resolved','sql_import_failed','db_load_called','db_load_resolved','db_load_failed','schema_read_started','schema_read_resolved','schema_read_failed','backend_init_resolved','backend_init_failed','frontend_ready','frontend_boot_failed']);
    let seq = 0;
    const record = (stage) => {
      try {
        if (!stages.has(stage) || seq >= 64) return;
        const frontendSeq = ++seq;
        void window.__TAURI_INTERNALS__.invoke('qa_startup_record', { stage, frontendSeq }).catch(() => {});
      } catch (_) {}
    };
    Object.defineProperty(window, '__EG_QA_STARTUP_RECORD__', { value: record });
    window.addEventListener('error', () => record('document_error'));
    window.addEventListener('unhandledrejection', () => record('document_unhandled_rejection'));
    record('document_start');
  } catch (_) {}
})();
"#;

#[cfg(feature = "qa-faults")]
pub(crate) fn initialize(config: &Config) -> Option<tauri::plugin::TauriPlugin<tauri::Wry>> {
    let enabled =
        std::env::var_os("EASTGENESIS_QA_STARTUP_DIAGNOSTICS").is_some_and(|value| value == "1");
    let required = std::env::var_os("EASTGENESIS_QA_INSTALL_ISOLATION_REQUIRED")
        .is_some_and(|value| value == "1");
    let run_id = std::env::var("EASTGENESIS_QA_STARTUP_RUN_ID").ok()?;
    if !guarded(config, enabled, required, &run_id) {
        return None;
    }
    let binary = std::env::current_exe().ok()?;
    let recorder = Arc::new(Recorder::create(binary.parent()?, &run_id).ok()?);
    RECORDER.set(recorder).ok()?;
    record(Stage::NativeStarted);
    Some(
        tauri::plugin::Builder::new("qa-startup-observer")
            .js_init_script(INIT_SCRIPT)
            .setup(|_, _| {
                record(Stage::PluginSetupStarted);
                record(Stage::PluginSetupFinished);
                Ok(())
            })
            .on_page_load(|webview, payload| {
                if webview.label() != "main" {
                    return;
                }
                record(match payload.event() {
                    tauri::webview::PageLoadEvent::Started => Stage::PageStarted,
                    tauri::webview::PageLoadEvent::Finished => Stage::PageFinished,
                });
            })
            .build(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU32, Ordering};

    const RUN_ID: &str = "01234567-89ab-cdef-0123-456789abcdef";
    fn isolated() -> Config {
        let mut config = Config::default();
        config.app.app_directories_override = Some(AppDirectoriesOverride::Root(PathBuf::from(
            "./eg-qa-appdata",
        )));
        config
    }
    fn owned_directory() -> PathBuf {
        static NEXT: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "eg-qa-startup-unit-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&dir).unwrap();
        dir
    }
    #[test]
    fn guard_requires_flags_exact_embedded_root_and_safe_run_id() {
        assert!(guarded(&isolated(), true, true, RUN_ID));
        assert!(!guarded(&isolated(), false, true, RUN_ID));
        assert!(!guarded(&isolated(), true, false, RUN_ID));
        assert!(!guarded(&Config::default(), true, true, RUN_ID));
        for value in [
            "",
            "../private",
            "01234567-89AB-cdef-0123-456789abcdef",
            "01234567-89ab-cdef-0123-456789abcdeg",
        ] {
            assert!(!guarded(&isolated(), true, true, value));
        }
        for root in [
            "eg-qa-appdata",
            "../eg-qa-appdata",
            "./eg-qa-appdata/",
            "././eg-qa-appdata",
        ] {
            let mut config = isolated();
            config.app.app_directories_override = Some(AppDirectoriesOverride::Root(root.into()));
            assert!(!guarded(&config, true, true, RUN_ID));
        }
    }
    #[test]
    fn journal_is_bounded_fixed_fields_and_never_creates_appdata_or_overwrites() {
        let dir = owned_directory();
        let recorder = Recorder::create(&dir, RUN_ID).unwrap();
        assert_eq!(recorder.run_id, RUN_ID);
        recorder.record(Stage::NativeStarted, None);
        recorder.record(Stage::FrontendEntry, Some(1));
        recorder.record(Stage::FrontendEntry, Some(1));
        // Native vocabulary cannot be attributed to the renderer and vice versa.
        recorder.record(Stage::SetupStarted, Some(2));
        recorder.record(Stage::FrontendReady, None);
        recorder.record(Stage::FrontendEntry, Some(65));
        for _ in 0..100 {
            recorder.record(Stage::PageStarted, None);
        }
        let path = dir.join(format!("eg-qa-startup-{RUN_ID}.jsonl"));
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.ends_with('\n'));
        assert!(text.len() <= BYTE_LIMIT);
        assert!(!dir.join("eg-qa-appdata").exists());
        let lines: Vec<serde_json::Value> = text
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(lines.len(), 65);
        assert_eq!(lines[0].as_object().unwrap().len(), 4);
        assert_eq!(lines[0]["runId"], RUN_ID);
        for (index, value) in lines.iter().skip(1).enumerate() {
            assert_eq!(value.as_object().unwrap().len(), 5);
            assert_eq!(value["seq"], index + 1);
            assert!(value["elapsedMs"].as_u64().unwrap() <= MAX_ELAPSED_MS);
        }
        assert_eq!(lines[2]["frontendSeq"], 1);
        assert_eq!(lines[64]["stage"], "record_limit_reached");
        assert_eq!(lines[64]["source"], "native");
        assert!(lines[64]["frontendSeq"].is_null());
        assert!(Recorder::create(&dir, RUN_ID).is_err());
        assert_eq!(std::fs::read_to_string(path).unwrap(), text);
        drop(recorder);
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn missing_parent_is_not_created_and_unknown_stage_is_rejected() {
        let dir = owned_directory();
        assert!(Recorder::create(&dir.join("absent"), RUN_ID).is_err());
        assert!(!dir.join("absent").exists());
        assert!(serde_json::from_str::<Stage>("\"private-error-text\"").is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn simultaneous_native_and_renderer_arrivals_allocate_one_bounded_sequence() {
        let dir = owned_directory();
        let recorder = Arc::new(Recorder::create(&dir, RUN_ID).unwrap());
        let mut threads = Vec::new();
        for frontend in 1..=30 {
            let recorder = recorder.clone();
            threads.push(std::thread::spawn(move || {
                recorder.record(Stage::PageStarted, None);
                recorder.record(Stage::FrontendEntry, Some(frontend));
            }));
        }
        for thread in threads {
            thread.join().unwrap();
        }
        let text =
            std::fs::read_to_string(dir.join(format!("eg-qa-startup-{RUN_ID}.jsonl"))).unwrap();
        let records: Vec<serde_json::Value> = text
            .lines()
            .skip(1)
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(records.len(), 60);
        let mut elapsed = 0;
        let mut frontend_seen = std::collections::BTreeSet::new();
        for (index, value) in records.iter().enumerate() {
            assert_eq!(value["seq"], index + 1);
            let current = value["elapsedMs"].as_u64().unwrap();
            assert!(current >= elapsed);
            elapsed = current;
            if let Some(frontend) = value["frontendSeq"].as_u64() {
                assert!(frontend_seen.insert(frontend));
            }
        }
        assert_eq!(frontend_seen.len(), 30);
        drop(recorder);
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn writer_failure_disables_only_observation_and_never_panics() {
        let dir = owned_directory();
        let path = dir.join("readonly-fixture");
        std::fs::write(&path, b"fixed").unwrap();
        let recorder = Recorder {
            started: Instant::now(),
            run_id: RUN_ID.to_owned(),
            writer: Mutex::new(Writer {
                file: File::open(&path).unwrap(),
                seq: 0,
                bytes: 0,
                disabled: false,
                frontend_seen: [false; RECORD_LIMIT as usize],
            }),
        };
        recorder.record(Stage::NativeStarted, None);
        recorder.record(Stage::PageStarted, None);
        assert!(recorder.writer.lock().unwrap().disabled);
        assert_eq!(std::fs::read(&path).unwrap(), b"fixed");
        drop(recorder);
        std::fs::remove_dir_all(dir).unwrap();
    }
}

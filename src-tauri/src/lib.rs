//! Tauri 外壳：只注册插件和命令，逻辑都在 eg-core（可在任何环境 cargo test）。
//! 命令名 snake_case，错误统一为 eg_core::AppError { code, message, detail }。
//! 前端拿不到任何 Key：set_* 只进不出，get_* 只返回「已配置 / 未配置」，模型请求经 provider_request 由这里代理。

mod keychain;
mod net;
pub mod qa_install_probe;
#[cfg(any(feature = "qa-faults", test))]
mod qa_startup_diagnostics;

use std::collections::HashMap;
#[cfg(feature = "qa-faults")]
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use eg_core::mcp_service::{path_hint, McpRegistryView, McpServerView, McpService};
use eg_core::providers::{self, CustomProvider, CustomProviderStore, ProxyRequest, ProxyResponse, SavedProvider};
#[cfg(feature = "qa-faults")]
use eg_core::providers::Protocol;
use eg_core::secrets::{validate_provider_id, KeyService, KeyStatus, JEV_ACCOUNT};
#[cfg(feature = "qa-faults")]
use eg_core::secrets::KeySource;
use eg_core::file_roots::{FileRoot, FileRootsStore};
use eg_core::{AppError, AppInfo, AppResult};
use serde::Serialize;
use tauri::{Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_sql::{Migration, MigrationKind};

struct AppState {
    keys: KeyService<keychain::KeyringStore>,
    custom: Mutex<CustomProviderStore>,
    /// 内置文件服务器允许访问的目录（默认 ~/Downloads + 用户加的）
    roots: Mutex<FileRootsStore>,
    mcp: McpService<keychain::KeyringStore>,
    /// Cancellation state for in-flight Provider streams. The body itself is
    /// delivered over a Tauri Channel so the webview can render SSE deltas.
    streams: Mutex<net::StreamRegistry>,
}

struct StreamRegistration<'a> {
    registry: &'a Mutex<net::StreamRegistry>,
    id: &'a str,
    signal: Arc<net::StreamCancellation>,
}

impl Drop for StreamRegistration<'_> {
    fn drop(&mut self) {
        if let Ok(mut registry) = self.registry.lock() {
            registry.finish(self.id, &self.signal);
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ProviderStreamEvent {
    Headers { status: u16 },
    Chunk { data: Vec<u8> },
    Done,
    Error { error: AppError },
}

type Shared<'a> = State<'a, Arc<AppState>>;

fn dialog_starting_directory(raw: &str, home: Option<&Path>) -> Option<PathBuf> {
    let value = raw.trim();
    if value.is_empty() {
        return None;
    }
    if value == "~" {
        return home.map(Path::to_path_buf);
    }
    if let Some(rest) = value.strip_prefix("~/") {
        return home.map(|path| path.join(rest));
    }
    Some(PathBuf::from(value))
}

fn lock(m: &Mutex<CustomProviderStore>) -> AppResult<MutexGuard<'_, CustomProviderStore>> {
    m.lock().map_err(|_| AppError::internal("lock poisoned"))
}

#[cfg(feature = "qa-faults")]
fn qa_unconfigured_status(id: impl Into<String>) -> KeyStatus {
    let id = id.into();
    let needs_key = id != "ollama";
    KeyStatus { id, configured: !needs_key, source: KeySource::None, needs_key }
}

fn roots_lock(m: &Mutex<FileRootsStore>) -> AppResult<MutexGuard<'_, FileRootsStore>> {
    m.lock().map_err(|_| AppError::internal("lock poisoned"))
}

#[tauri::command]
fn get_app_info(app: tauri::AppHandle) -> AppResult<AppInfo> {
    #[cfg(feature = "qa-faults")]
    qa_startup_diagnostics::record(qa_startup_diagnostics::Stage::GetAppInfoReceived);
    Ok(eg_core::app_info(&app.package_info().version.to_string()))
}

#[tauri::command]
fn get_provider_status(state: Shared<'_>) -> AppResult<Vec<KeyStatus>> {
    let ids = lock(&state.custom)?.ids();
    match state.keys.statuses(&ids) {
        Ok(statuses) => Ok(statuses),
        #[cfg(feature = "qa-faults")]
        Err(error) if error.code == "keychain_error" => {
            // Linux CI has no Secret Service. Keep the QA fixture usable while
            // preserving the production error path and never inventing keys.
            Ok(eg_core::secrets::OFFICIAL
                .iter()
                .map(|(id, _)| qa_unconfigured_status(*id))
                .chain(ids.into_iter().map(qa_unconfigured_status))
                .collect())
        }
        Err(error) => Err(error),
    }
}

#[tauri::command]
fn set_provider_key(state: Shared<'_>, provider: String, key: String) -> AppResult<KeyStatus> {
    validate_provider_id(&provider)?;
    state.keys.set(&provider, &key)
}

#[tauri::command]
fn delete_provider_key(state: Shared<'_>, provider: String) -> AppResult<KeyStatus> {
    validate_provider_id(&provider)?;
    state.keys.delete(&provider)
}

#[tauri::command]
fn get_jev_status(state: Shared<'_>) -> AppResult<KeyStatus> {
    match state.keys.status(JEV_ACCOUNT) {
        Ok(status) => Ok(status),
        #[cfg(feature = "qa-faults")]
        Err(error) if error.code == "keychain_error" => Ok(qa_unconfigured_status(JEV_ACCOUNT)),
        Err(error) => Err(error),
    }
}

#[tauri::command]
fn set_jev_key(state: Shared<'_>, key: String) -> AppResult<KeyStatus> {
    state.keys.set(JEV_ACCOUNT, &key)
}

#[tauri::command]
fn delete_jev_key(state: Shared<'_>) -> AppResult<KeyStatus> {
    state.keys.delete(JEV_ACCOUNT)
}

#[tauri::command]
fn list_custom_providers(state: Shared<'_>) -> AppResult<Vec<CustomProvider>> {
    Ok(lock(&state.custom)?.list())
}

#[tauri::command]
fn save_custom_provider(state: Shared<'_>, provider: CustomProvider, api_key: Option<String>) -> AppResult<SavedProvider> {
    let mut store = lock(&state.custom)?;
    providers::save_custom(&mut store, &state.keys, &provider, api_key.as_deref())
}

#[tauri::command]
fn delete_custom_provider(state: Shared<'_>, id: String) -> AppResult<()> {
    let mut store = lock(&state.custom)?;
    providers::delete_custom(&mut store, &state.keys, &id)
}

#[tauri::command]
async fn provider_request(state: Shared<'_>, req: ProxyRequest) -> AppResult<ProxyResponse> {
    let planned = {
        let store = lock(&state.custom)?;
        providers::plan_request(&req, &state.keys, &store)?
    };
    tauri::async_runtime::spawn_blocking(move || net::execute(&planned))
        .await
        .map_err(|e| AppError::internal(e.to_string()))?
}

/// Stream a Provider response through a Tauri IPC Channel. The command stays
/// alive while async reqwest awaits the network; independent
/// `provider_stream_cancel` calls wake those waits and drop the response.
#[tauri::command]
async fn provider_stream(
    state: Shared<'_>,
    req: ProxyRequest,
    stream_id: String,
    channel: tauri::ipc::Channel<ProviderStreamEvent>,
) -> AppResult<()> {
    if stream_id.is_empty() || stream_id.len() > 128 {
        return Err(AppError::new("invalid_stream_id", "流式请求标识无效"));
    }
    let cancelled = state.streams.lock().map_err(|_| AppError::internal("lock poisoned"))?.register(&stream_id)?;
    let _registration = StreamRegistration {
        registry: &state.streams,
        id: &stream_id,
        signal: cancelled.clone(),
    };
    let planned = {
        let store = lock(&state.custom)?;
        providers::plan_request(&req, &state.keys, &store)?
    };
    let channel_done = channel.clone();
    let result = net::execute_stream(&planned, &cancelled, |part| {
        let event = match part {
            net::StreamPart::Headers(status) => ProviderStreamEvent::Headers { status },
            net::StreamPart::Chunk(data) => ProviderStreamEvent::Chunk { data },
        };
        channel.send(event).map_err(|e| AppError::internal(e.to_string()))
    }).await;
    if let Err(error) = result {
        // The frontend turns this into a stream error after any already
        // delivered deltas, preserving partial-output semantics in the Agent.
        let _ = channel_done.send(ProviderStreamEvent::Error { error });
    } else {
        let _ = channel_done.send(ProviderStreamEvent::Done);
    }
    Ok(())
}

#[tauri::command]
fn provider_stream_cancel(state: Shared<'_>, stream_id: String) -> AppResult<()> {
    if stream_id.is_empty() || stream_id.len() > 128 {
        return Err(AppError::new("invalid_stream_id", "流式请求标识无效"));
    }
    state.streams.lock().map_err(|_| AppError::internal("lock poisoned"))?.cancel(&stream_id)
}

#[derive(Clone, Serialize)]
struct McpLine {
    server: String,
    connection_id: Option<String>,
    line: String,
}

#[derive(Clone, Serialize)]
struct McpExit {
    server: String,
    connection_id: Option<String>,
    reason: String,
}

/// 登记表 mcp.json 只由用户编辑；界面只能查看、启停、保存它引用的密钥
#[tauri::command]
fn mcp_list(state: Shared<'_>) -> McpRegistryView {
    state.mcp.list()
}

/// 内置文件服务器允许访问的目录：默认项在前（不可移除），用户加的在后
#[tauri::command]
fn file_roots_list(state: Shared<'_>) -> AppResult<Vec<FileRoot>> {
    Ok(roots_lock(&state.roots)?.list())
}

/// 加入一个目录。只能由这里改：界面选中的路径经校验后写进 file-roots.json。
#[tauri::command]
fn file_roots_add(state: Shared<'_>, path: String) -> AppResult<Vec<FileRoot>> {
    state.mcp.add_file_root(&mut *roots_lock(&state.roots)?, &path)
}

/// 移除一个用户加的目录；默认目录不能移除
#[tauri::command]
fn file_roots_remove(state: Shared<'_>, path: String) -> AppResult<Vec<FileRoot>> {
    state.mcp.remove_file_root(&mut *roots_lock(&state.roots)?, &path)
}

/// 打开系统目录选择器。返回的路径仍必须经过 file_roots_add / normalizeFolders
/// 校验；这个命令只负责让桌面端获得原生选择结果，不直接授予文件读写权限。
#[tauri::command]
async fn pick_directory(app: tauri::AppHandle, default_path: Option<String>) -> AppResult<Option<String>> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut dialog = app.dialog().file().set_title("选择文件夹");
        let home = app.path().home_dir().ok();
        if let Some(path) = default_path.and_then(|value| dialog_starting_directory(&value, home.as_deref())) {
            dialog = dialog.set_directory(path);
        }
        let selected = dialog.blocking_pick_folder();
        selected
            .map(|path| path.into_path().map(|p| p.to_string_lossy().into_owned()))
            .transpose()
            .map_err(|e| AppError::internal(e.to_string()))
    })
    .await
    .map_err(|e| AppError::internal(e.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::dialog_starting_directory;
    use std::path::Path;

    #[test]
    fn dialog_path_expands_tilde_against_home_without_touching_absolute_paths() {
        let home = Path::new("/Users/tester");
        assert_eq!(dialog_starting_directory("~/Documents/合同", Some(home)).as_deref(), Some(Path::new("/Users/tester/Documents/合同")));
        assert_eq!(dialog_starting_directory("~", Some(home)).as_deref(), Some(home));
        assert_eq!(dialog_starting_directory(" /tmp/work ", Some(home)).as_deref(), Some(Path::new("/tmp/work")));
        assert_eq!(dialog_starting_directory("~/Documents", None), None);
        assert_eq!(dialog_starting_directory("   ", Some(home)), None);
    }
}

/// 只接受服务器 ID：启动命令来自 mcp.json，webview 传不进任意命令
#[tauri::command]
fn mcp_start(app: tauri::AppHandle, state: Shared<'_>, server: String, connection_id: Option<String>) -> AppResult<McpServerView> {
    if connection_id.as_ref().is_some_and(|id| {
        id.is_empty() || id.len() > 128 || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    }) {
        return Err(AppError::new("invalid_mcp_connection", "MCP 连接标识无效"));
    }
    let (a, b) = (app.clone(), app);
    let (id1, id2) = (server.clone(), server.clone());
    let (connection1, connection2) = (connection_id.clone(), connection_id.clone());
    state.mcp.start_for_connection(
        &server,
        connection_id.as_deref(),
        Arc::new(move |line: String| {
            let _ = a.emit("mcp-message", McpLine { server: id1.clone(), connection_id: connection1.clone(), line });
        }),
        Arc::new(move |reason: String| {
            let _ = b.emit("mcp-exit", McpExit { server: id2.clone(), connection_id: connection2.clone(), reason });
        }),
    )
}

#[tauri::command]
fn mcp_send(state: Shared<'_>, server: String, line: String, connection_id: Option<String>) -> AppResult<()> {
    state.mcp.send_for_connection(&server, &line, connection_id.as_deref())
}

#[tauri::command]
fn mcp_stop(state: Shared<'_>, server: String, connection_id: Option<String>) -> AppResult<bool> {
    state.mcp.stop_for_connection(&server, connection_id.as_deref())
}

#[tauri::command]
fn set_mcp_secret(state: Shared<'_>, server: String, name: String, value: String) -> AppResult<()> {
    state.mcp.set_secret(&server, &name, &value)
}

#[tauri::command]
fn delete_mcp_secret(state: Shared<'_>, server: String, name: String) -> AppResult<()> {
    state.mcp.delete_secret(&server, &name)
}

/// QA 构建专用：只有显式启用 `qa-faults` feature 且环境变量匹配时才返回故障点。
/// 普通发行构建即使收到环境变量也固定返回 None。
fn configured_qa_fault_point() -> Option<String> {
    #[cfg(feature = "qa-faults")]
    {
        let point = std::env::var("EASTGENESIS_QA_FAULT_POINT").ok()?;
        match point.as_str() {
            "after_ledger_started" | "after_tool_before_ledger_commit" => Some(point),
            _ => None,
        }
    }
    #[cfg(not(feature = "qa-faults"))]
    {
        None
    }
}

/// Native WebDriver implementations do not all inherit the environment of
/// the process that starts `tauri-driver`. Accept QA-only Provider values as
/// explicit application arguments as a fallback, while retaining environment
/// variables for local runs. These flags are compiled out of release builds;
/// the base URL is still restricted to loopback below.
#[cfg(feature = "qa-faults")]
fn qa_arg(name: &str) -> Option<String> {
    let prefix = format!("{name}=");
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        if arg == name {
            return args.next().filter(|value| !value.trim().is_empty());
        }
        if let Some(value) = arg.strip_prefix(&prefix) {
            return (!value.trim().is_empty()).then(|| value.to_string());
        }
    }
    None
}

#[cfg(feature = "qa-faults")]
fn qa_setting(env_name: &str, arg_name: &str) -> Option<String> {
    std::env::var(env_name).ok().filter(|value| !value.trim().is_empty()).or_else(|| qa_arg(arg_name))
}

#[cfg(any(feature = "qa-faults", test))]
fn qa_loopback_url(value: &str) -> bool {
    let has_userinfo = value.trim().split_once("://").is_some_and(|(_, rest)| {
        rest.split(['/', '?', '#']).next().is_some_and(|authority| authority.contains('@'))
    });
    reqwest::Url::parse(value).is_ok_and(|url| {
        !has_userinfo && url.scheme() == "http" && url.username().is_empty() && url.password().is_none()
            && matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"))
    })
}

#[cfg(test)]
mod qa_url_tests {
    use super::qa_loopback_url;
    #[test]
    fn permits_only_exact_http_loopback_without_credentials() {
        for value in ["http://localhost/v1", "http://127.0.0.1:1234/v1", "http://[::1]:1234/v1"] { assert!(qa_loopback_url(value)); }
        for value in ["http://localhost.evil/v1", "http://127.0.0.1.evil/v1", "http://@localhost/v1", "http://user@localhost/v1", "http://user:pass@127.0.0.1/v1", "https://localhost/v1", "http://192.0.2.1/v1", "not-a-url"] { assert!(!qa_loopback_url(value)); }
    }
}

#[tauri::command]
fn qa_fault_point() -> Option<String> {
    configured_qa_fault_point()
}

/// Short leases are only available in explicitly enabled fault-test builds.
/// They preserve the active-lease guard while bounding isolated smoke waits.
#[tauri::command]
fn qa_ledger_lease_ms() -> Option<u64> {
    #[cfg(feature = "qa-faults")]
    {
        let value = std::env::var("EASTGENESIS_QA_LEDGER_LEASE_MS").ok()?.parse::<u64>().ok()?;
        (1_000..=120_000).contains(&value).then_some(value)
    }
    #[cfg(not(feature = "qa-faults"))]
    { None }
}

/// QA 构建专用的硬终止：调用发生在最终账本提交前，模拟桌面进程崩溃窗口。
#[tauri::command]
fn qa_fault_exit(point: String) -> AppResult<()> {
    let configured = configured_qa_fault_point().ok_or_else(|| AppError::new("qa_faults_disabled", "当前构建没有启用桌面故障夹具"))?;
    if configured != point {
        return Err(AppError::new("qa_fault_point_mismatch", "请求的故障点与启动时配置不一致"));
    }
    std::process::abort()
}

fn migrations() -> Vec<Migration> {
    eg_core::MIGRATIONS
        .iter()
        .map(|(version, description, sql)| Migration { version: *version, description, sql, kind: MigrationKind::Up })
        .collect()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let context = qa_install_probe::embedded_context();
    #[cfg(feature = "qa-faults")]
    let diagnostics = qa_startup_diagnostics::initialize(context.config());
    #[cfg(feature = "qa-faults")]
    qa_startup_diagnostics::record(qa_startup_diagnostics::Stage::BuilderStarted);
    let sql_plugin = tauri_plugin_sql::Builder::default()
        .add_migrations("sqlite:eastgenesis.db", migrations());
    #[cfg(feature = "qa-faults")]
    let sql_plugin = if diagnostics.is_some() {
        sql_plugin.with_qa_load_observer("sqlite:eastgenesis.db", qa_startup_diagnostics::record_sql_load)
    } else {
        sql_plugin
    };
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(sql_plugin.build());
    #[cfg(feature = "qa-faults")]
    let builder = if let Some(plugin) = diagnostics { builder.plugin(plugin) } else { builder };
    let builder = builder
        .setup(|app| {
            #[cfg(feature = "qa-faults")]
            qa_startup_diagnostics::record(qa_startup_diagnostics::Stage::SetupStarted);
            let result = (|| -> Result<(), Box<dyn std::error::Error>> {
                let dir = app.path().app_config_dir().inspect(|_| {
                    #[cfg(feature = "qa-faults")]
                    qa_startup_diagnostics::record(qa_startup_diagnostics::Stage::AppConfigPathResolved);
                }).inspect_err(|_| {
                    #[cfg(feature = "qa-faults")]
                    qa_startup_diagnostics::record(qa_startup_diagnostics::Stage::AppConfigPathFailed);
                })?;
                let custom = CustomProviderStore::load(dir.join("providers.json")).inspect(|_| {
                    #[cfg(feature = "qa-faults")]
                    qa_startup_diagnostics::record(qa_startup_diagnostics::Stage::ProviderStoreLoaded);
                }).inspect_err(|_| {
                    #[cfg(feature = "qa-faults")]
                    qa_startup_diagnostics::record(qa_startup_diagnostics::Stage::ProviderStoreFailed);
                })?;
                let keys = KeyService::from_process_env(keychain::KeyringStore);
                // A QA-only local Provider lets native WebDriver smoke exercise the
                // complete route -> proxy -> SSE -> task-card path without a real
                // account or writing a fixture into the user's providers.json.
                #[cfg(feature = "qa-faults")]
                let mut custom = custom;
                #[cfg(feature = "qa-faults")]
                if let Some(base_url) = qa_setting("EASTGENESIS_QA_PROVIDER_BASE_URL", "--eg-qa-provider-base-url")
                {
                    if !qa_loopback_url(&base_url) {
                        return Err(Box::new(AppError::new(
                            "qa_provider_not_local",
                            "QA Provider 只能指向本机回环地址",
                        )));
                    }
                    let protocol = match qa_setting("EASTGENESIS_QA_PROVIDER_PROTOCOL", "--eg-qa-provider-protocol").as_deref() {
                        Some("anthropic") => Protocol::Anthropic,
                        _ => Protocol::Openai,
                    };
                    let default_model = qa_setting("EASTGENESIS_QA_PROVIDER_MODEL", "--eg-qa-provider-model").unwrap_or_else(|| "fixture-model".to_string());
                    custom.insert_ephemeral(&CustomProvider {
                        id: "custom:qa".to_string(),
                        label: "QA Fixture".to_string(),
                        base_url,
                        default_model: default_model.clone(),
                        headers: BTreeMap::new(),
                        protocol,
                        models: vec![default_model],
                    })?;
                }
                let mcp_path = dir.join("mcp.json");
                let hint = path_hint(&mcp_path, app.path().home_dir().ok().as_deref());
                // 环境变量快照：${env:NAME} 从这里取；模型 Provider 和 Jev 的 Key 变量由 McpService 剔除
                let env: HashMap<String, String> =
                    std::env::vars_os().filter_map(|(k, v)| Some((k.into_string().ok()?, v.into_string().ok()?))).collect();
                // 内置文件服务器：应用自身以 --mcp-files 子进程方式启动，只能访问允许列表里的目录
                // （默认 ~/Downloads；用户选的目录存在 file-roots.json，读不出时退回默认）
                let home = app.path().home_dir().ok();
                let roots = FileRootsStore::load(dir.join("file-roots.json"), home.clone()).unwrap_or_default();
                let builtin: Vec<_> = std::env::current_exe()
                    .ok()
                    .and_then(|p| p.to_str().map(String::from))
                    .map(|exe| vec![eg_core::mcp_files::builtin_entry(&exe, &["--mcp-files"], &roots.raw_roots())])
                    .unwrap_or_default();
                app.manage(Arc::new(AppState {
                    keys,
                    custom: Mutex::new(custom),
                    roots: Mutex::new(roots),
                    mcp: McpService::new(mcp_path, hint, env, keychain::KeyringStore).with_builtin(builtin),
                    streams: Mutex::new(net::StreamRegistry::default()),
                }));
                #[cfg(feature = "qa-faults")]
                qa_startup_diagnostics::record(qa_startup_diagnostics::Stage::NativeStateReady);
                Ok(())
            })();
            #[cfg(feature = "qa-faults")]
            qa_startup_diagnostics::record(if result.is_ok() {
                qa_startup_diagnostics::Stage::SetupFinished
            } else { qa_startup_diagnostics::Stage::SetupFailed });
            result
        })
        .invoke_handler(tauri::generate_handler![
            get_app_info,
            get_provider_status,
            set_provider_key,
            delete_provider_key,
            get_jev_status,
            set_jev_key,
            delete_jev_key,
            list_custom_providers,
            save_custom_provider,
            delete_custom_provider,
            provider_request,
            provider_stream,
            provider_stream_cancel,
            mcp_list,
            file_roots_list,
            file_roots_add,
            file_roots_remove,
            pick_directory,
            mcp_start,
            mcp_send,
            mcp_stop,
            set_mcp_secret,
            delete_mcp_secret,
            qa_fault_point,
            qa_ledger_lease_ms,
            qa_fault_exit,
            #[cfg(feature = "qa-faults")]
            qa_startup_diagnostics::qa_startup_record
        ])
        .build(context);
    #[cfg(feature = "qa-faults")]
    qa_startup_diagnostics::record(if builder.is_ok() {
        qa_startup_diagnostics::Stage::BuilderFinished
    } else { qa_startup_diagnostics::Stage::BuilderFailed });
    builder.expect("EastGenesis Desktop 启动失败").run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(s) = app.try_state::<Arc<AppState>>() {
                    s.mcp.stop_all();
                }
            }
        });
}

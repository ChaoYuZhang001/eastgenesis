//! Tauri 外壳：只注册插件和命令，逻辑都在 eg-core（可在任何环境 cargo test）。
//! 命令名 snake_case，错误统一为 eg_core::AppError { code, message, detail }。
//! 前端拿不到任何 Key：set_* 只进不出，get_* 只返回「已配置 / 未配置」，模型请求经 provider_request 由这里代理。

mod keychain;
mod net;

use std::collections::HashMap;
#[cfg(feature = "qa-faults")]
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use eg_core::mcp_service::{path_hint, McpRegistryView, McpServerView, McpService};
use eg_core::providers::{self, CustomProvider, CustomProviderStore, ProxyRequest, ProxyResponse, SavedProvider};
#[cfg(feature = "qa-faults")]
use eg_core::providers::Protocol;
use eg_core::secrets::{validate_provider_id, KeyService, KeyStatus, JEV_ACCOUNT};
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
    /// Cancellation flags for in-flight Provider streams. The body itself is
    /// delivered over a Tauri Channel so the webview can render SSE deltas.
    streams: Mutex<HashMap<String, Arc<AtomicBool>>>,
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

fn roots_lock(m: &Mutex<FileRootsStore>) -> AppResult<MutexGuard<'_, FileRootsStore>> {
    m.lock().map_err(|_| AppError::internal("lock poisoned"))
}

#[tauri::command]
fn get_app_info(app: tauri::AppHandle) -> AppResult<AppInfo> {
    Ok(eg_core::app_info(&app.package_info().version.to_string()))
}

#[tauri::command]
fn get_provider_status(state: Shared<'_>) -> AppResult<Vec<KeyStatus>> {
    let ids = lock(&state.custom)?.ids();
    state.keys.statuses(&ids)
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
    state.keys.status(JEV_ACCOUNT)
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
/// alive while the blocking ureq reader runs on a worker thread; independent
/// `provider_stream_cancel` calls can set the cancellation flag meanwhile.
#[tauri::command]
async fn provider_stream(
    state: Shared<'_>,
    req: ProxyRequest,
    stream_id: String,
    channel: tauri::ipc::Channel<ProviderStreamEvent>,
) -> AppResult<()> {
    let planned = {
        let store = lock(&state.custom)?;
        providers::plan_request(&req, &state.keys, &store)?
    };
    if stream_id.is_empty() || stream_id.len() > 128 {
        return Err(AppError::new("invalid_stream_id", "流式请求标识无效"));
    }
    let cancelled = Arc::new(AtomicBool::new(false));
    state.streams.lock().map_err(|_| AppError::internal("lock poisoned"))?.insert(stream_id.clone(), cancelled.clone());
    let channel_done = channel.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        net::execute_stream(&planned, &cancelled, |part| {
            let event = match part {
                net::StreamPart::Headers(status) => ProviderStreamEvent::Headers { status },
                net::StreamPart::Chunk(data) => ProviderStreamEvent::Chunk { data },
            };
            channel.send(event).map_err(|e| AppError::internal(e.to_string()))
        })
    })
    .await
    .map_err(|e| AppError::internal(e.to_string()))?;
    if let Err(error) = result {
        // The frontend turns this into a stream error after any already
        // delivered deltas, preserving partial-output semantics in the Agent.
        let _ = channel_done.send(ProviderStreamEvent::Error { error });
    } else {
        let _ = channel_done.send(ProviderStreamEvent::Done);
    }
    state.streams.lock().map_err(|_| AppError::internal("lock poisoned"))?.remove(&stream_id);
    Ok(())
}

#[tauri::command]
fn provider_stream_cancel(state: Shared<'_>, stream_id: String) -> AppResult<()> {
    if let Some(flag) = state.streams.lock().map_err(|_| AppError::internal("lock poisoned"))?.get(&stream_id) {
        flag.store(true, Ordering::Relaxed);
    }
    Ok(())
}

#[derive(Clone, Serialize)]
struct McpLine {
    server: String,
    line: String,
}

#[derive(Clone, Serialize)]
struct McpExit {
    server: String,
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
    roots_lock(&state.roots)?.add(&path)
}

/// 移除一个用户加的目录；默认目录不能移除
#[tauri::command]
fn file_roots_remove(state: Shared<'_>, path: String) -> AppResult<Vec<FileRoot>> {
    let removed = roots_lock(&state.roots)?.remove(&path)?;
    if !removed {
        return Err(AppError::new("root_not_found", "这个目录不在允许列表里"));
    }
    Ok(roots_lock(&state.roots)?.list())
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
fn mcp_start(app: tauri::AppHandle, state: Shared<'_>, server: String) -> AppResult<McpServerView> {
    let (a, b) = (app.clone(), app);
    let (id1, id2) = (server.clone(), server.clone());
    state.mcp.start(
        &server,
        Arc::new(move |line: String| {
            let _ = a.emit("mcp-message", McpLine { server: id1.clone(), line });
        }),
        Arc::new(move |reason: String| {
            let _ = b.emit("mcp-exit", McpExit { server: id2.clone(), reason });
        }),
    )
}

#[tauri::command]
fn mcp_send(state: Shared<'_>, server: String, line: String) -> AppResult<()> {
    state.mcp.send(&server, &line)
}

#[tauri::command]
fn mcp_stop(state: Shared<'_>, server: String) -> AppResult<bool> {
    state.mcp.stop(&server)
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

#[tauri::command]
fn qa_fault_point() -> Option<String> {
    configured_qa_fault_point()
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
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_sql::Builder::default().add_migrations("sqlite:eastgenesis.db", migrations()).build())
        .setup(|app| {
            let dir = app.path().app_config_dir()?;
            let custom = CustomProviderStore::load(dir.join("providers.json"))?;
            let keys = KeyService::from_process_env(keychain::KeyringStore);
            // A QA-only local Provider lets native WebDriver smoke exercise the
            // complete route -> proxy -> SSE -> task-card path without a real
            // account or writing a fixture into the user's providers.json.
            #[cfg(feature = "qa-faults")]
            let mut custom = custom;
            #[cfg(feature = "qa-faults")]
            if let Some(base_url) = std::env::var_os("EASTGENESIS_QA_PROVIDER_BASE_URL")
                .and_then(|v| v.into_string().ok())
                .filter(|v| !v.trim().is_empty())
            {
                let is_loopback = ["http://127.0.0.1", "http://localhost", "http://[::1]"]
                    .iter()
                    .any(|prefix| base_url.starts_with(prefix));
                if !is_loopback {
                    return Err(Box::new(AppError::new(
                        "qa_provider_not_local",
                        "QA Provider 只能指向本机回环地址",
                    )));
                }
                let protocol = match std::env::var("EASTGENESIS_QA_PROVIDER_PROTOCOL").ok().as_deref() {
                    Some("anthropic") => Protocol::Anthropic,
                    _ => Protocol::Openai,
                };
                let default_model = std::env::var("EASTGENESIS_QA_PROVIDER_MODEL")
                    .ok()
                    .filter(|v| !v.trim().is_empty())
                    .unwrap_or_else(|| "fixture-model".to_string());
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
                streams: Mutex::new(HashMap::new()),
            }));
            Ok(())
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
            qa_fault_exit
        ])
        .build(tauri::generate_context!())
        .expect("EastGenesis Desktop 启动失败")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(s) = app.try_state::<Arc<AppState>>() {
                    s.mcp.stop_all();
                }
            }
        });
}

//! Tauri 外壳：只注册插件和命令，逻辑都在 eg-core（可在任何环境 cargo test）。
//! 命令名 snake_case，错误统一为 eg_core::AppError { code, message, detail }。
//! 前端拿不到任何 Key：set_* 只进不出，get_* 只返回「已配置 / 未配置」，模型请求经 provider_request 由这里代理。

mod keychain;
mod net;

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};

use eg_core::mcp_service::{path_hint, McpRegistryView, McpServerView, McpService};
use eg_core::providers::{self, CustomProvider, CustomProviderStore, ProxyRequest, ProxyResponse, SavedProvider};
use eg_core::secrets::{validate_provider_id, KeyService, KeyStatus, JEV_ACCOUNT};
use eg_core::{AppError, AppInfo, AppResult};
use serde::Serialize;
use tauri::{Emitter, Manager, State};
use tauri_plugin_sql::{Migration, MigrationKind};

struct AppState {
    keys: KeyService<keychain::KeyringStore>,
    custom: Mutex<CustomProviderStore>,
    mcp: McpService<keychain::KeyringStore>,
}

type Shared<'a> = State<'a, Arc<AppState>>;

fn lock(m: &Mutex<CustomProviderStore>) -> AppResult<MutexGuard<'_, CustomProviderStore>> {
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

fn migrations() -> Vec<Migration> {
    eg_core::MIGRATIONS
        .iter()
        .map(|(version, description, sql)| Migration { version: *version, description, sql, kind: MigrationKind::Up })
        .collect()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_sql::Builder::default().add_migrations("sqlite:eastgenesis.db", migrations()).build())
        .setup(|app| {
            let dir = app.path().app_config_dir()?;
            let custom = CustomProviderStore::load(dir.join("providers.json"))?;
            let mcp_path = dir.join("mcp.json");
            let hint = path_hint(&mcp_path, app.path().home_dir().ok().as_deref());
            // 环境变量快照：${env:NAME} 从这里取；模型 Provider 和 Jev 的 Key 变量由 McpService 剔除
            let env: HashMap<String, String> =
                std::env::vars_os().filter_map(|(k, v)| Some((k.into_string().ok()?, v.into_string().ok()?))).collect();
            // 内置文件服务器：应用自身以 --mcp-files 子进程方式启动，只能访问 ~/Downloads
            let builtin: Vec<_> = std::env::current_exe()
                .ok()
                .and_then(|p| p.to_str().map(String::from))
                .map(|exe| vec![eg_core::mcp_files::builtin_entry(&exe, &["--mcp-files"])])
                .unwrap_or_default();
            app.manage(Arc::new(AppState {
                keys: KeyService::from_process_env(keychain::KeyringStore),
                custom: Mutex::new(custom),
                mcp: McpService::new(mcp_path, hint, env, keychain::KeyringStore).with_builtin(builtin),
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
            mcp_list,
            mcp_start,
            mcp_send,
            mcp_stop,
            set_mcp_secret,
            delete_mcp_secret
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

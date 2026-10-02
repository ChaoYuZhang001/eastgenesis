//! 桌面端 MCP 服务：读 mcp.json 登记表、解析密钥引用、只启动登记过的服务器、检查发出的消息。
//! src-tauri 的 mcp_* 命令只是它的薄封装。

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};

use serde::Serialize;

use crate::error::{AppError, AppResult};
use crate::mcp_guard::check_outgoing;
use crate::mcp_host::{LineFn, McpHost};
use crate::mcp_registry::{parse_registry, AllowTools, EntryError, McpEntry, Registry};
use crate::mcp_secrets::McpSecrets;
pub use crate::mcp_resolve::path_hint;
use crate::mcp_resolve::resolve;
use crate::mcp_template::{protected_env, RefSource};
use crate::secrets::SecretStore;

/// 引用的密钥：只有「是否已提供」，没有值
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct RefStatus {
    pub source: RefSource,
    pub name: String,
    pub configured: bool,
}

/// 界面看到的服务器：配置原文（里面只有引用，没有密钥值）+ 运行状态
#[derive(Debug, Clone, Serialize)]
pub struct McpServerView {
    pub id: String,
    pub command: String,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
    pub cwd: Option<String>,
    pub allow_tools: AllowTools,
    pub trust_annotations: bool,
    pub refs: Vec<RefStatus>,
    pub running: bool,
    /// 最近的 stderr（已脱敏），用于诊断启动失败
    pub stderr_tail: Option<String>,
    /// 应用内置的服务器（不在 mcp.json 里，界面不能停用其白名单）
    pub builtin: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct McpRegistryView {
    /// 形如 `~/Library/Application Support/<应用 ID>/mcp.json`，不含用户名
    pub path_hint: String,
    pub servers: Vec<McpServerView>,
    pub errors: Vec<EntryError>,
}

pub struct McpService<S: SecretStore> {
    host: McpHost,
    path: PathBuf,
    path_hint: String,
    env: HashMap<String, String>,
    secrets: McpSecrets<S>,
    /// 启动时从登记表取的白名单；运行期间改 mcp.json 要重启服务器才生效
    policies: Mutex<HashMap<String, AllowTools>>,
    /// 内置服务器：由应用自己登记，优先于 mcp.json 里的同名条目
    builtin: Vec<McpEntry>,
}

fn not_registered() -> AppError {
    AppError::new("mcp_not_registered", "mcp.json 里没有登记这个 MCP 服务器")
}

impl<S: SecretStore> McpService<S> {
    /// env：应用启动时的环境变量快照；模型 Provider 和 Jev 的 Key 变量直接剔除
    pub fn new(path: PathBuf, path_hint: String, mut env: HashMap<String, String>, store: S) -> Self {
        env.retain(|k, _| !protected_env(k));
        Self {
            host: McpHost::default(),
            path,
            path_hint,
            env,
            secrets: McpSecrets::new(store),
            policies: Mutex::new(HashMap::new()),
            builtin: Vec::new(),
        }
    }

    /// 登记内置服务器（例如 mcp_files::builtin_entry）
    pub fn with_builtin(mut self, entries: Vec<McpEntry>) -> Self {
        self.builtin = entries;
        self
    }

    fn policies(&self) -> AppResult<MutexGuard<'_, HashMap<String, AllowTools>>> {
        self.policies.lock().map_err(|_| AppError::internal("lock poisoned"))
    }

    /// 每次都重新读文件：用户改完 mcp.json 点「刷新」即可，不用重启应用
    fn user_registry(&self) -> AppResult<Registry> {
        match std::fs::read_to_string(&self.path) {
            Ok(s) => parse_registry(&s),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Registry::default()),
            Err(e) => Err(AppError::new("mcp_config_read_failed", "无法读取 mcp.json").with_detail(e.to_string())),
        }
    }

    fn is_builtin(&self, id: &str) -> bool {
        self.builtin.iter().any(|b| b.id == id)
    }

    /// 按 ID 找登记项：先内置，再 mcp.json
    fn entry(&self, id: &str) -> AppResult<McpEntry> {
        if let Some(e) = self.builtin.iter().find(|e| e.id == id) {
            return Ok(e.clone());
        }
        self.user_registry()?.entries.remove(id).ok_or_else(not_registered)
    }

    /// 内置服务器总在最前；mcp.json 损坏时内置服务器照常列出
    pub fn list(&self) -> McpRegistryView {
        let mut servers: Vec<McpServerView> = self.builtin.iter().map(|e| self.view(e, true)).collect();
        let mut errors = Vec::new();
        match self.user_registry() {
            Ok(r) => {
                for e in r.entries.values() {
                    if self.is_builtin(&e.id) {
                        errors.push(EntryError { id: e.id.clone(), message: "与内置 MCP 服务器同名，已忽略".into() });
                    } else {
                        servers.push(self.view(e, false));
                    }
                }
                errors.extend(r.errors);
            }
            Err(e) => {
                let detail = e.detail.map(|d| format!("（{d}）")).unwrap_or_default();
                errors.push(EntryError { id: "mcp.json".into(), message: format!("{}{detail}", e.message) });
            }
        }
        McpRegistryView { path_hint: self.path_hint.clone(), servers, errors }
    }

    fn view(&self, e: &McpEntry, builtin: bool) -> McpServerView {
        let refs = e
            .refs()
            .into_iter()
            .map(|(source, name)| {
                let configured = match source {
                    // 钥匙串暂时不可用时显示为未提供，不让整个列表失败
                    RefSource::Keychain => self.secrets.configured(&e.id, &name).unwrap_or(false),
                    RefSource::Env => self.env.get(&name).is_some_and(|v| !v.is_empty()),
                };
                RefStatus { source, name, configured }
            })
            .collect();
        McpServerView {
            id: e.id.clone(),
            // 内置服务器是应用程序本身：只显示文件名，不暴露安装路径
            command: if builtin {
                std::path::Path::new(&e.command).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
            } else {
                e.command.clone()
            },
            args: e.args.iter().map(|t| t.raw.clone()).collect(),
            env: e.env.iter().map(|(k, t)| (k.clone(), t.raw.clone())).collect(),
            cwd: e.cwd.clone(),
            allow_tools: e.allow_tools.clone(),
            trust_annotations: e.trust_annotations,
            refs,
            running: self.host.running(&e.id),
            stderr_tail: self.host.stderr_tail(&e.id).filter(|s| !s.trim().is_empty()),
            builtin,
        }
    }

    /// 只能按 ID 启动登记过的服务器；返回启动时生效的配置（前端按它注册工具）
    pub fn start(&self, id: &str, on_line: LineFn, on_exit: LineFn) -> AppResult<McpServerView> {
        let e = self.entry(id)?;
        let cfg = resolve(&e, &self.env, &self.secrets)?;
        self.host.start(&cfg, &self.env, on_line, on_exit)?;
        self.policies()?.insert(e.id.clone(), e.allow_tools.clone());
        Ok(self.view(&e, self.is_builtin(&e.id)))
    }

    pub fn send(&self, id: &str, line: &str) -> AppResult<()> {
        let allow = self.policies()?.get(id).cloned();
        let allow = allow.ok_or_else(|| AppError::new("mcp_not_running", "这个 MCP 服务器没有运行"))?;
        self.host.send(id, &check_outgoing(line, &allow)?)
    }

    pub fn stop(&self, id: &str) -> AppResult<bool> {
        self.policies()?.remove(id);
        self.host.stop(id)
    }

    pub fn stop_all(&self) {
        if let Ok(mut p) = self.policies.lock() {
            p.clear();
        }
        self.host.stop_all();
    }

    /// 只能写 mcp.json 里确实引用了的钥匙串条目
    pub fn set_secret(&self, server: &str, name: &str, value: &str) -> AppResult<()> {
        let e = self.entry(server)?;
        if !e.refs().iter().any(|(s, n)| *s == RefSource::Keychain && n == name) {
            return Err(AppError::new("mcp_secret_not_referenced", "mcp.json 里这个服务器没有引用这个钥匙串条目"));
        }
        self.secrets.set(server, name, value)
    }

    pub fn delete_secret(&self, server: &str, name: &str) -> AppResult<()> {
        self.secrets.delete(server, name)
    }
}

#[cfg(all(test, unix))]
#[path = "mcp_service_tests.rs"]
mod tests;

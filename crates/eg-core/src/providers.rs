//! Provider 请求代理（桌面端）。前端只提交 { target, method, url, body }，由 Rust：
//! 1. 只放行该目标的固定端点（base URL + 白名单路径）。自定义 Provider 的 base URL 取自 Rust 侧配置，不信任请求里的地址；
//! 2. 丢弃前端带来的所有请求头，由 Rust 从钥匙串或环境变量读取 Key 并加上鉴权头；
//! 3. 返回前把响应里出现的 Key 逐字抹掉。
//! 这样即使 webview 被攻破，也无法把 Key 发到别的主机。

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::secrets::{is_custom_id, validate_key, KeyService, KeyStatus, SecretStore, JEV_ACCOUNT};

pub const MAX_BODY: usize = 4 * 1024 * 1024;
pub const MAX_RESPONSE: usize = 16 * 1024 * 1024;

const OPENAI_PATHS: &[&str] = &["/chat/completions", "/models"];
const ANTHROPIC_PATHS: &[&str] = &["/messages", "/models"];
const JEV_PATHS: &[&str] = &["/v1/systemone", "/v1/models"];
const RESERVED: &[&str] = &[
    "authorization", "x-api-key", "anthropic-version", "content-type", "content-length", "host", "cookie", "accept", "connection",
    "transfer-encoding",
];
/// 附加请求头以明文保存在配置文件里，看起来像凭据的一律拒绝，改用 API Key 字段（存钥匙串）
const SECRET_LIKE: &[&str] = &["token", "key", "secret", "auth", "cookie", "password", "session", "signature"];

fn is_local_host(host: &str) -> bool {
    matches!(host, "localhost" | "127.0.0.1" | "[::1]")
}

fn url_host(u: &str) -> &str {
    let a = u.split_once("://").map_or("", |(_, r)| r.split('/').next().unwrap_or(""));
    if a.starts_with('[') {
        a.find(']').map_or(a, |i| &a[..=i])
    } else {
        a.split(':').next().unwrap_or(a)
    }
}

/// 规范化 base URL：https（本机地址可用 http）；不能有账号密码、查询参数、锚点、`.` / `..` 或编码字符；
/// 主机名转小写，去掉默认端口和末尾斜杠（与前端 `new URL()` 的结果一致）
pub fn validate_base_url(raw: &str) -> AppResult<String> {
    let bad = |m: &str| AppError::new("invalid_base_url", format!("baseUrl 无效：{m}"));
    let s = raw.trim();
    if s.len() > 2048 || s.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(bad("包含空白或过长"));
    }
    if s.contains(['?', '#', '\\', '%']) {
        return Err(bad("不能带查询参数、锚点或编码字符"));
    }
    let (scheme, rest) = s.split_once("://").ok_or_else(|| bad("缺少协议"))?;
    let scheme = scheme.to_ascii_lowercase();
    let (authority, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, ""),
    };
    if authority.is_empty() || authority.contains('@') {
        return Err(bad("不能包含账号或密码"));
    }
    let authority = authority.to_ascii_lowercase();
    let (host, port) = if authority.starts_with('[') {
        let end = authority.find(']').ok_or_else(|| bad("IPv6 地址格式错误"))?;
        let tail = &authority[end + 1..];
        let port = match tail.strip_prefix(':') {
            Some(p) => Some(p),
            None if tail.is_empty() => None,
            None => return Err(bad("端口格式错误")),
        };
        (authority[..=end].to_string(), port)
    } else {
        match authority.rsplit_once(':') {
            Some((h, p)) => (h.to_string(), Some(p)),
            None => (authority.clone(), None),
        }
    };
    let host_ok = if host.starts_with('[') {
        host.len() > 2 && host[1..host.len() - 1].chars().all(|c| c.is_ascii_hexdigit() || c == ':')
    } else {
        !host.is_empty() && host.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
    };
    if !host_ok {
        return Err(bad("主机名无效"));
    }
    let port = match port {
        Some(p) => match p.parse::<u16>() {
            Ok(n) if n > 0 => Some(n),
            _ => return Err(bad("端口无效")),
        },
        None => None,
    };
    match scheme.as_str() {
        "https" => {}
        "http" if is_local_host(&host) => {}
        _ => return Err(bad("必须使用 https（本机地址除外）")),
    }
    let path = path.trim_end_matches('/');
    if path.contains("//") || path.split('/').any(|seg| seg == "." || seg == "..") {
        return Err(bad("路径不能包含 . 或 .."));
    }
    let default_port = if scheme == "https" { 443 } else { 80 };
    let port = port.filter(|p| *p != default_port).map(|p| format!(":{p}")).unwrap_or_default();
    Ok(format!("{scheme}://{host}{port}{path}"))
}

/// 自定义端点说哪种协议。决定鉴权头和允许的路径
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Protocol {
    /// OpenAI Chat Completions：Bearer
    #[default]
    Openai,
    /// Anthropic Messages：x-api-key + anthropic-version
    Anthropic,
}

/// 每个自定义 Provider 最多登记的模型数
pub const MAX_CUSTOM_MODELS: usize = 32;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CustomProvider {
    pub id: String,
    pub label: String,
    pub base_url: String,
    pub default_model: String,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    /// 旧配置没有这两个字段：按 OpenAI 协议、只有默认模型处理
    #[serde(default)]
    pub protocol: Protocol,
    /// 参与路由的模型，保存时规整为「默认模型在第一个、去重」
    #[serde(default)]
    pub models: Vec<String>,
}

fn valid_model(m: &str) -> bool {
    !m.is_empty() && m.len() <= 128 && !m.chars().any(|c| c.is_whitespace() || c.is_control())
}

pub fn validate_custom(p: &CustomProvider) -> AppResult<CustomProvider> {
    let bad = |m: &str| AppError::new("invalid_provider_config", m.to_string());
    if !is_custom_id(&p.id) {
        return Err(bad("ID 应为 custom:<名称>，名称由小写字母、数字、_ 或 - 组成"));
    }
    let label = p.label.trim();
    if label.is_empty() || label.chars().count() > 64 {
        return Err(bad("名称应为 1–64 个字符"));
    }
    let model = p.default_model.trim();
    if !valid_model(model) {
        return Err(bad("默认模型名无效"));
    }
    let mut models = vec![model.to_string()];
    for m in p.models.iter().map(|m| m.trim()).filter(|m| !m.is_empty()) {
        if !valid_model(m) {
            return Err(bad("模型名无效：不能含空白或控制字符，最长 128 个字符"));
        }
        if !models.iter().any(|x| x == m) {
            models.push(m.to_string());
        }
    }
    if models.len() > MAX_CUSTOM_MODELS {
        return Err(bad("每个自定义 Provider 最多登记 32 个模型"));
    }
    let base_url = validate_base_url(&p.base_url)?;
    if p.headers.len() > 16 {
        return Err(bad("附加请求头最多 16 个"));
    }
    let mut headers = BTreeMap::new();
    for (k, v) in &p.headers {
        let k = k.trim().to_ascii_lowercase();
        if k.is_empty() || k.len() > 64 || !k.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
            return Err(bad("请求头名称无效"));
        }
        if RESERVED.contains(&k.as_str()) {
            return Err(bad("不能覆盖保留的请求头"));
        }
        if SECRET_LIKE.iter().any(|s| k.contains(s)) {
            return Err(bad("看起来是凭据的请求头请改用 API Key 字段（附加请求头以明文保存）"));
        }
        if v.len() > 512 || v.chars().any(|c| c.is_control()) {
            return Err(bad("请求头的值无效"));
        }
        headers.insert(k, v.trim().to_string());
    }
    Ok(CustomProvider { id: p.id.clone(), label: label.to_string(), base_url, default_model: model.to_string(), headers, protocol: p.protocol, models })
}

/// 自定义 Provider 的非敏感配置，保存在应用配置目录的 providers.json；Key 存钥匙串
#[derive(Debug, Default)]
pub struct CustomProviderStore {
    path: Option<PathBuf>,
    items: BTreeMap<String, CustomProvider>,
}

fn write_err(e: std::io::Error) -> AppError {
    AppError::new("config_write_failed", "无法保存自定义 Provider 配置").with_detail(e.to_string())
}

impl CustomProviderStore {
    pub fn load(path: impl Into<PathBuf>) -> AppResult<Self> {
        let path = path.into();
        let items = match std::fs::read_to_string(&path) {
            Ok(s) => serde_json::from_str::<Vec<CustomProvider>>(&s)
                .map_err(|e| AppError::new("config_corrupt", "自定义 Provider 配置文件损坏").with_detail(e.to_string()))?
                .iter()
                .filter_map(|p| validate_custom(p).ok())
                .map(|p| (p.id.clone(), p))
                .collect(),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => BTreeMap::new(),
            Err(e) => return Err(AppError::new("config_read_failed", "无法读取自定义 Provider 配置").with_detail(e.to_string())),
        };
        Ok(Self { path: Some(path), items })
    }

    pub fn in_memory() -> Self {
        Self::default()
    }

    pub fn list(&self) -> Vec<CustomProvider> {
        self.items.values().cloned().collect()
    }

    pub fn ids(&self) -> Vec<String> {
        self.items.keys().cloned().collect()
    }

    pub fn get(&self, id: &str) -> Option<&CustomProvider> {
        self.items.get(id)
    }

    /// Insert a validated provider without persisting it.  This is used by
    /// desktop QA fixtures so a test endpoint never becomes part of a user's
    /// provider configuration.
    pub fn insert_ephemeral(&mut self, p: &CustomProvider) -> AppResult<()> {
        let v = validate_custom(p)?;
        self.items.insert(v.id.clone(), v);
        Ok(())
    }

    /// 返回（保存后的配置，base URL 是否相对已有配置发生了变化）
    fn upsert(&mut self, p: &CustomProvider) -> AppResult<(CustomProvider, bool)> {
        let v = validate_custom(p)?;
        let changed = self.items.get(&v.id).is_some_and(|old| old.base_url != v.base_url);
        self.items.insert(v.id.clone(), v.clone());
        self.persist()?;
        Ok((v, changed))
    }

    fn remove(&mut self, id: &str) -> AppResult<bool> {
        let had = self.items.remove(id).is_some();
        if had {
            self.persist()?;
        }
        Ok(had)
    }

    fn persist(&self) -> AppResult<()> {
        let Some(path) = &self.path else { return Ok(()) };
        let json = serde_json::to_string_pretty(&self.list()).map_err(|e| AppError::internal(e.to_string()))?;
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(write_err)?;
        }
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, json).map_err(write_err)?;
        std::fs::rename(&tmp, path).map_err(write_err)
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct SavedProvider {
    pub provider: CustomProvider,
    pub key: KeyStatus,
    /// base URL 改了、又没有提供新 Key：旧 Key 可能属于别的服务，已清除
    pub key_cleared: bool,
}

pub fn save_custom<S: SecretStore>(
    store: &mut CustomProviderStore,
    keys: &KeyService<S>,
    p: &CustomProvider,
    api_key: Option<&str>,
) -> AppResult<SavedProvider> {
    // 先校验 Key，避免 Key 无效时留下只保存了一半的配置
    let key = api_key.map(str::trim).filter(|k| !k.is_empty());
    if let Some(k) = key {
        validate_key(k)?;
    }
    let (provider, changed) = store.upsert(p)?;
    let key_cleared = changed && key.is_none();
    if key_cleared {
        keys.delete(&provider.id)?;
    }
    let status = match key {
        Some(k) => keys.set(&provider.id, k)?,
        None => keys.status(&provider.id)?,
    };
    Ok(SavedProvider { provider, key: status, key_cleared })
}

pub fn delete_custom<S: SecretStore>(store: &mut CustomProviderStore, keys: &KeyService<S>, id: &str) -> AppResult<()> {
    if !is_custom_id(id) {
        return Err(AppError::new("invalid_provider", "Provider ID 无效"));
    }
    keys.delete(id)?;
    store.remove(id)?;
    Ok(())
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Auth {
    Bearer,
    XApiKey,
    /// 本机服务（Ollama）：不读钥匙串，不加鉴权头
    None,
}

struct Target {
    /// 允许的 base URL。有地域之分的 Provider（通义千问、Kimi）每个地域一个，全部是厂商官方域名
    bases: Vec<String>,
    auth: Auth,
    fixed: Vec<(String, String)>,
    paths: &'static [&'static str],
    key_required: bool,
}

/// 官方 Provider 的端点（2026-09-29 按官方文档核对）。除 Anthropic 外都走 OpenAI 兼容的 Chat Completions。
/// 必须与 src/core/llm/official.ts 一致，由 tests/official-endpoints.test.ts 比对。
pub const OFFICIAL_BASES: &[(&str, &[&str])] = &[
    ("openai", &["https://api.openai.com/v1"]),
    ("anthropic", &["https://api.anthropic.com/v1"]),
    ("google", &["https://generativelanguage.googleapis.com/v1beta/openai"]),
    ("deepseek", &["https://api.deepseek.com"]),
    ("qwen", &["https://dashscope.aliyuncs.com/compatible-mode/v1", "https://dashscope-intl.aliyuncs.com/compatible-mode/v1"]),
    ("kimi", &["https://api.moonshot.cn/v1", "https://api.moonshot.ai/v1"]),
    ("ollama", &["http://127.0.0.1:11434/v1"]),
];

fn target_for(id: &str, custom: &CustomProviderStore) -> AppResult<Target> {
    let t = |bases: &[&str], auth: Auth, fixed: Vec<(String, String)>, paths: &'static [&'static str]| Target {
        bases: bases.iter().map(|b| b.to_string()).collect(),
        auth,
        fixed,
        paths,
        key_required: auth != Auth::None,
    };
    if id == JEV_ACCOUNT {
        return Ok(t(&["https://api.typesafe.ai"], Auth::Bearer, vec![], JEV_PATHS));
    }
    if let Some((_, bases)) = OFFICIAL_BASES.iter().find(|(p, _)| *p == id) {
        return Ok(match id {
            "anthropic" => t(bases, Auth::XApiKey, vec![("anthropic-version".to_string(), "2023-06-01".to_string())], ANTHROPIC_PATHS),
            "ollama" => t(bases, Auth::None, vec![], OPENAI_PATHS),
            _ => t(bases, Auth::Bearer, vec![], OPENAI_PATHS),
        });
    }
    if is_custom_id(id) {
        let c = custom.get(id).ok_or_else(|| AppError::new("provider_not_found", "没有找到这个自定义 Provider"))?;
        // 附加请求头已在保存时排除了 anthropic-version 等保留名，不会重复
        let mut fixed: Vec<(String, String)> = c.headers.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        let (auth, paths) = match c.protocol {
            Protocol::Openai => (Auth::Bearer, OPENAI_PATHS),
            Protocol::Anthropic => {
                fixed.push(("anthropic-version".to_string(), "2023-06-01".to_string()));
                (Auth::XApiKey, ANTHROPIC_PATHS)
            }
        };
        return Ok(Target {
            bases: vec![c.base_url.clone()],
            auth,
            fixed,
            paths,
            // 本机端点（例如本地模型服务）可以不配置 Key
            key_required: !is_local_host(url_host(&c.base_url)),
        });
    }
    Err(AppError::new("proxy_unsupported", "未知的 Provider"))
}

#[derive(Debug, Clone, Deserialize)]
pub struct ProxyRequest {
    pub target: String,
    pub method: String,
    pub url: String,
    #[serde(default)]
    pub body: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ProxyResponse {
    pub status: u16,
    pub body: String,
}

/// 已校验、带鉴权头的请求。Key 只在 Rust 进程内，Debug 输出不含请求头的值
pub struct PlannedRequest {
    pub method: String,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<String>,
    secret: Option<String>,
}

impl PlannedRequest {
    /// 把 Key 从文本里逐字抹掉（服务端可能在错误信息里回显 Key）
    pub fn scrub(&self, text: &str) -> String {
        match &self.secret {
            Some(s) if s.len() >= 8 => text.replace(s.as_str(), "[REDACTED]"),
            _ => text.to_string(),
        }
    }

    /// Incrementally redact a response chunk. The pending suffix retains only
    /// text that could still become the beginning of the secret on the next
    /// network read; complete secrets are replaced before the bytes leave Rust.
    pub fn scrub_stream(&self, pending: &mut String, incoming: &str, final_chunk: bool) -> String {
        pending.push_str(incoming);
        let Some(secret) = self.secret.as_deref().filter(|s| s.len() >= 8) else {
            return std::mem::take(pending);
        };
        let mut safe = String::new();
        while let Some(i) = pending.find(secret) {
            safe.push_str(&pending[..i]);
            safe.push_str("[REDACTED]");
            pending.drain(..i + secret.len());
        }
        if final_chunk {
            safe.push_str(&self.scrub(pending));
            pending.clear();
            return safe;
        }
        let keep = (1..secret.len()).rev().find(|n| pending.ends_with(&secret[..*n])).unwrap_or(0);
        if keep < pending.len() {
            safe.push_str(&pending[..pending.len() - keep]);
            pending.drain(..pending.len() - keep);
        }
        safe
    }
}

impl std::fmt::Debug for PlannedRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PlannedRequest")
            .field("method", &self.method)
            .field("url", &self.url)
            .field("headers", &self.headers.iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>())
            .field("body_len", &self.body.as_ref().map(String::len))
            .finish()
    }
}

pub fn plan_request<S: SecretStore>(req: &ProxyRequest, keys: &KeyService<S>, custom: &CustomProviderStore) -> AppResult<PlannedRequest> {
    let method = req.method.to_ascii_uppercase();
    if method != "GET" && method != "POST" {
        return Err(AppError::new("proxy_method", "只允许 GET 和 POST"));
    }
    let t = target_for(&req.target, custom)?;
    if !t.bases.iter().any(|b| t.paths.iter().any(|p| req.url == format!("{b}{p}"))) {
        return Err(AppError::new("proxy_url_not_allowed", "请求地址不在该 Provider 的允许列表内")
            .with_detail(req.url.chars().take(200).collect::<String>()));
    }
    if method == "GET" && req.body.is_some() {
        return Err(AppError::new("proxy_body", "GET 请求不能带请求体"));
    }
    if req.body.as_ref().is_some_and(|b| b.len() > MAX_BODY) {
        return Err(AppError::new("proxy_body", "请求体过大"));
    }
    // 本机服务不读钥匙串。除了 Ollama，回环自定义 Provider 也不需要 Key；
    // 跳过 resolve 不只是优化，Linux 没有 Secret Service 时不能让本地端点
    // 因为无关的钥匙串后端不可用而无法执行。
    let secret = if t.auth == Auth::None || !t.key_required { None } else { keys.resolve(&req.target)? };
    if t.key_required && secret.is_none() {
        return Err(AppError::new("provider_not_configured", "这个 Provider 还没有配置 API Key"));
    }
    let mut headers = vec![("accept".to_string(), "application/json, text/event-stream".to_string())];
    if method == "POST" {
        headers.push(("content-type".to_string(), "application/json".to_string()));
    }
    headers.extend(t.fixed);
    if let Some(k) = &secret {
        match t.auth {
            Auth::Bearer => headers.push(("authorization".to_string(), format!("Bearer {k}"))),
            Auth::XApiKey => headers.push(("x-api-key".to_string(), k.clone())),
            Auth::None => {}
        }
    }
    Ok(PlannedRequest { method, url: req.url.clone(), headers, body: req.body.clone(), secret })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secrets::{MemoryStore, SecretStore};

    const KEY: &str = "sk-real-0123456789abcdef";

    fn keys() -> KeyService<MemoryStore> {
        KeyService::new(MemoryStore::default(), Default::default())
    }

    struct FailingStore;

    impl SecretStore for FailingStore {
        fn get(&self, _account: &str) -> AppResult<Option<String>> {
            Err(AppError::new("keychain_error", "unavailable"))
        }
        fn set(&self, _account: &str, _secret: &str) -> AppResult<()> {
            Ok(())
        }
        fn delete(&self, _account: &str) -> AppResult<()> {
            Ok(())
        }
    }
    fn req(target: &str, method: &str, url: &str, body: Option<&str>) -> ProxyRequest {
        ProxyRequest { target: target.into(), method: method.into(), url: url.into(), body: body.map(Into::into) }
    }
    fn header<'a>(p: &'a PlannedRequest, k: &str) -> Option<&'a str> {
        p.headers.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str())
    }
    fn relay(base: &str) -> CustomProvider {
        CustomProvider {
            id: "custom:relay".into(),
            label: "Relay".into(),
            base_url: base.into(),
            default_model: "gpt-x".into(),
            headers: BTreeMap::from([("X-Org".to_string(), "eg".to_string())]),
            protocol: Protocol::Openai,
            models: vec![],
        }
    }

    #[test]
    fn custom_protocol_and_models() {
        let k = keys();
        let mut c = CustomProviderStore::in_memory();
        let mut p = relay("https://relay.example.com/v1");
        p.protocol = Protocol::Anthropic;
        p.models = vec![" claude-x ".into(), "gpt-x".into(), "".into(), "claude-x".into(), "openai/gpt-4o".into()];
        let s = save_custom(&mut c, &k, &p, Some(KEY)).unwrap();
        // 默认模型在第一个，去掉空白和重复
        assert_eq!(s.provider.models, ["gpt-x", "claude-x", "openai/gpt-4o"]);
        let plan = plan_request(&req("custom:relay", "POST", "https://relay.example.com/v1/messages", Some("{}")), &k, &c).unwrap();
        assert_eq!(header(&plan, "x-api-key"), Some(KEY));
        assert_eq!(header(&plan, "anthropic-version"), Some("2023-06-01"));
        assert_eq!(header(&plan, "authorization"), None);
        assert_eq!(header(&plan, "x-org"), Some("eg"));
        let e = plan_request(&req("custom:relay", "POST", "https://relay.example.com/v1/chat/completions", Some("{}")), &k, &c).unwrap_err();
        assert_eq!(e.code, "proxy_url_not_allowed");

        p.models = vec!["has space".into()];
        assert_eq!(save_custom(&mut c, &k, &p, None).unwrap_err().code, "invalid_provider_config");
        p.models = (0..MAX_CUSTOM_MODELS).map(|i| format!("m{i}")).collect();
        assert!(save_custom(&mut c, &k, &p, None).is_err(), "加上默认模型超过上限");
        p.models.pop();
        assert_eq!(save_custom(&mut c, &k, &p, None).unwrap().provider.models.len(), MAX_CUSTOM_MODELS);

        // 旧版 providers.json 没有 protocol / models
        let old: CustomProvider = serde_json::from_str(r#"{"id":"custom:old","label":"Old","base_url":"https://x.com/v1","default_model":"m"}"#).unwrap();
        assert_eq!(old.protocol, Protocol::Openai);
        assert_eq!(validate_custom(&old).unwrap().models, ["m"]);
        assert_eq!(serde_json::to_value(Protocol::Anthropic).unwrap(), "anthropic");
    }

    #[test]
    fn streaming_scrub_holds_a_secret_prefix_across_chunks() {
        let p = PlannedRequest {
            method: "POST".into(),
            url: "https://relay.example.com/v1/chat/completions".into(),
            headers: vec![],
            body: None,
            secret: Some(KEY.into()),
        };
        let mut pending = String::new();
        let mut out = p.scrub_stream(&mut pending, "prefix sk-real-0123", false);
        out.push_str(&p.scrub_stream(&mut pending, "456789abcdef suffix", true));
        assert!(!out.contains(KEY));
        assert!(out.contains("[REDACTED]"));
        assert_eq!(pending, "");
    }

    #[test]
    fn base_url_rules() {
        assert_eq!(validate_base_url("https://Relay.Example.com:443/v1/").unwrap(), "https://relay.example.com/v1");
        assert_eq!(validate_base_url("http://localhost:11434/v1").unwrap(), "http://localhost:11434/v1");
        assert_eq!(validate_base_url("http://[::1]:8080").unwrap(), "http://[::1]:8080");
        for bad in [
            "http://relay.example.com/v1",
            "https://u:p@relay.example.com",
            "https://x.com/v1?key=1",
            "https://x.com/../v1",
            "ftp://x.com",
            "https://x.com/v 1",
            "https://a:b:443",
            "https://x.com:0",
            "https://x.com/%2e%2e",
        ] {
            assert!(validate_base_url(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn official_targets_inject_auth() {
        let k = keys();
        k.set("openai", KEY).unwrap();
        k.set("anthropic", KEY).unwrap();
        let c = CustomProviderStore::in_memory();
        let p = plan_request(&req("openai", "post", "https://api.openai.com/v1/chat/completions", Some("{}")), &k, &c).unwrap();
        assert_eq!(p.method, "POST");
        assert_eq!(header(&p, "authorization"), Some(format!("Bearer {KEY}").as_str()));
        let a = plan_request(&req("anthropic", "POST", "https://api.anthropic.com/v1/messages", Some("{}")), &k, &c).unwrap();
        assert_eq!(header(&a, "x-api-key"), Some(KEY));
        assert_eq!(header(&a, "anthropic-version"), Some("2023-06-01"));
        assert_eq!(header(&a, "authorization"), None);
        assert!(!format!("{a:?}").contains(KEY));
        k.set("jev", KEY).unwrap();
        assert!(plan_request(&req("jev", "POST", "https://api.typesafe.ai/v1/systemone", Some("{}")), &k, &c).is_ok());
    }

    #[test]
    fn rejects_urls_methods_and_unconfigured() {
        let k = keys();
        k.set("openai", KEY).unwrap();
        let c = CustomProviderStore::in_memory();
        let code = |r: ProxyRequest| plan_request(&r, &k, &c).unwrap_err().code;
        assert_eq!(code(req("openai", "POST", "https://evil.example.com/v1/chat/completions", Some("{}"))), "proxy_url_not_allowed");
        assert_eq!(code(req("openai", "POST", "https://api.openai.com/v1/files", Some("{}"))), "proxy_url_not_allowed");
        assert_eq!(code(req("openai", "DELETE", "https://api.openai.com/v1/models", None)), "proxy_method");
        assert_eq!(code(req("openai", "GET", "https://api.openai.com/v1/models", Some("x"))), "proxy_body");
        assert_eq!(code(req("anthropic", "POST", "https://api.anthropic.com/v1/messages", Some("{}"))), "provider_not_configured");
        assert_eq!(code(req("deepseek", "POST", "https://api.deepseek.com/chat/completions", Some("{}"))), "provider_not_configured");
        assert_eq!(code(req("mistral", "GET", "https://api.mistral.ai/v1/models", None)), "proxy_unsupported");
        assert_eq!(code(req("custom:none", "GET", "https://x.com/models", None)), "provider_not_found");
    }

    #[test]
    fn m6_official_targets_and_regions() {
        let k = keys();
        let c = CustomProviderStore::in_memory();
        for id in ["google", "deepseek", "qwen", "kimi"] {
            k.set(id, KEY).unwrap();
        }
        let bearer = format!("Bearer {KEY}");
        for (id, url) in [
            ("google", "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"),
            ("deepseek", "https://api.deepseek.com/chat/completions"),
            ("qwen", "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"),
            ("qwen", "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models"),
            ("kimi", "https://api.moonshot.cn/v1/chat/completions"),
            ("kimi", "https://api.moonshot.ai/v1/models"),
        ] {
            let method = if url.ends_with("/models") { "GET" } else { "POST" };
            let body = (method == "POST").then_some("{}");
            let p = plan_request(&req(id, method, url, body), &k, &c).unwrap_or_else(|e| panic!("{id} {url}: {}", e.code));
            assert_eq!(header(&p, "authorization"), Some(bearer.as_str()), "{id}");
        }
        let code = |r: ProxyRequest| plan_request(&r, &k, &c).unwrap_err().code;
        // 地域域名只对本 Provider 有效：通义千问的 Key 不能发到 Kimi 的域名
        assert_eq!(code(req("qwen", "POST", "https://api.moonshot.cn/v1/chat/completions", Some("{}"))), "proxy_url_not_allowed");
        assert_eq!(code(req("deepseek", "POST", "https://api.deepseek.com/v1/chat/completions", Some("{}"))), "proxy_url_not_allowed");
        // Ollama：固定本机地址，不加鉴权头，也不读钥匙串
        let o = plan_request(&req("ollama", "POST", "http://127.0.0.1:11434/v1/chat/completions", Some("{}")), &k, &c).unwrap();
        assert_eq!(header(&o, "authorization"), None);
        assert!(o.secret.is_none());
        assert_eq!(code(req("ollama", "GET", "http://192.168.1.2:11434/v1/models", None)), "proxy_url_not_allowed");
        assert_eq!(k.set("ollama", KEY).unwrap_err().code, "key_not_needed");
    }

    #[test]
    fn official_bases_match_key_list() {
        let ids: Vec<&str> = OFFICIAL_BASES.iter().map(|(p, _)| *p).collect();
        let keyed: Vec<&str> = crate::secrets::OFFICIAL.iter().map(|(p, _)| *p).collect();
        assert_eq!(ids, keyed);
        for (_, bases) in OFFICIAL_BASES {
            for b in *bases {
                assert_eq!(validate_base_url(b).unwrap(), *b, "{b} 应是规整后的形式");
            }
        }
    }

    #[test]
    fn custom_provider_save_plan_and_key_reset() {
        let k = keys();
        let mut c = CustomProviderStore::in_memory();
        let s = save_custom(&mut c, &k, &relay("https://Relay.Example.com/v1/"), Some(KEY)).unwrap();
        assert_eq!(s.provider.base_url, "https://relay.example.com/v1");
        assert_eq!(s.provider.headers.get("x-org").map(String::as_str), Some("eg"));
        assert!(s.key.configured && !s.key_cleared);
        let p = plan_request(&req("custom:relay", "POST", "https://relay.example.com/v1/chat/completions", Some("{}")), &k, &c).unwrap();
        assert_eq!(header(&p, "authorization"), Some(format!("Bearer {KEY}").as_str()));
        assert_eq!(header(&p, "x-org"), Some("eg"));
        assert_eq!(p.scrub(&format!("echo {KEY}")), "echo [REDACTED]");
        assert!(save_custom(&mut c, &k, &relay("https://relay.example.com/v1"), None).unwrap().key.configured);
        let moved = save_custom(&mut c, &k, &relay("https://other.example.com/v1"), None).unwrap();
        assert!(moved.key_cleared && !moved.key.configured);
        assert_eq!(save_custom(&mut c, &k, &relay("https://x.com"), Some("bad key")).unwrap_err().code, "invalid_key");
        delete_custom(&mut c, &k, "custom:relay").unwrap();
        assert!(c.list().is_empty());
    }

    #[test]
    fn custom_validation_and_local_without_key() {
        let k = keys();
        let mut c = CustomProviderStore::in_memory();
        let mut bad = relay("https://x.com");
        bad.headers = BTreeMap::from([("Authorization".to_string(), "x".to_string())]);
        assert!(save_custom(&mut c, &k, &bad, None).is_err());
        bad.headers = BTreeMap::from([("x-api-token".to_string(), "x".to_string())]);
        assert!(save_custom(&mut c, &k, &bad, None).is_err());
        let mut local = relay("http://localhost:11434/v1");
        local.id = "custom:local".into();
        save_custom(&mut c, &k, &local, None).unwrap();
        let p = plan_request(&req("custom:local", "GET", "http://localhost:11434/v1/models", None), &k, &c).unwrap();
        assert_eq!(header(&p, "authorization"), None);
    }

    #[test]
    fn local_custom_provider_skips_keychain_lookup() {
        let k = KeyService::new(FailingStore, Default::default());
        let mut c = CustomProviderStore::in_memory();
        let mut local = relay("http://localhost:11434/v1");
        local.id = "custom:local".into();
        c.insert_ephemeral(&local).unwrap();
        let p = plan_request(&req("custom:local", "GET", "http://localhost:11434/v1/models", None), &k, &c).unwrap();
        assert_eq!(header(&p, "authorization"), None);
        assert!(p.secret.is_none());
    }

    #[test]
    fn store_roundtrip_on_disk_without_keys() {
        let dir = std::env::temp_dir().join(format!("eg-core-test-{}", std::process::id()));
        let path = dir.join("providers.json");
        let k = keys();
        let mut c = CustomProviderStore::load(&path).unwrap();
        save_custom(&mut c, &k, &relay("https://relay.example.com/v1"), Some(KEY)).unwrap();
        let again = CustomProviderStore::load(&path).unwrap();
        assert_eq!(again.list(), c.list());
        assert!(!std::fs::read_to_string(&path).unwrap().contains(KEY));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ephemeral_provider_is_not_persisted() {
        let dir = std::env::temp_dir().join(format!("eg-core-ephemeral-{}", std::process::id()));
        let path = dir.join("providers.json");
        let _ = std::fs::remove_dir_all(&dir);
        let mut c = CustomProviderStore::load(&path).unwrap();
        let mut p = relay("http://127.0.0.1:17891/staged/v1");
        p.id = "custom:qa".into();
        c.insert_ephemeral(&p).unwrap();
        assert!(c.get("custom:qa").is_some());
        assert!(!path.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}

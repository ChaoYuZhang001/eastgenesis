//! 密钥管理。前端只能设置、删除 Key 和查询「已配置 / 未配置」，Key 的值不经过 IPC 返回。
//! 存储经 SecretStore：桌面端用系统钥匙串（src-tauri/src/keychain.rs，keyring-rs），测试用 MemoryStore。
//! Jev 的 Key（账户 `jev`）与模型 Provider 的 Key（账户 `provider/<id>`）分开存放。

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};

use serde::Serialize;

use crate::error::{AppError, AppResult};

pub trait SecretStore: Send + Sync {
    fn get(&self, account: &str) -> AppResult<Option<String>>;
    fn set(&self, account: &str, secret: &str) -> AppResult<()>;
    fn delete(&self, account: &str) -> AppResult<()>;
}

#[derive(Default)]
pub struct MemoryStore(Mutex<HashMap<String, String>>);

impl MemoryStore {
    fn map(&self) -> AppResult<MutexGuard<'_, HashMap<String, String>>> {
        self.0.lock().map_err(|_| AppError::internal("lock poisoned"))
    }
}

impl SecretStore for MemoryStore {
    fn get(&self, account: &str) -> AppResult<Option<String>> {
        Ok(self.map()?.get(account).cloned())
    }
    fn set(&self, account: &str, secret: &str) -> AppResult<()> {
        self.map()?.insert(account.to_string(), secret.to_string());
        Ok(())
    }
    fn delete(&self, account: &str) -> AppResult<()> {
        self.map()?.remove(account);
        Ok(())
    }
}

pub const JEV_ACCOUNT: &str = "jev";
pub const JEV_ENV: &str = "TYPESAFE_API_KEY";

/// 官方 Provider 及其环境变量；Ollama 在本机运行，不需要 Key
pub const OFFICIAL: &[(&str, Option<&str>)] = &[
    ("openai", Some("OPENAI_API_KEY")),
    ("anthropic", Some("ANTHROPIC_API_KEY")),
    ("google", Some("GEMINI_API_KEY")),
    ("deepseek", Some("DEEPSEEK_API_KEY")),
    ("qwen", Some("DASHSCOPE_API_KEY")),
    ("kimi", Some("MOONSHOT_API_KEY")),
    ("ollama", None),
];

pub fn is_custom_id(id: &str) -> bool {
    id.strip_prefix("custom:").is_some_and(|n| {
        !n.is_empty()
            && n.len() <= 64
            && n.bytes().next().is_some_and(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
            && n.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
    })
}

/// 不回显输入：用户可能把 Key 误填进 ID 字段
pub fn validate_provider_id(id: &str) -> AppResult<()> {
    if OFFICIAL.iter().any(|(p, _)| *p == id) || is_custom_id(id) {
        Ok(())
    } else {
        Err(AppError::new("invalid_provider", "Provider ID 无效"))
    }
}

pub fn validate_key(key: &str) -> AppResult<&str> {
    let k = key.trim();
    if k.len() < 8 || k.len() > 512 || k.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(AppError::new("invalid_key", "API Key 格式无效（8–512 个字符，不能包含空白或控制字符）"));
    }
    Ok(k)
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum KeySource {
    Keychain,
    Env,
    None,
}

/// 返回给前端的只有这些字段，不含 Key
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct KeyStatus {
    pub id: String,
    pub configured: bool,
    pub source: KeySource,
    pub needs_key: bool,
}

pub struct KeyService<S: SecretStore> {
    store: S,
    env: HashMap<String, String>,
    /// 只缓存「钥匙串里有没有」，不缓存 Key 本身：减少钥匙串读取（macOS 可能每次读取都弹授权框）
    present: Mutex<HashMap<String, bool>>,
}

impl<S: SecretStore> KeyService<S> {
    pub fn new(store: S, env: HashMap<String, String>) -> Self {
        Self { store, env, present: Mutex::new(HashMap::new()) }
    }

    /// 只读取已知的 Key 环境变量
    pub fn from_process_env(store: S) -> Self {
        let mut env = HashMap::new();
        for name in OFFICIAL.iter().filter_map(|(_, e)| *e).chain([JEV_ENV]) {
            if let Ok(v) = std::env::var(name) {
                if !v.trim().is_empty() {
                    env.insert(name.to_string(), v.trim().to_string());
                }
            }
        }
        Self::new(store, env)
    }

    fn account(id: &str) -> String {
        if id == JEV_ACCOUNT {
            JEV_ACCOUNT.to_string()
        } else {
            format!("provider/{id}")
        }
    }

    fn env_name(id: &str) -> Option<&'static str> {
        if id == JEV_ACCOUNT {
            return Some(JEV_ENV);
        }
        OFFICIAL.iter().find(|(p, _)| *p == id).and_then(|(_, e)| *e)
    }

    fn validate(id: &str) -> AppResult<()> {
        if id == JEV_ACCOUNT {
            Ok(())
        } else {
            validate_provider_id(id)
        }
    }

    fn cache(&self) -> AppResult<MutexGuard<'_, HashMap<String, bool>>> {
        self.present.lock().map_err(|_| AppError::internal("lock poisoned"))
    }

    fn in_keychain(&self, id: &str) -> AppResult<bool> {
        let account = Self::account(id);
        if let Some(v) = self.cache()?.get(&account) {
            return Ok(*v);
        }
        let has = self.store.get(&account)?.is_some();
        self.cache()?.insert(account, has);
        Ok(has)
    }

    pub fn status(&self, id: &str) -> AppResult<KeyStatus> {
        Self::validate(id)?;
        let needs_key = id != "ollama";
        let (configured, source) = if !needs_key {
            (true, KeySource::None)
        } else if self.in_keychain(id)? {
            (true, KeySource::Keychain)
        } else if Self::env_name(id).is_some_and(|n| self.env.contains_key(n)) {
            (true, KeySource::Env)
        } else {
            (false, KeySource::None)
        };
        Ok(KeyStatus { id: id.to_string(), configured, source, needs_key })
    }

    /// 官方 Provider + 指定的自定义 Provider
    pub fn statuses(&self, custom: &[String]) -> AppResult<Vec<KeyStatus>> {
        OFFICIAL
            .iter()
            .map(|(p, _)| p.to_string())
            .chain(custom.iter().cloned())
            .map(|id| self.status(&id))
            .collect()
    }

    pub fn set(&self, id: &str, key: &str) -> AppResult<KeyStatus> {
        Self::validate(id)?;
        if id == "ollama" {
            return Err(AppError::new("key_not_needed", "这个 Provider 不需要 API Key"));
        }
        let k = validate_key(key)?;
        let account = Self::account(id);
        self.store.set(&account, k)?;
        self.cache()?.insert(account, true);
        self.status(id)
    }

    pub fn delete(&self, id: &str) -> AppResult<KeyStatus> {
        Self::validate(id)?;
        let account = Self::account(id);
        self.store.delete(&account)?;
        self.cache()?.insert(account, false);
        self.status(id)
    }

    /// 只在 Rust 内部使用（给代理请求加鉴权头），不通过任何命令返回
    pub(crate) fn resolve(&self, id: &str) -> AppResult<Option<String>> {
        Self::validate(id)?;
        if let Some(k) = self.store.get(&Self::account(id))? {
            return Ok(Some(k));
        }
        Ok(Self::env_name(id).and_then(|n| self.env.get(n).cloned()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &str = "sk-test-0123456789abcdef";

    fn svc(env: &[(&str, &str)]) -> KeyService<MemoryStore> {
        KeyService::new(MemoryStore::default(), env.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect())
    }

    #[test]
    fn set_status_delete_never_return_key() {
        let s = svc(&[]);
        assert!(!s.status("openai").unwrap().configured);
        let st = s.set("openai", &format!("  {KEY} ")).unwrap();
        assert_eq!(st, KeyStatus { id: "openai".into(), configured: true, source: KeySource::Keychain, needs_key: true });
        assert!(!serde_json::to_string(&st).unwrap().contains(KEY));
        assert_eq!(s.resolve("openai").unwrap().as_deref(), Some(KEY));
        assert!(!s.delete("openai").unwrap().configured);
        assert_eq!(s.resolve("openai").unwrap(), None);
    }

    #[test]
    fn env_fallback_and_ollama() {
        let s = svc(&[("ANTHROPIC_API_KEY", "env-key-123456")]);
        assert_eq!(s.status("anthropic").unwrap().source, KeySource::Env);
        assert_eq!(s.resolve("anthropic").unwrap().as_deref(), Some("env-key-123456"));
        let o = s.status("ollama").unwrap();
        assert!(o.configured && !o.needs_key);
        assert_eq!(s.set("ollama", KEY).unwrap_err().code, "key_not_needed");
    }

    #[test]
    fn jev_key_is_separate() {
        let s = svc(&[]);
        s.set("jev", KEY).unwrap();
        assert!(s.status("jev").unwrap().configured);
        assert!(!s.status("openai").unwrap().configured);
        assert_eq!(s.store.get("jev").unwrap().as_deref(), Some(KEY));
        assert_eq!(s.store.get("provider/openai").unwrap(), None);
    }

    #[test]
    fn validation_does_not_echo_input() {
        let s = svc(&[]);
        let e = s.set(KEY, KEY).unwrap_err();
        assert_eq!(e.code, "invalid_provider");
        assert!(!format!("{e:?}").contains(KEY));
        assert_eq!(s.set("openai", "short").unwrap_err().code, "invalid_key");
        assert_eq!(s.set("openai", "has space inside key").unwrap_err().code, "invalid_key");
        assert!(s.set("custom:relay", KEY).is_ok());
        assert!(s.set("custom:Bad", KEY).is_err());
        assert_eq!(s.statuses(&["custom:relay".into()]).unwrap().len(), 8);
    }
}

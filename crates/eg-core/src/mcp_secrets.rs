//! MCP 服务器用的密钥：钥匙串账户 `mcp/<服务器>/<NAME>`，与模型 Provider（`provider/<id>`）和 Jev（`jev`）分开。
//! 和 Provider 的 Key 一样只进不出：界面能保存、删除、查询「是否已保存」，读值只在 Rust 启动服务器时发生。

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};

use crate::error::{AppError, AppResult};
use crate::mcp_host::valid_server_id;
use crate::mcp_template::valid_ref_name;
use crate::secrets::SecretStore;

pub const MAX_SECRET: usize = 8192;

pub fn account(server: &str, name: &str) -> AppResult<String> {
    if !valid_server_id(server) || !valid_ref_name(name) {
        return Err(AppError::new("invalid_mcp_secret", "MCP 服务器 ID 或密钥名无效"));
    }
    Ok(format!("mcp/{server}/{name}"))
}

/// 不回显输入
pub fn validate_secret(value: &str) -> AppResult<&str> {
    let v = value.trim();
    if v.is_empty() || v.len() > MAX_SECRET || v.chars().any(char::is_control) {
        return Err(AppError::new("invalid_mcp_secret_value", "密钥格式无效（1–8192 个字符，不能包含换行或控制字符）"));
    }
    Ok(v)
}

pub struct McpSecrets<S: SecretStore> {
    store: S,
    /// 只缓存「有没有」，不缓存值
    present: Mutex<HashMap<String, bool>>,
}

impl<S: SecretStore> McpSecrets<S> {
    pub fn new(store: S) -> Self {
        Self { store, present: Mutex::new(HashMap::new()) }
    }

    fn cache(&self) -> AppResult<MutexGuard<'_, HashMap<String, bool>>> {
        self.present.lock().map_err(|_| AppError::internal("lock poisoned"))
    }

    pub fn configured(&self, server: &str, name: &str) -> AppResult<bool> {
        let acc = account(server, name)?;
        if let Some(v) = self.cache()?.get(&acc) {
            return Ok(*v);
        }
        let has = self.store.get(&acc)?.is_some();
        self.cache()?.insert(acc, has);
        Ok(has)
    }

    pub fn set(&self, server: &str, name: &str, value: &str) -> AppResult<()> {
        let acc = account(server, name)?;
        self.store.set(&acc, validate_secret(value)?)?;
        self.cache()?.insert(acc, true);
        Ok(())
    }

    pub fn delete(&self, server: &str, name: &str) -> AppResult<()> {
        let acc = account(server, name)?;
        self.store.delete(&acc)?;
        self.cache()?.insert(acc, false);
        Ok(())
    }

    /// 只在启动服务器时调用；值不经过 IPC
    pub(crate) fn get(&self, server: &str, name: &str) -> AppResult<Option<String>> {
        let acc = account(server, name)?;
        let v = self.store.get(&acc)?;
        self.cache()?.insert(acc, v.is_some());
        Ok(v)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secrets::MemoryStore;

    #[test]
    fn stored_under_separate_namespace() {
        let s = McpSecrets::new(MemoryStore::default());
        assert!(!s.configured("gh", "GITHUB_TOKEN").unwrap());
        s.set("gh", "GITHUB_TOKEN", "  value-123  ").unwrap();
        assert!(s.configured("gh", "GITHUB_TOKEN").unwrap());
        assert_eq!(s.store.get("mcp/gh/GITHUB_TOKEN").unwrap().as_deref(), Some("value-123"));
        assert!(s.store.get("provider/gh").unwrap().is_none());
        s.delete("gh", "GITHUB_TOKEN").unwrap();
        assert!(!s.configured("gh", "GITHUB_TOKEN").unwrap());
        assert!(s.get("gh", "GITHUB_TOKEN").unwrap().is_none());
    }

    #[test]
    fn rejects_bad_names_and_values() {
        let s = McpSecrets::new(MemoryStore::default());
        assert_eq!(s.set("Bad", "X", "v").unwrap_err().code, "invalid_mcp_secret");
        assert_eq!(s.set("gh", "../jev", "v").unwrap_err().code, "invalid_mcp_secret");
        assert_eq!(s.set("gh", "X", "a\nb").unwrap_err().code, "invalid_mcp_secret_value");
        assert_eq!(s.set("gh", "X", "   ").unwrap_err().code, "invalid_mcp_secret_value");
        let e = s.set("gh", "X", "sk-bad\u{7}value").unwrap_err();
        assert!(!e.message.contains("sk-bad") && e.detail.is_none());
    }
}

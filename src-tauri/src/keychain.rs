//! 系统钥匙串（keyring-rs）：macOS Keychain、Windows 凭据管理器、Linux Secret Service。
//! 条目：服务名 com.eastgenesis.desktop，账户 `provider/<id>` 或 `jev`。
use eg_core::error::{AppError, AppResult};
use eg_core::secrets::SecretStore;

pub const SERVICE: &str = "com.eastgenesis.desktop";

pub struct KeyringStore;

fn keychain_err(msg: &str, e: keyring::Error) -> AppError {
    AppError::new("keychain_error", msg).with_detail(e.to_string())
}

fn entry(account: &str) -> AppResult<keyring::Entry> {
    keyring::Entry::new(SERVICE, account).map_err(|e| keychain_err("无法访问系统钥匙串", e))
}

impl SecretStore for KeyringStore {
    fn get(&self, account: &str) -> AppResult<Option<String>> {
        match entry(account)?.get_password() {
            Ok(s) => Ok(Some(s)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(keychain_err("读取系统钥匙串失败", e)),
        }
    }

    fn set(&self, account: &str, secret: &str) -> AppResult<()> {
        entry(account)?.set_password(secret).map_err(|e| keychain_err("写入系统钥匙串失败", e))
    }

    fn delete(&self, account: &str) -> AppResult<()> {
        match entry(account)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(keychain_err("删除钥匙串条目失败", e)),
        }
    }
}

//! 系统钥匙串（keyring-rs）：macOS Keychain、Windows 凭据管理器、Linux Secret Service。
//! 条目：服务名 com.eastgenesis.desktop，账户 `provider/<id>` 或 `jev`。
use eg_core::error::{AppError, AppResult};
use eg_core::secrets::SecretStore;

pub const SERVICE: &str = "com.eastgenesis.desktop";

pub struct KeyringStore;

#[cfg(any(feature = "qa-faults", test))]
fn isolation_flag(value: Option<&str>) -> bool { value == Some("1") }

fn isolated_profile() -> bool {
    #[cfg(feature = "qa-faults")]
    { isolation_flag(std::env::var("EASTGENESIS_QA_ISOLATED_PROFILE").ok().as_deref()) }
    #[cfg(not(feature = "qa-faults"))]
    { false }
}

// The backend closures must remain lazy: isolated QA reads cannot even open
// an OS keyring entry, and mutation cannot touch the user's system keychain.
fn read_secret(isolated: bool, load: impl FnOnce() -> AppResult<Option<String>>) -> AppResult<Option<String>> {
    if isolated { Ok(None) } else { load() }
}
fn mutate_secret(isolated: bool, action: impl FnOnce() -> AppResult<()>) -> AppResult<()> {
    if isolated { Err(AppError::new("qa_keychain_disabled", "隔离 QA profile 禁止修改系统钥匙串")) } else { action() }
}

fn keychain_err(msg: &str, e: keyring::Error) -> AppError {
    AppError::new("keychain_error", msg).with_detail(e.to_string())
}

fn entry(account: &str) -> AppResult<keyring::Entry> {
    keyring::Entry::new(SERVICE, account).map_err(|e| keychain_err("无法访问系统钥匙串", e))
}

impl SecretStore for KeyringStore {
    fn get(&self, account: &str) -> AppResult<Option<String>> {
        read_secret(isolated_profile(), || match entry(account)?.get_password() {
            Ok(s) => Ok(Some(s)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(keychain_err("读取系统钥匙串失败", e)),
        })
    }

    fn set(&self, account: &str, secret: &str) -> AppResult<()> {
        mutate_secret(isolated_profile(), || entry(account)?.set_password(secret).map_err(|e| keychain_err("写入系统钥匙串失败", e)))
    }

    fn delete(&self, account: &str) -> AppResult<()> {
        mutate_secret(isolated_profile(), || match entry(account)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(keychain_err("删除钥匙串条目失败", e)),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[test]
    fn isolated_access_never_calls_keyring_backend() {
        assert_eq!(read_secret(true, || panic!("keyring read invoked")).unwrap(), None);
        assert_eq!(mutate_secret(true, || panic!("keyring write invoked")).unwrap_err().code, "qa_keychain_disabled");
        assert_eq!(mutate_secret(true, || panic!("keyring delete invoked")).unwrap_err().code, "qa_keychain_disabled");
    }

    #[test]
    fn isolation_requires_exact_opt_in_and_normal_access_is_preserved() {
        assert!(isolation_flag(Some("1")));
        for value in [None, Some(""), Some("true"), Some("0"), Some(" 1 ")] { assert!(!isolation_flag(value)); }
        let called = Cell::new(0);
        let value = read_secret(false, || { called.set(called.get() + 1); Ok(Some("synthetic".into())) }).unwrap();
        assert_eq!(value.as_deref(), Some("synthetic"));
        mutate_secret(false, || { called.set(called.get() + 1); Ok(()) }).unwrap();
        assert_eq!(called.get(), 2);
    }

    #[cfg(not(feature = "qa-faults"))]
    #[test]
    fn production_build_has_no_isolation_switch() { assert!(!isolated_profile()); }
}

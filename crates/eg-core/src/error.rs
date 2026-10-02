//! IPC 统一错误结构：{ code, message, detail }，与 src/lib/ipc.ts 的 AppError 对应。

use serde::Serialize;

use crate::redact::redact;

#[derive(Debug, Clone, Serialize, PartialEq, Eq, thiserror::Error)]
#[error("{code}: {message}")]
pub struct AppError {
    /// 机器可读的错误码，snake_case
    pub code: String,
    /// 面向用户的中文说明
    pub message: String,
    /// 调试细节，序列化前已脱敏
    pub detail: Option<String>,
}

pub type AppResult<T> = Result<T, AppError>;

impl AppError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self { code: code.into(), message: message.into(), detail: None }
    }

    /// 附加调试细节。细节可能来自底层库的报错，统一脱敏后再保存。
    pub fn with_detail(mut self, detail: impl AsRef<str>) -> Self {
        self.detail = Some(redact(detail.as_ref()));
        self
    }

    pub fn internal(detail: impl AsRef<str>) -> Self {
        Self::new("internal", "内部错误").with_detail(detail)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_to_ipc_shape() {
        let e = AppError::new("db_open_failed", "无法打开数据库").with_detail("locked");
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(v, serde_json::json!({"code":"db_open_failed","message":"无法打开数据库","detail":"locked"}));
    }

    #[test]
    fn detail_is_redacted() {
        let e = AppError::internal("request failed: Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz0123");
        let d = e.detail.unwrap();
        assert!(!d.contains("sk-abcdefghijklmnopqrstuvwxyz0123"), "{d}");
        assert!(d.contains("[REDACTED]"));
    }

    #[test]
    fn none_detail_serializes_as_null() {
        let v = serde_json::to_value(AppError::new("x", "y")).unwrap();
        assert!(v["detail"].is_null());
    }
}

//! mcp.json 里的值模板：字面文本加 `${keychain:NAME}`（钥匙串，账户 `mcp/<服务器>/<NAME>`）
//! 和 `${env:NAME}`（本应用进程的环境变量）。密钥不能明文写在文件里：
//! - 字面文本看起来像密钥（redact 会改写它、或是带密码的 URL）时拒绝；
//! - 模型 Provider 和 Jev 的 Key 变量不能被引用，MCP 服务器拿不到它们。

use serde::Serialize;

use crate::error::{AppError, AppResult};
use crate::redact::redact;
use crate::secrets::{JEV_ENV, OFFICIAL};

pub const MAX_TEXT: usize = 4096;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum RefSource {
    Keychain,
    Env,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Segment {
    Lit(String),
    Ref(RefSource, String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Template {
    /// 原文，界面按原样展示（里面只有引用，没有密钥值）
    pub raw: String,
    pub parts: Vec<Segment>,
}

pub fn valid_ref_name(n: &str) -> bool {
    !n.is_empty()
        && n.len() <= 64
        && n.bytes().next().is_some_and(|b| b.is_ascii_alphabetic() || b == b'_')
        && n.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

/// 模型 Provider 与 Jev 的 Key 所在的环境变量
pub fn protected_env(name: &str) -> bool {
    name == JEV_ENV || OFFICIAL.iter().any(|(_, e)| *e == Some(name))
}

pub(crate) fn bad(msg: impl Into<String>) -> AppError {
    AppError::new("mcp_config_invalid", msg)
}

impl Template {
    pub fn parse(raw: &str) -> AppResult<Self> {
        if raw.len() > MAX_TEXT || raw.contains('\0') {
            return Err(bad(format!("值过长（上限 {MAX_TEXT} 字节）或包含空字符")));
        }
        let mut parts = Vec::new();
        let mut rest = raw;
        while let Some(i) = rest.find("${") {
            if i > 0 {
                parts.push(Segment::Lit(rest[..i].to_string()));
            }
            let after = &rest[i + 2..];
            let end = after.find('}').ok_or_else(|| bad("引用缺少右花括号，应写成 ${keychain:NAME} 或 ${env:NAME}"))?;
            let (kind, name) = after[..end].split_once(':').ok_or_else(|| bad("引用应写成 ${keychain:NAME} 或 ${env:NAME}"))?;
            if !valid_ref_name(name) {
                return Err(bad("引用名只能包含字母、数字和下划线，不能以数字开头，最长 64 个字符"));
            }
            let source = match kind {
                "keychain" => RefSource::Keychain,
                "env" if protected_env(name) => {
                    return Err(bad(format!("不能引用 {name}：模型 Provider 和 Jev 的 Key 不提供给 MCP 服务器")));
                }
                "env" => RefSource::Env,
                _ => return Err(bad("只支持 ${keychain:NAME} 和 ${env:NAME} 两种引用")),
            };
            parts.push(Segment::Ref(source, name.to_string()));
            rest = &after[end + 1..];
        }
        if !rest.is_empty() {
            parts.push(Segment::Lit(rest.to_string()));
        }
        Ok(Self { raw: raw.to_string(), parts })
    }

    pub fn is_literal(&self) -> bool {
        self.parts.iter().all(|p| matches!(p, Segment::Lit(_)))
    }

    /// 字面部分是否像明文密钥
    pub fn leaks_secret(&self) -> bool {
        self.parts.iter().any(|p| match p {
            Segment::Lit(s) => redact(s) != *s || url_password(s),
            Segment::Ref(..) => false,
        })
    }

    pub fn refs(&self) -> impl Iterator<Item = (RefSource, &str)> + '_ {
        self.parts.iter().filter_map(|p| match p {
            Segment::Ref(s, n) => Some((*s, n.as_str())),
            Segment::Lit(_) => None,
        })
    }
}

/// `scheme://user:password@host`：密码不为空
fn url_password(s: &str) -> bool {
    s.split_whitespace().any(|w| {
        let Some((_, rest)) = w.split_once("://") else { return false };
        let auth = rest.split(['/', '?', '#']).next().unwrap_or("");
        auth.rsplit_once('@').is_some_and(|(info, _)| info.split_once(':').is_some_and(|(_, p)| !p.is_empty()))
    })
}

/// 变量名或参数名像是装密钥的：最后一段是 KEY，或任意一段是 TOKEN、SECRET、PASSWORD 等
pub fn secret_name(name: &str) -> bool {
    let n = name.trim_start_matches('-').to_ascii_uppercase().replace('-', "_");
    let parts: Vec<&str> = n.split('_').filter(|s| !s.is_empty()).collect();
    parts.last().is_some_and(|l| *l == "KEY" || *l == "APIKEY")
        || parts.iter().any(|p| {
            ["TOKEN", "SECRET", "PASSWORD", "PASSWD", "PAT", "CREDENTIAL", "CREDENTIALS"].contains(p)
                || p.ends_with("PASSWORD")
                || p.ends_with("TOKEN")
                || p.ends_with("SECRET")
        })
}

/// 短值或纯数字不当作密钥（例如 TOKEN_LIMIT=4096）
pub fn trivial(s: &str) -> bool {
    s.chars().count() < 8 || s.bytes().all(|b| b.is_ascii_digit())
}

#[cfg(test)]
#[path = "mcp_template_tests.rs"]
mod tests;

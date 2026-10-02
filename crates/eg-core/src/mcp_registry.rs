//! MCP 服务器登记表：应用配置目录下的 mcp.json，只由用户自己编辑。
//! 界面只能查看和启停登记过的服务器，不能添加或修改：即使 webview 被注入脚本，也启动不了登记表以外的命令。
//! 格式沿用常见的 `mcpServers`（command / args / env / cwd），另加两个字段：
//! - `allowTools`：允许注册的工具（服务器上的原始名称），`"*"` 表示全部；不写则一个都不注册；
//! - `trustAnnotations`：是否采信服务器自报的只读等标注，默认否。
//!   密钥写成 `${keychain:NAME}` 或 `${env:NAME}`，见 mcp_template。

use std::collections::BTreeMap;

use serde::{Serialize, Serializer};
use serde_json::{Map, Value};

use crate::error::{AppError, AppResult};
use crate::mcp_fields::{parse_allow, parse_args, parse_env, text};
use crate::mcp_host::valid_server_id;
use crate::mcp_template::{bad, RefSource, Template, MAX_TEXT};
use crate::redact::redact;

pub const MAX_SERVERS: usize = 32;
pub const MAX_ARGS: usize = 64;
pub const MAX_ENV: usize = 64;
pub const MAX_ALLOW: usize = 256;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AllowTools {
    All,
    Only(Vec<String>),
}

impl AllowTools {
    pub fn allows(&self, tool: &str) -> bool {
        match self {
            Self::All => true,
            Self::Only(v) => v.iter().any(|t| t == tool),
        }
    }
}

/// 前端的 McpServerPolicy.allowTools：`"*"` 或名称数组
impl Serialize for AllowTools {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::All => s.serialize_str("*"),
            Self::Only(v) => v.serialize(s),
        }
    }
}

#[derive(Debug, Clone)]
pub struct McpEntry {
    pub id: String,
    pub command: String,
    pub args: Vec<Template>,
    pub env: BTreeMap<String, Template>,
    pub cwd: Option<String>,
    pub allow_tools: AllowTools,
    pub trust_annotations: bool,
}

impl McpEntry {
    /// 用到的引用（去重、排序）
    pub fn refs(&self) -> Vec<(RefSource, String)> {
        let mut v: Vec<(RefSource, String)> =
            self.args.iter().chain(self.env.values()).flat_map(|t| t.refs().map(|(s, n)| (s, n.to_string()))).collect();
        v.sort();
        v.dedup();
        v
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct EntryError {
    pub id: String,
    pub message: String,
}

#[derive(Debug, Default)]
pub struct Registry {
    pub entries: BTreeMap<String, McpEntry>,
    pub errors: Vec<EntryError>,
}

/// 整个文件无法解析时返回错误；单个条目有问题只记录在 errors 里，其他条目照常可用
pub fn parse_registry(text: &str) -> AppResult<Registry> {
    let corrupt = |d: String| AppError::new("mcp_config_corrupt", "mcp.json 不是有效的 JSON 对象").with_detail(d);
    let root: Value = serde_json::from_str(text).map_err(|e| corrupt(e.to_string()))?;
    let Value::Object(root) = root else { return Err(corrupt("根节点应是对象".into())) };
    let servers = match root.get("mcpServers") {
        None | Some(Value::Null) => return Ok(Registry::default()),
        Some(Value::Object(m)) => m,
        Some(_) => return Err(corrupt("mcpServers 应是对象".into())),
    };
    let mut reg = Registry::default();
    for (id, v) in servers {
        let shown = redact(&id.chars().take(64).collect::<String>());
        if reg.entries.len() >= MAX_SERVERS {
            reg.errors.push(EntryError { id: shown, message: format!("最多登记 {MAX_SERVERS} 个服务器") });
            continue;
        }
        match parse_entry(id, v) {
            Ok(e) => {
                reg.entries.insert(id.clone(), e);
            }
            Err(e) => reg.errors.push(EntryError { id: shown, message: e.message }),
        }
    }
    Ok(reg)
}

/// 同时接受 camelCase 和 snake_case；null 当作没写
fn field<'a>(o: &'a Map<String, Value>, camel: &str, snake: &str) -> Option<&'a Value> {
    o.get(camel).or_else(|| o.get(snake)).filter(|v| !v.is_null())
}

fn parse_entry(id: &str, v: &Value) -> AppResult<McpEntry> {
    if !valid_server_id(id) {
        return Err(bad("服务器 ID 只能用小写字母、数字和下划线，以字母或数字开头，最长 32 个字符"));
    }
    let o = v.as_object().ok_or_else(|| bad("配置应是对象"))?;
    let stdio = match field(o, "type", "type") {
        None => true,
        Some(t) => t == "stdio",
    };
    if o.contains_key("url") || !stdio {
        return Err(bad("只支持本机 stdio 服务器（command + args），暂不支持 url / sse / http"));
    }
    let command = field(o, "command", "command").and_then(Value::as_str).map(str::trim).unwrap_or("");
    if command.is_empty() || command.len() > MAX_TEXT || command.contains("${") || command.chars().any(char::is_control) {
        return Err(bad("command 应是可执行文件名或绝对路径，不能包含引用或控制字符"));
    }
    let cwd = match field(o, "cwd", "cwd") {
        None => None,
        Some(v) => {
            let t = text(v, "cwd")?;
            if !t.is_literal() || !std::path::Path::new(&t.raw).is_absolute() {
                return Err(bad("cwd 应是绝对路径，不能包含引用"));
            }
            Some(t.raw)
        }
    };
    Ok(McpEntry {
        id: id.to_string(),
        command: command.to_string(),
        args: parse_args(field(o, "args", "args"))?,
        env: parse_env(field(o, "env", "env"))?,
        cwd,
        allow_tools: parse_allow(field(o, "allowTools", "allow_tools"))?,
        trust_annotations: match field(o, "trustAnnotations", "trust_annotations") {
            None => false,
            Some(v) => v.as_bool().ok_or_else(|| bad("trustAnnotations 应是 true 或 false"))?,
        },
    })
}

#[cfg(test)]
#[path = "mcp_registry_tests.rs"]
mod tests;

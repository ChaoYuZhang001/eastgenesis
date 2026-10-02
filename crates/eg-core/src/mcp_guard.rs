//! 发往 MCP 服务器的消息在 Rust 侧再查一遍（纵深防御）：
//! - 只放行我们的客户端会发的请求：initialize、ping、tools/list，以及白名单内工具的 tools/call；
//! - 通知（notifications/*）和对服务器请求的应答照常放行；
//! - 不接受批量消息和非 JSON；
//!   转发的是解析后重新序列化的文本，服务器看到的就是这里检查过的内容。

use serde_json::Value;

use crate::error::{AppError, AppResult};
use crate::mcp_registry::AllowTools;

pub const MAX_OUTGOING: usize = 10 * 1024 * 1024;

fn reject(code: &str, msg: impl Into<String>) -> AppError {
    AppError::new(code, msg)
}

pub fn check_outgoing(line: &str, allow: &AllowTools) -> AppResult<String> {
    if line.len() > MAX_OUTGOING {
        return Err(reject("invalid_message", "消息过大"));
    }
    let v: Value = serde_json::from_str(line).map_err(|_| reject("invalid_message", "消息不是 JSON"))?;
    let Value::Object(m) = &v else { return Err(reject("invalid_message", "只接受单条 JSON-RPC 消息")) };
    match m.get("method") {
        // 对服务器请求的应答（例如 ping）
        None => {
            if !m.contains_key("id") || !(m.contains_key("result") || m.contains_key("error")) {
                return Err(reject("invalid_message", "不是有效的 JSON-RPC 消息"));
            }
        }
        Some(Value::String(method)) => {
            let is_request = m.contains_key("id");
            match method.as_str() {
                _ if !is_request && method.starts_with("notifications/") => {}
                "initialize" | "ping" | "tools/list" if is_request => {}
                "tools/call" if is_request => {
                    let name = m.get("params").and_then(|p| p.get("name")).and_then(Value::as_str).unwrap_or("");
                    if name.is_empty() || !allow.allows(name) {
                        let shown: String = name.chars().take(64).collect();
                        return Err(reject("mcp_tool_not_allowed", format!("工具 {shown} 不在这个服务器的 allowTools 白名单内")));
                    }
                }
                _ => {
                    let shown: String = method.chars().take(40).collect();
                    return Err(reject("mcp_method_not_allowed", format!("不允许向 MCP 服务器发送 {shown}")));
                }
            }
        }
        Some(_) => return Err(reject("invalid_message", "method 应是字符串")),
    }
    serde_json::to_string(&v).map_err(|e| AppError::internal(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn run(v: Value, allow: &AllowTools) -> Result<String, String> {
        check_outgoing(&v.to_string(), allow).map_err(|e| e.code)
    }

    #[test]
    fn allows_client_requests_and_whitelisted_calls() {
        let allow = AllowTools::Only(vec!["read".into()]);
        for v in [
            json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}),
            json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
            json!({"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":3}}),
            json!({"jsonrpc":"2.0","id":2,"method":"tools/list","params":{"cursor":"c"}}),
            json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"read","arguments":{}}}),
            json!({"jsonrpc":"2.0","id":"s1","result":{}}),
            json!({"jsonrpc":"2.0","id":"s2","error":{"code":-32601,"message":"x"}}),
        ] {
            assert!(run(v.clone(), &allow).is_ok(), "{v}");
        }
    }

    #[test]
    fn blocks_other_tools_methods_and_shapes() {
        let allow = AllowTools::Only(vec!["read".into()]);
        let call = |name: Value| json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":name}});
        assert_eq!(run(call(json!("delete_all")), &allow).unwrap_err(), "mcp_tool_not_allowed");
        assert_eq!(run(call(json!(7)), &allow).unwrap_err(), "mcp_tool_not_allowed");
        assert_eq!(run(json!({"jsonrpc":"2.0","id":1,"method":"resources/read"}), &allow).unwrap_err(), "mcp_method_not_allowed");
        assert_eq!(run(json!({"jsonrpc":"2.0","method":"tools/call","params":{"name":"read"}}), &allow).unwrap_err(), "mcp_method_not_allowed");
        assert_eq!(run(json!([{"jsonrpc":"2.0","id":1,"method":"ping"}]), &allow).unwrap_err(), "invalid_message");
        assert_eq!(run(json!({"jsonrpc":"2.0","id":1}), &allow).unwrap_err(), "invalid_message");
        assert_eq!(check_outgoing("not json", &allow).unwrap_err().code, "invalid_message");
        assert_eq!(run(call(json!("anything")), &AllowTools::All), Ok(call(json!("anything")).to_string()));
        assert_eq!(run(call(json!("read")), &AllowTools::Only(vec![])).unwrap_err(), "mcp_tool_not_allowed");
    }

    #[test]
    fn forwards_the_checked_form() {
        // 重复的键以最后一个为准，转发的文本里只剩检查过的那个
        let raw = r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"delete_all","name":"read"}}"#;
        let out = check_outgoing(raw, &AllowTools::Only(vec!["read".into()])).unwrap();
        assert!(!out.contains("delete_all") && out.contains("\"read\""));
        assert!(!out.contains('\n'));
    }
}

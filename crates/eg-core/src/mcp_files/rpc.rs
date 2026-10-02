//! JSON-RPC 2.0（MCP over stdio）：一行一条消息；没有 id 的通知不回复
use super::sandbox::Sandbox;
use super::tools_fs::Args;
use super::{schema, tools_fs, tools_pdf, tools_write};
use crate::AppResult;
use serde_json::{json, Map, Value};

/// 支持的 MCP 协议版本；客户端要的版本不在其中时回第一个
const VERSIONS: [&str; 3] = ["2025-06-18", "2025-03-26", "2024-11-05"];

type ToolFn = fn(&Sandbox, &Args) -> AppResult<Value>;

fn find(name: &str) -> Option<ToolFn> {
    let f: ToolFn = match name {
        "list_directory" => tools_fs::list_directory,
        "read_file" => tools_fs::read_file,
        "get_file_info" => tools_fs::get_file_info,
        "write_file" => tools_write::write_file,
        "create_directory" => tools_write::create_directory,
        "move_file" => tools_write::move_file,
        "delete_file" => tools_write::delete_file,
        "read_pdf" => tools_pdf::read_pdf,
        "get_pdf_metadata" => tools_pdf::get_pdf_metadata,
        _ => return None,
    };
    Some(f)
}

fn ok(id: &Value, result: Value) -> String { json!({ "jsonrpc": "2.0", "id": id, "result": result }).to_string() }
pub(crate) fn rpc_err(id: &Value, code: i64, msg: &str) -> String {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": msg } }).to_string()
}

/// tools/call：参数错误回 JSON-RPC 错误；执行失败放在 isError 结果里，让模型看到原因
fn call(sb: &Sandbox, id: &Value, params: Option<&Value>) -> String {
    let name = params.and_then(|p| p.get("name")).and_then(Value::as_str);
    let Some(f) = name.and_then(find) else { return rpc_err(id, -32602, "未知工具") };
    let empty = Map::new();
    let args = match params.and_then(|p| p.get("arguments")) {
        None | Some(Value::Null) => &empty,
        Some(Value::Object(m)) => m,
        Some(_) => return rpc_err(id, -32602, "arguments 必须是对象"),
    };
    let result = match f(sb, args) {
        Ok(v) => {
            let text = v.to_string();
            json!({ "content": [{ "type": "text", "text": text }], "structuredContent": v, "isError": false })
        }
        Err(e) => json!({ "content": [{ "type": "text", "text": format!("{}（{}）", e.message, e.code) }], "isError": true }),
    };
    ok(id, result)
}

/// 处理一行请求，返回要写回的一行；通知和空行返回 None
pub fn handle_line(sb: &Sandbox, line: &str) -> Option<String> {
    let line = line.trim();
    if line.is_empty() { return None; }
    let Ok(msg) = serde_json::from_str::<Value>(line) else { return Some(rpc_err(&Value::Null, -32700, "无法解析的 JSON")) };
    let Some(obj) = msg.as_object() else { return Some(rpc_err(&Value::Null, -32600, "请求必须是单个 JSON 对象")) };
    let id = obj.get("id")?;
    let Some(method) = obj.get("method").and_then(Value::as_str) else {
        // 客户端发来的响应：本服务器不发请求，忽略
        return if obj.contains_key("result") || obj.contains_key("error") { None } else { Some(rpc_err(id, -32600, "缺少 method")) };
    };
    let params = obj.get("params");
    Some(match method {
        "initialize" => {
            let want = params.and_then(|p| p.get("protocolVersion")).and_then(Value::as_str);
            let v = want.filter(|w| VERSIONS.contains(w)).unwrap_or(VERSIONS[0]);
            ok(id, json!({
                "protocolVersion": v,
                "capabilities": { "tools": { "listChanged": false } },
                "serverInfo": { "name": "eastgenesis-files", "version": env!("CARGO_PKG_VERSION") },
            }))
        }
        "ping" => ok(id, json!({})),
        "tools/list" => ok(id, json!({ "tools": schema::tools() })),
        "tools/call" => call(sb, id, params),
        _ => rpc_err(id, -32601, "不支持的方法"),
    })
}

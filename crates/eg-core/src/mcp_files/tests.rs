//! 内置文件服务器单元测试：临时目录当作家目录，覆盖越界、过滤、移动不覆盖、PDF 和 JSON-RPC
use super::sandbox::Sandbox;
use super::time::{age_days, rfc3339, within_days};
use super::*;
use crate::AppResult;
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

static N: AtomicUsize = AtomicUsize::new(0);

/// 临时目录：home/Downloads 是允许的根，outside 在范围外；结束时删除
struct Env {
    base: PathBuf,
    sb: Sandbox,
}
impl Drop for Env {
    fn drop(&mut self) { let _ = fs::remove_dir_all(&self.base); }
}
impl Env {
    fn new() -> Env {
        let base = std::env::temp_dir().join(format!("eg-files-{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
        fs::create_dir_all(base.join("home/Downloads")).unwrap();
        fs::create_dir_all(base.join("outside")).unwrap();
        let (sb, skipped) = Sandbox::new(&["~/Downloads".to_string(), "~/missing".to_string()], Some(base.join("home")));
        assert_eq!(skipped, ["~/missing"]);
        Env { base, sb }
    }
    fn dl(&self, rel: &str) -> PathBuf { self.base.join("home/Downloads").join(rel) }
    /// 写文件并把修改时间设为 days 天前
    fn put(&self, rel: &str, data: &[u8], days: u64) {
        let p = self.dl(rel);
        fs::write(&p, data).unwrap();
        let t = SystemTime::now() - Duration::from_secs(days * 86_400);
        fs::File::options().write(true).open(&p).unwrap().set_modified(t).unwrap();
    }
    /// 调 tools/call：返回 (isError, 结构化结果或错误文本)
    fn call(&self, name: &str, args: Value) -> (bool, Value) {
        let line = json!({ "jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": { "name": name, "arguments": args } });
        let r: Value = serde_json::from_str(&handle_line(&self.sb, &line.to_string()).unwrap()).unwrap();
        let err = r["result"]["isError"].as_bool().unwrap();
        (err, if err { r["result"]["content"][0]["text"].clone() } else { r["result"]["structuredContent"].clone() })
    }
    fn ok(&self, name: &str, args: Value) -> Value { let (e, v) = self.call(name, args); assert!(!e, "{name} 失败：{v}"); v }
    fn fail(&self, name: &str, args: Value) -> String { let (e, v) = self.call(name, args); assert!(e, "{name} 应当失败：{v}"); v.as_str().unwrap().to_string() }
}

#[test]
fn time_format_and_age() {
    let t = |s: u64| UNIX_EPOCH + Duration::from_secs(s);
    assert_eq!(rfc3339(t(0)), "1970-01-01T00:00:00Z");
    assert_eq!(rfc3339(t(951_782_400)), "2000-02-29T00:00:00Z");
    assert_eq!(rfc3339(t(20_454 * 86_400 + 3_723)), "2026-01-01T01:02:03Z");
    assert_eq!(rfc3339(UNIX_EPOCH - Duration::from_secs(86_400)), "1969-12-31T00:00:00Z");
    let now = t(100 * 86_400);
    assert_eq!(age_days(t(70 * 86_400 - 1), now), 30);
    assert_eq!(age_days(t(200 * 86_400), now), 0);
    assert!(within_days(t(70 * 86_400), now, 30));
    assert!(!within_days(t(70 * 86_400 - 1), now, 30));
    assert!(within_days(t(200 * 86_400), now, 0));
}

#[test]
fn sandbox_paths() {
    let e = Env::new();
    e.put("a.txt", b"hi", 0);
    let real = e.sb.existing("~/Downloads/a.txt").unwrap();
    assert_eq!(e.sb.show(&real), "~/Downloads/a.txt");
    assert_eq!(e.sb.existing(e.dl("a.txt").to_str().unwrap()).unwrap(), real);
    let code = |r: AppResult<PathBuf>| r.unwrap_err().code;
    assert_eq!(code(e.sb.existing("~/Downloads/none.txt")), "not_found");
    assert_eq!(code(e.sb.existing("Downloads/a.txt")), "invalid_path");
    assert_eq!(code(e.sb.existing("~/Downloads/../Downloads/a.txt")), "invalid_path");
    assert_eq!(code(e.sb.existing("")), "invalid_path");
    // 范围外：不论是否存在都回同一个错误，不泄露范围外的文件是否存在
    fs::write(e.base.join("outside/secret.txt"), b"x").unwrap();
    assert_eq!(code(e.sb.existing(e.base.join("outside/secret.txt").to_str().unwrap())), "path_not_allowed");
    assert_eq!(code(e.sb.existing(e.base.join("outside/none/x").to_str().unwrap())), "path_not_allowed");
    assert_eq!(code(e.sb.target("~/elsewhere.txt")), "path_not_allowed");
    assert!(e.sb.is_root(&e.sb.existing("~/Downloads").unwrap()));
    // 没有可用根目录：一律拒绝
    let (none, _) = Sandbox::new(&["/definitely/not/here".to_string()], None);
    assert!(none.is_empty());
    assert_eq!(code(none.existing("/tmp")), "path_not_allowed");
    assert_eq!(code(none.existing("~/x")), "invalid_path");
}

#[cfg(unix)]
#[test]
fn symlinks_cannot_escape() {
    use std::os::unix::fs::symlink;
    let e = Env::new();
    let out = e.base.join("outside");
    fs::write(out.join("secret.pdf"), b"%PDF-1.4 secret").unwrap();
    symlink(out.join("secret.pdf"), e.dl("link.pdf")).unwrap();
    symlink(&out, e.dl("link_dir")).unwrap();
    symlink(out.join("none"), e.dl("dangling")).unwrap();
    assert!(e.fail("read_file", json!({ "path": "~/Downloads/link.pdf" })).contains("path_not_allowed"));
    assert!(e.fail("read_pdf", json!({ "path": "~/Downloads/link.pdf" })).contains("path_not_allowed"));
    assert!(e.fail("list_directory", json!({ "path": "~/Downloads/link_dir" })).contains("path_not_allowed"));
    assert!(e.fail("write_file", json!({ "path": "~/Downloads/link_dir/x.txt", "content": "x" })).contains("path_not_allowed"));
    assert!(e.fail("write_file", json!({ "path": "~/Downloads/dangling", "content": "x" })).contains("path_not_allowed"));
    assert!(e.fail("create_directory", json!({ "path": "~/Downloads/link_dir/sub" })).contains("path_not_allowed"));
    e.put("a.txt", b"a", 0);
    assert!(e.fail("move_file", json!({ "src": "~/Downloads/a.txt", "dst": "~/Downloads/link_dir" })).contains("path_not_allowed"));
    // 链接本身在范围内：可以查看、移动、删除，目标不受影响
    assert_eq!(e.ok("get_file_info", json!({ "path": "~/Downloads/link.pdf" }))["type"], "symlink");
    e.ok("move_file", json!({ "src": "~/Downloads/link.pdf", "dst": "~/Downloads/moved.pdf" }));
    e.ok("delete_file", json!({ "path": "~/Downloads/moved.pdf" }));
    assert!(out.join("secret.pdf").exists());
    // 按扩展名过滤时不列符号链接
    symlink(out.join("secret.pdf"), e.dl("again.pdf")).unwrap();
    assert_eq!(e.ok("list_directory", json!({ "path": "~/Downloads", "extension": "pdf" }))["total"], 0);
}

#[test]
fn list_filters_sorts_and_pages() {
    let e = Env::new();
    fs::create_dir(e.dl("folder.pdf")).unwrap();
    e.put("old.pdf", b"o", 40);
    e.put("mid.pdf", b"m", 10);
    e.put("new.PDF", b"n", 1);
    e.put("notes.txt", b"t", 2);
    e.put(".hidden.pdf", b"h", 0);
    let v = e.ok("list_directory", json!({ "path": "~/Downloads", "extension": ".pdf", "modified_within_days": 30 }));
    let names: Vec<&str> = v["entries"].as_array().unwrap().iter().map(|x| x["name"].as_str().unwrap()).collect();
    assert_eq!(names, ["new.PDF", "mid.pdf"]);
    assert_eq!(v["entries"][1]["path"], "~/Downloads/mid.pdf");
    assert_eq!((v["entries"][1]["age_days"].as_u64(), v["entries"][1]["type"].as_str()), (Some(10), Some("file")));
    assert_eq!((v["total"].as_u64(), v["truncated"].as_bool()), (Some(2), Some(false)));
    assert_eq!(e.ok("list_directory", json!({ "path": "~/Downloads" }))["total"], 5);
    assert_eq!(e.ok("list_directory", json!({ "path": "~/Downloads", "include_hidden": true }))["total"], 6);
    let v = e.ok("list_directory", json!({ "path": "~/Downloads", "modified_within_days": "30", "offset": 1 }));
    assert_eq!((v["total"].as_u64(), v["returned"].as_u64(), v["entries"][0]["name"].as_str()), (Some(4), Some(3), Some("new.PDF")));
    assert!(e.fail("list_directory", json!({ "path": "~/Downloads/notes.txt" })).contains("不是目录"));
    assert!(e.fail("list_directory", json!({ "path": "~/Downloads", "offset": -1 })).contains("invalid_argument"));
}

#[test]
fn write_move_delete() {
    let e = Env::new();
    let v = e.ok("write_file", json!({ "path": "~/Downloads/a.txt", "content": "你好" }));
    assert_eq!((v["created"].as_bool(), v["bytes"].as_u64()), (Some(true), Some(6)));
    assert!(e.fail("write_file", json!({ "path": "~/Downloads/a.txt", "content": "x" })).contains("already_exists"));
    assert_eq!(e.ok("write_file", json!({ "path": "~/Downloads/a.txt", "content": "新", "overwrite": true }))["created"], false);
    assert_eq!(fs::read_to_string(e.dl("a.txt")).unwrap(), "新");
    assert!(e.fail("write_file", json!({ "path": "~/Downloads/no/a.txt", "content": "x" })).contains("not_found"));
    // 建目录：可重复；同名文件已存在时报错
    assert_eq!(e.ok("create_directory", json!({ "path": "~/Downloads/合同/2026" }))["created"], true);
    assert_eq!(e.ok("create_directory", json!({ "path": "~/Downloads/合同" }))["created"], false);
    assert!(e.fail("create_directory", json!({ "path": "~/Downloads/a.txt" })).contains("already_exists"));
    // 移动：dst 是目录时移入；目标已存在一律不覆盖
    let v = e.ok("move_file", json!({ "src": "~/Downloads/a.txt", "dst": "~/Downloads/合同" }));
    assert_eq!((v["src"].as_str(), v["dst"].as_str()), (Some("~/Downloads/a.txt"), Some("~/Downloads/合同/a.txt")));
    e.put("a.txt", b"second", 0);
    assert!(e.fail("move_file", json!({ "src": "~/Downloads/a.txt", "dst": "~/Downloads/合同" })).contains("already_exists"));
    assert!(e.fail("move_file", json!({ "src": "~/Downloads/a.txt", "dst": "~/Downloads/合同/a.txt" })).contains("already_exists"));
    assert_eq!(fs::read_to_string(e.dl("合同/a.txt")).unwrap(), "新");
    assert!(e.fail("move_file", json!({ "src": "~/Downloads/a.txt", "dst": "~/Downloads" })).contains("same_path"));
    assert!(e.fail("move_file", json!({ "src": "~/Downloads/合同", "dst": "~/Downloads/合同/2026" })).contains("自己里面"));
    assert!(e.fail("move_file", json!({ "src": "~/Downloads", "dst": "~/moved" })).contains("path_not_allowed"));
    assert!(e.fail("move_file", json!({ "src": "~/Downloads/a.txt", "dst": "~/Downloads/x/y.txt" })).contains("not_found"));
    assert!(e.fail("move_file", json!({ "src": "~/Downloads/none", "dst": "~/Downloads/合同" })).contains("not_found"));
    // 删除：只删文件
    assert!(e.fail("delete_file", json!({ "path": "~/Downloads/合同" })).contains("不能删除目录"));
    e.ok("delete_file", json!({ "path": "~/Downloads/a.txt" }));
    assert!(!e.dl("a.txt").exists());
    assert!(e.fail("delete_file", json!({ "path": "~/Downloads/a.txt" })).contains("not_found"));
}

#[test]
fn read_text_and_info() {
    let e = Env::new();
    e.put("a.txt", "第一行\n第二行".as_bytes(), 3);
    let v = e.ok("read_file", json!({ "path": "~/Downloads/a.txt" }));
    assert_eq!((v["content"].as_str(), v["truncated"].as_bool()), (Some("第一行\n第二行"), Some(false)));
    e.put("big.txt", "字".repeat(7_000).as_bytes(), 0);
    let v = e.ok("read_file", json!({ "path": "~/Downloads/big.txt" }));
    assert_eq!((v["content"].as_str().unwrap().chars().count(), v["truncated"].as_bool()), (6_000, Some(true)));
    e.put("bin.dat", &[0xff, 0xfe, 0x00, 0x41], 0);
    assert!(e.fail("read_file", json!({ "path": "~/Downloads/bin.dat" })).contains("read_pdf"));
    assert!(e.fail("read_file", json!({ "path": "~/Downloads" })).contains("不是文件"));
    assert!(e.fail("read_file", json!({})).contains("缺少参数 path"));
    let v = e.ok("get_file_info", json!({ "path": "~/Downloads/a.txt" }));
    assert_eq!((v["type"].as_str(), v["size"].as_u64(), v["age_days"].as_u64(), v["extension"].as_str()), (Some("file"), Some(19), Some(3), Some("txt")));
    assert!(v["modified"].as_str().unwrap().ends_with('Z'));
    let v = e.ok("get_file_info", json!({ "path": "~/Downloads" }));
    assert_eq!((v["path"].as_str(), v["type"].as_str()), (Some("~/Downloads"), Some("directory")));
}

/// 最小的单页 PDF：标题和一行正文（ASCII）
fn mini_pdf(title: &str, body: &str) -> Vec<u8> {
    let content = format!("BT /F1 12 Tf 72 720 Td ({body}) Tj ET");
    let objs = [
        "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_string(),
        "<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>".to_string(),
        format!("<< /Length {} >>\nstream\n{content}\nendstream", content.len()),
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_string(),
        format!("<< /Title ({title}) >>"),
    ];
    let mut out = String::from("%PDF-1.7\n");
    for (i, o) in objs.iter().enumerate() { out.push_str(&format!("{} 0 obj\n{o}\nendobj\n", i + 1)); }
    out.push_str("trailer\n<< /Root 1 0 R /Info 6 0 R >>\n%%EOF\n");
    out.into_bytes()
}

#[test]
fn pdf_tools() {
    let e = Env::new();
    e.put("a.pdf", &mini_pdf("Q3 Report", "Revenue and profit"), 0);
    let v = e.ok("read_pdf", json!({ "path": "~/Downloads/a.pdf" }));
    assert_eq!((v["title"].as_str(), v["text"].as_str(), v["pages"].as_u64()), (Some("Q3 Report"), Some("Revenue and profit"), Some(1)));
    assert!(v.get("note").is_none());
    let v = e.ok("read_pdf", json!({ "path": "~/Downloads/a.pdf", "max_chars": 7 }));
    assert_eq!((v["text"].as_str(), v["truncated"].as_bool()), (Some("Revenue"), Some(true)));
    let v = e.ok("get_pdf_metadata", json!({ "path": "~/Downloads/a.pdf" }));
    assert_eq!((v["title"].as_str(), v["pages"].as_u64(), v.get("text")), (Some("Q3 Report"), Some(1), None));
    e.put("scan.pdf", &mini_pdf("Scan", ""), 0);
    assert!(e.ok("read_pdf", json!({ "path": "~/Downloads/scan.pdf" }))["note"].is_string());
    e.put("bad.pdf", b"not a pdf", 0);
    assert!(e.fail("read_pdf", json!({ "path": "~/Downloads/bad.pdf" })).contains("pdf_invalid"));
    e.put("a.txt", b"x", 0);
    assert!(e.fail("read_pdf", json!({ "path": "~/Downloads/a.txt" })).contains("不是 .pdf"));
}

fn rpc(e: &Env, msg: Value) -> Option<Value> { handle_line(&e.sb, &msg.to_string()).map(|s| serde_json::from_str(&s).unwrap()) }

#[test]
fn json_rpc_protocol() {
    let e = Env::new();
    let init = rpc(&e, json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "1999-01-01" } })).unwrap();
    assert_eq!(init["result"]["protocolVersion"], "2025-06-18");
    assert_eq!(init["result"]["serverInfo"]["name"], "eastgenesis-files");
    let old = rpc(&e, json!({ "jsonrpc": "2.0", "id": 2, "method": "initialize", "params": { "protocolVersion": "2024-11-05" } })).unwrap();
    assert_eq!(old["result"]["protocolVersion"], "2024-11-05");
    assert!(rpc(&e, json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })).is_none());
    assert!(handle_line(&e.sb, "   ").is_none());
    assert_eq!(rpc(&e, json!({ "jsonrpc": "2.0", "id": "p", "method": "ping" })).unwrap()["result"], json!({}));
    let list = rpc(&e, json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/list" })).unwrap();
    let tools = list["result"]["tools"].as_array().unwrap();
    let names: Vec<&str> = tools.iter().map(|t| t["name"].as_str().unwrap()).collect();
    assert_eq!(names, TOOL_NAMES);
    for t in tools {
        let (name, ann) = (t["name"].as_str().unwrap(), &t["annotations"]);
        assert_eq!(t["inputSchema"]["type"], "object", "{name}");
        let destructive = matches!(name, "write_file" | "move_file" | "delete_file");
        assert_eq!(ann["destructiveHint"], destructive, "{name}");
        assert_eq!(ann["readOnlyHint"], !destructive && name != "create_directory", "{name}");
    }
    let code = |line: &str| -> i64 { serde_json::from_str::<Value>(&handle_line(&e.sb, line).unwrap()).unwrap()["error"]["code"].as_i64().unwrap() };
    assert_eq!(code("{not json"), -32700);
    assert_eq!(code("[1,2]"), -32600);
    assert_eq!(code(r#"{"jsonrpc":"2.0","id":4,"method":"resources/list"}"#), -32601);
    assert_eq!(code(r#"{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"rm_rf"}}"#), -32602);
    assert_eq!(code(r#"{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"read_file","arguments":[1]}}"#), -32602);
}

#[test]
fn serve_skips_overlong_lines() {
    let e = Env::new();
    let ping = json!({ "jsonrpc": "2.0", "id": 1, "method": "ping" }).to_string();
    let input = format!("{ping}\n{}\n\n{ping}\n", "x".repeat(200));
    let mut out = Vec::new();
    serve(&e.sb, std::io::Cursor::new(input), &mut out, 64).unwrap();
    let lines: Vec<Value> = String::from_utf8(out).unwrap().lines().map(|l| serde_json::from_str(l).unwrap()).collect();
    assert_eq!(lines.len(), 3);
    assert_eq!((lines[0]["result"].clone(), lines[1]["error"]["code"].as_i64(), lines[2]["id"].as_i64()), (json!({}), Some(-32700), Some(1)));
}

#[test]
fn builtin_entry_is_literal_and_whitelisted() {
    let b = builtin_entry("/Apps/EastGenesis", &["--mcp-files"]);
    assert_eq!((b.id.as_str(), b.trust_annotations), ("files", true));
    let args: Vec<&str> = b.args.iter().map(|t| t.raw.as_str()).collect();
    assert_eq!(args, ["--mcp-files", "--allow", "~/Downloads"]);
    // 参数里的 ${ 按字面传递，不当作引用
    assert!(builtin_entry("/x", &["${env:HOME}"]).refs().is_empty());
    assert!(TOOL_NAMES.iter().all(|t| b.allow_tools.allows(t)) && !b.allow_tools.allows("exec"));
    assert_eq!(run_cli(vec![]), 2);
    assert_eq!(run_cli(vec!["--allow".into()]), 2);
    assert_eq!(run_cli(vec!["--bogus".into(), "x".into()]), 2);
}

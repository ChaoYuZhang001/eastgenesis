//! eg-mcp-files 进程级测试：真实子进程，JSON-RPC 走标准输入输出；环境变量清空，只给 HOME
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

const BIN: &str = env!("CARGO_BIN_EXE_eg-mcp-files");

struct Proc {
    child: Child,
    stdin: Option<ChildStdin>,
    out: BufReader<ChildStdout>,
}
impl Proc {
    fn start(home: &PathBuf) -> Proc {
        let mut child = Command::new(BIN)
            .args(["--allow", "~/Downloads"])
            .env_clear()
            .env("HOME", home)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let (stdin, out) = (child.stdin.take(), BufReader::new(child.stdout.take().unwrap()));
        Proc { child, stdin, out }
    }
    fn send(&mut self, msg: Value) {
        let w = self.stdin.as_mut().unwrap();
        writeln!(w, "{msg}").unwrap();
        w.flush().unwrap();
    }
    fn ask(&mut self, msg: Value) -> Value {
        self.send(msg);
        let mut line = String::new();
        self.out.read_line(&mut line).unwrap();
        serde_json::from_str(&line).unwrap()
    }
    fn call(&mut self, id: u64, name: &str, args: Value) -> Value {
        self.ask(json!({ "jsonrpc": "2.0", "id": id, "method": "tools/call", "params": { "name": name, "arguments": args } }))["result"].clone()
    }
}

#[test]
fn stdio_roundtrip() {
    let home = std::env::temp_dir().join(format!("eg-stdio-{}", std::process::id()));
    std::fs::create_dir_all(home.join("Downloads")).unwrap();
    std::fs::write(home.join("Downloads/a.txt"), "hello").unwrap();
    std::fs::write(home.join("secret.txt"), "x").unwrap();
    let mut p = Proc::start(&home);
    let init = p.ask(json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": { "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": { "name": "test", "version": "0" } } }));
    assert_eq!(init["result"]["serverInfo"]["name"], "eastgenesis-files");
    p.send(json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }));
    let list = p.ask(json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }));
    assert_eq!(list["result"]["tools"].as_array().unwrap().len(), 9);
    let v = p.call(3, "list_directory", json!({ "path": "~/Downloads" }));
    assert_eq!((v["isError"].as_bool(), v["structuredContent"]["entries"][0]["name"].as_str()), (Some(false), Some("a.txt")));
    assert_eq!(p.call(4, "create_directory", json!({ "path": "~/Downloads/sub" }))["isError"], false);
    let v = p.call(5, "move_file", json!({ "src": "~/Downloads/a.txt", "dst": "~/Downloads/sub" }));
    assert_eq!(v["structuredContent"]["dst"], "~/Downloads/sub/a.txt");
    assert!(home.join("Downloads/sub/a.txt").is_file());
    let v = p.call(6, "read_file", json!({ "path": home.join("secret.txt").to_str().unwrap() }));
    assert_eq!(v["isError"], true);
    assert!(v["content"][0]["text"].as_str().unwrap().contains("path_not_allowed"));
    drop(p.stdin.take());
    assert!(p.child.wait().unwrap().success());
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn requires_allow_argument() {
    let s = Command::new(BIN).stdin(Stdio::null()).stderr(Stdio::null()).status().unwrap();
    assert_eq!(s.code(), Some(2));
}

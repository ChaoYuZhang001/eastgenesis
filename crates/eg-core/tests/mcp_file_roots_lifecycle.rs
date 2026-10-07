//! Real stdio process proof for directory grants/revocations in one app lifetime.
//! Owned temporary HOME only; no Provider, user profile, or synthetic MCP replies.
use eg_core::file_roots::FileRootsStore;
use eg_core::mcp_files::builtin_entry;
use eg_core::mcp_host::LineFn;
use eg_core::mcp_service::McpService;
use eg_core::secrets::MemoryStore;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{mpsc, Arc};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

struct OwnedHome(PathBuf);
static NEXT_HOME_ID: AtomicUsize = AtomicUsize::new(0);
impl OwnedHome {
    fn new() -> Self {
        let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let sequence = NEXT_HOME_ID.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!("eg-roots-lifecycle-{}-{nonce}-{sequence}", std::process::id()));
        std::fs::create_dir(&path).unwrap();
        for dir in ["Downloads", "Documents", "outside"] { std::fs::create_dir(path.join(dir)).unwrap(); }
        std::fs::write(path.join("Downloads/default.txt"), "default-content").unwrap();
        std::fs::write(path.join("Documents/input.txt"), "explicitly-granted-content").unwrap();
        std::fs::write(path.join("outside/private.txt"), "outside-content").unwrap();
        Self(path)
    }
}
impl Drop for OwnedHome {
    fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); }
}

fn service(home: &OwnedHome, roots: &FileRootsStore) -> McpService<MemoryStore> {
    let mut env = HashMap::from([
        ("HOME".into(), home.0.to_string_lossy().into_owned()),
        ("USERPROFILE".into(), home.0.to_string_lossy().into_owned()),
    ]);
    // Windows process startup may need these system paths; never inherit keys.
    for name in ["SystemRoot", "PATH"] {
        if let Ok(value) = std::env::var(name) { env.insert(name.into(), value); }
    }
    McpService::new(home.0.join("mcp.json"), "~/mcp.json".into(), env, MemoryStore::default())
        .with_builtin(vec![builtin_entry(env!("CARGO_BIN_EXE_eg-mcp-files"), &[], &roots.raw_roots())])
}

fn start(service: &McpService<MemoryStore>) -> mpsc::Receiver<String> {
    let (tx, rx) = mpsc::channel();
    let on_line: LineFn = Arc::new(move |line| { let _ = tx.send(line); });
    service.start("files", on_line, Arc::new(|_| {})).unwrap();
    rx
}

fn call(service: &McpService<MemoryStore>, replies: &mpsc::Receiver<String>, name: &str, arguments: Value) -> Value {
    service.send("files", &json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":name,"arguments":arguments}}).to_string()).unwrap();
    let line = replies.recv_timeout(Duration::from_secs(3)).expect("owned file server did not reply");
    serde_json::from_str::<Value>(&line).unwrap()["result"].clone()
}

fn denied(result: Value) {
    assert_eq!(result["isError"], true);
    assert!(result["content"][0]["text"].as_str().unwrap().contains("path_not_allowed"));
}

#[test]
fn explicit_grant_and_revoke_refresh_the_real_file_server_without_app_restart() {
    let home = OwnedHome::new();
    let mut roots = FileRootsStore::load(home.0.join("file-roots.json"), Some(home.0.clone())).unwrap();
    let service = service(&home, &roots);
    let replies = start(&service);
    denied(call(&service, &replies, "read_file", json!({"path":"~/Documents/input.txt"})));

    service.add_file_root(&mut roots, "~/Documents").unwrap();
    assert!(!service.list().servers[0].running, "saving roots must stop the previous server before returning");
    assert_eq!(service.send("files", "{}").unwrap_err().code, "mcp_not_running");
    let replies = start(&service);
    assert_eq!(call(&service, &replies, "read_file", json!({"path":"~/Documents/input.txt"}))["isError"], false);
    assert_eq!(call(&service, &replies, "write_file", json!({"path":"~/Documents/output.txt","content":"owned-output"}))["isError"], false);
    assert_eq!(std::fs::read_to_string(home.0.join("Documents/output.txt")).unwrap(), "owned-output");
    denied(call(&service, &replies, "read_file", json!({"path":"~/outside/private.txt"})));
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(home.0.join("outside"), home.0.join("Documents/escape")).unwrap();
        denied(call(&service, &replies, "read_file", json!({"path":"~/Documents/escape/private.txt"})));
    }

    service.remove_file_root(&mut roots, "~/Documents").unwrap();
    assert!(!service.list().servers[0].running);
    assert_eq!(service.send("files", "{}").unwrap_err().code, "mcp_not_running");
    let replies = start(&service);
    denied(call(&service, &replies, "read_file", json!({"path":"~/Documents/input.txt"})));
    denied(call(&service, &replies, "write_file", json!({"path":"~/Documents/revoked.txt","content":"must-not-write"})));
    assert!(!home.0.join("Documents/revoked.txt").exists());
    assert_eq!(call(&service, &replies, "read_file", json!({"path":"~/Downloads/default.txt"}))["isError"], false);
    assert_eq!(FileRootsStore::load(home.0.join("file-roots.json"), Some(home.0.clone())).unwrap().raw_roots(), vec!["~/Downloads".to_string()]);
    service.stop_all();
}

#[test]
fn failed_permission_save_preserves_the_running_server_and_its_roots() {
    let home = OwnedHome::new();
    let blocked = home.0.join("config-is-a-file");
    let mut roots = FileRootsStore::load(blocked.join("file-roots.json"), Some(home.0.clone())).unwrap();
    std::fs::write(&blocked, "owned storage blocker").unwrap();
    let service = service(&home, &roots);
    let replies = start(&service);
    let before = service.list().servers[0].args.clone();
    assert_eq!(service.add_file_root(&mut roots, "~/Documents").unwrap_err().code, "config_write_failed");
    assert_eq!(service.list().servers[0].args, before);
    assert!(service.list().servers[0].running);
    denied(call(&service, &replies, "read_file", json!({"path":"~/Documents/input.txt"})));
    assert_eq!(call(&service, &replies, "read_file", json!({"path":"~/Downloads/default.txt"}))["isError"], false);

    // Repair only our synthetic config destination, grant, then force a real
    // removal-write failure. A rejected revoke must keep the old live grant.
    std::fs::remove_file(&blocked).unwrap();
    service.add_file_root(&mut roots, "~/Documents").unwrap();
    let replies = start(&service);
    let granted = service.list().servers[0].args.clone();
    std::fs::remove_file(blocked.join("file-roots.json")).unwrap();
    std::fs::remove_dir(&blocked).unwrap();
    std::fs::write(&blocked, "owned storage blocker").unwrap();
    assert_eq!(service.remove_file_root(&mut roots, "~/Documents").unwrap_err().code, "config_write_failed");
    assert_eq!(service.list().servers[0].args, granted);
    assert!(service.list().servers[0].running);
    assert!(roots.raw_roots().contains(&"~/Documents".to_string()));
    assert_eq!(call(&service, &replies, "read_file", json!({"path":"~/Documents/input.txt"}))["isError"], false);
    service.stop_all();
}

#[test]
fn stale_connection_cannot_write_to_or_stop_a_replacement_file_process() {
    let home = OwnedHome::new();
    let mut roots = FileRootsStore::load(home.0.join("file-roots.json"), Some(home.0.clone())).unwrap();
    let service = service(&home, &roots);
    service.start_for_connection("files", Some("old-connection"), Arc::new(|_| {}), Arc::new(|_| {})).unwrap();
    // The root update invalidates the previous owner as well as its process.
    service.add_file_root(&mut roots, "~/Documents").unwrap();
    let (tx, replies) = mpsc::channel();
    service.start_for_connection("files", Some("new-connection"), Arc::new(move |line| { let _ = tx.send(line); }), Arc::new(|_| {})).unwrap();
    assert_eq!(service.stop_for_connection("files", Some("old-connection")).unwrap_err().code, "mcp_stale_connection");
    assert!(service.list().servers[0].running);
    let stale_write = json!({"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"write_file","arguments":{"path":"~/Documents/stale.txt","content":"must-not-write"}}});
    assert_eq!(service.send_for_connection("files", &stale_write.to_string(), Some("old-connection")).unwrap_err().code, "mcp_stale_connection");
    assert!(!home.0.join("Documents/stale.txt").exists());
    let current_read = json!({"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"read_file","arguments":{"path":"~/Documents/input.txt"}}});
    service.send_for_connection("files", &current_read.to_string(), Some("new-connection")).unwrap();
    let line = replies.recv_timeout(Duration::from_secs(3)).expect("current connection did not receive its real file reply");
    assert_eq!(serde_json::from_str::<Value>(&line).unwrap()["result"]["isError"], false);
    service.stop_for_connection("files", Some("new-connection")).unwrap();
    assert!(!service.list().servers[0].running);
}

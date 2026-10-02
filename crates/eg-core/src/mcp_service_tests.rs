use super::*;
use crate::secrets::{MemoryStore, JEV_ENV};
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{mpsc, Arc};
use std::time::Duration;

static N: AtomicUsize = AtomicUsize::new(0);

/// 临时配置目录（系统临时目录，不在项目里）
struct Tmp(PathBuf);
impl Tmp {
    fn file(&self) -> PathBuf {
        self.0.join("mcp.json")
    }
}
impl Drop for Tmp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn svc(json: &str, env: &[(&str, &str)]) -> (Tmp, McpService<MemoryStore>) {
    let t = Tmp(std::env::temp_dir().join(format!("eg-mcp-{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst))));
    std::fs::create_dir_all(&t.0).unwrap();
    std::fs::write(t.file(), json).unwrap();
    let env = env.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
    let s = McpService::new(t.file(), "~/cfg/mcp.json".into(), env, MemoryStore::default());
    (t, s)
}

fn chan() -> (LineFn, LineFn, mpsc::Receiver<String>) {
    let (tx, rx) = mpsc::channel();
    (Arc::new(move |l: String| drop(tx.send(l))), Arc::new(|_r: String| {}), rx)
}

fn call(name: &str) -> String {
    format!(r#"{{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{{"name":"{name}"}}}}"#)
}

#[test]
fn starts_only_registered_servers_and_guards_calls() {
    let (_t, s) = svc(r#"{ "mcpServers": { "echo": { "command": "/bin/cat", "allowTools": ["read"] } } }"#, &[("PATH", "/usr/bin:/bin")]);
    let (a, b, lines) = chan();
    assert_eq!(s.start("other", a.clone(), b.clone()).unwrap_err().code, "mcp_not_registered");
    let v = s.start("echo", a, b).unwrap();
    assert!(v.running && v.allow_tools == AllowTools::Only(vec!["read".into()]));
    s.send("echo", &call("read")).unwrap();
    assert!(lines.recv_timeout(Duration::from_secs(3)).unwrap().contains("\"read\""));
    assert_eq!(s.send("echo", &call("delete_all")).unwrap_err().code, "mcp_tool_not_allowed");
    assert!(s.list().servers[0].running);
    assert!(s.stop("echo").unwrap());
    assert_eq!(s.send("echo", &call("read")).unwrap_err().code, "mcp_not_running");
    assert!(!s.list().servers[0].running);
}

#[test]
fn resolves_keychain_and_env_references_for_the_child_only() {
    let json = r#"{ "mcpServers": { "probe": {
        "command": "/bin/sh",
        "args": ["-c", "printf '%s|%s|%s\\n' \"$GH_TOKEN\" \"$WHERE\" \"$OPENAI_API_KEY\""],
        "env": { "GH_TOKEN": "${keychain:GH_TOKEN}", "WHERE": "${env:EG_TEST_WHERE}" }
    } } }"#;
    let env = [("PATH", "/usr/bin:/bin"), ("EG_TEST_WHERE", "here"), ("OPENAI_API_KEY", "sk-parent-secret-0123456789")];
    let (_t, s) = svc(json, &env);
    let (a, b, lines) = chan();
    assert_eq!(s.start("probe", a.clone(), b.clone()).unwrap_err().code, "mcp_secret_missing");
    assert_eq!(
        s.list().servers[0].refs,
        vec![
            RefStatus { source: RefSource::Keychain, name: "GH_TOKEN".into(), configured: false },
            RefStatus { source: RefSource::Env, name: "EG_TEST_WHERE".into(), configured: true },
        ]
    );
    s.set_secret("probe", "GH_TOKEN", "tok-value-1").unwrap();
    assert!(s.list().servers[0].refs[0].configured);
    s.start("probe", a, b).unwrap();
    // 子进程拿到钥匙串和环境变量里的值，拿不到模型 Provider 的 Key
    assert_eq!(lines.recv_timeout(Duration::from_secs(3)).unwrap(), "tok-value-1|here|");
    let shown = serde_json::to_string(&s.list()).unwrap();
    assert!(shown.contains("${keychain:GH_TOKEN}") && !shown.contains("tok-value-1"));
    s.stop_all();
}

#[test]
fn secrets_only_for_referenced_names_and_errors_are_listed() {
    let (t, s) = svc(r#"{ "mcpServers": { "gh": { "command": "gh-mcp", "env": { "T": "${keychain:GH_TOKEN}" } }, "Bad": { "command": "x" } } }"#, &[]);
    assert_eq!(s.set_secret("gh", "OTHER", "value-1").unwrap_err().code, "mcp_secret_not_referenced");
    assert_eq!(s.set_secret("nope", "GH_TOKEN", "value-1").unwrap_err().code, "mcp_not_registered");
    s.set_secret("gh", "GH_TOKEN", "value-1").unwrap();
    s.delete_secret("gh", "GH_TOKEN").unwrap();
    assert!(!s.list().servers[0].refs[0].configured);
    let v = s.list();
    assert_eq!(v.path_hint, "~/cfg/mcp.json");
    assert_eq!((v.servers.len(), v.errors[0].id.as_str()), (1, "Bad"));
    std::fs::write(t.file(), "{ broken").unwrap();
    let v = s.list();
    assert!(v.servers.is_empty() && v.errors[0].id == "mcp.json");
    std::fs::remove_file(t.file()).unwrap();
    let v = s.list();
    assert!(v.servers.is_empty() && v.errors.is_empty());
}

#[test]
fn provider_keys_are_dropped_from_the_env_snapshot() {
    let (_t, s) = svc("{}", &[("OPENAI_API_KEY", "sk-x"), (JEV_ENV, "y"), ("HOME", "/h")]);
    assert!(!s.env.contains_key("OPENAI_API_KEY") && !s.env.contains_key(JEV_ENV) && s.env.contains_key("HOME"));
}

#[test]
fn path_hint_hides_home() {
    let p = Path::new("/Users/alice/Library/Application Support/com.eastgenesis.desktop/mcp.json");
    assert_eq!(path_hint(p, Some(Path::new("/Users/alice"))), "~/Library/Application Support/com.eastgenesis.desktop/mcp.json");
    assert_eq!(path_hint(p, None), "mcp.json");
    assert_eq!(path_hint(p, Some(Path::new("/home/bob"))), "mcp.json");
}

#[test]
fn builtin_servers_win_over_mcp_json_and_survive_corruption() {
    // 用 sh -c cat 代替真实程序：多余的参数被 sh 吞掉，cat 原样回显
    let files = crate::mcp_files::builtin_entry("/bin/sh", &["-c", "cat", "sh"]);
    let (t, s) = svc(r#"{ "mcpServers": { "files": { "command": "/evil", "allowTools": "*" }, "echo": { "command": "/bin/cat" } } }"#, &[("PATH", "/usr/bin:/bin")]);
    let s = s.with_builtin(vec![files]);
    let v = s.list();
    let ids: Vec<(&str, bool)> = v.servers.iter().map(|x| (x.id.as_str(), x.builtin)).collect();
    assert_eq!(ids, [("files", true), ("echo", false)]);
    assert_eq!((v.servers[0].command.as_str(), v.errors[0].id.as_str()), ("sh", "files"));
    let (a, b, lines) = chan();
    let started = s.start("files", a, b).unwrap();
    assert!(started.builtin && started.allow_tools.allows("move_file") && !started.allow_tools.allows("exec"));
    s.send("files", &call("read_pdf")).unwrap();
    assert!(lines.recv_timeout(Duration::from_secs(3)).unwrap().contains("read_pdf"));
    assert_eq!(s.send("files", &call("exec")).unwrap_err().code, "mcp_tool_not_allowed");
    assert_eq!(s.set_secret("files", "X", "value-1").unwrap_err().code, "mcp_secret_not_referenced");
    s.stop_all();
    // mcp.json 损坏：内置服务器照常列出，错误单独报告
    std::fs::write(t.file(), "{ broken").unwrap();
    let v = s.list();
    assert_eq!((v.servers.len(), v.servers[0].id.as_str(), v.errors[0].id.as_str()), (1, "files", "mcp.json"));
}

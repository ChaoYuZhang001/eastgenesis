//! MCP 进程管理（桌面端）。Rust 只负责启动进程、按行转发消息；JSON-RPC 协议由前端的 McpClient 处理（与 CLI 共用）。
//! 启动哪些服务器由 mcp_service 按 mcp.json 登记表决定，这里不直接接受前端传来的配置。
//! - 不经过 shell，参数不会被解释。
//! - 子进程只继承最小环境变量加显式配置，拿不到我们的 API Key。
//! - 每行一条消息；超过 10MB 的行丢弃。

use std::collections::{BTreeMap, HashMap};
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex, MutexGuard};

use crate::error::{AppError, AppResult};

pub const PASS_ENV: &[&str] = &[
    "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TMPDIR", "TEMP", "TMP", "SystemRoot", "ComSpec", "APPDATA",
    "LOCALAPPDATA", "USERPROFILE",
];
const MAX_LINE: usize = 10 * 1024 * 1024;

/// 已解析引用的启动配置，只由 mcp_service 根据 mcp.json 生成；env 里可能有密钥值，Debug 不输出它们
#[derive(Clone)]
pub struct McpServerConfig {
    pub id: String,
    pub command: String,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
    pub cwd: Option<String>,
}

impl std::fmt::Debug for McpServerConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("McpServerConfig")
            .field("id", &self.id)
            .field("command", &self.command)
            .field("args", &self.args.len())
            .field("env", &self.env.keys().collect::<Vec<_>>())
            .field("cwd", &self.cwd)
            .finish()
    }
}

pub fn child_env(parent: &HashMap<String, String>, extra: &BTreeMap<String, String>) -> BTreeMap<String, String> {
    let mut env: BTreeMap<String, String> =
        PASS_ENV.iter().filter_map(|k| parent.get(*k).map(|v| (k.to_string(), v.clone()))).collect();
    env.extend(extra.iter().map(|(k, v)| (k.clone(), v.clone())));
    env
}

pub fn valid_server_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 32
        && id.bytes().next().is_some_and(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}

pub type LineFn = Arc<dyn Fn(String) + Send + Sync>;

struct Proc {
    child: Child,
    stdin: Option<ChildStdin>,
    stderr: Arc<Mutex<String>>,
}

#[derive(Default)]
pub struct McpHost {
    procs: Mutex<HashMap<String, Proc>>,
}

fn write_line(w: &mut impl Write, line: &str) -> std::io::Result<()> {
    w.write_all(line.as_bytes())?;
    w.write_all(b"\n")?;
    w.flush()
}

impl McpHost {
    fn procs(&self) -> AppResult<MutexGuard<'_, HashMap<String, Proc>>> {
        self.procs.lock().map_err(|_| AppError::internal("lock poisoned"))
    }

    /// on_line：服务器输出的每一行；on_exit：stdout 关闭（进程退出）时调用一次
    pub fn start(&self, cfg: &McpServerConfig, parent_env: &HashMap<String, String>, on_line: LineFn, on_exit: LineFn) -> AppResult<()> {
        if !valid_server_id(&cfg.id) {
            return Err(AppError::new("invalid_mcp_id", "MCP 服务器 ID 无效"));
        }
        if cfg.command.trim().is_empty() {
            return Err(AppError::new("invalid_mcp_command", "缺少启动命令"));
        }
        let mut procs = self.procs()?;
        if let Some(p) = procs.get_mut(&cfg.id) {
            if matches!(p.child.try_wait(), Ok(None)) {
                return Err(AppError::new("mcp_already_running", "这个 MCP 服务器已在运行"));
            }
            procs.remove(&cfg.id);
        }
        let mut cmd = Command::new(&cfg.command);
        cmd.args(&cfg.args)
            .env_clear()
            .envs(child_env(parent_env, &cfg.env))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(dir) = &cfg.cwd {
            cmd.current_dir(dir);
        }
        let mut child = cmd
            .spawn()
            .map_err(|e| {
                let msg = if e.kind() == std::io::ErrorKind::NotFound {
                    "找不到启动命令：桌面应用不继承终端的 PATH，请在 mcp.json 的 command 里写绝对路径"
                } else {
                    "无法启动 MCP 服务器"
                };
                AppError::new("mcp_spawn_failed", msg).with_detail(e.to_string())
            })?;
        let stdout = child.stdout.take();
        let stderr_pipe = child.stderr.take();
        let stdin = child.stdin.take();
        let stderr = Arc::new(Mutex::new(String::new()));

        if let Some(out) = stdout {
            std::thread::spawn(move || {
                let mut r = BufReader::new(out);
                let mut buf = Vec::new();
                loop {
                    buf.clear();
                    match r.read_until(b'\n', &mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(_) if buf.len() > MAX_LINE => continue,
                        Ok(_) => {
                            let line = String::from_utf8_lossy(&buf).trim().to_string();
                            if !line.is_empty() {
                                on_line(line);
                            }
                        }
                    }
                }
                on_exit("MCP 服务器已退出".to_string());
            });
        }
        if let Some(mut err) = stderr_pipe {
            let tail = Arc::clone(&stderr);
            std::thread::spawn(move || {
                let mut chunk = [0u8; 4096];
                while let Ok(n) = err.read(&mut chunk) {
                    if n == 0 {
                        break;
                    }
                    if let Ok(mut t) = tail.lock() {
                        t.push_str(&String::from_utf8_lossy(&chunk[..n]));
                        if t.len() > 4000 {
                            let cut = (t.len() - 2000..t.len()).find(|i| t.is_char_boundary(*i)).unwrap_or(t.len());
                            t.drain(..cut);
                        }
                    }
                }
            });
        }
        procs.insert(cfg.id.clone(), Proc { child, stdin, stderr });
        Ok(())
    }

    pub fn send(&self, id: &str, line: &str) -> AppResult<()> {
        if line.contains('\n') || line.contains('\r') {
            return Err(AppError::new("invalid_message", "消息不能包含换行"));
        }
        let not_running = || AppError::new("mcp_not_running", "这个 MCP 服务器没有运行");
        let mut procs = self.procs()?;
        let stdin = procs.get_mut(id).and_then(|p| p.stdin.as_mut()).ok_or_else(not_running)?;
        write_line(stdin, line).map_err(|e| AppError::new("mcp_write_failed", "无法写入 MCP 服务器").with_detail(e.to_string()))
    }

    /// 进程是否还活着
    pub fn running(&self, id: &str) -> bool {
        self.procs.lock().ok().and_then(|mut m| m.get_mut(id).map(|p| matches!(p.child.try_wait(), Ok(None)))).unwrap_or(false)
    }

    pub fn stop(&self, id: &str) -> AppResult<bool> {
        let removed = self.procs()?.remove(id);
        let Some(mut p) = removed else { return Ok(false) };
        drop(p.stdin.take());
        let _ = p.child.kill();
        let _ = p.child.wait();
        Ok(true)
    }

    pub fn stop_all(&self) {
        let ids: Vec<String> = self.procs.lock().map(|m| m.keys().cloned().collect()).unwrap_or_default();
        for id in ids {
            let _ = self.stop(&id);
        }
    }

    /// 服务器 stderr 的最后约 2000 字节（已脱敏），用于诊断
    pub fn stderr_tail(&self, id: &str) -> Option<String> {
        let procs = self.procs.lock().ok()?;
        let s = procs.get(id)?.stderr.lock().ok()?.clone();
        Some(crate::redact::redact(&s))
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    fn chan() -> (LineFn, LineFn, mpsc::Receiver<String>, mpsc::Receiver<String>) {
        let (lt, lr) = mpsc::channel();
        let (et, er) = mpsc::channel();
        (Arc::new(move |l: String| drop(lt.send(l))), Arc::new(move |r: String| drop(et.send(r))), lr, er)
    }
    fn cfg(id: &str, command: &str) -> McpServerConfig {
        McpServerConfig { id: id.into(), command: command.into(), args: vec![], env: BTreeMap::new(), cwd: None }
    }
    fn parent() -> HashMap<String, String> {
        std::env::vars_os().filter_map(|(k, v)| Some((k.into_string().ok()?, v.into_string().ok()?))).collect()
    }

    #[test]
    fn forwards_lines_both_ways() {
        let host = McpHost::default();
        let (on_line, on_exit, lines, exits) = chan();
        host.start(&cfg("echo", "/bin/cat"), &parent(), on_line, on_exit).unwrap();
        host.send("echo", r#"{"jsonrpc":"2.0","id":1}"#).unwrap();
        assert_eq!(lines.recv_timeout(Duration::from_secs(3)).unwrap(), r#"{"jsonrpc":"2.0","id":1}"#);
        assert_eq!(host.send("echo", "a\nb").unwrap_err().code, "invalid_message");
        assert!(host.stop("echo").unwrap());
        assert!(exits.recv_timeout(Duration::from_secs(3)).is_ok());
        assert_eq!(host.send("echo", "x").unwrap_err().code, "mcp_not_running");
    }

    #[test]
    fn child_does_not_inherit_secrets() {
        let host = McpHost::default();
        let (on_line, on_exit, lines, _exits) = chan();
        let mut p = parent();
        p.insert("OPENAI_API_KEY".into(), "sk-parent-secret-0123456789".into());
        let mut c = cfg("envprobe", "/usr/bin/env");
        c.env.insert("FAKE_FLAG".into(), "on".into());
        host.start(&c, &p, on_line, on_exit).unwrap();
        let mut out = Vec::new();
        while let Ok(l) = lines.recv_timeout(Duration::from_secs(3)) {
            out.push(l);
        }
        assert!(out.iter().any(|l| l == "FAKE_FLAG=on"), "{out:?}");
        assert!(!out.iter().any(|l| l.contains("OPENAI_API_KEY")));
        host.stop("envprobe").unwrap();
    }

    #[test]
    fn rejects_bad_config() {
        let host = McpHost::default();
        let (a, b, _l, _e) = chan();
        assert_eq!(host.start(&cfg("Bad Id", "/bin/cat"), &parent(), a.clone(), b.clone()).unwrap_err().code, "invalid_mcp_id");
        assert_eq!(host.start(&cfg("x", "/nonexistent/eg-mcp"), &parent(), a.clone(), b.clone()).unwrap_err().code, "mcp_spawn_failed");
        host.start(&cfg("dup", "/bin/cat"), &parent(), a.clone(), b.clone()).unwrap();
        assert_eq!(host.start(&cfg("dup", "/bin/cat"), &parent(), a, b).unwrap_err().code, "mcp_already_running");
        host.stop_all();
        let parent_env = HashMap::from([("PATH".to_string(), "/bin".to_string()), ("TYPESAFE_API_KEY".to_string(), "y".to_string())]);
        let extra = BTreeMap::from([("A".to_string(), "1".to_string())]);
        assert_eq!(
            child_env(&parent_env, &extra),
            BTreeMap::from([("A".to_string(), "1".to_string()), ("PATH".to_string(), "/bin".to_string())])
        );
    }
}

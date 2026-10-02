//! 内置 MCP 文件服务器（JSON-RPC over stdio）：列目录、读写文本、建目录、移动、删除、读 PDF。
//! 只能访问启动参数 --allow 给出的目录。桌面端用 `--mcp-files` 以子进程方式自启动（不依赖 Node），
//! 独立程序 eg-mcp-files 给 CLI、测试和脚本用；两者是同一份逻辑。
mod rpc;
mod sandbox;
mod schema;
mod time;
mod tools_fs;
mod tools_pdf;
mod tools_write;
#[cfg(test)]
mod tests;

pub use rpc::handle_line;
pub use sandbox::Sandbox;

use crate::mcp_registry::{AllowTools, McpEntry};
use crate::mcp_template::{Segment, Template};
use std::collections::BTreeMap;
use std::io::{BufRead, Read, Write};
use std::path::PathBuf;

pub const SERVER_ID: &str = "files";
pub const TOOL_NAMES: [&str; 9] =
    ["list_directory", "read_file", "write_file", "create_directory", "move_file", "delete_file", "get_file_info", "read_pdf", "get_pdf_metadata"];
/// 默认只开放下载文件夹
pub const DEFAULT_ROOTS: [&str; 1] = ["~/Downloads"];
/// 单行请求上限
const MAX_LINE: usize = 8 << 20;

/// 字面模板：路径里即使有 `${` 也不当作引用
fn lit(s: &str) -> Template { Template { raw: s.into(), parts: vec![Segment::Lit(s.into())] } }

/// 内置服务器的登记项：exe 是启动程序，prefix 是放在 --allow 前面的参数（桌面端为 ["--mcp-files"]）。
/// 采信本服务器的标注：只读工具不弹确认，写入、移动、删除每次确认
pub fn builtin_entry(exe: &str, prefix: &[&str]) -> McpEntry {
    let mut args: Vec<Template> = prefix.iter().map(|a| lit(a)).collect();
    for r in DEFAULT_ROOTS { args.push(lit("--allow")); args.push(lit(r)); }
    McpEntry {
        id: SERVER_ID.into(),
        command: exe.into(),
        args,
        env: BTreeMap::new(),
        cwd: None,
        allow_tools: AllowTools::Only(TOOL_NAMES.iter().map(|s| s.to_string()).collect()),
        trust_annotations: true,
    }
}

fn home_dir() -> Option<PathBuf> {
    ["HOME", "USERPROFILE"].iter().find_map(|k| std::env::var_os(k).filter(|v| !v.is_empty())).map(PathBuf::from)
}

/// 命令行入口：参数为若干个 `--allow <目录>`；返回进程退出码
pub fn run_cli(args: Vec<String>) -> i32 {
    let mut roots = Vec::new();
    let mut it = args.into_iter();
    while let Some(a) = it.next() {
        match (a.as_str(), it.next()) {
            ("--allow", Some(dir)) => roots.push(dir),
            _ => { eprintln!("用法：eg-mcp-files --allow <目录> [--allow <目录> …]"); return 2; }
        }
    }
    if roots.is_empty() { eprintln!("用法：eg-mcp-files --allow <目录> [--allow <目录> …]"); return 2; }
    let (sb, skipped) = Sandbox::new(&roots, home_dir());
    for s in skipped { eprintln!("eg-mcp-files：目录不存在，已忽略：{s}"); }
    if sb.is_empty() { eprintln!("eg-mcp-files：没有可访问的目录，所有文件操作都会被拒绝"); }
    let stdin = std::io::stdin();
    match serve(&sb, stdin.lock(), std::io::stdout().lock(), MAX_LINE) {
        Ok(()) => 0,
        Err(_) => 1,
    }
}

/// 逐行处理直到输入结束；超长的行丢弃并回解析错误
pub(crate) fn serve(sb: &Sandbox, mut input: impl BufRead, mut out: impl Write, max_line: usize) -> std::io::Result<()> {
    let mut buf = Vec::new();
    loop {
        buf.clear();
        let n = (&mut input).take(max_line as u64 + 1).read_until(b'\n', &mut buf)?;
        if n == 0 { return Ok(()); }
        let reply = if buf.len() > max_line && buf.last() != Some(&b'\n') {
            skip_line(&mut input)?;
            Some(rpc::rpc_err(&serde_json::Value::Null, -32700, "请求过长"))
        } else {
            handle_line(sb, &String::from_utf8_lossy(&buf))
        };
        if let Some(r) = reply {
            out.write_all(r.as_bytes())?;
            out.write_all(b"\n")?;
            out.flush()?;
        }
    }
}

/// 丢弃到下一个换行（含）为止
fn skip_line(input: &mut impl BufRead) -> std::io::Result<()> {
    loop {
        let (done, used) = {
            let b = input.fill_buf()?;
            if b.is_empty() { return Ok(()); }
            match b.iter().position(|&c| c == b'\n') { Some(i) => (true, i + 1), None => (false, b.len()) }
        };
        input.consume(used);
        if done { return Ok(()); }
    }
}

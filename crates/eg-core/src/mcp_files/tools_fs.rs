//! 文件系统工具：列目录、读写文本、建目录、移动、删除、查看信息。返回的路径都按 Sandbox::show 展示
use super::sandbox::Sandbox;
use super::time::{age_days, rfc3339, within_days};
use crate::{AppError, AppResult};
use serde_json::{json, Map, Value};
use std::fs;
use std::io::Read;
use std::path::Path;
use std::time::SystemTime;

pub(crate) type Args = Map<String, Value>;

/// 列目录最多扫描的条目数
const MAX_SCAN: usize = 10_000;
/// 一页最多返回的条目数和 JSON 字符数（前端还会把工具输出截断到 8000 字）
const PAGE_ITEMS: usize = 200;
const PAGE_CHARS: usize = 6_000;
const READ_BYTES: u64 = 256 * 1024;
const READ_CHARS: usize = 6_000;

pub(crate) fn bad_arg(msg: impl Into<String>) -> AppError { AppError::new("invalid_argument", msg) }
pub(crate) fn str_arg<'a>(a: &'a Args, k: &str) -> AppResult<&'a str> {
    a.get(k).and_then(Value::as_str).ok_or_else(|| bad_arg(format!("缺少参数 {k}")))
}
/// 非负整数参数；模型有时传 3.0 或 "3"，一并接受
pub(crate) fn opt_u64(a: &Args, k: &str) -> AppResult<Option<u64>> {
    let Some(v) = a.get(k).filter(|v| !v.is_null()) else { return Ok(None) };
    v.as_u64()
        .or_else(|| v.as_f64().filter(|f| f.fract() == 0.0 && *f >= 0.0 && *f < 1e15).map(|f| f as u64))
        .or_else(|| v.as_str().and_then(|s| s.trim().parse().ok()))
        .map(Some)
        .ok_or_else(|| bad_arg(format!("参数 {k} 应为非负整数")))
}
pub(crate) fn opt_bool(a: &Args, k: &str) -> bool { a.get(k).and_then(|v| v.as_bool().or_else(|| v.as_str().map(|s| s == "true"))).unwrap_or(false) }

/// io 错误转成中文说明；std 的错误文本不含路径
pub(crate) fn io_err(e: std::io::Error) -> AppError {
    use std::io::ErrorKind::*;
    let (code, msg) = match e.kind() {
        NotFound => ("not_found", "路径不存在"),
        PermissionDenied => ("permission_denied", "没有权限访问。macOS 上请在「系统设置 › 隐私与安全性 › 文件和文件夹」里允许 EastGenesis 访问该文件夹"),
        AlreadyExists => ("already_exists", "目标已存在"),
        _ => ("io_error", "文件操作失败"),
    };
    AppError::new(code, msg).with_detail(e.to_string())
}
pub(crate) fn kind(m: &fs::Metadata) -> &'static str {
    let t = m.file_type();
    if t.is_symlink() { "symlink" } else if t.is_dir() { "directory" } else if t.is_file() { "file" } else { "other" }
}
pub(crate) fn ext_of(p: &Path) -> Option<String> { p.extension().map(|e| e.to_string_lossy().to_lowercase()) }
fn mtime(m: &fs::Metadata) -> SystemTime { m.modified().unwrap_or(SystemTime::UNIX_EPOCH) }

pub(crate) fn list_directory(sb: &Sandbox, a: &Args) -> AppResult<Value> {
    let dir = sb.existing(str_arg(a, "path")?)?;
    if !dir.is_dir() { return Err(bad_arg("不是目录")); }
    let ext = a.get("extension").and_then(Value::as_str).map(|e| e.trim().trim_start_matches('.').to_lowercase()).filter(|e| !e.is_empty());
    let days = opt_u64(a, "modified_within_days")?;
    let hidden = opt_bool(a, "include_hidden");
    let offset = usize::try_from(opt_u64(a, "offset")?.unwrap_or(0)).unwrap_or(usize::MAX);
    let now = SystemTime::now();
    let (mut items, mut scanned) = (Vec::new(), 0);
    for e in fs::read_dir(&dir).map_err(io_err)? {
        if scanned >= MAX_SCAN { break; }
        scanned += 1;
        let Ok(e) = e else { continue };
        let name = e.file_name().to_string_lossy().into_owned();
        if !hidden && name.starts_with('.') { continue; }
        // 不跟随符号链接：链接按 symlink 列出，扩展名过滤时排除
        let Ok(m) = e.path().symlink_metadata() else { continue };
        let k = kind(&m);
        if ext.as_ref().is_some_and(|x| k != "file" || ext_of(Path::new(&name)).as_ref() != Some(x)) { continue; }
        if days.is_some_and(|d| !within_days(mtime(&m), now, d)) { continue; }
        items.push((mtime(&m), name, k, if k == "file" { m.len() } else { 0 }));
    }
    items.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    let (total, mut used, mut entries) = (items.len(), 0, Vec::new());
    for (mt, name, k, size) in items.iter().skip(offset) {
        let v = json!({ "name": name, "path": sb.show(&dir.join(name)), "type": k, "size": size, "modified": rfc3339(*mt), "age_days": age_days(*mt, now) });
        let n = v.to_string().chars().count();
        if !entries.is_empty() && (entries.len() >= PAGE_ITEMS || used + n > PAGE_CHARS) { break; }
        used += n;
        entries.push(v);
    }
    let next = offset.saturating_add(entries.len());
    let mut out = json!({ "path": sb.show(&dir), "total": total, "returned": entries.len(), "entries": entries, "truncated": next < total });
    if next < total { out["next_offset"] = json!(next); }
    if scanned >= MAX_SCAN { out["scan_limited"] = json!(true); }
    Ok(out)
}

pub(crate) fn read_file(sb: &Sandbox, a: &Args) -> AppResult<Value> {
    let p = sb.existing(str_arg(a, "path")?)?;
    if !p.is_file() { return Err(bad_arg("不是文件")); }
    let size = fs::metadata(&p).map_err(io_err)?.len();
    let mut buf = Vec::new();
    fs::File::open(&p).map_err(io_err)?.take(READ_BYTES).read_to_end(&mut buf).map_err(io_err)?;
    let text = match std::str::from_utf8(&buf) {
        Ok(s) => s,
        // 读取上限截在多字节字符中间：保留完整的部分
        Err(e) if e.error_len().is_none() => std::str::from_utf8(&buf[..e.valid_up_to()]).unwrap_or(""),
        Err(_) => return Err(AppError::new("not_text", "不是 UTF-8 文本文件；PDF 请用 read_pdf")),
    };
    let content: String = text.chars().take(READ_CHARS).collect();
    let truncated = size > buf.len() as u64 || content.len() < text.len();
    Ok(json!({ "path": sb.show(&p), "size": size, "content": content, "truncated": truncated }))
}

pub(crate) fn get_file_info(sb: &Sandbox, a: &Args) -> AppResult<Value> {
    let raw = str_arg(a, "path")?;
    // 条目本身不跟随符号链接；允许的根目录本身是链接时按真实路径
    let p = sb.entry(raw).or_else(|e| sb.existing(raw).map_err(|_| e))?;
    let m = p.symlink_metadata().map_err(io_err)?;
    let k = kind(&m);
    Ok(json!({
        "path": sb.show(&p), "type": k, "size": if k == "file" { m.len() } else { 0 },
        "modified": rfc3339(mtime(&m)), "age_days": age_days(mtime(&m), SystemTime::now()), "extension": ext_of(&p),
    }))
}

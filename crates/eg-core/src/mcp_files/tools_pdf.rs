//! PDF 工具：读取标题、作者、页数和前几页文本；只读元数据
use super::sandbox::Sandbox;
use super::tools_fs::{bad_arg, ext_of, io_err, opt_u64, str_arg, Args};
use crate::pdf;
use crate::AppResult;
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;

const DEFAULT_PAGES: u64 = 3;
const MAX_PAGES: u64 = 20;
const DEFAULT_CHARS: u64 = 2_000;
const MAX_CHARS: u64 = 6_000;

fn load(sb: &Sandbox, a: &Args) -> AppResult<(PathBuf, Vec<u8>)> {
    let p = sb.existing(str_arg(a, "path")?)?;
    if !p.is_file() { return Err(bad_arg("不是文件")); }
    if ext_of(&p).as_deref() != Some("pdf") { return Err(bad_arg("不是 .pdf 文件")); }
    if fs::metadata(&p).map_err(io_err)?.len() > pdf::MAX_FILE as u64 { return Err(bad_arg("PDF 文件超过 100 MB，无法读取")); }
    let bytes = fs::read(&p).map_err(io_err)?;
    Ok((p, bytes))
}

pub(crate) fn read_pdf(sb: &Sandbox, a: &Args) -> AppResult<Value> {
    let pages = opt_u64(a, "max_pages")?.unwrap_or(DEFAULT_PAGES).clamp(1, MAX_PAGES) as usize;
    let chars = opt_u64(a, "max_chars")?.unwrap_or(DEFAULT_CHARS).clamp(1, MAX_CHARS) as usize;
    let (p, bytes) = load(sb, a)?;
    let info = pdf::parse(&bytes, pages, chars)?;
    let mut out = json!({
        "path": sb.show(&p), "title": info.title, "author": info.author, "pages": info.pages,
        "pages_read": info.pages_read, "text": info.text, "truncated": info.truncated,
    });
    if out["text"].as_str().is_some_and(str::is_empty) { out["note"] = json!("没有可提取的文本（可能是扫描件或图片）"); }
    Ok(out)
}

pub(crate) fn get_pdf_metadata(sb: &Sandbox, a: &Args) -> AppResult<Value> {
    let (p, bytes) = load(sb, a)?;
    let info = pdf::metadata(&bytes)?;
    Ok(json!({ "path": sb.show(&p), "title": info.title, "author": info.author, "subject": info.subject, "pages": info.pages }))
}

//! 有副作用的文件工具：写文件、建目录、移动、删除。是否执行由前端的确认队列决定，这里只保证不越界、不覆盖
use super::sandbox::{denied, Sandbox};
use super::tools_fs::{bad_arg, io_err, opt_bool, str_arg, Args};
use crate::{AppError, AppResult};
use serde_json::{json, Value};
use std::fs;
use std::io::Write;

const WRITE_BYTES: usize = 1 << 20;

fn exists(p: &std::path::Path) -> bool { p.symlink_metadata().is_ok() }

pub(crate) fn write_file(sb: &Sandbox, a: &Args) -> AppResult<Value> {
    let content = str_arg(a, "content")?;
    if content.len() > WRITE_BYTES { return Err(bad_arg("内容超过 1 MB")); }
    let overwrite = opt_bool(a, "overwrite");
    let p = sb.target(str_arg(a, "path")?)?;
    if p.is_dir() { return Err(bad_arg("目标是目录")); }
    let existed = exists(&p);
    if existed && !overwrite { return Err(AppError::new("already_exists", "文件已存在；要覆盖请传 overwrite: true")); }
    if !p.parent().is_some_and(|d| d.is_dir()) { return Err(AppError::new("not_found", "上级目录不存在，请先创建目录")); }
    let mut f = if overwrite {
        fs::OpenOptions::new().write(true).create(true).truncate(true).open(&p)
    } else {
        fs::OpenOptions::new().write(true).create_new(true).open(&p)
    }
    .map_err(io_err)?;
    f.write_all(content.as_bytes()).map_err(io_err)?;
    Ok(json!({ "path": sb.show(&p), "bytes": content.len(), "created": !existed }))
}

pub(crate) fn create_directory(sb: &Sandbox, a: &Args) -> AppResult<Value> {
    let p = sb.target(str_arg(a, "path")?)?;
    if p.is_dir() { return Ok(json!({ "path": sb.show(&p), "created": false })); }
    if exists(&p) { return Err(AppError::new("already_exists", "同名文件已存在")); }
    fs::create_dir_all(&p).map_err(io_err)?;
    Ok(json!({ "path": sb.show(&p), "created": true }))
}

pub(crate) fn move_file(sb: &Sandbox, a: &Args) -> AppResult<Value> {
    let src = sb.entry(str_arg(a, "src")?)?;
    if sb.is_root(&src) { return Err(AppError::new("path_not_allowed", "不能移动允许访问的根目录")); }
    let mut dst = sb.target(str_arg(a, "dst")?)?;
    // dst 是已存在的真实目录：移入其中
    if dst.symlink_metadata().is_ok_and(|m| m.is_dir()) {
        let name = src.file_name().ok_or_else(denied)?;
        dst.push(name);
    }
    if dst == src { return Err(AppError::new("same_path", "源路径和目标路径相同")); }
    if exists(&dst) { return Err(AppError::new("already_exists", "目标已存在，不会覆盖；请换一个名字")); }
    if dst.starts_with(&src) { return Err(bad_arg("不能把目录移到它自己里面")); }
    if !dst.parent().is_some_and(|d| d.is_dir()) { return Err(AppError::new("not_found", "目标的上级目录不存在，请先创建目录")); }
    fs::rename(&src, &dst).map_err(io_err)?;
    Ok(json!({ "src": sb.show(&src), "dst": sb.show(&dst) }))
}

pub(crate) fn delete_file(sb: &Sandbox, a: &Args) -> AppResult<Value> {
    let p = sb.entry(str_arg(a, "path")?)?;
    let m = p.symlink_metadata().map_err(io_err)?;
    if m.is_dir() { return Err(bad_arg("只能删除文件，不能删除目录")); }
    fs::remove_file(&p).map_err(io_err)?;
    Ok(json!({ "path": sb.show(&p), "deleted": true }))
}

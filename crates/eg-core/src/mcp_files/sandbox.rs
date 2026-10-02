//! 访问范围：只允许启动参数 --allow 给出的目录（按真实路径）及其子孙。
//! - 路径必须是绝对路径或以 ~ 开头，不接受 `..`；
//! - 已存在的部分按真实路径（跟随符号链接）检查，链接指到范围外一律拒绝；
//! - 移动、删除作用于条目本身，不跟随最后一级符号链接；
//! - 允许的根目录本身不能移动或删除（由调用方用 is_root 检查）。
use crate::{AppError, AppResult};
use std::ffi::OsString;
use std::path::{Component, Path, PathBuf};

pub struct Sandbox {
    /// 允许访问的目录（真实路径，去重）
    roots: Vec<PathBuf>,
    /// 家目录：展开 ~，展示路径时换回 ~
    home: Option<PathBuf>,
    home_real: Option<PathBuf>,
}

pub(crate) fn denied() -> AppError { AppError::new("path_not_allowed", "不在允许访问的目录内") }
pub(crate) fn not_found() -> AppError { AppError::new("not_found", "路径不存在") }
fn invalid(msg: &str) -> AppError { AppError::new("invalid_path", msg) }

impl Sandbox {
    /// 不存在或不是目录的根跳过，第二个返回值是被跳过的原文
    pub fn new(raw_roots: &[String], home: Option<PathBuf>) -> (Sandbox, Vec<String>) {
        let home_real = home.as_ref().and_then(|h| h.canonicalize().ok());
        let mut sb = Sandbox { roots: Vec::new(), home, home_real };
        let mut skipped = Vec::new();
        for r in raw_roots {
            match sb.expand(r).ok().and_then(|p| p.canonicalize().ok()).filter(|p| p.is_dir()) {
                Some(p) => { if !sb.roots.contains(&p) { sb.roots.push(p); } }
                None => skipped.push(r.clone()),
            }
        }
        (sb, skipped)
    }
    pub fn is_empty(&self) -> bool { self.roots.is_empty() }

    /// 展开 ~；要求绝对路径；不接受 `..`
    pub fn expand(&self, raw: &str) -> AppResult<PathBuf> {
        let raw = raw.trim();
        if raw.is_empty() || raw.contains('\0') { return Err(invalid("路径为空或包含空字符")); }
        let p = if raw == "~" || raw.starts_with("~/") || raw.starts_with("~\\") {
            let home = self.home.as_ref().ok_or_else(|| invalid("无法确定家目录，请写绝对路径"))?;
            if raw.len() == 1 { home.clone() } else { home.join(&raw[2..]) }
        } else {
            PathBuf::from(raw)
        };
        if !p.is_absolute() { return Err(invalid("请写绝对路径或以 ~/ 开头的路径")); }
        if p.components().any(|c| c == Component::ParentDir) { return Err(invalid("路径里不能有 ..")); }
        Ok(p)
    }
    fn inside(&self, real: &Path) -> bool { self.roots.iter().any(|r| real.starts_with(r)) }
    pub fn is_root(&self, real: &Path) -> bool { self.roots.iter().any(|r| r == real) }

    /// 最近的已存在祖先换成真实路径，再接上其余部分；遇到悬空的符号链接返回 None
    fn resolve(&self, p: &Path) -> Option<PathBuf> {
        let mut rest: Vec<OsString> = Vec::new();
        let mut cur = p;
        loop {
            if let Ok(mut real) = cur.canonicalize() {
                for c in rest.iter().rev() { real.push(c); }
                return Some(real);
            }
            if cur.symlink_metadata().is_ok() { return None; }
            rest.push(cur.file_name()?.to_os_string());
            cur = cur.parent()?;
        }
    }
    /// 跟随符号链接后的真实路径，要求在范围内；不要求存在（写入、新建目录用）
    pub fn target(&self, raw: &str) -> AppResult<PathBuf> {
        let real = self.resolve(&self.expand(raw)?).ok_or_else(denied)?;
        if self.inside(&real) { Ok(real) } else { Err(denied()) }
    }
    /// 已存在的路径，跟随符号链接（读取用）
    pub fn existing(&self, raw: &str) -> AppResult<PathBuf> {
        let real = self.target(raw)?;
        if real.exists() { Ok(real) } else { Err(not_found()) }
    }
    /// 条目本身：父目录换成真实路径，最后一级不跟随符号链接（移动、删除、查看信息用）
    pub fn entry(&self, raw: &str) -> AppResult<PathBuf> {
        let p = self.expand(raw)?;
        let (Some(name), Some(parent)) = (p.file_name(), p.parent()) else { return Err(denied()) };
        let full = self.resolve(parent).ok_or_else(denied)?.join(name);
        if !self.inside(&full) { return Err(denied()); }
        if full.symlink_metadata().is_err() { return Err(not_found()); }
        Ok(full)
    }
    /// 展示给模型和用户的路径：家目录换成 ~
    pub fn show(&self, real: &Path) -> String {
        for h in [&self.home_real, &self.home].into_iter().flatten() {
            if let Ok(rest) = real.strip_prefix(h) {
                return if rest.as_os_str().is_empty() { "~".into() } else { format!("~/{}", rest.display()) };
            }
        }
        real.display().to_string()
    }
}

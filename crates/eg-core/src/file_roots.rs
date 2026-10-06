//! 内置文件服务器允许访问的目录（docs/UI_LAYOUT_V3.md 第 10 节第 11 条）。
//! 默认只有 ~/Downloads；用户选中的目录加进来之后写进配置文件，下次启动仍然生效。
//! 这里只管「哪些目录允许」这一件事：真正拦越界访问的是 mcp_files::sandbox，两边规则独立。

use std::path::{Component, Path, PathBuf};

use serde::Serialize;

use crate::error::{AppError, AppResult};

/// 默认允许的目录：去掉它用户就没法让智能体碰任何文件，所以不提供移除
pub const DEFAULT_ROOTS: [&str; 1] = ["~/Downloads"];
/// 最多允许的目录数（含默认项）
pub const MAX_ROOTS: usize = 24;
/// 单条路径长度上限
pub const MAX_ROOT_LEN: usize = 1024;

/// 允许列表里的一个条目：原文（保留 ~，子进程自己展开）+ 是否可移除
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct FileRoot {
    pub path: String,
    /// 默认目录：界面不提供移除按钮
    pub fixed: bool,
}

fn invalid(msg: &str) -> AppError {
    AppError::new("invalid_root", msg)
}

/// 规整并校验一条路径。不接受空、控制字符、`..`、相对路径，以及整个磁盘或整个家目录。
/// 允许 `~` 和 `~/…`；原文返回（保留 ~），因为子进程按同样的写法规整。
pub fn validate_root(raw: &str, home: Option<&Path>) -> AppResult<String> {
    let s = raw.trim();
    if s.is_empty() {
        return Err(invalid("路径不能为空"));
    }
    if s.len() > MAX_ROOT_LEN {
        return Err(invalid("路径太长"));
    }
    if s.chars().any(|c| c.is_control()) {
        return Err(invalid("路径里有不可见的控制字符"));
    }
    // 连续分隔符合并；去掉末尾分隔符（根目录本身除外）
    let mut collapsed = String::with_capacity(s.len());
    let mut prev_sep = false;
    for c in s.chars() {
        let sep = c == '/' || c == '\\';
        if sep && prev_sep {
            continue;
        }
        prev_sep = sep;
        collapsed.push(if sep { '/' } else { c });
    }
    let path = if collapsed.len() > 1 {
        collapsed.trim_end_matches('/').to_string()
    } else {
        collapsed
    };
    // 原生目录选择器通常返回绝对路径；如果它位于当前用户 home 下，
    // 统一保存成 ~/...，这样不会把同一目录同时记录成绝对路径和默认的
    // ~/Downloads，也不会把机器的 home 前缀写进 file-roots.json。
    let path = if let Some(home) = home {
        if let Ok(rest) = Path::new(&path).strip_prefix(home) {
            if rest.as_os_str().is_empty() {
                "~".to_string()
            } else {
                format!("~/{}", rest.to_string_lossy().replace('\\', "/"))
            }
        } else {
            path
        }
    } else {
        path
    };
    if path == "/" || path == "//" {
        return Err(invalid("不能把整个磁盘加入允许列表"));
    }
    let is_home = path == "~" || home.is_some_and(|h| Path::new(&path) == h);
    if is_home {
        return Err(invalid("不能把整个家目录加入允许列表；请选择具体的子目录"));
    }
    if !(path == "~" || path.starts_with("~/") || Path::new(&path).is_absolute()) {
        return Err(invalid("请写绝对路径或以 ~/ 开头的路径"));
    }
    if Path::new(&path).components().any(|c| c == Component::ParentDir) {
        return Err(invalid("路径里不能有 .."));
    }
    Ok(path)
}

/// 允许列表。path 为 None 时只在内存里（测试用）。
#[derive(Debug, Default)]
pub struct FileRootsStore {
    path: Option<PathBuf>,
    extra: Vec<String>,
    home: Option<PathBuf>,
}

fn write_err(e: std::io::Error) -> AppError {
    AppError::new("config_write_failed", "无法保存允许访问的目录").with_detail(e.to_string())
}

impl FileRootsStore {
    /// 读回用户加过的目录；文件损坏或某一条不合法时丢掉那一条，不让整个列表失败
    pub fn load(path: impl Into<PathBuf>, home: Option<PathBuf>) -> AppResult<Self> {
        let path = path.into();
        let extra = match std::fs::read_to_string(&path) {
            Ok(s) => serde_json::from_str::<Vec<String>>(&s)
                .map_err(|e| AppError::new("config_corrupt", "允许访问目录的配置文件损坏").with_detail(e.to_string()))?
                .iter()
                .filter_map(|r| validate_root(r, home.as_deref()).ok())
                .collect(),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(e) => return Err(AppError::new("config_read_failed", "无法读取允许访问的目录").with_detail(e.to_string())),
        };
        Ok(Self { path: Some(path), extra, home })
    }

    pub fn in_memory() -> Self {
        Self::default()
    }

    /// 默认目录在前，用户加的在后，去掉重复
    pub fn list(&self) -> Vec<FileRoot> {
        let mut out: Vec<FileRoot> = DEFAULT_ROOTS
            .iter()
            .map(|p| FileRoot { path: (*p).to_string(), fixed: true })
            .collect();
        for e in &self.extra {
            if !out.iter().any(|r| r.path == *e) {
                out.push(FileRoot { path: e.clone(), fixed: false });
            }
        }
        out
    }

    /// 交给子进程的允许目录原文（默认项 + 用户加的）
    pub fn raw_roots(&self) -> Vec<String> {
        self.list().into_iter().map(|r| r.path).collect()
    }

    /// 加入一个目录；已经在列表里就原样返回（幂等）。返回加入后的列表
    pub fn add(&mut self, raw: &str) -> AppResult<Vec<FileRoot>> {
        let p = validate_root(raw, self.home.as_deref())?;
        if !self.extra.contains(&p) && !DEFAULT_ROOTS.contains(&p.as_str()) {
            if self.extra.len() + DEFAULT_ROOTS.len() >= MAX_ROOTS {
                return Err(invalid(&format!("最多 {MAX_ROOTS} 个目录，请先移除一些")));
            }
            self.extra.push(p);
            self.persist()?;
        }
        Ok(self.list())
    }

    /// 移除一个用户加的目录；默认目录不能移除；不在列表里返回 false
    pub fn remove(&mut self, raw: &str) -> AppResult<bool> {
        let p = validate_root(raw, self.home.as_deref())?;
        if DEFAULT_ROOTS.contains(&p.as_str()) {
            return Err(invalid("~/Downloads 是默认目录，不能移除"));
        }
        let before = self.extra.len();
        self.extra.retain(|e| e != &p);
        let had = self.extra.len() != before;
        if had {
            self.persist()?;
        }
        Ok(had)
    }

    fn persist(&self) -> AppResult<()> {
        let Some(path) = &self.path else { return Ok(()) };
        let json = serde_json::to_string_pretty(&self.extra).map_err(|e| AppError::internal(e.to_string()))?;
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(write_err)?;
        }
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, json).map_err(write_err)?;
        std::fs::rename(&tmp, path).map_err(write_err)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOME: &str = "/home/tester";

    fn store() -> FileRootsStore {
        FileRootsStore { path: None, extra: Vec::new(), home: Some(PathBuf::from(HOME)) }
    }

    #[test]
    fn validate_root_normalizes_and_rejects_dangerous_paths() {
        let home = Some(Path::new(HOME));
        assert_eq!(validate_root("  ~/Documents/合同  ", home).unwrap(), "~/Documents/合同");
        assert_eq!(validate_root("~/a//b/", home).unwrap(), "~/a/b");
        assert_eq!(validate_root("/home/tester/Documents", home).unwrap(), "~/Documents");
        assert_eq!(validate_root("/Users/x/Docs", home).unwrap(), "/Users/x/Docs");
        // 空、控制字符、太长
        assert!(validate_root("   ", home).is_err());
        assert!(validate_root("/tmp/a\u{7}", home).is_err());
        assert!(validate_root(&format!("/tmp/{}", "a".repeat(MAX_ROOT_LEN + 1)), home).is_err());
        // 整个磁盘、整个家目录
        assert!(validate_root("/", home).is_err());
        assert!(validate_root(HOME, home).is_err());
        assert!(validate_root("~", home).is_err());
        // 相对路径、..
        assert!(validate_root("Documents", home).is_err());
        assert!(validate_root("~/Documents/../Secrets", home).is_err());
        assert!(validate_root("/tmp/../etc", home).is_err());
    }

    #[test]
    fn list_always_starts_with_the_default_and_add_is_idempotent() {
        let mut s = store();
        assert_eq!(s.raw_roots(), vec!["~/Downloads".to_string()]);
        assert!(s.list()[0].fixed && !s.list().iter().any(|r| !r.fixed));
        s.add("~/Documents/合同").unwrap();
        s.add("  ~/Documents/合同 ").unwrap();
        assert_eq!(s.raw_roots(), vec!["~/Downloads".to_string(), "~/Documents/合同".to_string()]);
        // 再把默认目录加一遍不会重复
        s.add("~/Downloads").unwrap();
        s.add("/home/tester/Downloads").unwrap();
        assert_eq!(s.raw_roots().len(), 2);
        assert!(!s.list()[1].fixed);
    }

    #[test]
    fn remove_drops_user_roots_but_not_the_default() {
        let mut s = store();
        s.add("/data/项目").unwrap();
        assert!(s.remove("/data/项目").unwrap());
        assert_eq!(s.raw_roots(), vec!["~/Downloads".to_string()]);
        assert!(!s.remove("/data/项目").unwrap());
        assert_eq!(s.remove("~/Downloads").unwrap_err().code, "invalid_root");
        assert!(s.add("/").is_err());
    }

    #[test]
    fn roots_are_capped() {
        let mut s = store();
        // 合计不超过 MAX_ROOTS：默认目录占一个名额
        for i in 0..MAX_ROOTS - DEFAULT_ROOTS.len() {
            s.add(&format!("/data/dir-{i}")).unwrap();
        }
        assert_eq!(s.raw_roots().len(), MAX_ROOTS);
        assert!(s.add("/data/one-more").is_err());
    }

    #[test]
    fn load_skips_corrupt_entries_and_ignores_missing_file() {
        let dir = std::env::temp_dir().join(format!("eg-roots-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("file-roots.json");
        let _ = std::fs::remove_file(&path);
        // 文件不存在：只有默认目录
        assert_eq!(FileRootsStore::load(&path, Some(PathBuf::from(HOME))).unwrap().raw_roots(), vec!["~/Downloads"]);
        // 里面有不合法的一条：丢掉那一条，其余保留
        std::fs::write(&path, r#"["~/Documents", "/", "relative/x"]"#).unwrap();
        assert_eq!(
            FileRootsStore::load(&path, Some(PathBuf::from(HOME))).unwrap().raw_roots(),
            vec!["~/Downloads".to_string(), "~/Documents".to_string()]
        );
        // 内容不是 JSON 数组：报 config_corrupt（用户看得出文件坏了）
        std::fs::write(&path, "{oops").unwrap();
        assert_eq!(FileRootsStore::load(&path, Some(PathBuf::from(HOME))).unwrap_err().code, "config_corrupt");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn saving_round_trips_through_the_file() {
        let dir = std::env::temp_dir().join(format!("eg-roots-rw-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("file-roots.json");
        let _ = std::fs::remove_file(&path);
        let mut s = FileRootsStore::load(&path, Some(PathBuf::from(HOME))).unwrap();
        s.add("~/Documents/合同").unwrap();
        let back = FileRootsStore::load(&path, Some(PathBuf::from(HOME))).unwrap();
        assert_eq!(back.raw_roots(), vec!["~/Downloads".to_string(), "~/Documents/合同".to_string()]);
        // 落盘的是用户加的那部分，默认目录不写进文件
        assert_eq!(std::fs::read_to_string(&path).unwrap().trim(), "[\n  \"~/Documents/合同\"\n]");
        let _ = std::fs::remove_file(&path);
    }
}

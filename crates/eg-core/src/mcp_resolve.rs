//! 启动前把 mcp.json 里的引用换成实际值：值只进子进程的参数和环境变量，不回到前端，也不写日志。

use std::collections::HashMap;
use std::path::Path;

use crate::error::{AppError, AppResult};
use crate::mcp_host::McpServerConfig;
use crate::mcp_registry::McpEntry;
use crate::mcp_secrets::McpSecrets;
use crate::mcp_template::{RefSource, Segment, Template};
use crate::secrets::SecretStore;

fn render<S: SecretStore>(t: &Template, server: &str, env: &HashMap<String, String>, secrets: &McpSecrets<S>) -> AppResult<String> {
    let mut out = String::new();
    for p in &t.parts {
        match p {
            Segment::Lit(s) => out.push_str(s),
            Segment::Ref(RefSource::Env, n) => match env.get(n).filter(|v| !v.is_empty()) {
                Some(v) => out.push_str(v),
                None => return Err(AppError::new("mcp_env_missing", format!("环境变量 {n} 没有设置（mcp.json 引用了 ${{env:{n}}}）"))),
            },
            Segment::Ref(RefSource::Keychain, n) => match secrets.get(server, n)? {
                Some(v) => out.push_str(&v),
                None => return Err(AppError::new("mcp_secret_missing", format!("钥匙串里还没有 {n}，请先在设置页保存"))),
            },
        }
    }
    Ok(out)
}

pub(crate) fn resolve<S: SecretStore>(e: &McpEntry, env: &HashMap<String, String>, secrets: &McpSecrets<S>) -> AppResult<McpServerConfig> {
    Ok(McpServerConfig {
        id: e.id.clone(),
        command: e.command.clone(),
        args: e.args.iter().map(|t| render(t, &e.id, env, secrets)).collect::<AppResult<_>>()?,
        env: e.env.iter().map(|(k, t)| Ok((k.clone(), render(t, &e.id, env, secrets)?))).collect::<AppResult<_>>()?,
        cwd: e.cwd.clone(),
    })
}

/// 界面展示的配置文件位置：家目录换成 ~，不暴露用户名
pub fn path_hint(path: &Path, home: Option<&Path>) -> String {
    match home.and_then(|h| path.strip_prefix(h).ok()) {
        Some(rest) => format!("~/{}", rest.display()),
        None => path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "mcp.json".into()),
    }
}

//! mcp.json 的列表字段：args、env、allowTools。明文密钥在这里拦下，提示改用引用。

use std::collections::BTreeMap;

use serde_json::Value;

use crate::error::AppResult;
use crate::mcp_registry::{AllowTools, MAX_ALLOW, MAX_ARGS, MAX_ENV};
use crate::mcp_template::{bad, secret_name, trivial, valid_ref_name, Template};

const USE_REF: &str = "请改用 ${keychain:NAME}（保存在系统钥匙串）或 ${env:NAME}";

pub(crate) fn text(v: &Value, what: &str) -> AppResult<Template> {
    let s = v.as_str().ok_or_else(|| bad(format!("{what} 应是字符串")))?;
    Template::parse(s).map_err(|e| bad(format!("{what}：{}", e.message)))
}

fn secret_flag(t: &Template) -> bool {
    t.is_literal() && t.raw.starts_with('-') && !t.raw.contains('=') && secret_name(&t.raw)
}

pub(crate) fn parse_args(v: Option<&Value>) -> AppResult<Vec<Template>> {
    let Some(v) = v else { return Ok(vec![]) };
    let items = v.as_array().ok_or_else(|| bad("args 应是字符串数组"))?;
    if items.len() > MAX_ARGS {
        return Err(bad(format!("args 最多 {MAX_ARGS} 项")));
    }
    let mut out: Vec<Template> = Vec::with_capacity(items.len());
    for (i, item) in items.iter().enumerate() {
        let what = format!("args 第 {} 项", i + 1);
        let t = text(item, &what)?;
        // `--api-key=xxx`，或 `--token` 后面紧跟的一项
        let inline = t.raw.split_once('=').is_some_and(|(k, val)| k.starts_with('-') && secret_name(k) && !val.contains("${") && !trivial(val));
        let after_flag = out.last().is_some_and(secret_flag) && t.is_literal() && !trivial(&t.raw);
        if t.leaks_secret() || inline || after_flag {
            return Err(bad(format!("{what} 看起来是明文密钥，{USE_REF}")));
        }
        out.push(t);
    }
    Ok(out)
}

pub(crate) fn parse_env(v: Option<&Value>) -> AppResult<BTreeMap<String, Template>> {
    let Some(v) = v else { return Ok(BTreeMap::new()) };
    let m = v.as_object().ok_or_else(|| bad("env 应是对象"))?;
    if m.len() > MAX_ENV {
        return Err(bad(format!("env 最多 {MAX_ENV} 项")));
    }
    let mut out = BTreeMap::new();
    for (k, v) in m {
        if !valid_ref_name(k) {
            return Err(bad("环境变量名只能包含字母、数字和下划线，不能以数字开头，最长 64 个字符"));
        }
        let t = text(v, &format!("env.{k}"))?;
        if t.leaks_secret() || (secret_name(k) && t.is_literal() && !trivial(&t.raw)) {
            return Err(bad(format!("env.{k} 看起来是明文密钥，{USE_REF}")));
        }
        out.insert(k.clone(), t);
    }
    Ok(out)
}

pub(crate) fn parse_allow(v: Option<&Value>) -> AppResult<AllowTools> {
    match v {
        None => Ok(AllowTools::Only(vec![])),
        Some(Value::String(s)) if s == "*" => Ok(AllowTools::All),
        Some(Value::Array(items)) => {
            if items.len() > MAX_ALLOW {
                return Err(bad(format!("allowTools 最多 {MAX_ALLOW} 项")));
            }
            let mut out: Vec<String> = Vec::new();
            for item in items {
                let name = item.as_str().filter(|s| !s.is_empty() && s.len() <= 128 && !s.chars().any(char::is_control));
                let name = name.ok_or_else(|| bad("allowTools 的每一项应是 1–128 个字符的工具名"))?;
                if name == "*" {
                    return Err(bad("要允许全部工具，请写 \"allowTools\": \"*\""));
                }
                if !out.iter().any(|x| x == name) {
                    out.push(name.to_string());
                }
            }
            Ok(AllowTools::Only(out))
        }
        Some(_) => Err(bad("allowTools 应是工具名数组，或 \"*\" 表示全部")),
    }
}

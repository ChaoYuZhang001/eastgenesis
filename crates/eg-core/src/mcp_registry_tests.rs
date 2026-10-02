use super::*;
use serde_json::json;

fn reg(v: Value) -> Registry {
    parse_registry(&v.to_string()).unwrap()
}

fn only_error(v: Value) -> String {
    let r = reg(json!({ "mcpServers": { "x": v } }));
    assert!(r.entries.is_empty(), "应被拒绝");
    r.errors[0].message.clone()
}

#[test]
fn parses_standard_entries_with_extensions() {
    let r = reg(json!({ "mcpServers": {
        "fs": { "command": "/opt/homebrew/bin/npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
                "allowTools": ["read_text_file", "read_text_file", "list_directory"], "cwd": "/tmp" },
        "gh": { "command": "gh-mcp", "env": { "GITHUB_TOKEN": "${keychain:GITHUB_TOKEN}", "LOG_LEVEL": "info" },
                "allow_tools": "*", "trust_annotations": true, "disabled": false }
    }}));
    assert!(r.errors.is_empty(), "{:?}", r.errors);
    let fs = &r.entries["fs"];
    assert_eq!(fs.allow_tools, AllowTools::Only(vec!["read_text_file".into(), "list_directory".into()]));
    assert!(!fs.trust_annotations && fs.cwd.as_deref() == Some("/tmp") && fs.args.len() == 3);
    let gh = &r.entries["gh"];
    assert!(gh.allow_tools.allows("anything") && gh.trust_annotations);
    assert_eq!(gh.refs(), vec![(RefSource::Keychain, "GITHUB_TOKEN".to_string())]);
    assert_eq!(serde_json::to_value(&gh.allow_tools).unwrap(), json!("*"));
    assert_eq!(serde_json::to_value(&fs.allow_tools).unwrap(), json!(["read_text_file", "list_directory"]));
}

#[test]
fn allow_tools_defaults_to_none() {
    let r = reg(json!({ "mcpServers": { "a": { "command": "a" } } }));
    assert_eq!(r.entries["a"].allow_tools, AllowTools::Only(vec![]));
    assert!(!r.entries["a"].allow_tools.allows("x"));
}

#[test]
fn empty_or_missing_server_map_is_fine() {
    assert!(reg(json!({})).entries.is_empty());
    assert!(reg(json!({ "mcpServers": null })).entries.is_empty());
    for bad_text in ["not json", "[]", r#"{"mcpServers": []}"#] {
        assert_eq!(parse_registry(bad_text).unwrap_err().code, "mcp_config_corrupt", "{bad_text}");
    }
}

#[test]
fn bad_entries_are_reported_one_by_one() {
    let r = reg(json!({ "mcpServers": {
        "ok": { "command": "srv" },
        "Bad-Id": { "command": "srv" },
        "remote": { "url": "https://example.com/mcp" },
        "sse": { "type": "sse", "command": "srv" },
        "nocmd": { "args": [] },
        "tpl": { "command": "${env:HOME}/bin/srv" },
        "rel": { "command": "srv", "cwd": "relative/dir" },
        "star": { "command": "srv", "allowTools": ["*"] },
        "argnum": { "command": "srv", "args": [1] }
    }}));
    assert_eq!(r.entries.keys().collect::<Vec<_>>(), vec!["ok"]);
    assert_eq!(r.errors.len(), 8);
    let msg = |id: &str| r.errors.iter().find(|e| e.id == id).map(|e| e.message.clone()).unwrap();
    assert!(msg("Bad-Id").contains("服务器 ID"));
    assert!(msg("remote").contains("stdio") && msg("sse").contains("stdio"));
    assert!(msg("tpl").contains("command"));
    assert!(msg("rel").contains("绝对路径"));
    assert!(msg("star").contains("\"*\""));
    assert!(msg("argnum").contains("args 第 1 项"));
}

#[test]
fn plaintext_secrets_are_rejected() {
    for v in [
        json!({ "command": "s", "env": { "GITHUB_TOKEN": "ghp_short1234" } }),
        json!({ "command": "s", "env": { "AUTH": "Bearer abc" } }),
        json!({ "command": "s", "args": ["--token", "abcdefgh1234"] }),
        json!({ "command": "s", "args": ["--api-key=abcdefgh1234"] }),
        json!({ "command": "s", "args": ["postgres://u:p4ss@db/x"] }),
        json!({ "command": "s", "env": { "X": "sk-proj-AAAABBBBCCCCDDDD1234" } }),
    ] {
        let m = only_error(v.clone());
        assert!(m.contains("${keychain:NAME}"), "{v}: {m}");
        assert!(!m.contains("abcdefgh1234") && !m.contains("p4ss"), "错误信息不能回显密钥：{m}");
    }
    let ok = reg(json!({ "mcpServers": { "x": {
        "command": "s", "args": ["--token", "${keychain:T}", "--max-tokens", "4096", "--port", "8080"],
        "env": { "TOKEN_LIMIT": "4096", "LOG_LEVEL": "debug", "PAT": "${env:MY_PAT}" }
    }}}));
    assert!(ok.errors.is_empty(), "{:?}", ok.errors);
    assert_eq!(ok.entries["x"].refs(), vec![(RefSource::Keychain, "T".to_string()), (RefSource::Env, "MY_PAT".to_string())]);
}

#[test]
fn server_count_is_capped() {
    let servers: Map<String, Value> = (0..MAX_SERVERS + 3).map(|i| (format!("s{i:02}"), json!({ "command": "srv" }))).collect();
    let r = reg(json!({ "mcpServers": servers }));
    assert_eq!(r.entries.len(), MAX_SERVERS);
    assert_eq!(r.errors.len(), 3);
}

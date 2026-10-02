use super::*;

fn code(r: AppResult<Template>) -> String {
    r.err().map(|e| e.code).unwrap_or_default()
}

#[test]
fn parses_literals_and_references() {
    let t = Template::parse("Bearer ${keychain:GH_TOKEN}").unwrap();
    assert_eq!(t.parts, vec![Segment::Lit("Bearer ".into()), Segment::Ref(RefSource::Keychain, "GH_TOKEN".into())]);
    assert!(!t.is_literal());
    let t = Template::parse("${env:HOME}/work").unwrap();
    assert_eq!(t.refs().collect::<Vec<_>>(), vec![(RefSource::Env, "HOME")]);
    assert!(Template::parse("/usr/local/bin").unwrap().is_literal());
    assert_eq!(Template::parse("").unwrap().parts, vec![]);
}

#[test]
fn rejects_bad_references() {
    for raw in ["${keychain:}", "${vault:X}", "${env:1A}", "${keychain:A-B}", "${env:HOME", "${HOME}", "x\0y"] {
        assert_eq!(code(Template::parse(raw)), "mcp_config_invalid", "{raw}");
    }
    assert_eq!(code(Template::parse(&"a".repeat(MAX_TEXT + 1))), "mcp_config_invalid");
}

#[test]
fn provider_and_jev_keys_cannot_be_referenced() {
    for name in ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "DASHSCOPE_API_KEY", JEV_ENV] {
        let e = Template::parse(&format!("${{env:{name}}}")).unwrap_err();
        assert!(e.message.contains(name), "{name}");
    }
    // 同名的钥匙串条目在 mcp/<服务器>/ 命名空间下，与 Provider 的 Key 无关
    assert!(Template::parse("${keychain:OPENAI_API_KEY}").is_ok());
}

#[test]
fn detects_plaintext_secrets() {
    let leaks = |raw: &str| Template::parse(raw).unwrap().leaks_secret();
    assert!(leaks("sk-proj-AAAABBBBCCCCDDDD1234"));
    assert!(leaks("Bearer abc.def"));
    assert!(leaks("--api-key=abc123"));
    assert!(leaks("postgres://app:hunter2@db.local/prod"));
    assert!(leaks("ghp_0123456789abcdefghijABCDEFGHIJ012345"));
    assert!(!leaks("Bearer ${keychain:GH_TOKEN}"));
    assert!(!leaks("postgres://app:${keychain:PG_PASSWORD}@db.local/prod"));
    assert!(!leaks("postgres://app@db.local/prod"));
    assert!(!leaks("--max-tokens=4096"));
    assert!(!leaks("/Users/me/projects/notes"));
    assert!(!leaks("@modelcontextprotocol/server-filesystem"));
}

#[test]
fn secret_like_names() {
    for n in ["GITHUB_TOKEN", "API_KEY", "APIKEY", "OPENAI_KEY", "PGPASSWORD", "CLIENT_SECRET", "GITHUB_PAT", "--api-key", "--token"] {
        assert!(secret_name(n), "{n}");
    }
    for n in ["PATH", "HOME", "LOG_LEVEL", "MONKEY", "--max-tokens", "--port", "KEYBOARD_LAYOUT"] {
        assert!(!secret_name(n), "{n}");
    }
    assert!(trivial("4096") && trivial("debug") && !trivial("abcdefgh1"));
}

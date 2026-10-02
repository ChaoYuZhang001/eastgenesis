//! 日志与错误细节脱敏：去掉 API Key、Bearer Token 和 key=value 形式的密钥。
//! 不依赖正则库，逐词扫描。

const SECRET_PREFIXES: &[&str] = &["sk-", "sk_", "sess-", "AIza", "xai-", "gsk_", "hf_"];
const SECRET_KEYS: &[&str] = &["api_key", "apikey", "api-key", "token", "secret", "password", "authorization"];
const MASK: &str = "[REDACTED]";

fn is_secret_like(word: &str) -> bool {
    let w = word.trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != '-' && c != '_');
    if w.len() < 16 {
        return false;
    }
    if SECRET_PREFIXES.iter().any(|p| w.starts_with(p)) {
        return true;
    }
    // 没有前缀的长随机串：同时含字母和数字、长度不小于 32
    w.len() >= 32
        && w.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        && w.chars().any(|c| c.is_ascii_digit())
        && w.chars().any(|c| c.is_ascii_alphabetic())
}

fn key_value_secret(word: &str) -> Option<String> {
    let (k, _) = word.split_once(['=', ':'])?;
    let key = k.trim_matches(|c: char| c == '"' || c == '\'').to_ascii_lowercase();
    if SECRET_KEYS.iter().any(|s| key.ends_with(s)) {
        let sep = &word[k.len()..k.len() + 1];
        return Some(format!("{k}{sep}{MASK}"));
    }
    None
}

pub fn redact(input: &str) -> String {
    let mut out = Vec::new();
    let mut mask_next = false;
    for word in input.split(' ') {
        let lower = word.to_ascii_lowercase();
        if mask_next && !word.is_empty() {
            out.push(MASK.to_string());
            mask_next = false;
            continue;
        }
        if lower == "bearer" || lower == "basic" {
            mask_next = true;
            out.push(word.to_string());
        } else if let Some(masked) = key_value_secret(word).filter(|_| !word.ends_with(':') && !word.ends_with('=')) {
            out.push(masked);
        } else if is_secret_like(word) {
            out.push(MASK.to_string());
        } else {
            out.push(word.to_string());
        }
    }
    out.join(" ")
}

#[cfg(test)]
mod tests {
    use super::redact;

    #[test]
    fn masks_bearer_and_prefixed_keys() {
        assert_eq!(redact("Authorization: Bearer abc.def.ghi"), "Authorization: Bearer [REDACTED]");
        assert_eq!(redact("key sk-proj-AAAABBBBCCCCDDDD1234"), "key [REDACTED]");
        assert_eq!(redact("using AIzaSyA1234567890abcdefgh"), "using [REDACTED]");
    }

    #[test]
    fn masks_key_value_pairs() {
        assert_eq!(redact("url?api_key=abc123"), "url?api_key=[REDACTED]");
        assert_eq!(redact("\"token\":\"xyz\""), "\"token\":[REDACTED]");
        assert_eq!(redact("password=hunter2 ok"), "password=[REDACTED] ok");
    }

    #[test]
    fn keeps_normal_text() {
        let s = "连接 https://api.example.com/v1 超时 (30s)";
        assert_eq!(redact(s), s);
        assert_eq!(redact("model gpt-4o-mini"), "model gpt-4o-mini");
    }
}

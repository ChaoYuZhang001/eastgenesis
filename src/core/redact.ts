// 日志与错误细节脱敏，规则与 crates/eg-core/src/redact.rs 保持一致。

const MASK = "[REDACTED]";

const PATTERNS: RegExp[] = [
  // Bearer / Basic 后的凭据
  /\b(Bearer|Basic)\s+[^\s"',]+/gi,
  // 常见厂商前缀的密钥
  /\b(?:sk-|sk_|sess-|AIza|xai-|gsk_|hf_)[A-Za-z0-9_-]{12,}/g,
  // key=value / "key":"value" 形式
  // 值是 Bearer/Basic 方案名或已脱敏时跳过，由第一条规则处理后面的凭据
  /((?:api[_-]?key|apikey|token|secret|password|authorization|x-api-key)["']?\s*[:=]\s*["']?)(?!(?:Bearer|Basic)\b|\[REDACTED\])[^\s"',&}]+/gi,
];

export function redact(input: string, extraSecrets: readonly string[] = []): string {
  let out = input;
  // 已知的密钥值（例如当前请求用到的 key）逐字替换，最可靠
  for (const s of extraSecrets) if (s && s.length >= 6) out = out.split(s).join(MASK);
  out = out.replace(PATTERNS[0], (_m, scheme: string) => `${scheme} ${MASK}`);
  out = out.replace(PATTERNS[1], MASK);
  out = out.replace(PATTERNS[2], (_m, prefix: string) => `${prefix}${MASK}`);
  return out;
}

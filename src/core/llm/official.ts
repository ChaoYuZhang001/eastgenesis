// 7 家官方 Provider 的端点和请求差异（2026-09-29 按官方文档核对）。
// 除 Anthropic 外都走 OpenAI 兼容的 Chat Completions，复用 OpenAIProvider。
// base URL 必须与 crates/eg-core/src/providers.rs 的 OFFICIAL_BASES 一致（tests/official-endpoints.test.ts 比对）：
// 桌面端的请求由 Rust 代理，只放行那张表里的地址。

export type OfficialId = "openai" | "anthropic" | "google" | "deepseek" | "qwen" | "kimi" | "ollama";

export interface OfficialRegion {
  id: string;
  label: string;
  baseUrl: string;
}

/** OpenAI 兼容端点之间的差异 */
export interface RequestQuirks {
  /** 输出上限的参数名。OpenAI、Kimi 已弃用 max_tokens */
  maxTokensParam?: "max_tokens" | "max_completion_tokens";
  /** 不发 temperature：Kimi 的采样参数固定；Gemini 3 系列要求去掉采样参数 */
  omitTemperature?: boolean;
  /** 流式请求带 stream_options.include_usage。Gemini 兼容层只在 extra_body 里写了，默认不发 */
  streamUsage?: boolean;
}

export interface OfficialEndpoint {
  id: OfficialId;
  label: string;
  dialect: "openai" | "anthropic";
  /** 第一个是默认地域。Key 按地域签发，不能混用 */
  regions: readonly OfficialRegion[];
  /** CLI 读取 Key 的环境变量；null 表示本机服务，不需要 Key */
  keyEnv: string | null;
  /** 能力矩阵里该家便宜且已启用的型号 */
  defaultModel: string;
  quirks?: RequestQuirks;
}

const one = (baseUrl: string): OfficialRegion[] => [{ id: "default", label: "默认", baseUrl }];

export const OFFICIAL_ENDPOINTS: readonly OfficialEndpoint[] = [
  { id: "openai", label: "OpenAI", dialect: "openai", regions: one("https://api.openai.com/v1"), keyEnv: "OPENAI_API_KEY", defaultModel: "gpt-5.6-luna", quirks: { maxTokensParam: "max_completion_tokens" } },
  { id: "anthropic", label: "Anthropic", dialect: "anthropic", regions: one("https://api.anthropic.com/v1"), keyEnv: "ANTHROPIC_API_KEY", defaultModel: "claude-sonnet-5-5" },
  { id: "google", label: "Google Gemini", dialect: "openai", regions: one("https://generativelanguage.googleapis.com/v1beta/openai"), keyEnv: "GEMINI_API_KEY", defaultModel: "gemini-3.5-flash-lite", quirks: { omitTemperature: true, streamUsage: false } },
  // 不带 /v1：官方文档已不再提 /v1，Rust 侧也只放行这个形式
  { id: "deepseek", label: "DeepSeek", dialect: "openai", regions: one("https://api.deepseek.com"), keyEnv: "DEEPSEEK_API_KEY", defaultModel: "deepseek-flash" },
  {
    id: "qwen",
    label: "通义千问 Qwen",
    dialect: "openai",
    regions: [
      { id: "cn", label: "中国站（北京）", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
      { id: "intl", label: "国际站（新加坡）", baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1" },
    ],
    keyEnv: "DASHSCOPE_API_KEY",
    defaultModel: "qwen3.8-flash",
  },
  {
    id: "kimi",
    label: "Kimi（Moonshot）",
    dialect: "openai",
    regions: [
      { id: "cn", label: "中国站（moonshot.cn）", baseUrl: "https://api.moonshot.cn/v1" },
      { id: "intl", label: "国际站（moonshot.ai）", baseUrl: "https://api.moonshot.ai/v1" },
    ],
    keyEnv: "MOONSHOT_API_KEY",
    defaultModel: "kimi-k2.6",
    quirks: { maxTokensParam: "max_completion_tokens", omitTemperature: true },
  },
  // 用 127.0.0.1 而不是 localhost：Ollama 默认只监听 IPv4，localhost 可能先解析到 ::1
  { id: "ollama", label: "Ollama（本机）", dialect: "openai", regions: one("http://127.0.0.1:11434/v1"), keyEnv: null, defaultModel: "qwen3:8b" },
];

export const OFFICIAL_IDS: readonly OfficialId[] = OFFICIAL_ENDPOINTS.map((e) => e.id);

export function officialEndpoint(id: string): OfficialEndpoint | undefined {
  return OFFICIAL_ENDPOINTS.find((e) => e.id === id);
}

/** 找不到对应地域时回到默认地域，保证不会拼出白名单以外的地址 */
export function regionBaseUrl(e: OfficialEndpoint, region?: string | null): string {
  return (e.regions.find((r) => r.id === region) ?? e.regions[0]).baseUrl;
}

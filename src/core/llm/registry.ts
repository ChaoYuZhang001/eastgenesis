// 由配置构造 Provider：校验 baseUrl 和附加头，从 SecretSource 取 Key。
import { AnthropicProvider } from "./anthropic";
import { ProviderError } from "./errors";
import { OFFICIAL_ENDPOINTS, OFFICIAL_IDS, officialEndpoint, regionBaseUrl } from "./official";
import { OpenAIProvider } from "./openai";
import type { FetchLike, LLMProvider, ProviderConfig } from "./types";
import { parseSecretRef, type SecretSource } from "../secrets";

/** 官方 Provider 的内置配置（见 official.ts）；Key 从约定的环境变量读取，Ollama 不需要 Key */
export const BUILTIN_PROVIDERS: ProviderConfig[] = OFFICIAL_ENDPOINTS.map((e) => ({
  id: e.id,
  kind: e.dialect === "anthropic" ? "anthropic" : e.id === "openai" ? "openai" : "openai-compatible",
  label: e.label,
  ...(e.id !== "openai" && e.id !== "anthropic" && { baseUrl: regionBaseUrl(e) }),
  ...(e.keyEnv && { apiKeyRef: `env:${e.keyEnv}` }),
  defaultModel: e.defaultModel,
}));

const PROVIDER_ID = new RegExp(`^(${OFFICIAL_IDS.join("|")}|custom:[a-z0-9][a-z0-9_-]{0,63})$`);
const RESERVED_HEADERS = new Set(["authorization", "x-api-key", "anthropic-version", "content-type", "host", "cookie"]);
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** 自定义端点必须 https；只有本机地址（本地模型）允许 http。URL 里不能带账号密码。 */
export function validateBaseUrl(raw: string, providerId: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ProviderError("config", providerId, { message: "baseUrl 不是合法 URL" });
  }
  if (u.username || u.password) throw new ProviderError("config", providerId, { message: "baseUrl 不能包含账号或密码" });
  if (u.search || u.hash) throw new ProviderError("config", providerId, { message: "baseUrl 不能带查询参数或锚点" });
  const local = LOCAL_HOSTS.has(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) {
    throw new ProviderError("config", providerId, { message: "baseUrl 必须使用 https（本机地址除外）" });
  }
  return u.toString().replace(/\/+$/, "");
}

export function validateHeaders(h: Record<string, string> | undefined, providerId: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h ?? {})) {
    const key = k.toLowerCase();
    if (!/^[a-z0-9-]+$/.test(key)) throw new ProviderError("config", providerId, { message: `请求头名称无效：${k}` });
    if (RESERVED_HEADERS.has(key)) throw new ProviderError("config", providerId, { message: `不允许覆盖请求头：${k}` });
    if (/[\r\n]/.test(v)) throw new ProviderError("config", providerId, { message: `请求头 ${k} 含换行` });
    out[key] = v;
  }
  return out;
}

export async function createProvider(
  cfg: ProviderConfig,
  secrets: SecretSource,
  deps: { fetch?: FetchLike; now?: () => number } = {},
): Promise<LLMProvider> {
  if (!PROVIDER_ID.test(cfg.id)) {
    throw new ProviderError("config", cfg.id, { message: `Provider ID 应为 ${OFFICIAL_IDS.join("、")} 或 custom:<名称>` });
  }
  const baseUrl = cfg.baseUrl && validateBaseUrl(cfg.baseUrl, cfg.id);
  let apiKey = "";
  if (cfg.apiKeyRef) {
    let ref;
    try {
      ref = parseSecretRef(cfg.apiKeyRef);
    } catch (e) {
      throw new ProviderError("config", cfg.id, { message: (e as Error).message });
    }
    apiKey = (await secrets.get(ref)) ?? "";
    if (!apiKey) {
      const where = ref.scheme === "env" ? `环境变量 ${ref.name}` : `钥匙串条目 ${ref.account}`;
      throw new ProviderError("auth", cfg.id, { message: `没有找到 API Key（${where}）` });
    }
  } else if (!baseUrl || !LOCAL_HOSTS.has(new URL(baseUrl).hostname)) {
    // 只有本机服务（Ollama、本地模型）可以不配 Key
    throw new ProviderError("config", cfg.id, { message: "缺少 apiKeyRef（只有本机地址可以不配 Key）" });
  }
  const headers = validateHeaders(cfg.headers, cfg.id);
  const common = { apiKey, headers, timeoutMs: cfg.timeoutMs, label: cfg.label, fetch: deps.fetch, now: deps.now };
  // 官方 Provider 的请求差异（参数名、采样参数）；自定义端点按标准 OpenAI 格式
  const quirks = officialEndpoint(cfg.id)?.quirks;

  switch (cfg.kind) {
    case "openai":
      return new OpenAIProvider({ ...common, id: cfg.id, kind: "openai", baseUrl, quirks });
    case "anthropic":
      return new AnthropicProvider({ ...common, id: cfg.id, baseUrl });
    case "openai-compatible":
      if (!baseUrl) throw new ProviderError("config", cfg.id, { message: "兼容端点必须填写 baseUrl" });
      return new OpenAIProvider({ ...common, id: cfg.id, kind: "openai-compatible", baseUrl, quirks });
    default:
      throw new ProviderError("config", cfg.id, { message: "未知的 Provider 类型" });
  }
}

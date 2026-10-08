// 桌面端的 Provider 组装：可用性判断（只看后端给的「是否已配置」）、地域与本机服务偏好、构造适配器。
// 适配器拿到占位 Key，请求经 proxiedFetch 交给 Rust 注入认证；base URL 只取官方表或 Rust 侧保存的自定义配置。
import { AnthropicProvider, OpenAIProvider, ProviderError, adapterRecoveryContract, officialEndpoint, regionBaseUrl, type LLMProvider } from "@/core/llm";
import { ADAPTER_READY, adapterRecoveryReady, type Availability, type ChainEntry, type HealthTracker } from "@/decision";
import { PROXY_PLACEHOLDER_KEY, isValidModelName, proxiedFetch, type Backend, type CustomProvider, type KeyStatus } from "@/platform";

export const isLocal = (url: string) => /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/.test(url);

/** 按 Provider 保存的偏好：地域（通义千问、Kimi 的 Key 按地域签发）、是否启用本机服务 */
export interface ProviderPrefs {
  regions: Record<string, string>;
  /** Ollama 不需要 Key，但本机不一定在运行：用户确认启用前不参与路由 */
  ollama: boolean;
  /** 第 2 级本地决策模型的 profile id（只能是本机服务）；null 表示不用 */
  localJev: string | null;
}

export const DEFAULT_PROVIDER_PREFS: ProviderPrefs = { regions: {}, ollama: false, localJev: null };
const LOCAL_PROVIDER = /^(?:ollama|custom:[a-z0-9][a-z0-9_-]{0,63})$/;

/** 本地决策模型的 profile id 只看格式（本机服务的 Provider + 合法模型名）；是否仍可选由 localJevCandidates 判断 */
function localJevId(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const i = v.indexOf("/");
  return i > 0 && LOCAL_PROVIDER.test(v.slice(0, i)) && isValidModelName(v.slice(i + 1)) ? v : null;
}

/** 容忍损坏的存储：未知的 Provider 或地域直接丢弃 */
export function parseProviderPrefs(raw: string | null): ProviderPrefs {
  try {
    const v = JSON.parse(raw ?? "null") as Partial<ProviderPrefs> | null;
    const regions: Record<string, string> = {};
    if (v?.regions && typeof v.regions === "object") {
      for (const [id, r] of Object.entries(v.regions)) {
        const e = officialEndpoint(id);
        if (e && e.regions.length > 1 && e.regions.some((x) => x.id === r)) regions[id] = r as string;
      }
    }
    return { regions, ollama: v?.ollama === true, localJev: localJevId(v?.localJev) };
  } catch {
    return DEFAULT_PROVIDER_PREFS;
  }
}

/** 可用性只看后端给的「是否已配置」，不接触 Key 本身 */
export function statusAvailability(
  statuses: readonly KeyStatus[],
  custom: readonly CustomProvider[],
  health: HealthTracker,
  prefs: ProviderPrefs = DEFAULT_PROVIDER_PREFS,
  adapters: ReadonlySet<string> = ADAPTER_READY,
): Availability {
  const byId = new Map(statuses.map((s) => [s.id, s]));
  return (p) => {
    if (p.provider.startsWith("custom:")) {
      const c = custom.find((x) => x.id === p.provider);
      if (!c) return { ok: false, reason: "自定义 Provider 不存在" };
      const protocol = c.protocol ?? "openai";
      if (!adapterRecoveryContract(protocol)) return { ok: false, reason: "自定义 Provider 协议未声明可恢复契约" };
      if (!byId.get(p.provider)?.configured && !isLocal(c.base_url)) return { ok: false, reason: "缺少 API Key（在设置页配置）" };
      return health.status(p.id, p.provider);
    }
    if (!adapters.has(p.provider)) return { ok: false, reason: "适配器未实现" };
    if (!adapterRecoveryReady(p.provider)) return { ok: false, reason: "适配器缺少可恢复执行契约" };
    if (p.provider === "ollama" && !prefs.ollama) return { ok: false, reason: "本机 Ollama 未启用（在设置页启用）" };
    const s = byId.get(p.provider);
    if (s?.needs_key !== false && !s?.configured) return { ok: false, reason: "缺少 API Key（在设置页配置）" };
    return health.status(p.id, p.provider);
  };
}

/**
 * 单次模型请求的超时（秒）：默认 90，设置页可调。上限低于 Rust 代理的 180 秒总超时，超时判定由这里做出。
 * 默认 90：实测中转站上的推理模型首字节常在 20–60 秒，60 秒会误判；更长的等待交给用户在设置页里选。
 */
export const REQUEST_TIMEOUT_OPTIONS = [30, 60, 90, 120, 150] as const;
export const DEFAULT_REQUEST_TIMEOUT_S = 90;

export function parseTimeout(raw: string | null): number {
  try {
    const v = JSON.parse(raw ?? "null") as unknown;
    return typeof v === "number" && (REQUEST_TIMEOUT_OPTIONS as readonly number[]).includes(v) ? v : DEFAULT_REQUEST_TIMEOUT_S;
  } catch {
    return DEFAULT_REQUEST_TIMEOUT_S;
  }
}

/** 每个 Provider 只构造一次适配器；地域和超时在引擎创建时确定，改动从下一个任务起生效 */
export function providerFactory(backend: Backend, custom: readonly CustomProvider[], regions: ProviderPrefs["regions"] = {}, timeoutMs = DEFAULT_REQUEST_TIMEOUT_S * 1000) {
  const cache = new Map<string, LLMProvider>();
  return async (e: Pick<ChainEntry, "provider">): Promise<LLMProvider> => {
    const hit = cache.get(e.provider);
    if (hit) return hit;
    const fetch = proxiedFetch(backend, e.provider);
    const off = officialEndpoint(e.provider);
    let p: LLMProvider;
    if (off) {
      const init = { id: off.id, label: off.label, baseUrl: regionBaseUrl(off, regions[off.id]), apiKey: PROXY_PLACEHOLDER_KEY, fetch, timeoutMs };
      p = off.dialect === "anthropic" ? new AnthropicProvider(init) : new OpenAIProvider({ ...init, kind: off.id === "openai" ? "openai" : "openai-compatible", quirks: off.quirks });
    } else {
      const c = custom.find((x) => x.id === e.provider);
      if (!c) throw new Error(`没有找到 Provider：${e.provider}`);
      const protocol = c.protocol ?? "openai";
      if (!adapterRecoveryContract(protocol)) throw new ProviderError("config", c.id, { message: "自定义 Provider 协议未声明可恢复契约" });
      const init = { id: c.id, label: c.label, baseUrl: c.base_url, apiKey: PROXY_PLACEHOLDER_KEY, fetch, timeoutMs };
      p = protocol === "anthropic" ? new AnthropicProvider(init) : new OpenAIProvider({ ...init, kind: "openai-compatible" });
    }
    cache.set(e.provider, p);
    return p;
  };
}

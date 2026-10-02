// 模型能力矩阵：加载、校验 config/model_profiles.json，判断 Provider 是否就绪。
import raw from "../../config/model_profiles.json";
import { OFFICIAL_ENDPOINTS, OFFICIAL_IDS } from "../core/llm/official";
import { CAPABILITIES, type Capability, type ModelProfile } from "./types";

/** context_window 不小于这个值的模型才标 long_context */
export const LONG_CONTEXT_WINDOW = 200_000;

const PROVIDER_RE = /^(openai|anthropic|google|deepseek|qwen|kimi|ollama|custom:[a-z0-9][a-z0-9_-]{0,63})$/;
const TIER_FIELDS = ["cost_tier", "quality_tier", "latency_tier"] as const;

export class ProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProfileError";
  }
}

/** 校验整份配置；任何一条出错都抛出，错误信息带字段路径 */
export function validateProfiles(data: unknown): ModelProfile[] {
  const list = (data as { profiles?: unknown })?.profiles;
  if (!Array.isArray(list)) throw new ProfileError("profiles 必须是数组");
  const seen = new Set<string>();
  return list.map((p: any, i) => {
    const at = (f: string) => `profiles[${i}]${f ? `.${f}` : ""}`;
    if (typeof p !== "object" || p === null) throw new ProfileError(`${at("")}: 应为对象`);
    if (typeof p.provider !== "string" || !PROVIDER_RE.test(p.provider)) throw new ProfileError(`${at("provider")}: 无效的 Provider`);
    if (typeof p.id !== "string" || !p.id.startsWith(`${p.provider}/`) || p.id.length <= p.provider.length + 1) {
      throw new ProfileError(`${at("id")}: 应为 "${p.provider}/<模型名>"`);
    }
    if (seen.has(p.id)) throw new ProfileError(`${at("id")}: 重复的 id ${p.id}`);
    seen.add(p.id);
    if (!Array.isArray(p.capabilities) || p.capabilities.some((c: unknown) => !CAPABILITIES.includes(c as Capability))) {
      throw new ProfileError(`${at("capabilities")}: 只能包含 ${CAPABILITIES.join("、")}`);
    }
    if (new Set(p.capabilities).size !== p.capabilities.length) throw new ProfileError(`${at("capabilities")}: 有重复标签`);
    for (const f of TIER_FIELDS) {
      if (!Number.isInteger(p[f]) || p[f] < 1 || p[f] > 5) throw new ProfileError(`${at(f)}: 应为 1–5 的整数`);
    }
    if (!Number.isInteger(p.context_window) || p.context_window <= 0) throw new ProfileError(`${at("context_window")}: 应为正整数`);
    if (typeof p.enabled !== "boolean" || typeof p.is_custom !== "boolean") throw new ProfileError(`${at("enabled")}: enabled / is_custom 应为布尔值`);
    if (p.is_custom !== p.provider.startsWith("custom:")) throw new ProfileError(`${at("is_custom")}: 与 provider 不一致`);
    const tagged = p.capabilities.includes("long_context");
    if (tagged !== p.context_window >= LONG_CONTEXT_WINDOW) {
      throw new ProfileError(`${at("capabilities")}: long_context 标签应当且仅当 context_window ≥ ${LONG_CONTEXT_WINDOW}`);
    }
    return {
      id: p.id,
      provider: p.provider,
      capabilities: [...p.capabilities].sort(),
      cost_tier: p.cost_tier,
      quality_tier: p.quality_tier,
      latency_tier: p.latency_tier,
      context_window: p.context_window,
      enabled: p.enabled,
      is_custom: p.is_custom,
    };
  });
}

export const MODEL_PROFILES: readonly ModelProfile[] = validateProfiles(raw);

export function modelName(p: Pick<ModelProfile, "id" | "provider">): string {
  return p.id.slice(p.provider.length + 1);
}

/** 各 Provider 读取 Key 的环境变量；Ollama 在本机运行，不需要 Key */
export const PROVIDER_KEY_ENV: Readonly<Record<string, string | null>> = Object.fromEntries(OFFICIAL_ENDPOINTS.map((e) => [e.id, e.keyEnv]));

/** 已有适配器的 Provider：7 家官方全部就绪（M6） */
export const ADAPTER_READY: ReadonlySet<string> = new Set(OFFICIAL_IDS);

/** CLI 下本机 Ollama 需要显式启用（EG_OLLAMA=1），否则没在运行时也会被路由选中 */
export const OLLAMA_ENV = "EG_OLLAMA";

export type Readiness = { ok: true } | { ok: false; reason: string };

/** Provider 是否能被调用：有适配器，且（需要时）配置了 Key。只检查 Key 是否存在，不读取其值。 */
export function providerReadiness(
  provider: string,
  env: Record<string, string | undefined>,
  adapters: ReadonlySet<string> = ADAPTER_READY,
): Readiness {
  if (provider.startsWith("custom:")) return { ok: false, reason: "自定义 Provider 尚未配置" };
  if (!adapters.has(provider)) return { ok: false, reason: "适配器未实现" };
  if (provider === "ollama" && env[OLLAMA_ENV]?.trim() !== "1") return { ok: false, reason: `本机 Ollama 未启用（${OLLAMA_ENV}=1）` };
  const envName = PROVIDER_KEY_ENV[provider];
  if (envName && !env[envName]?.trim()) return { ok: false, reason: `缺少 API Key（${envName}）` };
  return { ok: true };
}

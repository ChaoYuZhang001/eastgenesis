// 自定义 Provider 的能力矩阵条目：每个登记的模型一条。
// 中转站转发的往往就是官方型号：型号名（去掉 vendor/ 前缀，不分大小写）和内置矩阵某条同名时，
// 默认沿用那条的能力和档位，并在界面上标明参照来源；否则用保守的默认值。两种情况都能在能力矩阵里改。
import { MODEL_PROFILES, modelName, type ModelProfile } from "@/decision";
import { customModels, type CustomProvider } from "@/platform";

export const customProfileId = (providerId: string, model: string) => `${providerId}/${model}`;

/** 找不到参照时的默认值：能力未知，档位居中 */
const UNKNOWN = { capabilities: [], cost_tier: 3, quality_tier: 3, latency_tier: 3, context_window: 128_000 } as const;

const norm = (m: string) => (m.split("/").pop() ?? m).toLowerCase();

/**
 * 与自定义型号同名的内置条目。不参照 Ollama：本机模型的成本、延迟档位不适用于远端服务。
 * 也不参照其他自定义条目。
 */
export function officialMatch(model: string): ModelProfile | undefined {
  const n = norm(model);
  return MODEL_PROFILES.find((p) => p.provider !== "ollama" && !p.provider.startsWith("custom:") && modelName(p).toLowerCase() === n);
}

export function customProfiles(custom: readonly CustomProvider[]): ModelProfile[] {
  return custom.flatMap((c) =>
    customModels(c).map((m): ModelProfile => {
      const ref = officialMatch(m);
      return {
        id: customProfileId(c.id, m),
        provider: c.id,
        capabilities: [...(ref?.capabilities ?? UNKNOWN.capabilities)],
        cost_tier: ref?.cost_tier ?? UNKNOWN.cost_tier,
        quality_tier: ref?.quality_tier ?? UNKNOWN.quality_tier,
        latency_tier: ref?.latency_tier ?? UNKNOWN.latency_tier,
        context_window: ref?.context_window ?? UNKNOWN.context_window,
        // 用户明确登记了这个型号，即使参照的内置条目默认停用，这里也启用
        enabled: true,
        is_custom: true,
      };
    }),
  );
}

/** 自定义条目参照了哪条内置条目（给能力矩阵和自定义 Provider 列表展示） */
export function customReference(profile: Pick<ModelProfile, "id" | "provider" | "is_custom">): string | null {
  if (!profile.is_custom || !profile.provider.startsWith("custom:")) return null;
  return officialMatch(modelName(profile))?.id ?? null;
}

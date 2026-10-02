// 桌面端的本地决策模型（第 2 级）：只能选本机服务，即 Ollama 或地址在本机的自定义 Provider，任务内容和工具输出不离开本机。
// 请求和普通模型调用一样经 proxiedFetch 交给 Rust（浏览器模式交给模拟后端），适配器与路由共用一份缓存。
import type { LLMProvider } from "@/core/llm";
import { LocalJevBackend, modelName, type ChainEntry, type ModelProfile } from "@/decision";
import type { CustomProvider } from "@/platform";
import { isLocal } from "./providers";

/** 可以做本地决策模型的 profile。不看路由开关和能力矩阵的启用状态：只用来做决策也可以 */
export function localJevCandidates(profiles: readonly ModelProfile[], custom: readonly CustomProvider[]): ModelProfile[] {
  const local = new Set(custom.filter((c) => isLocal(c.base_url)).map((c) => c.id));
  return profiles.filter((p) => p.provider === "ollama" || local.has(p.provider));
}

/** 按设置构造第 2 级决策后端；没选，或选的模型已经不在候选里时跳过，并说明原因 */
export function localJevBackend(
  id: string | null,
  profiles: readonly ModelProfile[],
  custom: readonly CustomProvider[],
  providerFor: (e: Pick<ChainEntry, "provider">) => Promise<LLMProvider>,
): LocalJevBackend {
  if (!id) return new LocalJevBackend(null, "没有选择本地决策模型（在设置页选择）");
  const p = localJevCandidates(profiles, custom).find((x) => x.id === id);
  if (!p) return new LocalJevBackend(null, `本地决策模型 ${id} 不可用（在设置页重新选择）`);
  return new LocalJevBackend({
    id: p.id,
    async ask(system, user, signal) {
      const provider = await providerFor(p);
      const messages = [
        { role: "system" as const, content: system },
        { role: "user" as const, content: user },
      ];
      return (await provider.chat({ model: modelName(p), messages, temperature: 0, maxTokens: 300, signal })).text;
    },
  });
}

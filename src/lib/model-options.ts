// 输入框模型下拉的选项。
// 官方 Provider 取能力矩阵里已启用、当前可用的条目：官方 /models 会返回嵌入、语音、绘图等没有 profile 的型号，
// 且命名常与矩阵对不上，拿来做下拉只会让人选到调不通的东西。
// 自定义 Provider（含中转站）取 /models 缓存，没有缓存时退回已登记的模型：中转站的型号只有服务自己知道。
// 轻量探测返回 404 的型号从下拉里去掉（stores/settings.ts probeModels）。
import type { ModelProfile } from "@/decision";
import type { Availability } from "@/decision";
import { customProfileId } from "@/lib/custom-profiles";
import { customModels, type CustomProvider } from "@/platform";
import { officialEndpoint } from "@/core/llm/official";
import type { ModelCache } from "@/stores/settings";

export interface ModelOption {
  /** profile id：官方是 <provider>/<model>，自定义是 custom:<名称>/<model> */
  id: string;
  /** 展示名：只有型号 */
  label: string;
  /** 这个模型能不能用；不能用时下拉里禁选并说明原因 */
  ok: boolean;
  reason: string | null;
}

export interface ModelGroup {
  provider: string;
  label: string;
  options: ModelOption[];
}

const modelOf = (id: string, provider: string) => id.slice(provider.length + 1);

/**
 * 按 Provider 分组的可选模型。官方来自能力矩阵，自定义来自 /models 缓存或已登记模型。
 * 只保留有可用模型的分组：没配 Key 的 Provider 不必出现在输入框里。
 */
export function modelGroups(
  profiles: readonly ModelProfile[],
  custom: readonly CustomProvider[],
  available: Availability,
  cache: ModelCache = {},
): ModelGroup[] {
  const groups: ModelGroup[] = [];
  const byProvider = new Map<string, ModelProfile[]>();
  for (const p of profiles) {
    if (!p.enabled) continue;
    const list = byProvider.get(p.provider);
    if (list) list.push(p);
    else byProvider.set(p.provider, [p]);
  }

  for (const e of [...byProvider.keys()].filter((id) => !id.startsWith("custom:"))) {
    const options = (byProvider.get(e) ?? []).map((p) => {
      const s = available(p);
      return { id: p.id, label: modelOf(p.id, p.provider), ok: s.ok, reason: s.ok ? null : s.reason };
    });
    const ok = options.filter((o) => o.ok);
    if (ok.length) groups.push({ provider: e, label: officialEndpoint(e)?.label ?? e, options: ok });
  }

  for (const c of custom) {
    const registered = customModels(c);
    const entry = cache[c.id];
    // 探测确认不存在（404）的型号不给用户选：选了也只会失败
    const gone = new Set(entry?.unavailable ?? []);
    const models = (entry?.models ?? registered).filter((m) => !gone.has(m));
    // 用缓存里的型号时，可用性照这家已登记模型的判断（Key、熔断都是按 Provider 记的）
    const probe = byProvider.get(c.id)?.[0] ?? { id: customProfileId(c.id, registered[0] ?? "model"), provider: c.id, enabled: true };
    const s = available(probe as ModelProfile);
    if (!s.ok || !models.length) continue;
    groups.push({
      provider: c.id,
      label: c.label,
      options: models.map((m) => ({ id: customProfileId(c.id, m), label: m, ok: true, reason: null })),
    });
  }
  return groups;
}

/** 锁定的模型还在不在选项里；不在就当作自动路由（例如删掉了那个 Provider） */
export function hasOption(groups: readonly ModelGroup[], id: string | null): boolean {
  return !!id && groups.some((g) => g.options.some((o) => o.id === id));
}

/** 折叠状态显示的名字 */
export function lockLabel(groups: readonly ModelGroup[], id: string | null): string {
  if (!id) return "自动路由";
  for (const g of groups) for (const o of g.options) if (o.id === id) return o.label;
  return id.replace(/^custom:/, "");
}

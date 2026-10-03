// 「省了多少」（docs/UI_LAYOUT_V3.md 5.1）：每次模型调用的实际花费，和同一批 tokens 交给「最强模式」排第一的模型的花费比较。
// 单价来自 config/model-prices.json（官方价目页、核对日期都写在里面）；缺单价的调用不计入金额，单独计数，不估。
// 不同模型分词不同，这里用实际调用的 tokens 计价，所以金额只是「约」。
import raw from "../../config/model-prices.json";
import type { AgentEvent } from "@/agent";
import { route, type Availability, type ModelProfile, type RouteDecision } from "@/decision";

export interface Price {
  input: number;
  output: number;
  source: string;
  checked: string;
  long_context?: { over_input_tokens: number; input: number; output: number };
  valid_until?: string;
  note?: string;
  region?: string;
}
export type PriceTable = Readonly<Record<string, Price>>;

export const PRICES: PriceTable = (raw as { models: Record<string, Price> }).models;
/** 价目表本身的核对日期（取最早的一条，最保守） */
export const PRICES_CHECKED = Object.values(PRICES).map((p) => p.checked).sort()[0] ?? "";

/** 一次调用的花费（美元）；没有单价返回 null。超过长上下文门槛时整次按长上下文价（官方的计价方式） */
export function callCost(profileId: string, inputTokens: number, outputTokens: number, prices: PriceTable = PRICES): number | null {
  const p = prices[profileId];
  if (!p) return null;
  const long = p.long_context && inputTokens > p.long_context.over_input_tokens ? p.long_context : null;
  return (inputTokens * (long?.input ?? p.input) + outputTokens * (long?.output ?? p.output)) / 1_000_000;
}

/**
 * 基准模型：同一任务类型、同一批可用模型里，按「最强」偏好排第一的模型（本地规则计算，不多调 Jev）。
 * 用这次路由记录里的分类和排除名单，所以「可用」的口径和这次决策一致。
 */
export function baselineFor(decision: RouteDecision, profiles: readonly ModelProfile[], availability: Availability): string | null {
  const excluded = new Set((decision.excluded ?? []).map((e) => e.profileId));
  const usable: Availability = (p) => (excluded.has(p.id) ? { ok: false, reason: "这次不可用", health: 0 } : availability(p));
  // 节省只是展示用的派生信息：路由记录不完整（旧数据、只带部分字段）时算不出基准就不写金额，不能让回答渲染出错
  try {
    const best = route({ text: "", classification: decision.classification, preference: "best" }, { profiles, availability: usable });
    return best.primary?.profileId ?? null;
  } catch {
    return null;
  }
}

export interface Savings {
  /** 实际花费、基准花费（只算两边都有单价的调用） */
  actual: number;
  baseline: number;
  /** 计入金额的调用数 */
  priced: number;
  /** 没有单价（实际模型或基准模型缺价）、没算进去的调用数 */
  unpriced: number;
  /** 没有 token 用量（服务没返回 usage）的调用数 */
  noUsage: number;
  baselineModel: string | null;
}

export const EMPTY_SAVINGS: Savings = { actual: 0, baseline: 0, priced: 0, unpriced: 0, noUsage: 0, baselineModel: null };

/** 一个任务的事件流 → 节省。baselineModel 由调用方用 baselineFor 算好传进来（需要 profiles 和可用性） */
export function savingsOf(events: readonly AgentEvent[], baselineModel: string | null, prices: PriceTable = PRICES): Savings {
  const s: Savings = { ...EMPTY_SAVINGS, baselineModel };
  for (const outer of events) {
    const e = outer.type === "subagent" ? outer.event : outer;
    if (e.type !== "llm") continue;
    if (!e.usage) {
      s.noUsage++;
      continue;
    }
    const actual = callCost(e.profileId, e.usage.inputTokens, e.usage.outputTokens, prices);
    const base = baselineModel ? callCost(baselineModel, e.usage.inputTokens, e.usage.outputTokens, prices) : null;
    if (actual === null || base === null) {
      s.unpriced++;
      continue;
    }
    s.actual += actual;
    s.baseline += base;
    s.priced++;
  }
  return s;
}

export function addSavings(a: Savings, b: Savings): Savings {
  return {
    actual: a.actual + b.actual,
    baseline: a.baseline + b.baseline,
    priced: a.priced + b.priced,
    unpriced: a.unpriced + b.unpriced,
    noUsage: a.noUsage + b.noUsage,
    baselineModel: a.baselineModel === b.baselineModel ? a.baselineModel : null,
  };
}

/** 金额文字：大于 0「省 $x」，小于 0 如实「多花 $x」，等于 0 或没有可计价的调用时不写；不足一分写「<$0.01」 */
export function savedText(s: Savings): string | null {
  if (s.priced === 0) return null;
  const d = s.baseline - s.actual;
  const abs = Math.abs(d);
  if (abs < 1e-9) return null;
  const amount = abs < 0.01 ? "<$0.01" : `$${abs.toFixed(2)}`;
  return d > 0 ? `省 ${amount}` : `多花 ${amount}`;
}

/** 节省比例（相对基准）；没有可计价的调用返回 null */
export function savedPercent(s: Savings): number | null {
  if (s.priced === 0 || s.baseline <= 0) return null;
  return Math.round(((s.baseline - s.actual) / s.baseline) * 100);
}

export const SAVINGS_HINT = "和最强模式相比，按官方标价估算";

// 内部基准：同一批标注样例（tests/fixtures/routing_cases.json），比较智能路由和「固定用一个模型」。
// 不调用模型，只跑分类和路由，结果可复现；docs/BENCHMARK.md 的内部基准表由 `pnpm eg bench` 生成。
// 能力是否满足以样例的人工标注为准，不以分类器的判断为准：分类错了，这里会如实扣分。
import type { RoutingCase } from "./eval";
import { MODEL_PROFILES } from "./profiles";
import { route, type Preference } from "./router";
import { HARD_CAPS, type Capability, type ModelProfile } from "./types";

export interface BenchScenario {
  id: string;
  label: string;
  providers: readonly string[];
}

/** A 与模拟后端、验收测试的默认配置一致；B 是 6 家云端官方 Provider 都配了 Key（不含本机 Ollama） */
export const BENCH_SCENARIOS: readonly BenchScenario[] = [
  { id: "A", label: "已配置 OpenAI、Anthropic", providers: ["openai", "anthropic"] },
  { id: "B", label: "已配置 6 家云端官方 Provider", providers: ["openai", "anthropic", "google", "deepseek", "qwen", "kimi"] },
];

export interface BenchRow {
  strategy: string;
  /** 固定策略用的模型；智能路由为 null */
  model: string | null;
  /** 首选模型具备样例标注的全部硬性能力（视觉、长上下文、工具调用） */
  hardOk: number;
  /** 首选模型具备样例标注的全部能力（另含代码、推理、中文） */
  allOk: number;
  avgCost: number;
  avgQuality: number;
  /** 首选模型所在的 Provider 整体不可用时，降级链上还有别家、且满足硬性能力的模型接手 */
  survive: number;
}

const covers = (p: ModelProfile, caps: readonly Capability[]) => caps.every((c) => p.capabilities.includes(c));
const hardOf = (caps: readonly Capability[]) => caps.filter((c) => HARD_CAPS.includes(c));
const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

/** 固定策略选的模型：旗舰取质量最高、能力最全、再最便宜；最便宜取成本最低、再质量最高 */
export function fixedPick(pool: readonly ModelProfile[], kind: "flagship" | "cheapest"): ModelProfile {
  const by = kind === "flagship"
    ? (a: ModelProfile, b: ModelProfile) => b.quality_tier - a.quality_tier || b.capabilities.length - a.capabilities.length || a.cost_tier - b.cost_tier || a.id.localeCompare(b.id)
    : (a: ModelProfile, b: ModelProfile) => a.cost_tier - b.cost_tier || b.quality_tier - a.quality_tier || b.capabilities.length - a.capabilities.length || a.id.localeCompare(b.id);
  return [...pool].sort(by)[0];
}

function row(strategy: string, model: string | null, picks: { p: ModelProfile; c: RoutingCase; survive: boolean }[]): BenchRow {
  const n = picks.length;
  return {
    strategy,
    model,
    hardOk: picks.filter(({ p, c }) => covers(p, hardOf(c.expected_capabilities))).length / n,
    allOk: picks.filter(({ p, c }) => covers(p, c.expected_capabilities)).length / n,
    avgCost: avg(picks.map(({ p }) => p.cost_tier)),
    avgQuality: avg(picks.map(({ p }) => p.quality_tier)),
    survive: picks.filter((x) => x.survive).length / n,
  };
}

export function runBench(cases: readonly RoutingCase[], s: BenchScenario, profiles: readonly ModelProfile[] = MODEL_PROFILES): BenchRow[] {
  const pool = profiles.filter((p) => p.enabled && s.providers.includes(p.provider));
  const byId = new Map(pool.map((p) => [p.id, p]));
  const availability = (p: ModelProfile) => (s.providers.includes(p.provider) ? { ok: true as const, health: 1 } : { ok: false as const, reason: "未配置" });

  const routed = (preference: Preference) =>
    cases.map((c) => {
      const d = route({ text: c.input, attachments: c.attachments, preference }, { profiles, availability });
      if (!d.primary) throw new Error(`场景 ${s.id} 样例 ${c.id} 没有可用模型`);
      const hard = hardOf(c.expected_capabilities);
      const survive = d.chain.some((e) => e.provider !== d.primary!.provider && covers(byId.get(e.profileId)!, hard));
      return { p: byId.get(d.primary.profileId)!, c, survive };
    });
  // 固定一个模型：没有备选，它的 Provider 不可用时任务就失败
  const fixed = (p: ModelProfile) => cases.map((c) => ({ p, c, survive: false }));

  const flagship = fixedPick(pool, "flagship");
  const cheapest = fixedPick(pool, "cheapest");
  return [
    row("智能路由（平衡）", null, routed("balanced")),
    row("智能路由（省钱）", null, routed("economy")),
    row("固定旗舰", flagship.id, fixed(flagship)),
    row("固定最便宜", cheapest.id, fixed(cheapest)),
  ];
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

export function formatBench(cases: readonly RoutingCase[], scenarios: readonly BenchScenario[] = BENCH_SCENARIOS): string {
  const out: string[] = [];
  for (const s of scenarios) {
    out.push(`场景 ${s.id}：${s.label}，${cases.length} 条样例`, "");
    out.push("| 策略 | 模型 | 硬性能力满足 | 全部能力满足 | 平均成本档 | 平均质量档 | 首选 Provider 故障后仍可完成 |", "|---|---|---|---|---|---|---|");
    for (const r of runBench(cases, s)) {
      out.push(`| ${r.strategy} | ${r.model ?? "按任务选择"} | ${pct(r.hardOk)} | ${pct(r.allOk)} | ${r.avgCost.toFixed(2)} | ${r.avgQuality.toFixed(2)} | ${pct(r.survive)} |`);
    }
    out.push("");
  }
  return out.join("\n").trimEnd();
}

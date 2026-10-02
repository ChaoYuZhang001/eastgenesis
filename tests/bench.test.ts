// @vitest-environment node
// 内部基准（docs/BENCHMARK.md 第 2 节）：口径见 src/decision/bench.ts 顶部注释。
import { readFileSync } from "node:fs";
import fixtures from "./fixtures/routing_cases.json";
import { BENCH_SCENARIOS, fixedPick, formatBench, runBench } from "@/decision/bench";
import type { RoutingCase } from "@/decision/eval";
import { MODEL_PROFILES } from "@/decision/profiles";

const cases = fixtures.cases as unknown as RoutingCase[];
const poolOf = (providers: readonly string[]) => MODEL_PROFILES.filter((p) => p.enabled && providers.includes(p.provider));

describe("内部基准：智能路由对比固定模型", () => {
  it("两个场景下，智能路由的首选都满足硬性能力；首选 Provider 故障后都有别家接手", () => {
    for (const s of BENCH_SCENARIOS) {
      for (const r of runBench(cases, s).filter((x) => x.model === null)) {
        expect(r.hardOk, `场景 ${s.id} ${r.strategy} 硬性能力满足`).toBe(1);
        expect(r.survive, `场景 ${s.id} ${r.strategy} 故障后仍可完成`).toBe(1);
      }
    }
  });

  it("固定一个模型没有备选：首选 Provider 故障后仍可完成按定义是 0%", () => {
    for (const s of BENCH_SCENARIOS) {
      for (const r of runBench(cases, s).filter((x) => x.model !== null)) expect(r.survive, `场景 ${s.id} ${r.strategy}`).toBe(0);
    }
  });

  it("只配了一家 Provider 时，智能路由也换不到别家，如实记 0%", () => {
    const rows = runBench(cases, { id: "单家", label: "只配置 OpenAI", providers: ["openai"] });
    expect(rows.map((r) => r.survive)).toEqual([0, 0, 0, 0]);
  });

  it("以人工标注为准：分类器漏判视觉时，首选和别家接手的模型都不具备视觉，两项都不计入", () => {
    const noVision = MODEL_PROFILES.map((p) => ({ ...p, capabilities: p.capabilities.filter((c) => c !== "vision") }));
    const missed: RoutingCase = { id: "漏判", input: "把下面这段话翻译成英文：今天天气很好。", lang: "zh", expected_type: "vision", expected_capabilities: ["vision", "zh"] };
    const [balanced] = runBench([missed], BENCH_SCENARIOS[0], noVision);
    expect(balanced.hardOk).toBe(0);
    expect(balanced.survive).toBe(0);
  });

  it("停用的模型不参加固定策略：原来选中的旗舰和最便宜被停用后改选别的模型", () => {
    const pool = poolOf(BENCH_SCENARIOS[0].providers);
    const off = new Set([fixedPick(pool, "flagship").id, fixedPick(pool, "cheapest").id]);
    const profiles = MODEL_PROFILES.map((p) => (off.has(p.id) ? { ...p, enabled: false } : p));
    for (const r of runBench(cases, BENCH_SCENARIOS[0], profiles)) {
      if (r.model !== null) expect(off.has(r.model), `${r.strategy} 选到了停用的 ${r.model}`).toBe(false);
    }
  });

  it("平均成本档：省钱 < 平衡 < 固定旗舰", () => {
    for (const s of BENCH_SCENARIOS) {
      const cost = Object.fromEntries(runBench(cases, s).map((r) => [r.strategy, r.avgCost]));
      expect(cost["智能路由（省钱）"], `场景 ${s.id}`).toBeLessThan(cost["智能路由（平衡）"]);
      expect(cost["智能路由（平衡）"], `场景 ${s.id}`).toBeLessThan(cost["固定旗舰"]);
    }
  });

  it("固定旗舰取质量最高的模型，固定最便宜取成本最低的模型", () => {
    for (const s of BENCH_SCENARIOS) {
      const pool = poolOf(s.providers);
      expect(fixedPick(pool, "flagship").quality_tier, `场景 ${s.id} 旗舰`).toBe(Math.max(...pool.map((p) => p.quality_tier)));
      expect(fixedPick(pool, "cheapest").cost_tier, `场景 ${s.id} 最便宜`).toBe(Math.min(...pool.map((p) => p.cost_tier)));
    }
  });

  it("docs/BENCHMARK.md 的内部基准表与 formatBench 输出一致（改了路由或能力矩阵后用 pnpm eg bench 重新生成）", () => {
    const doc = readFileSync(new URL("../docs/BENCHMARK.md", import.meta.url), "utf8");
    const start = doc.indexOf("<!-- bench:start -->");
    const end = doc.indexOf("<!-- bench:end -->");
    expect(start, "缺少 bench:start 标记").toBeGreaterThan(-1);
    expect(end, "缺少 bench:end 标记").toBeGreaterThan(start);
    expect(doc.slice(start + "<!-- bench:start -->".length, end).trim()).toBe(formatBench(cases));
  });
});

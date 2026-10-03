// 「省了多少」的口径（docs/UI_LAYOUT_V3.md 5.1）：官方标价、基准是「最强」排第一的模型、缺单价不估
import raw from "../config/model-prices.json";
import type { AgentEvent } from "@/agent";
import { MODEL_PROFILES, classifyTask, route, type Availability, type RouteDecision } from "@/decision";
import { addSavings, baselineFor, callCost, savedPercent, savedText, savingsOf, type PriceTable } from "@/lib/savings";

const T: PriceTable = {
  "a/cheap": { input: 0.2, output: 1.2, source: "x", checked: "2026-10-03" },
  "b/best": { input: 4, output: 20, source: "x", checked: "2026-10-03" },
  "c/long": { input: 2, output: 12, source: "x", checked: "2026-10-03", long_context: { over_input_tokens: 200_000, input: 4, output: 18 } },
};
const call = (profileId: string, inputTokens: number, outputTokens: number): AgentEvent => ({ type: "llm", purpose: "answer", profileId, latencyMs: 1, usage: { inputTokens, outputTokens } });

describe("价目表", () => {
  it("每条都写了官方来源和核对日期；只有本机模型是 0 元", () => {
    const models = (raw as { models: Record<string, { input: number; output: number; source: string; checked: string }> }).models;
    for (const [id, p] of Object.entries(models)) {
      expect(p.checked).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      if (id.startsWith("ollama/")) expect([p.input, p.output]).toEqual([0, 0]);
      else {
        expect(p.source).toMatch(/^https:\/\//);
        expect(p.input).toBeGreaterThan(0);
        expect(p.output).toBeGreaterThan(0);
      }
    }
  });

  it("只给能力矩阵里有的模型定价，不出现矩阵外的型号", () => {
    const ids = new Set(MODEL_PROFILES.map((p) => p.id));
    for (const id of Object.keys((raw as { models: object }).models)) expect(ids.has(id)).toBe(true);
  });
});

describe("计价", () => {
  it("按每百万 tokens 计；超过长上下文门槛时整次按长上下文价", () => {
    expect(callCost("a/cheap", 1000, 500, T)).toBeCloseTo((1000 * 0.2 + 500 * 1.2) / 1e6, 12);
    expect(callCost("c/long", 200_000, 1000, T)).toBeCloseTo((200_000 * 2 + 1000 * 12) / 1e6, 12);
    expect(callCost("c/long", 200_001, 1000, T)).toBeCloseTo((200_001 * 4 + 1000 * 18) / 1e6, 12);
    expect(callCost("x/unknown", 1000, 1000, T)).toBeNull();
  });

  it("节省 = 基准模型按同样 tokens 计价 − 实际；缺单价、缺用量的调用单独计数，不计入金额", () => {
    const events: AgentEvent[] = [
      call("a/cheap", 10_000, 2_000),
      { type: "subagent", agent: "r", event: call("a/cheap", 5_000, 1_000) } as AgentEvent,
      call("x/unknown", 1_000, 1_000),
      { type: "llm", purpose: "answer", profileId: "a/cheap", latencyMs: 1, usage: null },
    ];
    const s = savingsOf(events, "b/best", T);
    // 实际 (15000×0.2 + 3000×1.2)/1e6 = 0.0066；基准 (15000×4 + 3000×20)/1e6 = 0.12
    expect(s.actual).toBeCloseTo(0.0066, 10);
    expect(s.baseline).toBeCloseTo(0.12, 10);
    expect(s).toMatchObject({ priced: 2, unpriced: 1, noUsage: 1, baselineModel: "b/best" });
    expect(savedText(s)).toBe("省 $0.11");
    expect(savedPercent(s)).toBe(95);
  });

  it("用的就是基准模型时不写金额；比基准还贵时如实写「多花」；不足一分写 <$0.01；没有可计价的调用不写", () => {
    expect(savedText(savingsOf([call("b/best", 1000, 1000)], "b/best", T))).toBeNull();
    expect(savedText(savingsOf([call("b/best", 100_000, 10_000)], "a/cheap", T))).toBe("多花 $0.57");
    expect(savedText(savingsOf([call("a/cheap", 100, 100)], "b/best", T))).toBe("省 <$0.01");
    expect(savedText(savingsOf([call("x/unknown", 100, 100)], "b/best", T))).toBeNull();
    expect(savedText(savingsOf([call("a/cheap", 100, 100)], null, T))).toBeNull();
    expect(savedPercent(savingsOf([], "b/best", T))).toBeNull();
  });

  it("合计：金额和计数相加；基准模型不一致时不再写具体是哪个", () => {
    const a = savingsOf([call("a/cheap", 1000, 0)], "b/best", T);
    const b = savingsOf([call("a/cheap", 1000, 0)], "c/long", T);
    const sum = addSavings(a, b);
    expect(sum.priced).toBe(2);
    expect(sum.baseline).toBeCloseTo((1000 * 4 + 1000 * 2) / 1e6, 12);
    expect(sum.baselineModel).toBeNull();
  });
});

describe("基准模型", () => {
  const all: Availability = () => ({ ok: true, health: 1 });
  it("是同一任务类型下按「最强」偏好排第一的模型，和这次实际的偏好无关", () => {
    const req = { text: "写一段 Python 快速排序" };
    const cls = classifyTask(req);
    const economy = route({ ...req, classification: cls, preference: "economy" }, { availability: all });
    const best = route({ ...req, classification: cls, preference: "best" }, { availability: all });
    expect(baselineFor(economy, MODEL_PROFILES, all)).toBe(best.primary!.profileId);
    expect(baselineFor(best, MODEL_PROFILES, all)).toBe(best.primary!.profileId);
  });

  it("路由记录不完整时算不出基准：返回 null（不写金额），不抛错", () => {
    const partial = { classification: { type: "reasoning", capabilities: ["reasoning"] } } as unknown as RouteDecision;
    expect(baselineFor(partial, MODEL_PROFILES, all)).toBeNull();
    expect(savedText(savingsOf([call("a/cheap", 1000, 1000)], baselineFor(partial, MODEL_PROFILES, all), T))).toBeNull();
  });

  it("这次决策里被排除的模型（没有 Key、不可用）不能当基准", () => {
    const cls = classifyTask({ text: "写一段 Python 快速排序" });
    const top = route({ text: "", classification: cls, preference: "best" }, { availability: all }).primary!.profileId;
    const decision = { classification: cls, excluded: [{ profileId: top, reason: "没有 Key" }] } as unknown as RouteDecision;
    const base = baselineFor(decision, MODEL_PROFILES, all);
    expect(base).not.toBe(top);
    expect(base).toBeTruthy();
  });
});

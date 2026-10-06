// @vitest-environment node
// 回放录制的真实 Jev 回答：tests/fixtures/jev_recorded_*.json，不需要 Key。
// 每个录制文件自带当时的 questions 原文和指纹；问题措辞一改，指纹就对不上，要用 tools/jev-eval.ts --collect 重新采样。
import { createHash } from "node:crypto";
import cases from "./fixtures/routing_cases.json";
import holdoutCases from "./fixtures/routing_cases_holdout.json";
import recorded from "./fixtures/jev_recorded_2026-10-02.json";
import recordedHoldout from "./fixtures/jev_recorded_holdout_2026-10-02.json";
import recordedHoldoutV1 from "./fixtures/jev_recorded_holdout_v1_2026-10-02.json";
import { evaluateChain, type JevSample, type RoutingCase } from "@/decision/eval";
import { CLASSIFY_QUESTIONS, DEFAULT_MIN_CONFIDENCE, VISION_QUESTION } from "@/decision/jev-config";

type Doc = { cases: string; questions: Record<string, string>; questionsSha256: string; samplings: JevSample[][] };
const routing = cases.cases as unknown as RoutingCase[];
const holdout = holdoutCases.cases as unknown as RoutingCase[];
const current = createHash("sha256")
  .update(JSON.stringify({ ...CLASSIFY_QUESTIONS, vision: VISION_QUESTION }))
  .digest("hex");
const sets = (doc: Doc) => doc.samplings as JevSample[][];
const fingerprint = (doc: Doc) => createHash("sha256").update(JSON.stringify(doc.questions)).digest("hex");
const toolUseFp = (list: readonly RoutingCase[], samples: readonly JevSample[]) =>
  new Set(samples.filter((s) => s.probs.tool_use >= 0.5 && !list.find((c) => c.id === s.id)!.expected_capabilities.includes("tool_use")).map((s) => s.id)).size;

describe("录制文件的内部一致性", () => {
  it.each([
    ["50 条", recorded as unknown as Doc],
    ["hold-out", recordedHoldout as unknown as Doc],
    ["hold-out（旧措辞对照）", recordedHoldoutV1 as unknown as Doc],
  ])("%s：questions 与 questionsSha256 对得上，且样例集里每条都有采样", (_, doc) => {
    expect(fingerprint(doc)).toBe(doc.questionsSha256);
    const list = doc.cases === "routing_cases_holdout.json" ? holdout : routing;
    for (const s of sets(doc)) {
      expect(s).toHaveLength(list.length);
      expect(s.map((x) => x.id).sort()).toEqual(list.map((c) => c.id).sort());
    }
  });

  it("生产用的措辞与当前 jev-config.ts 一致（50 条和 hold-out 用的是同一版）", () => {
    expect((recorded as unknown as Doc).questionsSha256).toBe(current);
    expect((recordedHoldout as unknown as Doc).questionsSha256).toBe(current);
  });

  it("旧措辞的对照数据只差 tool_use 一题，便于比较", () => {
    const v1 = (recordedHoldoutV1 as unknown as Doc).questions;
    expect(v1.code).toBe((CLASSIFY_QUESTIONS as Record<string, string>).code);
    expect(v1.vision).toBe(VISION_QUESTION);
    expect(v1.tool_use).not.toBe((CLASSIFY_QUESTIONS as Record<string, string>).tool_use);
  });
});

describe("50 条标注样例（训练集，问题措辞在这一版上定过）", () => {
  it.each([0, 1])("采样 %i：降级 < 10%，整条链准确率 ≥ 95%", (i) => {
    const r = evaluateChain(routing, sets(recorded as unknown as Doc)[i], DEFAULT_MIN_CONFIDENCE);
    expect(r.handed / r.total).toBeLessThan(0.1);
    expect(r.chainOk / r.total).toBeGreaterThanOrEqual(0.95);
  });
});

describe("hold-out（54 条独立盲写，只用来检验）", () => {
  it.each([0, 1])("采样 %i：降级 < 20%，整条链准确率 ≥ 90%，且不劣于规则引擎单独运行", (i) => {
    const r = evaluateChain(holdout, sets(recordedHoldout as unknown as Doc)[i], DEFAULT_MIN_CONFIDENCE);
    expect(r.handed / r.total).toBeLessThan(0.2);
    expect(r.chainOk / r.total).toBeGreaterThanOrEqual(0.9);
    // 规则引擎达到 100% 硬路由准确率时，Jev → 规则链路允许与规则基线持平；
    // 这里验证降级不会把已经正确的规则结果变差，而不是强求云端 Jev 必须再赢一条。
    expect(r.chainOk).toBeGreaterThanOrEqual(r.rulesOk);
  });

  it("v2 措辞把 tool_use 误报从 13 条降到 0 条（旧措辞的数据留作对照）", () => {
    const v1 = sets(recordedHoldoutV1 as unknown as Doc)[0];
    const v2 = sets(recordedHoldout as unknown as Doc)[0];
    expect(toolUseFp(holdout, v1)).toBeGreaterThanOrEqual(10);
    expect(toolUseFp(holdout, v2)).toBe(0);
  });

  it("v2 措辞没有降低整条链准确率", () => {
    const v1 = evaluateChain(holdout, sets(recordedHoldoutV1 as unknown as Doc)[0], DEFAULT_MIN_CONFIDENCE);
    const v2 = evaluateChain(holdout, sets(recordedHoldout as unknown as Doc)[0], DEFAULT_MIN_CONFIDENCE);
    expect(v2.chainOk).toBeGreaterThanOrEqual(v1.chainOk);
  });
});

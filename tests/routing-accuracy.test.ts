// @vitest-environment node
// 路由准确率：50 条独立标注的样例（标注规范见 MEMORY.md「M3 路由测试集」）。
import fixtures from "./fixtures/routing_cases.json";
import holdout from "./fixtures/routing_cases_holdout.json";
import { evaluate, formatReport, type RoutingCase } from "@/decision/eval";
import { CAPABILITIES, TASK_TYPES, typeFromCapabilities } from "@/decision/types";

const cases = fixtures.cases as unknown as RoutingCase[];
const holdoutCases = holdout.cases as unknown as RoutingCase[];

describe("路由准确率测试集", () => {
  it("50 条样例，覆盖 6 种任务类型和 3 种语言，标注自洽", () => {
    expect(cases).toHaveLength(50);
    expect(new Set(cases.map((c) => c.id)).size).toBe(50);
    for (const t of TASK_TYPES) {
      for (const lang of ["zh", "en", "mixed"]) expect(cases.some((c) => c.expected_type === t && c.lang === lang)).toBe(true);
    }
    for (const c of cases) {
      expect(c.expected_capabilities.every((x) => CAPABILITIES.includes(x))).toBe(true);
      expect(typeFromCapabilities(c.expected_capabilities)).toBe(c.expected_type);
    }
  });

  it("规则引擎（第 3 级）路由准确率 ≥ 70%（M3 目标；接入 Jev 后目标 85%）", () => {
    const report = evaluate(cases);
    console.log(`\n${formatReport(report)}\n`);
    expect(report.routingAccuracy).toBeGreaterThanOrEqual(0.7);
  });
});

describe("hold-out 样例集（独立盲写，只用来检验，不要拿来调规则或问题措辞）", () => {
  it("54 条，6 种类型各 9 条、3 种语言各 3 条，标注自洽", () => {
    expect(holdoutCases).toHaveLength(54);
    expect(new Set(holdoutCases.map((c) => c.id)).size).toBe(54);
    for (const t of TASK_TYPES) {
      for (const lang of ["zh", "en", "mixed"]) expect(holdoutCases.filter((c) => c.expected_type === t && c.lang === lang)).toHaveLength(3);
    }
    for (const c of holdoutCases) {
      expect(c.expected_capabilities.every((x) => CAPABILITIES.includes(x))).toBe(true);
      expect(typeFromCapabilities(c.expected_capabilities)).toBe(c.expected_type);
      expect(c.expected_capabilities.includes("zh")).toBe(c.lang !== "en");
    }
  });
});

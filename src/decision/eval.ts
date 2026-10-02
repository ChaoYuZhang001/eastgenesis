// 路由准确率评估：用标注样例集（tests/fixtures/routing_cases.json）衡量任务分类。
import { classificationFromProbs } from "./classification";
import { classifyTask } from "./rules";
import {
  CAPABILITIES,
  HARD_CAPS,
  TASK_TYPES,
  sortCaps,
  type Attachment,
  type Capability,
  type Classification,
  type Lang,
  type TaskInput,
  type TaskType,
} from "./types";

export interface RoutingCase {
  id: string;
  input: string;
  lang: Lang;
  attachments?: Attachment[];
  expected_type: TaskType;
  expected_capabilities: Capability[];
}

export interface CapStat {
  tp: number;
  fp: number;
  fn: number;
  precision: number;
  recall: number;
}

export interface EvalReport {
  total: number;
  /** 主类型正确的比例 */
  typeAccuracy: number;
  /** 路由准确率：主类型正确，且硬性能力（vision / long_context / tool_use）完全一致。它决定能否选到有资格的模型 */
  routingAccuracy: number;
  /** 严格准确率：主类型正确，且全部能力标签完全一致 */
  strictAccuracy: number;
  byType: Record<TaskType, { total: number; correct: number }>;
  perCapability: Record<Capability, CapStat>;
  failures: { id: string; expected: string; got: string }[];
}

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x));
const hardOf = (caps: readonly Capability[]) => caps.filter((c) => HARD_CAPS.includes(c));
const ratio = (n: number, d: number) => (d === 0 ? 1 : n / d);

/** 路由是否正确：主类型一致，且硬性能力（vision / long_context / tool_use）完全一致 */
export function routeCorrect(got: Classification, c: RoutingCase): boolean {
  return got.type === c.expected_type && sameSet(hardOf(got.capabilities), hardOf(sortCaps(c.expected_capabilities)));
}

export function evaluate(
  cases: readonly RoutingCase[],
  classify: (input: TaskInput) => Classification = classifyTask,
): EvalReport {
  const byType = Object.fromEntries(TASK_TYPES.map((t) => [t, { total: 0, correct: 0 }])) as EvalReport["byType"];
  const counts = Object.fromEntries(CAPABILITIES.map((c) => [c, { tp: 0, fp: 0, fn: 0 }])) as Record<
    Capability,
    { tp: number; fp: number; fn: number }
  >;
  let typeOk = 0;
  let routeOk = 0;
  let strictOk = 0;
  const failures: EvalReport["failures"] = [];

  for (const c of cases) {
    const got = classify({ text: c.input, attachments: c.attachments });
    const expected = sortCaps(c.expected_capabilities);
    const t = got.type === c.expected_type;
    const r = routeCorrect(got, c);
    const s = t && sameSet(got.capabilities, expected);
    typeOk += Number(t);
    routeOk += Number(r);
    strictOk += Number(s);
    byType[c.expected_type].total++;
    if (r) byType[c.expected_type].correct++;
    for (const cap of CAPABILITIES) {
      const e = expected.includes(cap);
      const g = got.capabilities.includes(cap);
      if (e && g) counts[cap].tp++;
      else if (g) counts[cap].fp++;
      else if (e) counts[cap].fn++;
    }
    if (!r) {
      failures.push({
        id: c.id,
        expected: `${c.expected_type} [${expected.join(",")}]`,
        got: `${got.type} [${got.capabilities.join(",")}]`,
      });
    }
  }

  const perCapability = Object.fromEntries(
    CAPABILITIES.map((c) => {
      const { tp, fp, fn } = counts[c];
      return [c, { tp, fp, fn, precision: ratio(tp, tp + fp), recall: ratio(tp, tp + fn) }];
    }),
  ) as Record<Capability, CapStat>;

  const n = cases.length;
  return {
    total: n,
    typeAccuracy: ratio(typeOk, n),
    routingAccuracy: ratio(routeOk, n),
    strictAccuracy: ratio(strictOk, n),
    byType,
    perCapability,
    failures,
  };
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

export interface JevSample {
  id: string;
  /** 能力 → Jev 回答「需要它」的概率 */
  probs: Record<string, number>;
}

export type ChainErrorKind = "hard_extra" | "hard_missing" | "type_mismatch" | null;

export interface ChainReport {
  total: number;
  rulesOk: number;
  jevOk: number;
  /** 置信度低于阈值、交给规则引擎的条数；其中 Jev 本来也对的、规则引擎对的条数 */
  handed: number;
  handedJevOk: number;
  handedRulesOk: number;
  /** 留用 Jev 的条数；其中 Jev 错的条数 */
  kept: number;
  keptWrong: number;
  /** Jev → 规则引擎整条链路由正确的条数 */
  chainOk: number;
  outcomes: { id: string; confidence: number; handed: boolean; jevOk: boolean; rulesOk: boolean; error: ChainErrorKind; by: "jev" | "rules" }[];
}

export interface CapStat2 {
  tp: number;
  fp: number;
  fn: number;
  /** 期望里没有、Jev 也没判——算「没有误报」的分母 */
  tn: number;
}

/** 按样例统计某个能力标签的命中/误报/漏报（取自 Jev 的概率 ≥ 0.5 的判断，与「是否被降级」无关） */
export function capabilityStats(cases: readonly RoutingCase[], samples: readonly JevSample[]): Record<string, CapStat2> {
  const byId = new Map(cases.map((c) => [c.id, c]));
  const out: Record<string, CapStat2> = {};
  const bump = (k: string) => (out[k] ??= { tp: 0, fp: 0, fn: 0, tn: 0 });
  for (const s of samples) {
    const c = byId.get(s.id);
    if (!c) throw new Error(`样例集里没有 ${s.id}`);
    const expected = new Set(sortCaps(c.expected_capabilities));
    for (const k of Object.keys(s.probs)) {
      const e = expected.has(k as Capability);
      const g = s.probs[k] >= 0.5;
      const n = bump(k);
      if (e && g) n.tp++;
      else if (e) n.fn++;
      else if (g) n.fp++;
      else n.tn++;
    }
  }
  return out;
}

const errKind = (got: Classification, c: RoutingCase): ChainErrorKind => {
  if (routeCorrect(got, c)) return null;
  const want = hardOf(sortCaps(c.expected_capabilities));
  const have = hardOf(got.capabilities);
  const extra = have.find((x) => !want.includes(x));
  if (extra) return "hard_extra";
  const missing = want.find((x) => !have.includes(x));
  if (missing) return "hard_missing";
  return "type_mismatch";
};

/** 用录制的 Jev 回答回放「Jev → 规则引擎」两级链；confidenceOf 默认用产品的置信度，也可换成别的算法做对照 */
export function evaluateChain(
  cases: readonly RoutingCase[],
  samples: readonly JevSample[],
  threshold: number,
  confidenceOf: (probs: Record<string, number>, jev: Classification) => number = (_probs, jev) => jev.confidence,
): ChainReport {
  const byId = new Map(cases.map((c) => [c.id, c]));
  const r: ChainReport = { total: samples.length, rulesOk: 0, jevOk: 0, handed: 0, handedJevOk: 0, handedRulesOk: 0, kept: 0, keptWrong: 0, chainOk: 0, outcomes: [] };
  for (const s of samples) {
    const c = byId.get(s.id);
    if (!c) throw new Error(`样例集里没有 ${s.id}`);
    const input = { text: c.input, attachments: c.attachments };
    const jev = classificationFromProbs(input, s.probs, "Jev");
    const confidence = confidenceOf(s.probs, jev);
    const handed = confidence < threshold;
    const jevOk = routeCorrect(jev, c);
    const rulesOk = routeCorrect(classifyTask(input), c);
    r.rulesOk += Number(rulesOk);
    r.jevOk += Number(jevOk);
    if (handed) {
      r.handed++;
      r.handedJevOk += Number(jevOk);
      r.handedRulesOk += Number(rulesOk);
    } else {
      r.kept++;
      r.keptWrong += Number(!jevOk);
    }
    r.chainOk += Number(handed ? rulesOk : jevOk);
    r.outcomes.push({ id: s.id, confidence, handed, jevOk, rulesOk, error: errKind(jev, c), by: handed ? "rules" : "jev" });
  }
  return r;
}

export function formatReport(r: EvalReport, opts: { failures?: boolean } = {}): string {
  const lines = [
    `样例数：${r.total}`,
    `路由准确率（主类型 + 硬性能力）：${pct(r.routingAccuracy)}`,
    `主类型准确率：${pct(r.typeAccuracy)}`,
    `严格准确率（全部标签）：${pct(r.strictAccuracy)}`,
    `按类型：${TASK_TYPES.map((t) => `${t} ${r.byType[t].correct}/${r.byType[t].total}`).join(" · ")}`,
    `能力标签 P/R：${CAPABILITIES.map((c) => `${c} ${r.perCapability[c].precision.toFixed(2)}/${r.perCapability[c].recall.toFixed(2)}`).join(" · ")}`,
  ];
  if (opts.failures) for (const f of r.failures) lines.push(`  ✗ ${f.id}：期望 ${f.expected}，得到 ${f.got}`);
  return lines.join("\n");
}

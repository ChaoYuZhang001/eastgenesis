// 路由记录：把路由决策和模型调用事件整理成给用户看的说明。
// 只用自然语言，不出现内部评分和成本档位（那些只在专家模式的路由面板里展示）。
import type { AgentEvent, LlmFallback } from "@/agent";
import { CAP_LABEL, HARD_CAPS, TYPE_LABEL, type ChainEntry, type DecisionMeta, type RouteDecision } from "@/decision";

/** 展示用的模型名：去掉自定义 Provider 的 custom: 前缀，其余原样（provider/model） */
export const displayModel = (id: string) => id.replace(/^custom:/, "");

export interface RouteCandidate {
  profileId: string;
  stage: ChainEntry["stage"];
  /** 为什么排这个位置，自然语言 */
  why: string;
}

/** 一次降级：从哪个模型换到哪个模型，为什么；同样的降级重复出现时合并计数 */
export interface FallbackStep {
  from: string;
  to: string;
  reason: string;
  times: number;
  /** 因为超时才换的模型：中转站延迟波动大，要让用户一眼看出是「慢」而不是「坏」 */
  timeout: boolean;
}

/** 降级的动因：超时单独点出来，其余统称降级（具体原因在括号里） */
export const fallbackVerb = (f: Pick<FallbackStep, "timeout">) => (f.timeout ? "因超时降级到" : "降级到");

export interface RouteSummary {
  /** 实际用上的模型（最后一次成功调用）；一次都没成功时为 null */
  used: string | null;
  /** 这次任务用过的所有模型，按首次使用排序 */
  models: string[];
  calls: number;
  tokens: number;
  /** 手动锁定的模型（输入框或专家模式的手动干预） */
  locked: boolean;
  candidates: RouteCandidate[];
  fallbacks: FallbackStep[];
  /** 超时后对同一个模型重试的总次数 */
  retries: number;
  /** 全链失败时每个模型的失败原因 */
  failures: LlmFallback[];
  taskType: string;
  /** 硬性要求的能力 */
  needs: string[];
  /** 没有可用模型时的说明 */
  noModel: string | null;
}

/** 候选模型的原因：给用户看的人话，不提评分、Provider、规则这些内部概念（路由器自己的原因只在专家模式的路由面板里） */
export const CANDIDATE_WHY = {
  primary: "综合能力最强，匹配当前任务",
  diverse: "不同厂商，主模型故障时备用",
  sameProvider: "同厂商次优，最后兜底",
  ruleFallback: "本地模型优先，最省钱",
  /** 兜底选到的不是本机模型：只是「剩下的模型里最后一个兜底」，不能说它省钱（可能正好最贵） */
  ruleFallbackCloud: "前面都失败时的最后兜底",
} as const;

function candidateWhy(e: ChainEntry): string {
  if (e.reason === "手动锁定") return "你手动锁定了这个模型";
  if (e.reason === "用户锁定" || e.reason === "用户指定下一步") return `手动干预：${e.reason}`;
  if (e.stage === "primary") return CANDIDATE_WHY.primary;
  // 规则兜底优先本机模型；没有可用的本机模型时排到的是剩下的云端模型，这时不说「省钱」
  if (e.stage === "rule_fallback") return e.provider === "ollama" ? CANDIDATE_WHY.ruleFallback : CANDIDATE_WHY.ruleFallbackCloud;
  return e.reason.startsWith("同一 Provider") ? CANDIDATE_WHY.sameProvider : CANDIDATE_WHY.diverse;
}

/** 归并同类降级：把「连续失败 3 次」里的数字抹平，重复的只算一次并计数 */
const dedupeKey = (from: string, to: string, reason: string) => `${from}→${to}|${reason.replace(/\d+/g, "#")}`;

/** 展开所有模型调用事件（含子 Agent） */
function llmEvents(events: readonly AgentEvent[]): AgentEvent[] {
  return events.map((e) => (e.type === "subagent" ? e.event : e)).filter((e) => e.type === "llm" || e.type === "llm_failed");
}

/**
 * 汇总一次任务的路由记录。route 是任务开始时的路由事件，events 是完整事件流
 * （多 Agent 协同时子 Agent 各自路由，这里合并统计实际用过的模型和降级）。
 */
export function routeSummary(
  route: { decision: RouteDecision; meta: DecisionMeta } | null,
  events: readonly AgentEvent[],
): RouteSummary | null {
  if (!route) return null;
  const { decision: d } = route;
  const c = d.classification;
  const models: string[] = [];
  const steps = new Map<string, FallbackStep>();
  let used: string | null = null;
  let calls = 0;
  let tokens = 0;
  let retries = 0;
  let failures: LlmFallback[] = [];

  for (const e of llmEvents(events)) {
    if (e.type === "llm") {
      calls++;
      used = e.profileId;
      if (!models.includes(e.profileId)) models.push(e.profileId);
      tokens += e.usage ? e.usage.inputTokens + e.usage.outputTokens : 0;
      retries += e.retries ?? 0;
      // fallbacks 是这次调用里排在前面、没用上的模型：依次记成 a→b、b→最终模型
      const chain: LlmFallback[] = [...(e.fallbacks ?? []), { profileId: e.profileId, reason: "" }];
      for (let i = 0; i < chain.length - 1; i++) {
        const from = chain[i];
        const to = chain[i + 1];
        const k = dedupeKey(from.profileId, to.profileId, from.reason);
        const hit = steps.get(k);
        if (hit) hit.times++;
        else steps.set(k, { from: from.profileId, to: to.profileId, reason: from.reason, times: 1, timeout: from.code === "timeout" });
      }
    } else if (e.type === "llm_failed") {
      retries += e.retries ?? 0;
      failures = e.attempts;
      for (const a of e.attempts) if (!models.includes(a.profileId)) models.push(a.profileId);
    }
  }

  const hard = c.capabilities.filter((x) => HARD_CAPS.includes(x));
  return {
    used,
    models,
    calls,
    tokens,
    locked: d.chain.length === 1 && d.chain[0]?.reason === "手动锁定",
    candidates: d.chain.map((e) => ({ profileId: e.profileId, stage: e.stage, why: candidateWhy(e) })),
    fallbacks: [...steps.values()],
    retries,
    failures,
    taskType: TYPE_LABEL[c.type] ?? c.type,
    needs: hard.map((x) => CAP_LABEL[x] ?? x),
    noModel: d.chain.length === 0 ? (d.reasons.at(-1) ?? "全部模型都被排除") : null,
  };
}

/** 1234 → 1.2k；给「成本」一栏用（没有价格表，用 token 数代替） */
export function formatTokens(n: number): string {
  if (n <= 0) return "token 数未知";
  if (n < 1000) return `${n} tokens`;
  return `${(n / 1000).toFixed(1)}k tokens`;
}

/** 12400 → 12.4s；90000 → 1 分 30 秒 */
export function formatDuration(ms: number): string {
  if (ms < 0) return "0.0s";
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
}

/**
 * 折叠状态那一行的文字（docs/UI_LAYOUT_V3.md 5.2）：「使用 X · 省 $0.12」「手动锁定 X」，有降级时接上降级说明。
 * 耗时和 tokens 不在这一行，放在浮层的「执行过程」里。saved 是 savings.ts 的 savedText，没有可计价的调用时不写
 */
export function routeLineText(s: RouteSummary, saved: string | null = null): string {
  const parts: string[] = [];
  if (s.used) {
    const more = s.models.length > 1 ? `（共 ${s.models.length} 个模型）` : "";
    parts.push(s.locked ? `手动锁定 ${displayModel(s.used)}` : `使用 ${displayModel(s.used)}${more}`);
  } else if (s.failures.length) parts.push(`${s.failures.length} 个模型都没有成功`);
  else if (s.noModel) parts.push("没有可用模型");
  else parts.push(`准备使用 ${displayModel(s.candidates[0]?.profileId ?? "")}`);
  if (saved) parts.push(saved);
  if (s.fallbacks.length) {
    const total = s.fallbacks.reduce((n, f) => n + f.times, 0);
    const slow = s.fallbacks.filter((f) => f.timeout).reduce((n, f) => n + f.times, 0);
    // 折叠状态也要看得出是超时：全部因超时就直说，部分因超时标出次数
    parts.push(slow === total ? `因超时降级 ${total} 次` : slow ? `降级 ${total} 次（${slow} 次因超时）` : `降级 ${total} 次`);
  }
  return parts.join(" · ");
}

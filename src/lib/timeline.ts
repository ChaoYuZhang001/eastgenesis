// 把 Agent 事件整理成执行时间线：任务分析 → 路由决策 → 工具调用 → 模型输出 → 反思。
// 只做展示层的转换，事件本身在运行时已经脱敏。
import type { AgentEvent } from "@/agent";
import { TYPE_LABEL, type BackendName, type ModelProfile } from "@/decision";
import { KIND_LABEL } from "./memory";
import { PURPOSE_LABEL } from "./purpose";

export type Stage = "analysis" | "routing" | "tool" | "model" | "reflect" | "done";
export type Tone = "neutral" | "ok" | "warn" | "error";

export const STAGE_LABEL: Record<Stage, string> = {
  analysis: "任务分析",
  routing: "路由决策",
  tool: "工具调用",
  model: "模型输出",
  reflect: "反思",
  done: "完成",
};

export const BACKEND_LABEL: Record<BackendName, string> = {
  "cloud-jev": "Jev 云端",
  "local-jev": "本地 Jev",
  rules: "规则引擎",
};

export const STATUS_LABEL: Record<string, string> = {
  running: "进行中",
  completed: "已完成",
  failed: "失败",
  aborted: "已停止",
  needs_user: "需要用户处理",
  budget_exceeded: "超出预算",
};

export interface TimelineItem {
  key: string;
  stage: Stage;
  title: string;
  detail?: string;
  tone: Tone;
  /** 模型输出：用了哪个模型、成本档位 */
  profileId?: string;
  costTier?: number;
  tokens?: number;
  latencyMs?: number;
}

/** 子 Agent 的这些事件不单独列出：开始由拆分说明，记忆和技能在任务开头已列出 */
const NESTED_SKIP = new Set<AgentEvent["type"]>(["run_start", "memory", "skill"]);

export function toTimeline(events: readonly AgentEvent[], profiles: readonly ModelProfile[]): TimelineItem[] {
  const roles = new Map<string, string>();
  for (const e of events) if (e.type === "split") for (const a of e.agents) roles.set(a.id, a.role);
  return events.flatMap((e, i) => itemsFor(e, `${i}`, profiles, roles));
}

function itemsFor(e: AgentEvent, idx: string, profiles: readonly ModelProfile[], roles: ReadonlyMap<string, string>): TimelineItem[] {
  const tier = (id: string) => profiles.find((p) => p.id === id)?.cost_tier;
  const key = `${idx}-${e.type}`;
  switch (e.type) {
    case "run_start":
      return [{ key, stage: "analysis", title: "开始分析任务", detail: e.goal, tone: "neutral" }];
    case "skill":
      return [{ key, stage: "analysis", title: `参考了 ${e.items.length} 个技能`, detail: e.items.map((s) => `「${s.name}」`).join("、"), tone: "neutral" }];
    case "memory":
      return [{ key, stage: "analysis", title: `参考了 ${e.items.length} 条记忆`, detail: e.items.map((m) => `${KIND_LABEL[m.kind]}：${m.text}`).join("；"), tone: "neutral" }];
    case "route": {
      const c = e.decision.classification;
      const analysis: TimelineItem = {
        key: `${key}-cls`,
        stage: "analysis",
        title: `任务类型：${TYPE_LABEL[c.type] ?? c.type}`,
        detail: `由${BACKEND_LABEL[e.meta.backend]}判断${e.meta.degraded ? "（已降级）" : ""}`,
        tone: e.meta.degraded ? "warn" : "neutral",
      };
      const routing: TimelineItem = e.profileId
        ? { key, stage: "routing", title: `选择 ${e.profileId}`, detail: e.decision.primary?.reason, tone: "ok", profileId: e.profileId, costTier: tier(e.profileId) }
        : { key, stage: "routing", title: "没有可用模型", detail: e.reasons.at(-1), tone: "error" };
      return [analysis, routing];
    }
    case "plan":
      return [{ key, stage: "analysis", title: e.revision ? `重新规划（第 ${e.revision} 次）` : `规划 ${e.plan.steps.length} 个步骤`, detail: e.plan.note, tone: e.revision ? "warn" : "neutral" }];
    case "step_start":
      return e.step.tool ? [] : [{ key, stage: "model", title: `步骤：${e.step.goal}`, detail: e.attempt > 1 ? `第 ${e.attempt} 次尝试` : undefined, tone: "neutral" }];
    case "gate":
      return [{ key, stage: "tool", title: `${e.step.tool}：${e.verdict === "allow" ? "允许" : e.verdict === "confirm" ? "需要确认" : "拒绝"}`, detail: e.reasons.join("；"), tone: e.verdict === "deny" ? "error" : e.verdict === "confirm" ? "warn" : "ok" }];
    case "confirm":
      return [{ key, stage: "tool", title: e.approved ? "用户已批准" : "用户已拒绝", tone: e.approved ? "ok" : "error" }];
    case "plan_review":
      return [{ key, stage: "analysis", title: e.approved ? "你批准了这个计划" : "你取消了这个计划", tone: e.approved ? "ok" : "warn" }];
    case "tool_result":
      return [{ key, stage: "tool", title: `${e.step.tool} ${e.ok ? "完成" : "出错"}`, detail: e.content.slice(0, 300), tone: e.ok ? "ok" : "error", latencyMs: e.latencyMs }];
    case "llm":
      return [{
        key,
        stage: "model",
        title: `${PURPOSE_LABEL[e.purpose]} · ${e.profileId}`,
        // 降级过就写明先试了谁、为什么没用上，以及最后落在哪个模型上（不写「本模型」）
        ...(e.fallbacks?.length
          ? {
              // 超时单独点明：中转站慢和模型坏是两回事，用户要知道是哪一种
              detail: `${e.fallbacks.some((f) => f.code === "timeout") ? "因超时降级" : "已降级"}：先试 ${e.fallbacks.map((f) => `${f.profileId}（${f.reason}）`).join("、")}，降级到 ${e.profileId}`,
            }
          : {}),
        tone: e.fallbacks?.length ? "warn" : "neutral",
        profileId: e.profileId,
        costTier: tier(e.profileId),
        tokens: e.usage ? e.usage.inputTokens + e.usage.outputTokens : undefined,
        latencyMs: e.latencyMs,
      }];
    case "llm_failed":
      return [{
        key,
        stage: "model",
        title: `${PURPOSE_LABEL[e.purpose]} · 降级链上的 ${e.attempts.length} 个模型都没有成功`,
        detail: e.attempts.map((f) => `${f.profileId}（${f.reason}）`).join("、"),
        tone: "error",
      }];
    case "reflect":
      return [{ key, stage: "reflect", title: e.done ? "子目标已达成" : "子目标未达成", detail: `评分 ${e.score.toFixed(2)} · ${BACKEND_LABEL[e.backend]}`, tone: e.done ? "ok" : "warn" }];
    case "recover":
      return [{ key, stage: "reflect", title: `恢复策略：${e.strategy}`, detail: e.error.slice(0, 200), tone: "warn" }];
    case "run_end":
      return [{ key, stage: "done", title: STATUS_LABEL[e.status] ?? e.status, detail: e.summary.slice(0, 300), tone: e.status === "completed" ? "ok" : "error" }];
    case "split":
      return [{ key, stage: "analysis", title: `拆分为 ${e.agents.length} 个子 Agent`, detail: [e.note, ...e.agents.map((a) => `${a.role}：${a.goal}`)].filter(Boolean).join("；"), tone: e.note ? "warn" : "neutral" }];
    case "subagent": {
      if (NESTED_SKIP.has(e.event.type)) return [];
      const role = roles.get(e.agent) ?? e.agent;
      // 子 Agent 结束不代表整个任务完成，归到「反思」阶段
      return itemsFor(e.event, `${idx}.${e.agent}`, profiles, roles).map((it) => ({ ...it, key: `${key}-${it.key}`, title: `「${role}」${it.title}`, stage: it.stage === "done" ? "reflect" : it.stage }));
    }
    default:
      return [];
  }
}

/** 最近一次路由事件，供路由面板展示候选链和排除原因 */
export function lastRoute(events: readonly AgentEvent[]) {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === "route") return e;
  }
  return null;
}

/** 已用模型调用的 token 合计与成本档位（没有真实价格表，只展示档位和 token） */
export function usageTotals(events: readonly AgentEvent[]) {
  let calls = 0;
  let tokens = 0;
  for (const outer of events) {
    // 多 Agent 协同时子 Agent 的模型调用也计入
    const e = outer.type === "subagent" ? outer.event : outer;
    if (e.type !== "llm") continue;
    calls++;
    tokens += e.usage ? e.usage.inputTokens + e.usage.outputTokens : 0;
  }
  return { calls, tokens };
}

// 把 Agent 事件整理成执行时间线：任务分析 → 路由决策 → 工具调用 → 模型输出 → 反思。
// 只做展示层的转换，事件本身在运行时已经脱敏。
import type { AgentEvent } from "@/agent";
import { TYPE_LABEL, WORK_SURFACE_LABEL, type BackendName, type ModelProfile } from "@/decision";
import { KIND_LABEL } from "./memory";
import { PURPOSE_LABEL } from "./purpose";
import { routeFailureText, splitLlmAttempts } from "./route-summary";

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
      const surface = c.surface ? ` · ${WORK_SURFACE_LABEL[c.surface]}` : "";
      const analysis: TimelineItem = {
        key: `${key}-cls`,
        stage: "analysis",
        title: `任务类型：${TYPE_LABEL[c.type] ?? c.type}${surface}`,
        detail: `由${BACKEND_LABEL[e.meta.backend]}判断${e.meta.degraded ? "（已降级）" : ""}${c.surfaceReason ? `；${c.surfaceReason}` : ""}`,
        tone: e.meta.degraded ? "warn" : "neutral",
      };
      const routing: TimelineItem = e.profileId
        ? { key, stage: "routing", title: `选择 ${e.profileId}`, detail: e.decision.primary?.reason, tone: "ok", profileId: e.profileId, costTier: tier(e.profileId) }
        : { key, stage: "routing", title: "没有可用模型", detail: e.reasons.at(-1), tone: "error" };
      return [analysis, routing];
    }
    case "step_route": {
      const surface = e.surface ? WORK_SURFACE_LABEL[e.surface] : WORK_SURFACE_LABEL[e.decision.classification.surface ?? "chat"];
      const analysis: TimelineItem = {
        key: `${key}-surface`,
        stage: "analysis",
        title: `步骤能力：${surface}`,
        detail: [`步骤：${e.step.goal}`, e.surfaceReason ?? e.decision.classification.surfaceReason ?? ""].filter(Boolean).join("；"),
        tone: e.meta.degraded ? "warn" : "neutral",
      };
      const routing: TimelineItem = e.profileId
        ? { key, stage: "routing", title: `步骤选择 ${e.profileId}`, detail: e.decision.primary?.reason, tone: e.meta.degraded ? "warn" : "ok", profileId: e.profileId, costTier: tier(e.profileId) }
        : { key, stage: "routing", title: "这一步没有可用模型", detail: e.reasons.at(-1), tone: "error" };
      return [analysis, routing];
    }
    case "plan":
      return [{ key, stage: "analysis", title: e.revision ? `重新规划（第 ${e.revision} 次）` : `规划 ${e.plan.steps.length} 个步骤`, detail: e.plan.note, tone: e.revision ? "warn" : "neutral" }];
    case "step_start": {
      // 旧事件没有能力面字段，继续隐藏工具步骤以兼容历史时间线；新事件把
      // 能力面作为执行证据展示出来，用户可以看到一次任务如何跨 Chat/Work/Codex。
      if (e.step.tool && !e.surface) return [];
      return [{
        key,
        stage: e.step.tool ? "tool" : "model",
        title: `步骤：${e.step.goal}`,
        detail: [
          e.surface ? `工作能力：${WORK_SURFACE_LABEL[e.surface]}` : "",
          e.surfaceReason ?? "",
          e.attempt > 1 ? `第 ${e.attempt} 次尝试` : "",
        ].filter(Boolean).join("；") || undefined,
        tone: "neutral",
      }];
    }
    case "probe":
      return [{
        key,
        stage: "tool",
        title: `恢复前探测：${e.state === "applied" ? "已生效" : e.state === "not_applied" ? "未生效" : e.state === "conflict" ? "发现冲突" : "仍未知"}`,
        detail: `${e.step.tool ?? "工具"}：${e.detail.slice(0, 300)}`,
        tone: e.state === "applied" ? "ok" : e.state === "conflict" || e.state === "unknown" ? "error" : "warn",
      }];
    case "gate":
      return [{ key, stage: "tool", title: `${e.step.tool}：${e.verdict === "allow" ? "允许" : e.verdict === "confirm" ? "需要确认" : "拒绝"}`, detail: e.reasons.join("；"), tone: e.verdict === "deny" ? "error" : e.verdict === "confirm" ? "warn" : "ok" }];
    case "confirm":
      return [{ key, stage: "tool", title: e.approved ? "用户已批准" : "用户已拒绝", tone: e.approved ? "ok" : "error" }];
    case "plan_review":
      return [{ key, stage: "analysis", title: e.approved ? "你批准了这个计划" : "你取消了这个计划", tone: e.approved ? "ok" : "warn" }];
    case "tool_result":
      return [{ key, stage: "tool", title: `${e.step.tool} ${e.ok ? "完成" : "出错"}`, detail: e.content.slice(0, 300), tone: e.ok ? "ok" : "error", latencyMs: e.latencyMs }];
    case "llm": {
      const { called, skipped } = splitLlmAttempts(e.fallbacks ?? []);
      const detail = [
        called.length ? `${called.some((f) => f.code === "timeout") ? "因超时降级" : "已降级"}：先试 ${called.map((f) => `${f.profileId}（${f.reason}）`).join("、")}，降级到 ${e.profileId}` : "",
        skipped.length ? `已跳过（未调用）：${skipped.map((f) => `${f.profileId}（${f.reason}）`).join("、")}` : "",
        skipped.length && !called.length ? `最终使用 ${e.profileId}` : "",
      ].filter(Boolean).join("；");
      return [{
        key,
        stage: "model",
        title: `${PURPOSE_LABEL[e.purpose]} · ${e.profileId}`,
        ...(detail ? { detail } : {}),
        tone: e.fallbacks?.length ? "warn" : "neutral",
        profileId: e.profileId,
        costTier: tier(e.profileId),
        tokens: e.usage ? e.usage.inputTokens + e.usage.outputTokens : undefined,
        latencyMs: e.latencyMs,
      }];
    }
    case "llm_failed": {
      const { called, skipped } = splitLlmAttempts(e.attempts);
      const title = routeFailureText({ failures: called, failureSkipped: skipped, failurePartialOutput: e.partialOutput === true }) ?? "没有发起模型调用";
      const detail = [
        e.partialOutput ? "已保留部分输出，为避免拼接不同模型的回答，本次停止自动降级。" : "",
        called.length ? `失败：${called.map((f) => `${f.profileId}（${f.reason}）`).join("、")}` : "",
        skipped.length ? `已跳过（未调用）：${skipped.map((f) => `${f.profileId}（${f.reason}）`).join("、")}` : "",
      ].filter(Boolean).join("；");
      return [{
        key,
        stage: "model",
        title: `${PURPOSE_LABEL[e.purpose]} · ${title}`,
        ...(detail ? { detail } : {}),
        tone: "error",
      }];
    }
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

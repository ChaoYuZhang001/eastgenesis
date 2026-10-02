// 多 Agent 协同的展示数据：从协调器的事件里还原每个子 Agent 的角色、状态、模型和当前步骤。
import type { AgentEvent, RunStatus } from "@/agent";
import type { StepState, StepView } from "./steps";

export type SubAgentStatus = "pending" | "running" | RunStatus;

export interface SubAgentView {
  id: string;
  role: string;
  goal: string;
  status: SubAgentStatus;
  /** 最近一次实际使用的模型（降级后以模型调用为准） */
  profileId: string | null;
  step: string | null;
}

export function subAgentViews(events: readonly AgentEvent[]): SubAgentView[] {
  const split = events.find((e) => e.type === "split");
  if (!split || split.type !== "split") return [];
  const views = new Map<string, SubAgentView>();
  for (const a of split.agents) views.set(a.id, { id: a.id, role: a.role, goal: a.goal, status: "pending", profileId: null, step: null });
  for (const e of events) {
    if (e.type !== "subagent") continue;
    const v = views.get(e.agent);
    const x = e.event;
    if (!v) continue;
    if (x.type === "run_start") v.status = "running";
    else if (x.type === "route" || x.type === "llm") v.profileId = x.profileId ?? v.profileId;
    else if (x.type === "step_start") v.step = x.step.goal;
    else if (x.type === "run_end") {
      v.status = x.status;
      v.step = null;
    }
  }
  return [...views.values()];
}

const STATE: Record<SubAgentStatus, StepState> = { pending: "pending", running: "running", completed: "done", failed: "failed", aborted: "failed", needs_user: "failed", budget_exceeded: "failed" };

/** 任务卡片的步骤列表：多 Agent 协同时每个子 Agent 一行（角色：子任务，模型） */
export function subAgentSteps(agents: readonly SubAgentView[]): StepView[] {
  return agents.map((a) => ({ id: a.id, goal: `${a.role}：${a.goal}`, tool: a.profileId, state: STATE[a.status] }));
}

/** 最前面的几条（开始、记忆、路由、拆分）总是保留，其余只留最新的 */
const HEAD = 12;
export function appendEvent(list: readonly AgentEvent[], e: AgentEvent, max: number): AgentEvent[] {
  const next = [...list, e];
  return next.length <= max ? next : [...next.slice(0, HEAD), ...next.slice(next.length - (max - HEAD))];
}

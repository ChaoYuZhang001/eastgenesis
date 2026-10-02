// 任务卡片的步骤进度：从当前计划和执行事件算出每一步的状态。
import type { AgentEvent } from "@/agent";

export type StepState = "pending" | "running" | "done" | "failed";
export interface StepView {
  id: string;
  goal: string;
  tool: string | null;
  state: StepState;
}

/** 当前计划（取最后一次 plan 事件）每一步的进度，给任务卡片展示 */
export function stepProgress(events: readonly AgentEvent[]): StepView[] {
  let steps: StepView[] = [];
  const state = new Map<string, StepState>();
  let recovered: string | null = null;
  for (const e of events) {
    if (e.type === "plan") steps = e.plan.steps.map((s) => ({ id: s.id, goal: s.goal, tool: s.tool, state: "pending" }));
    else if (e.type === "recover") {
      recovered = e.step.id;
      state.set(e.step.id, "failed");
    } else if (e.type === "step_start") {
      // modify_step 会换掉当前步骤但不发新的 plan 事件：用新步骤替换刚失败的那一步
      const s = e.step;
      if (recovered && !steps.some((x) => x.id === s.id)) steps = steps.map((x) => (x.id === recovered ? { id: s.id, goal: s.goal, tool: s.tool, state: "pending" } : x));
      state.set(s.id, "running");
    } else if (e.type === "tool_result") state.set(e.step.id, e.ok ? "done" : "failed");
    else if (e.type === "confirm" && !e.approved) state.set(e.step.id, "failed");
    else if (e.type === "gate" && e.verdict === "deny") state.set(e.step.id, "failed");
    else if (e.type === "reflect" && e.step && state.get(e.step.id) === "running") state.set(e.step.id, "done");
    else if (e.type === "run_end") for (const [id, s] of state) if (s === "running") state.set(id, e.status === "completed" ? "done" : "failed");
  }
  return steps.map((s) => ({ ...s, state: state.get(s.id) ?? "pending" }));
}

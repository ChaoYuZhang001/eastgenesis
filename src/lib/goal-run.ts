// 目标执行的接线（M10）：把纯循环（lib/goal-runner.ts）接到真实的 store 和决策层上。
// 一轮 = 一次任务：建任务卡、跑 AgentRuntime、结束后把事件整理成实据，交给决策层判定。
import { judgeByRules, mergeEvidence, type Evidence, type EvidenceResult } from "@/decision/evidence";
import type { Goal, GoalChange } from "@/decision/goal";
import { resolveInstructions } from "@/decision/project";
import { getBackend } from "@/platform";
import { createEngine } from "./engine";
import { freeCompletedPublication, type GoalExecutionSession } from "./goal-execution";
import { GoalQuotaControlError } from "@/core/goal-quota";
import { GoalRunner, type RoundHandle } from "./goal-runner";
import { health } from "@/stores/health";
import { setGoalStopper, useGoals } from "@/stores/goals";
import { useProjects } from "@/stores/projects";
import { useSettings } from "@/stores/settings";
import { taskToStoredTurn, useTasks } from "@/stores/tasks";

/** 这一轮的任务描述：第一轮就是目标原文，之后写清是第几轮、这一轮重点解决什么 */
export function roundGoalText(g: Goal, round: number, hint: string | null): string {
  const base = round > 1 ? `继续完成目标：${g.description}` : g.description;
  return hint ? `${base}\n这一轮重点：${hint}` : base;
}

/** 之前几轮的结果，作为这一轮的历史（模型据此知道已经做过什么，不重复劳动） */
export function roundsHistory(g: Goal): string {
  const lines = g.rounds
    .filter((r) => r.verdict)
    .map((r) => `第 ${r.index} 轮（${r.title}）：${r.verdict!.verdict === "done" ? "已完成" : "未完成"} · ${r.verdict!.reason}`);
  return lines.length ? `这个目标之前几轮的结果：\n${lines.join("\n")}` : "";
}

/** 目标 + 之前几轮 + 这一轮的实据：判定「整个目标完成没有」看的是全部记录，不是这一轮单独的 */
export function cumulativeEvidence(g: Goal, round: Evidence): Evidence {
  return mergeEvidence([...g.rounds.map((r) => r.evidence), round]);
}

/** 完成校验用的决策层：和跑任务用的是同一套可用性判断（Key 状态、能力矩阵、熔断记录） */
function verifier(session:GoalExecutionSession|null=null): ReturnType<typeof createEngine>["decision"] {
  const s = useSettings.getState();
  return createEngine({
    ...(session?{goalExecution:session.context,goalMeter:session.meter}:{}),
    backend: getBackend(),
    statuses: s.statuses,
    jev: s.jev,
    custom: s.custom,
    overrides: s.overrides,
    providerPrefs: s.providerPrefs,
    permission: s.defaultPermission,
    timeoutMs: s.timeoutS * 1000,
    health,
  }).decision;
}

/**
 * 传给循环的依赖。每一轮都新建引擎（和一次普通任务一样），
 * 完成校验另用一个决策层实例：它只问 Jev 或走规则，不跑任何步骤。
 */
export const goalRunner = new GoalRunner({
  read: (id) => useGoals.getState().items.find((g) => g.id === id) ?? null,
  refresh:(id)=>useGoals.getState().refresh(id),
  apply: async (id: string, change: GoalChange) => useGoals.getState().apply(id, change),
  startRoundTask(goal, round, hint, maxLlmCalls): RoundHandle {
    const project = goal.project_id ? useProjects.getState().items.find((p) => p.id === goal.project_id) ?? null : null;
    const instructions = resolveInstructions(null, goal, project);
    const history = [roundsHistory(goal), instructions].filter(Boolean).join("\n\n");
    return useTasks.getState().runGoalRound(roundGoalText(goal, round, hint), {
      goalId: goal.id,
      projectId: goal.project_id,
      mode: "goal",
      permission: useSettings.getState().defaultPermission,
      maxLlmCalls,
      ...(history && { history }),
    });
  },
  resumeRoundTask(goal, round, maxLlmCalls, continuation): RoundHandle | null {
    const last = goal.rounds.at(-1);
    const taskId = last?.task_id;
    if (!taskId) return null;
    const project = goal.project_id ? useProjects.getState().items.find((p) => p.id === goal.project_id) ?? null : null;
    const instructions = resolveInstructions(null, goal, project);
    const history = [roundsHistory(goal), instructions].filter(Boolean).join("\n\n");
    return useTasks.getState().resumeGoalRound(roundGoalText(goal, round, null), {
      goalId: goal.id,
      taskId,
      projectId: goal.project_id,
      mode: "goal",
      permission: useSettings.getState().defaultPermission,
      maxLlmCalls,
      ...(history && { history }),
    }, continuation);
  },
  prepareRecovery(goal) {
    const last = goal.rounds.at(-1);
    if (!last?.task_id) return Promise.resolve({ accounting: null, completed: null });
    return useTasks.getState().prepareGoalRecovery(last.task_id, goal.id);
  },
  async checkDone(goal,evidence,taskId,allowModel=true,session=null): Promise<EvidenceResult> {
    if (!allowModel) return judgeByRules(goal.description, cumulativeEvidence(goal, evidence)) ?? {
      verdict: "uncertain", by: "rules", reason: "已有成果已保存，但规则无法确认完成；调用预算不可用，请你确认",
    };
    // 判定看的是「到目前为止的全部记录」，不只是这一轮：上一轮建好的文件这一轮仍然算数
    if(goal.quota&&!session)throw new GoalQuotaControlError("quota_invalid_request");
    return verifier(session).checkDoneWithEvidence(goal.description, cumulativeEvidence(goal, evidence), {
      taskId,
      ...(goal.project_id ? { projectId: goal.project_id } : {}),
    });
  },
  cancelTask: (taskId) => useTasks.getState().cancel(taskId),
  async checkpointTask(taskId,session=null) {
    // pause/abandon 先切目标状态，再 abort Agent。等任务进入终态后取最新事件，
    // 确保用户可以立刻点击“继续”，而不是撞上 25ms 的普通 checkpoint debounce。
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const card = useTasks.getState().tasks.find((task) => task.id === taskId);
      if (!card || card.status !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const card = useTasks.getState().tasks.find((task) => task.id === taskId);
    if (!card?.goalId) return;
    const goal = useGoals.getState().items.find((item) => item.id === card.goalId);
    const round = goal?.rounds.at(-1);
    if (!round || round.task_id !== card.id || (round.status !== "running" && round.status !== "interrupted")) return;
    const publication=session?.publication??(goal?freeCompletedPublication(goal,taskId):null);
    const saved = await useGoals.getState().apply(card.goalId, { op: "checkpoint_round", task: taskToStoredTurn(card),...(publication?{quota_publication:publication}:{}) });
    if (typeof saved === "string") throw new Error(saved);
  },
  onError: (message) => useGoals.getState().reportError(message),
});

// 暂停、放弃、删除目标时，先在跑的那一轮立刻停下
setGoalStopper(async (id) => {
  await goalRunner.stopAndCheckpoint(id);
});

/** 开始（或继续）一个目标的自动多轮；不满足条件时循环自己返回 */
export function runGoal(id: string): void {
  void goalRunner.run(id);
}

/** 停掉某个目标的循环（暂停、放弃、删除时调用） */
export const stopGoal = (id: string): boolean => goalRunner.stop(id);

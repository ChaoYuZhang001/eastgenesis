// 任务：一次任务就是会话里的一轮（用户目标 + 助手成果）。专家模式下同一份数据以卡片形式展示。
import { create } from "zustand";
import type { AgentEvent, ConfirmRequest, Plan, RunFile, RunStatus } from "@/agent";
import { emptyEvidence } from "@/decision/evidence";
import { toAttachments } from "@/lib/attachments";
import { createEngine, withLockedModel, type ModelOverride } from "@/lib/engine";
import type { RoundHandle } from "@/lib/goal-runner";
import { outcomeOf } from "@/lib/run-evidence";
import { toAppError } from "@/lib/ipc";
import { proposeAlignment, proposeMemory, type MemoryProposal } from "@/lib/memory";
import { appendEvent } from "@/lib/subagents";
import { DEMO_TOOLS, getBackend } from "@/platform";
import type { PermissionMode, Preference } from "@/decision";
import { newId, preferenceSource, type PreferenceSource } from "@/decision/project";
import { health } from "./health";
import { activeMcpTools } from "./mcp";
import { useMemory } from "./memory";
import { useSkills } from "./skills";
import { useSettings } from "./settings";
import { useGoals } from "./goals";
import { useProjects } from "./projects";

export type TaskStatus = "running" | RunStatus;
/** 输入框「+」菜单里的模式：快速（一问一答）、计划模式、目标（多轮直到有实据完成）。M8 只记录，执行仍是原逻辑 */
export type TaskMode = "quick" | "plan" | "goal";
export const TASK_MODES: readonly TaskMode[] = ["quick", "plan", "goal"];

export interface SubmitOptions {
  /** 所属会话；null 表示不属于任何会话（测试或 CLI 式直接提交） */
  sessionId?: string | null;
  /** 输入框锁定的模型（profile id）；null 表示自动路由 */
  lock?: string | null;
  permission?: PermissionMode;
  /** 同一会话之前几轮的对话 */
  history?: string;
  files?: readonly RunFile[];
  /** 第一次对话：总结时顺带对齐称呼、风格和边界 */
  onboarding?: boolean;
  /** 上一轮刚问过对齐问题：这一轮的回答整句作为待确认偏好 */
  aligning?: boolean;
  /** 多 Agent 协同 */
  multi?: boolean;
  /** 所属项目；null 表示不属于任何项目 */
  projectId?: string | null;
  /** 所属目标（目标模式下每一轮对应的任务）；null 表示不属于任何目标 */
  goalId?: string | null;
  mode?: TaskMode;
  /** 任务层路由偏好（输入框的「省钱模式」「最强模式」）；不给表示自动，按 目标 > 项目 > 全局 取值 */
  preference?: Preference | null;
  /** 工作目录：作为上下文告诉模型文件在哪；文件工具能访问哪些目录仍由文件服务器的允许列表决定 */
  workdir?: string | null;
  /** 只用这些 MCP 服务器的工具；不给表示所有已连接的 */
  servers?: readonly string[] | null;
  /** 项目、目标、任务三层叠加的说明（decision/project.ts resolveInstructions）；目标模式由执行器传入 */
  instructions?: string | null;
  /** 这一轮的模型调用上限（目标模式按目标剩余额度给）；不给用运行时的默认预算 */
  maxLlmCalls?: number;
}

export interface TaskCard {
  id: string;
  /** 递增序号：会话里按它排时间顺序，专家模式的拖拽排序不影响它 */
  seq: number;
  sessionId: string | null;
  goal: string;
  status: TaskStatus;
  collapsed: boolean;
  events: AgentEvent[];
  summary: string | null;
  pendingConfirm: ConfirmRequest | null;
  /** 计划模式：等你批准的计划 */
  pendingPlan: Plan | null;
  override: ModelOverride | null;
  /** 输入框锁定的模型；null 表示自动路由 */
  lock: string | null;
  permission: PermissionMode;
  onboarding: boolean;
  /** 附带的文件（只保留名字用于展示，正文在运行时已交给模型） */
  files: string[];
  /** 多 Agent 协同 */
  multi: boolean;
  startedAt: number;
  endedAt: number | null;
  /** 目标里明确要求记住某件事时的待确认记忆；只有用户确认才保存 */
  proposal: MemoryProposal | null;
  projectId: string | null;
  goalId: string | null;
  mode: TaskMode;
  /** 这次实际用的路由偏好和它来自哪一层（任务 / 目标 / 项目 / 全局），回答下方的浮层里写明 */
  preference: Preference;
  preferenceSource: PreferenceSource;
}

/** 一次运行结束后给调用方的信息：最终卡片（卡片被关掉时 undefined）和「哪些工具是只读的」判断 */
export interface RunOutcome {
  card: TaskCard | undefined;
  readOnly: (tool: string) => boolean;
}

interface TasksState {
  tasks: TaskCard[];
  activeId: string | null;
  submit(goal: string, opts?: SubmitOptions): string | null;
  /** 目标模式的一轮：同步建出任务卡（界面立刻显示第 N 轮进行中），跑完后返回这一轮的记账 */
  runGoalRound(goal: string, opts: SubmitOptions & { goalId: string }): RoundHandle;
  close(id: string): void;
  toggleCollapse(id: string): void;
  move(id: string, toIndex: number): void;
  select(id: string): void;
  respond(id: string, approved: boolean): void;
  /** 计划模式：批准或取消计划 */
  respondPlan(id: string, approved: boolean): void;
  cancel(id: string): void;
  setOverride(id: string, o: ModelOverride | null): void;
  /** 保存待确认的记忆；失败返回错误说明 */
  acceptProposal(id: string): Promise<string | null>;
  dismissProposal(id: string): void;
}

export const MAX_GOAL = 4000;

/** 任务 > 目标 > 项目 > 全局（M8 的 preferenceSource）；项目、目标从各自的 store 里取 */
function resolvePreference(opts: SubmitOptions): { preference: Preference; preferenceSource: PreferenceSource } {
  const project = opts.projectId ? (useProjects.getState().items.find((p) => p.id === opts.projectId) ?? null) : null;
  const goal = opts.goalId ? (useGoals.getState().items.find((g) => g.id === opts.goalId) ?? null) : null;
  const r = preferenceSource({ routing_preference: opts.preference ?? null }, goal, project, useSettings.getState().routing.preference);
  return { preference: r.preference, preferenceSource: r.source };
}
const MAX_EVENTS = 500;
const controllers = new Map<string, AbortController>();
const confirms = new Map<string, (ok: boolean) => void>();
const plans = new Map<string, (ok: boolean) => void>();
let seq = Date.now();

export const useTasks = create<TasksState>((set, get) => {
  // 卡片已关闭时，运行收尾的事件直接丢弃（返回原 state，不触发重新渲染）
  const patch = (id: string, f: (t: TaskCard) => Partial<TaskCard>) =>
    set((s) => (s.tasks.some((t) => t.id === id) ? { tasks: s.tasks.map((t) => (t.id === id ? { ...t, ...f(t) } : t)) } : s));
  const settle = (id: string, ok: boolean) => {
    confirms.get(id)?.(ok);
    confirms.delete(id);
  };
  const settlePlan = (id: string, ok: boolean) => {
    plans.get(id)?.(ok);
    plans.delete(id);
  };

  /** 建一张任务卡（不启动）：普通任务进会话，目标轮次不进（sessionId 为 null） */
  const make = (goal: string, opts: SubmitOptions): TaskCard | null => {
    const g = goal.trim().slice(0, MAX_GOAL);
    if (!g) return null;
    const n = ++seq;
    const files = (opts.files ?? []).map((f) => ({ name: f.name, text: f.text }));
    return {
      id: newId("task"),
      seq: n,
      sessionId: opts.sessionId ?? null,
      goal: g,
      status: "running",
      collapsed: false,
      events: [],
      summary: null,
      pendingConfirm: null,
      pendingPlan: null,
      override: null,
      lock: opts.lock ?? null,
      permission: opts.permission ?? "confirm",
      onboarding: opts.onboarding === true,
      files: files.map((f) => f.name),
      multi: opts.multi === true,
      startedAt: Date.now(),
      endedAt: null,
      // 刚问过对齐问题时，这一轮的回答整句作为待确认偏好
      proposal: opts.aligning ? proposeAlignment(g) : proposeMemory(g),
      projectId: opts.projectId ?? null,
      goalId: opts.goalId ?? null,
      mode: opts.mode ?? "quick",
      ...resolvePreference(opts),
    };
  };

  async function run(id: string, goal: string, opts: SubmitOptions, files: readonly RunFile[]): Promise<RunOutcome> {
    const multi = opts.multi === true;
    const lock = opts.lock ?? null;
    const s = useSettings.getState();
    const backend = getBackend();
    const ctrl = new AbortController();
    controllers.set(id, ctrl);
    const notes = useMemory.getState().pick(goal);
    // 多 Agent 协同时不带技能：拆分后的子任务和技能对不上
    const skills = multi ? [] : useSkills.getState().pick(goal);
    // 目标模式会把执行记录当作实据：只读工具不算「做过事」，需要按工具自己的声明判断
    const registered = [...(backend.kind === "mock" ? DEMO_TOOLS : []), ...activeMcpTools(opts.servers ?? null)];
    const readOnly = (name: string) => registered.find((t) => t.name === name)?.sideEffect === "none";
    const { runtime, coordinator } = createEngine({
      backend,
      statuses: s.statuses,
      jev: s.jev,
      // 锁定了 /models 里发现但没登记的模型时，这一次临时补进模型列表
      custom: withLockedModel(s.custom, lock),
      overrides: s.overrides,
      providerPrefs: s.providerPrefs,
      permission: opts.permission,
      timeoutMs: s.timeoutS * 1000,
      onboarding: opts.onboarding === true,
      ...(opts.instructions ? { instructions: opts.instructions } : {}),
      ...(opts.maxLlmCalls ? { budget: { maxLlmCalls: Math.max(1, opts.maxLlmCalls) } } : {}),
      health,
      memories: notes,
      skills,
      // 浏览器模式另外注册演示工具；MCP 工具来自设置页里已连接的服务器（只含白名单内的）
      tools: registered,
      onEvent: (e) => patch(id, (t) => ({ events: appendEvent(t.events, e, MAX_EVENTS) })),
      confirm: (req) =>
        new Promise<boolean>((resolve) => {
          confirms.set(id, resolve);
          patch(id, () => ({ pendingConfirm: req }));
        }).finally(() => patch(id, () => ({ pendingConfirm: null }))),
      // 计划模式：规划完停下来，等你批准；取消任务时视为不批准
      ...(opts.mode === "plan" && {
        approvePlan: (plan: Plan) =>
          new Promise<boolean>((resolve) => {
            plans.set(id, resolve);
            patch(id, () => ({ pendingPlan: plan }));
          }).finally(() => patch(id, () => ({ pendingPlan: null }))),
      }),
      override: () => get().tasks.find((t) => t.id === id)?.override ?? null,
      consumeNext: () => patch(id, (t) => (t.override?.mode === "next" ? { override: null } : {})),
    });
    const { latency, maxCostTier } = s.routing;
    const preference = get().tasks.find((t) => t.id === id)?.preference ?? s.routing.preference;
    const attachments = files.length ? toAttachments(files.map((f) => ({ ...f, bytes: f.text.length }))) : undefined;
    // 锁定模型时跳过路由决策，成本上限也不再适用（用户明确选了它）
    const route = { preference, latency, ...(maxCostTier < 5 && !lock && { maxCostTier }), ...(lock && { lock }), ...(attachments && { attachments }) };
    let status: TaskStatus = "failed";
    try {
      const history = [opts.workdir ? `工作目录：${opts.workdir}（文件读写优先放在这里）` : "", opts.history ?? ""].filter(Boolean).join("\n\n") || undefined;
      const r = await (multi ? coordinator : runtime).run(goal, { signal: ctrl.signal, route, history, files });
      status = r.status;
      patch(id, () => ({ status: r.status, summary: r.summary, endedAt: Date.now() }));
    } catch (e) {
      patch(id, () => ({ status: "failed", summary: toAppError(e).message, endedAt: Date.now() }));
    } finally {
      controllers.delete(id);
      settle(id, false);
      settlePlan(id, false);
      // 对齐问题真的问出去了才算「已引导过」，否则下次开机重新问
      if (opts.onboarding && status === "completed") void useSettings.getState().markOnboarded();
      useMemory.getState().markUsed(notes.map((n) => n.id));
      useSkills.getState().markUsed(skills.map((x) => x.id));
    }
    return { card: get().tasks.find((t) => t.id === id), readOnly };
  }

  return {
    tasks: [],
    activeId: null,
    submit(goal, opts = {}) {
      const card = make(goal, opts);
      if (!card) return null;
      set((s) => ({ tasks: [card, ...s.tasks], activeId: card.id }));
      void run(card.id, card.goal, opts, opts.files ? [...opts.files] : []);
      return card.id;
    },
    runGoalRound(goal, opts) {
      const card = make(goal, opts);
      if (!card) throw new Error("这一轮的任务描述为空");
      // 目标轮次不进会话列表（sessionId 为 null），也不会把会话顶到「最近」里
      set((s) => ({ tasks: [card, ...s.tasks] }));
      const result = run(card.id, card.goal, opts, []).then(({ card: done, readOnly }) => {
        // 卡片被关掉时按「执行出错」记，循环据此开下一轮或判失败
        if (!done) return { taskId: card.id, status: "aborted" as const, summary: "这一轮的任务被关掉了", evidence: emptyEvidence(), llmCalls: 0, items: [] };
        return outcomeOf(done, readOnly);
      });
      return { taskId: card.id, result };
    },
    close(id) {
      get().cancel(id);
      set((s) => {
        const tasks = s.tasks.filter((t) => t.id !== id);
        return { tasks, activeId: s.activeId === id ? (tasks[0]?.id ?? null) : s.activeId };
      });
    },
    toggleCollapse: (id) => patch(id, (t) => ({ collapsed: !t.collapsed })),
    move(id, toIndex) {
      set((s) => {
        const from = s.tasks.findIndex((t) => t.id === id);
        if (from < 0) return s;
        const tasks = [...s.tasks];
        const [card] = tasks.splice(from, 1);
        tasks.splice(Math.max(0, Math.min(toIndex, tasks.length)), 0, card);
        return { tasks };
      });
    },
    select: (id) => set({ activeId: id }),
    respond: (id, approved) => settle(id, approved),
    respondPlan: (id, approved) => settlePlan(id, approved),
    cancel(id) {
      settle(id, false);
      settlePlan(id, false);
      controllers.get(id)?.abort();
    },
    setOverride: (id, o) => patch(id, () => ({ override: o })),
    async acceptProposal(id) {
      const p = get().tasks.find((t) => t.id === id)?.proposal;
      if (!p) return null;
      const r = await useMemory.getState().save({ ...p, source: "task" });
      if (typeof r === "string") return r;
      patch(id, () => ({ proposal: null }));
      return null;
    },
    dismissProposal: (id) => patch(id, () => ({ proposal: null })),
  };
});

import { GoalQuotaControlError, isGoalQuotaControlError, type GoalQuotaErrorCode } from "@/core/goal-quota";
import { hasUnsettledGoalMain, acquireGoalExecution, requireGoalSession, goalExecutionForTask, freeCompletedPublication, type GoalExecutionSession } from "@/lib/goal-execution";
// 任务：一次任务就是会话里的一轮（用户目标 + 助手成果）。专家模式下同一份数据以卡片形式展示。
import { create } from "zustand";
import type { AgentEvent, ConfirmRequest, Plan, ResumeState, RunFile, RunStatus, RuntimeFaultPoint } from "@/agent";
import { emptyEvidence } from "@/decision/evidence";
import { toAttachments } from "@/lib/attachments";
import { createEngine, withLockedModel, type ModelOverride } from "@/lib/engine";
import type { RecoveryPreparation, RoundHandle } from "@/lib/goal-runner";
import { outcomeOf } from "@/lib/run-evidence";
import { recoveryCheckpoint } from "@/lib/recovery";
import { prepareGoalContinuation, goalContinuationSeed, type GoalContinuation } from "@/lib/goal-continuation";
import { toAppError } from "@/lib/ipc";
import { proposeAlignment, proposeMemory, type MemoryProposal } from "@/lib/memory";
import { appendEvent } from "@/lib/subagents";
import { DEMO_TOOLS, getBackend } from "@/platform";
import type { PermissionMode, Preference, WorkSurface } from "@/decision";
import { normalizeRecoveryAccounting, normalizeTurn, type RecoveryAccounting, type StoredTurn } from "@/decision/session";
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
  /** Only a positively acquired in-memory execution session; never persisted or user supplied credentials. */
  goalSession?: GoalExecutionSession | null;
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
  /** 可选的能力面提示；不是权限开关，最终仍以决策层分类为准 */
  surfaceHint?: WorkSurface | null;
  /** 项目、目标、任务三层叠加的说明（decision/project.ts resolveInstructions）；目标模式由执行器传入 */
  instructions?: string | null;
  /** 这一轮的模型调用上限（目标模式按目标剩余额度给）；不给用运行时的默认预算 */
  maxLlmCalls?: number;
}

export interface TaskCard {
  quotaControl?: { code:GoalQuotaErrorCode };
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
  /** 用户显式给这次任务的能力面提示；null 表示自动判断。 */
  surfaceHint?: WorkSurface | null;
  /** 运行中 checkpoint 在启动时没有终态，被读回为 aborted；只用于让恢复入口可见，不写入存储。 */
  recoveredFromRestart?: boolean;
  recovery_accounting?: RecoveryAccounting | null;
  /** 当前 answer / summary 的流式正文；只存在运行态，不写入历史。 */
  streamingText?: string;
  /** 流式正文已经开始后请求中断，不能静默拼接另一个模型。 */
  streamingInterrupted?: boolean;
  /** 当前窗口收到的首个/最后一个正文 chunk 时间；旧历史没有这两个字段。 */
  streamFirstChunkAt?: number | null;
  streamLastChunkAt?: number | null;
}

/** 一次运行结束后给调用方的信息：最终卡片（卡片被关掉时 undefined）和「哪些工具是只读的」判断 */
export interface RunOutcome {
  card: TaskCard | undefined;
  readOnly: (tool: string) => boolean;
  /** 本次运行新增的调用数；不依赖有界事件历史，也不重算已结算的旧调用。 */
  llmCalls: number;
}

interface TasksState {
  tasks: TaskCard[];
  activeId: string | null;
  submit(goal: string, opts?: SubmitOptions): string | null;
  /** 目标模式的一轮：同步建出任务卡（界面立刻显示第 N 轮进行中），跑完后返回这一轮的记账 */
  runGoalRound(goal: string, opts: SubmitOptions & { goalId: string }): RoundHandle;
  /** 重启后从目标轮次 checkpoint 继续同一任务 ID；缺少账本时返回 null。 */
  resumeGoalRound(goal: string, opts: SubmitOptions & { goalId: string; taskId: string }, continuation?: GoalContinuation): RoundHandle | null;
  /** 先补保存真实终态；只返回完整计数，运行中或历史未知计数不能解锁新调用。 */
  prepareGoalRecovery(taskId: string, goalId: string): Promise<RecoveryPreparation>;
  close(id: string): void;
  toggleCollapse(id: string): void;
  move(id: string, toIndex: number): void;
  select(id: string): void;
  respond(id: string, approved: boolean): void;
  /** 计划模式：批准或取消计划 */
  respondPlan(id: string, approved: boolean): void;
  /** 从失败、取消或预算耗尽的最后一个未完成步骤继续；不可恢复时返回 false */
  resume(id: string): boolean;
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

/** Hydration may append one display-only aborted marker, but cannot redirect
 * the persisted prompt, history or accounting used by a fresh claim. */
function recoveryCardMatches(card: TaskCard, task: StoredTurn): boolean {
  const extra = card.events.slice(task.events.length);
  return card.goal === task.goal
    && JSON.stringify(card.events.slice(0, task.events.length)) === JSON.stringify(task.events)
    && JSON.stringify(card.recovery_accounting) === JSON.stringify(task.recovery_accounting)
    && extra.length <= 1
    && (extra.length === 0 || extra[0].type === "run_end" && extra[0].status === "aborted");
}
const controllers = new Map<string, AbortController>();
const confirms = new Map<string, (ok: boolean) => void>();
const plans = new Map<string, (ok: boolean) => void>();
/** 当前进程内保留原始附件和任务输入；重启后恢复时只使用持久化的目标和计划。 */
const inputs = new Map<string, { opts: SubmitOptions; files: RunFile[] }>();
const checkpointTimers = new Map<string, ReturnType<typeof setTimeout>>();
let seq = Date.now();

/** 目标轮次使用的脱敏 checkpoint；附件正文、确认器和 AbortController 永远不落盘。 */
export function taskToStoredTurn(t: TaskCard): StoredTurn {
  return normalizeTurn({
    id: t.id, seq: t.seq, goal: t.goal, status: t.status, summary: t.summary,
    events: t.events as unknown[], lock: t.lock, permission: t.permission, files: t.files,
    multi: t.multi, startedAt: t.startedAt, endedAt: t.endedAt, goalId: t.goalId,
    mode: t.mode, preference: t.preference, preferenceSource: t.preferenceSource,
    surfaceHint: t.surfaceHint ?? null,
    streamingText: t.streamingText ?? "",
    streamingInterrupted: t.streamingInterrupted === true,
    recovery_accounting: t.recovery_accounting ?? null,
  });
}

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

  const checkpointWrites = new Map<string, Promise<void>>();
  const checkpointGoalTask = (id: string, required = false, session:GoalExecutionSession|null=goalExecutionForTask(id)): Promise<void> => {
    const old = checkpointTimers.get(id);
    if (old) clearTimeout(old);
    checkpointTimers.delete(id);
    // Serialize writes and read the latest card only when this write starts.
    // An older debounced snapshot must never overwrite a completed checkpoint.
    const write = (checkpointWrites.get(id) ?? Promise.resolve()).catch(() => {}).then(async () => {
      const card = get().tasks.find((t) => t.id === id);
      if (!card?.goalId) {
        if (required) throw new Error("目标任务不存在");
        return;
      }
      const goal = useGoals.getState().items.find((g) => g.id === card.goalId);
      const round = goal?.rounds.at(-1);
      if (!round || round.task_id !== card.id || (round.status !== "running" && round.status !== "interrupted")) {
        if (required) throw new Error("目标轮次不可恢复");
        return;
      }
      const publication=session?.publication??(goal?freeCompletedPublication(goal,id):null);
      const saved = await useGoals.getState().apply(card.goalId, { op: "checkpoint_round", task: taskToStoredTurn(card),...(publication?{quota_publication:publication}:{}) });
      if(typeof saved==="string"){
       if(["quota_invalid_request","quota_denied","quota_storage_unknown","quota_outcome_unknown","quota_protocol_invalid"].includes(saved))throw new GoalQuotaControlError(saved as GoalQuotaErrorCode);
       throw new Error(saved);
      }
    });
    checkpointWrites.set(id, write);
    const remove = () => { if (checkpointWrites.get(id) === write) checkpointWrites.delete(id); };
    void write.then(remove, remove);
    return write;
  };
  const scheduleGoalCheckpoint = (id: string,session:GoalExecutionSession|null=goalExecutionForTask(id)) => {
    const old = checkpointTimers.get(id);
    if (old) clearTimeout(old);
    const timer = setTimeout(() => {
      checkpointTimers.delete(id);
      void checkpointGoalTask(id,false,session).catch(() => useGoals.getState().reportError("无法保存任务恢复记录，请检查本地存储"));
    }, 25);
    checkpointTimers.set(id, timer);
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
      surfaceHint: opts.surfaceHint ?? null,
      streamingText: "",
      streamingInterrupted: false,
      streamFirstChunkAt: null,
      streamLastChunkAt: null,
    };
  };

  async function run(id: string, goal: string, opts: SubmitOptions, files: readonly RunFile[], resume?: ResumeState): Promise<RunOutcome> {
    let llmCalls = 0;
    const multi = opts.multi === true;
    const lock = opts.lock ?? null;
    const s = useSettings.getState();
    const backend = getBackend();
    const ctrl = new AbortController();
    controllers.set(id, ctrl);
    let status:TaskStatus="failed";
    let readOnly:(tool:string)=>boolean=()=>true;
    let cleanupUsage=()=>{};
    let session:GoalExecutionSession|null=opts.goalSession??null;
    try {
    if(opts.mode==="goal"&&!opts.goalId)throw new GoalQuotaControlError("quota_invalid_request");
    if(opts.goalId&&backend.kind==="tauri")session=await requireGoalSession(opts.goalId,id,session);
    const notes = useMemory.getState().pick(goal);
    // 多 Agent 协同时不带技能：拆分后的子任务和技能对不上
    const skills = multi ? [] : useSkills.getState().pick(goal);
    cleanupUsage=()=>{useMemory.getState().markUsed(notes.map(n=>n.id));useSkills.getState().markUsed(skills.map(x=>x.id));};
    // 目标模式会把执行记录当作实据：只读工具不算「做过事」，需要按工具自己的声明判断
    const registered = [...(backend.kind === "mock" ? DEMO_TOOLS : []), ...activeMcpTools(opts.servers ?? null)];
    // 仅 QA 构建从 Tauri 环境读取故障点；普通后端没有该能力，任务路径不增加故障注入。
    const qaFaultPoint: RuntimeFaultPoint | null = backend.qaFaultPoint ? await backend.qaFaultPoint().catch(() => null) : null;
    const qaLeaseMs = backend.qaLedgerLeaseMs ? await backend.qaLedgerLeaseMs().catch(() => null) : null;
    readOnly = (name: string) => registered.find((t) => t.name === name)?.sideEffect === "none";
    const { runtime, coordinator } = createEngine({
      ...(session?{goalExecution:session.context,goalMeter:session.meter}:{}),
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
      onEvent: (e) => {
        const callEvent = e.type === "subagent" ? e.event : e;
        if (callEvent.type === "llm" || callEvent.type === "llm_failed") llmCalls++;
        patch(id, (t) => {
          // 增量只用于当前窗口的实时绘制，不写进事件历史、SQLite 或路由统计。
          if (e.type === "llm_delta") {
            const at = Date.now();
            const text = `${t.streamingText ?? ""}${e.text}`.slice(0, 200_000);
            return {
              streamingText: text,
              streamingInterrupted: false,
              streamFirstChunkAt: t.streamFirstChunkAt ?? at,
              streamLastChunkAt: at,
            };
          }
          let accounting = normalizeRecoveryAccounting(t.recovery_accounting, t.id);
          if (e.type === "run_start") {
            if (useGoals.getState().items.find((g) => g.id === t.goalId)?.rounds.some((r) => r.task_id === t.id && r.llm_settlements?.some((x) => x.run_id === e.runId))) throw new Error("运行身份已结算，不能重复使用");
            accounting = normalizeRecoveryAccounting({ version: 1, task_id: t.id, run_id: e.runId, llm_calls: 0, final: false }, t.id);
          } else if (accounting && (callEvent.type === "llm" || callEvent.type === "llm_failed")) {
            // 终态后的晚事件不能继续声称计数完整。
            accounting = { ...accounting, llm_calls: llmCalls, final: false };
          } else if (accounting && e.type === "run_end") accounting = { ...accounting, llm_calls: llmCalls, final: session===null };
          const recovery_accounting = accounting;
          const recorded = { ...e, recordedAt: Date.now() };
          let events = appendEvent(t.events, recorded, MAX_EVENTS);
          // 有界历史保留这个完整计数所属的主运行锚点；不能让旧 head 的 run_start 冒充最新运行。
          if (accounting && !events.some((event) => event.type === "run_start" && event.runId === accounting.run_id)) {
            const anchor = t.events.find((event) => event.type === "run_start" && event.runId === accounting.run_id);
            if (anchor) {
              const context = events.findIndex((event, i) => i < 12 && (event.type === "route" || event.type === "memory" || event.type === "skill"));
              const omit = context < 0 ? 0 : context;
              events = [...events.slice(0, 12).filter((_, i) => i !== omit), anchor, ...events.slice(12)];
            }
          }
          if (e.type === "llm") {
            scheduleGoalCheckpoint(id,session);
            // The text panel is transient, but the timestamps are task evidence:
            // a fast native WebView can batch the last delta and terminal event
            // before WebDriver observes a frame. Keep the markers until the
            // next run starts so a completed card still proves a real stream.
            return { events, recovery_accounting, streamingText: "", streamingInterrupted: false };
          }
          if (e.type === "llm_failed") {
            scheduleGoalCheckpoint(id,session);
            // A provider may lose its partial-output flag while an IPC stream is
            // closing. Existing visible text is sufficient evidence that the
            // failure must preserve it and stop fallback concatenation.
            return { events, recovery_accounting, ...((e.partialOutput || Boolean(t.streamingText)) ? { streamingInterrupted: true } : {}) };
          }
          scheduleGoalCheckpoint(id,session);
          return { events, recovery_accounting };
        });
      },
      ...(opts.goalId ? { beforeSideEffect: () => checkpointGoalTask(id, true,session) } : {}),
      ...(qaLeaseMs ? { ledgerLeaseMs: qaLeaseMs } : {}),
      ...(qaFaultPoint && backend.qaFaultExit ? { fault: { point: qaFaultPoint, trigger: backend.qaFaultExit } } : {}),
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
    const route = { preference, latency, ...(maxCostTier < 5 && !lock && { maxCostTier }), ...(lock && { lock }), ...(attachments && { attachments }), ...(opts.surfaceHint && { surfaceHint: opts.surfaceHint }) };

      const history = [opts.workdir ? `工作目录：${opts.workdir}（文件读写优先放在这里）` : "", opts.history ?? ""].filter(Boolean).join("\n\n") || undefined;
      const runOpts = { ...(session?{goalExecution:session.context}:{}),taskId: id, signal: ctrl.signal, route, history, files, ...(!multi && resume ? { resume } : {}) };
      const r = await (multi ? coordinator : runtime).run(goal, runOpts);
      status=r.status;
      const quotaControl=(r as typeof r & {quotaControl?:{code:GoalQuotaErrorCode}}).quotaControl;
      patch(id,()=>({status:r.status,summary:r.summary,endedAt:Date.now(),...(quotaControl?{quotaControl}:{})}));
      if(session){
        // V1 run_end remains a lower bound until this exact main execution's permits are positively terminal.
        // A failed snapshot leaves final=false, including while debounced writes are queued.
        const prior=get().tasks.find(t=>t.id===id)?.recovery_accounting;
        const unsettled=await hasUnsettledGoalMain(session);
        if(prior&&!unsettled)patch(id,t=>({recovery_accounting:t.recovery_accounting&&t.recovery_accounting.run_id===prior.run_id&&t.recovery_accounting.llm_calls===prior.llm_calls?{...t.recovery_accounting,final:true}:t.recovery_accounting}));
      }
    } catch (e) {
      const quotaControl=isGoalQuotaControlError(e)?{code:e.code}:undefined;
      status=quotaControl?"needs_user":"failed";
      patch(id, (t) => ({
        status,...(quotaControl?{quotaControl}:{}),
        summary: toAppError(e).message,
        endedAt: Date.now(),
        // Keep a visible partial-output marker even if an adapter/runtime
        // failure reaches the outer boundary without first emitting
        // `llm_failed`. The text itself is already bounded in the llm_delta
        // handler, and clearing it would make a real interrupted stream look
        // like a task that never produced output.
        ...(t.streamingText ? { streamingInterrupted: true } : {}),
      }));
    } finally {
      if (opts.goalId) {
        try { await checkpointGoalTask(id,false,session); }
        catch(e) {
          status = "needs_user";
          const quotaControl=isGoalQuotaControlError(e)?{code:e.code}:session?{code:"quota_storage_unknown" as const}:undefined;
          patch(id, () => ({ status: "needs_user", summary: "无法保存任务完成记录，请检查本地存储后继续",...(quotaControl?{quotaControl}:{}) }));
          useGoals.getState().reportError("无法保存任务完成记录，请检查本地存储后继续");
        }
      } else scheduleGoalCheckpoint(id,session);
      controllers.delete(id);
      settle(id, false);
      settlePlan(id, false);
      // 对齐问题真的问出去了才算「已引导过」，否则下次开机重新问
      if (opts.onboarding && status === "completed") void useSettings.getState().markOnboarded();
      try{cleanupUsage();}catch{/* Cleanup cannot leave a lazy round result unresolved. */}
    }
    return { card: get().tasks.find((t) => t.id === id), readOnly, llmCalls };
  }

  /** 目标轮次的惰性句柄：先由 GoalRunner 将 start_round/resume_round 写入数据库，再真正启动 Agent。 */
  const lazyRound = (id: string, goal: string, opts: SubmitOptions, files: readonly RunFile[], resume?: ResumeState, continuation?: GoalContinuation): RoundHandle => {
    opts={...opts};
    let prepared:GoalExecutionSession|null=null;
    let started = false;
    let resolveResult!: (value: Awaited<RoundHandle["result"]>) => void;
    const result = new Promise<Awaited<RoundHandle["result"]>>((resolve) => {
      resolveResult = resolve;
    });
    return {
      taskId: id,
      result,
      async prepare(){
       if(getBackend().kind==="tauri"&&opts.goalId)prepared=await acquireGoalExecution(opts.goalId,id,Date.now,continuation);
       opts={...opts,goalSession:prepared};return prepared;
      },
      session:()=>prepared,
      start() {
        if (started) return;
        started = true;
        void run(id, goal, opts, files, resume).then(({ card: done, readOnly, llmCalls }) => {
          if (!done) return { taskId: id, status: "aborted" as const, summary: "这一轮的任务被关掉了", evidence: emptyEvidence(), llmCalls: 0, items: [] };
          // Evidence still describes the entire task, including completed
          // steps. Billing describes only this invocation of run(); a resumed
          // task retains old events that have already been settled.
          return { ...outcomeOf(done, readOnly), llmCalls, accounting: done.recovery_accounting ?? null,...(done.quotaControl?{quotaControl:done.quotaControl}:{}) };
        }).then(resolveResult).catch(()=>resolveResult({taskId:id,status:"needs_user",summary:"目标运行准备或收尾失败，请检查本地状态",evidence:emptyEvidence(),llmCalls:0,accounting:null,items:[],quotaControl:{code:"quota_storage_unknown"}}));
      },
    };
  };

  return {
    tasks: [],
    activeId: null,
    submit(goal, opts = {}) {
      const card = make(goal, opts);
      if (!card) return null;
      inputs.set(card.id, { opts: { ...opts }, files: opts.files ? [...opts.files] : [] });
      set((s) => ({ tasks: [card, ...s.tasks], activeId: card.id }));
      void run(card.id, card.goal, opts, opts.files ? [...opts.files] : []);
      return card.id;
    },
    runGoalRound(goal, opts) {
      const card = make(goal, opts);
      if (!card) throw new Error("这一轮的任务描述为空");
      inputs.set(card.id, { opts: { ...opts }, files: opts.files ? [...opts.files] : [] });
      // 目标轮次不进会话列表（sessionId 为 null），也不会把会话顶到「最近」里
      set((s) => ({ tasks: [card, ...s.tasks] }));
      return lazyRound(card.id, card.goal, opts, []);
    },
    async prepareGoalRecovery(taskId, goalId) {
      const card = get().tasks.find((t) => t.id === taskId && t.goalId === goalId);
      if (!card || controllers.has(taskId) || card.status === "running") return { accounting: null, completed: null };
      // 只看最近的主运行；合成的重启 aborted 不会把非终态计数变成完整计数。
      let terminal: Extract<AgentEvent, { type: "run_end" }> | undefined;
      let runId: string | undefined;
      for (let i = card.events.length - 1; i >= 0; i--) {
        const e = card.events[i];
        if (e.type === "run_end" && !terminal) terminal = e;
        if (e.type === "run_start") { runId = e.runId; break; }
      }
      const a = normalizeRecoveryAccounting(card.recovery_accounting, card.id);
      const round = useGoals.getState().items.find((g) => g.id === goalId)?.rounds.at(-1);
      const accounting = round?.task_id === taskId && round.llm_settlements !== undefined && a?.final && a.run_id === runId && terminal ? a : null;
      const completed = terminal?.status === "completed";
      const goal = useGoals.getState().items.find((g) => g.id === goalId);
      if (!completed && goal?.quota && getBackend().kind === "tauri") {
        // Preclaim recovery is read-only. Re-saving a failed checkpoint here
        // has no owned publication; validate its persisted seed instead.
        const continuation = await prepareGoalContinuation(goalId, taskId);
        const seed = continuation ? goalContinuationSeed(continuation, goal) : null;
        if (!continuation || !seed || !recoveryCardMatches(card, seed.task)) return { accounting: null, completed: null };
        return { accounting: seed.task.recovery_accounting?.final ? seed.task.recovery_accounting : null, completed: null, continuation };
      }
      if (accounting || completed) {
        if (terminal) patch(card.id, () => ({ status: terminal.status, summary: terminal.summary }));
        await checkpointGoalTask(card.id, true);
      }
      const current = get().tasks.find((t) => t.id === taskId)!;
      if (!accounting && !completed && getBackend().kind === "tauri") {
        const continuation = await prepareGoalContinuation(goalId, taskId);
        if (continuation) return { accounting: null, completed: null, continuation };
      }
      return { accounting, completed: completed ? { ...outcomeOf(current, (name) => [...(getBackend().kind === "mock" ? DEMO_TOOLS : []), ...activeMcpTools(null)].find((tool) => tool.name === name)?.sideEffect === "none"), status: "completed", llmCalls: 0, accounting } : null };
    },
    resumeGoalRound(_goal, opts, continuation) {
      const card = get().tasks.find((t) => t.id === opts.taskId && t.goalId === opts.goalId);
      if (!card || card.status === "running" || card.multi || controllers.has(card.id)) return null;
      const g = useGoals.getState().items.find(goal => goal.id === opts.goalId);
      const seed = continuation && g ? goalContinuationSeed(continuation, g) : null;
      if (continuation && !seed) return null;
      if (g?.quota && !continuation && !card.recovery_accounting?.final) return null;
      if (g?.quota && !continuation && ["running", "interrupted"].includes(g.rounds.at(-1)?.status ?? "")
        && g.rounds.at(-1)?.task_checkpoint?.status !== "completed") return null;
      if (seed) {
        // The hydrated view may add one aborted marker; every persisted event,
        // the task prompt and accounting must otherwise match the DB source.
        if (!recoveryCardMatches(card, seed.task)) return null;
      }
      const checkpoint = seed?.checkpoint ?? recoveryCheckpoint(card.events);
      if (!checkpoint) return null;
      const saved = inputs.get(card.id);
      const runOpts: SubmitOptions = saved
        ? { ...saved.opts, ...opts, onboarding: false, aligning: false, multi: false }
        : { ...opts, sessionId: card.sessionId, lock: card.lock, permission: card.permission, projectId: card.projectId, mode: "goal", multi: false, surfaceHint: card.surfaceHint };
      const files = saved?.files ?? [];
      patch(card.id, () => ({ status: "running", summary: null, endedAt: null, pendingConfirm: null, pendingPlan: null, collapsed: false, streamingText: "", streamingInterrupted: false, streamFirstChunkAt: null, streamLastChunkAt: null }));
      inputs.set(card.id, { opts: runOpts, files });
      return lazyRound(card.id, card.goal, runOpts, files, checkpoint, continuation);
    },
    close(id) {
      get().cancel(id);
      inputs.delete(id);
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
    resume(id) {
      const card = get().tasks.find((t) => t.id === id);
      if (!card || card.status === "running" || card.multi || controllers.has(id)) return false;
      const checkpoint = recoveryCheckpoint(card.events);
      if (!checkpoint) return false;
      const saved = inputs.get(id);
      const opts: SubmitOptions = saved
        ? { ...saved.opts, onboarding: false, aligning: false, multi: false }
        : {
            sessionId: card.sessionId,
            lock: card.lock,
            permission: card.permission,
            projectId: card.projectId,
            goalId: card.goalId,
            mode: card.mode,
            preference: card.preference,
            surfaceHint: card.surfaceHint,
            multi: false,
          };
      const files = saved?.files ?? [];
      patch(id, () => ({ status: "running", summary: null, endedAt: null, pendingConfirm: null, pendingPlan: null, collapsed: false, streamingText: "", streamingInterrupted: false, streamFirstChunkAt: null, streamLastChunkAt: null }));
      set({ activeId: id });
      void run(id, card.goal, opts, files, checkpoint).then(() => undefined);
      return true;
    },
    cancel(id) {
      settle(id, false);
      settlePlan(id, false);
      const controller = controllers.get(id);
      if (controller) controller.abort();
      else patch(id, (t) => (t.status === "running" ? { status: "aborted", summary: "任务在启动前被取消", endedAt: Date.now() } : {}));
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

// 会话持久化（迁移 5）：启动时读回会话和回合；运行中的回合也会保存脱敏 checkpoint，
// 这样桌面进程在工具账本关键窗口退出后，重启仍能看到「从未完成步骤继续」。确认请求、AbortController
// 这类运行时状态不持久化；恢复时重新生成参数并重新走权限闸门。写入前在 decision/session.ts 脱敏。
// 同时把每次模型调用记进 usage_calls，供「本月省了多少」跨重启统计。
import type { AgentEvent } from "@/agent";
import { HealthTracker } from "@/decision";
import type { PreferenceSource } from "@/decision/project";
import type { StoredSession, StoredTurn, UsageCall } from "@/decision/session";
import { effectiveProfiles, statusAvailability } from "@/lib/engine";
import { toAppError } from "@/lib/ipc";
import { baselineFor } from "@/lib/savings";
import { lastRoute } from "@/lib/timeline";
import { getBackend } from "@/platform";
import type { PermissionMode, Preference } from "@/decision";
import { useChat, type Session } from "./chat";
import { useSettings } from "./settings";
import { useTasks, type TaskCard, type TaskMode, type TaskStatus } from "./tasks";
import { useUsage } from "./usage";

const DONE = new Set<TaskStatus>(["completed", "failed", "aborted", "needs_user", "budget_exceeded"]);
const saving = new Map<string, Promise<unknown>>();
const recorded = new Set<string>();
let lastError: string | null = null;
export const persistError = () => lastError;

export function toStoredTurn(t: TaskCard): StoredTurn {
  return {
    id: t.id,
    seq: t.seq,
    goal: t.goal,
    status: t.status,
    summary: t.summary,
    events: t.events as unknown[],
    lock: t.lock,
    permission: t.permission,
    files: t.files,
    multi: t.multi,
    startedAt: t.startedAt,
    endedAt: t.endedAt,
    goalId: t.goalId,
    mode: t.mode,
    preference: t.preference,
    preferenceSource: t.preferenceSource,
    surfaceHint: t.surfaceHint ?? null,
  };
}

/** 读回的回合 → 任务卡片（只读回放：没有确认请求、没有运行中的状态） */
export function fromStoredTurn(t: StoredTurn, s: StoredSession): TaskCard {
  const rawEvents = t.events as AgentEvent[];
  // 进程可能在 runtime 发出 run_end 后、TaskCard 状态写回前退出。优先相信终态事件，
  // 否则把持久化的 running checkpoint 转成明确的 aborted，并补一条恢复可识别的终态事件。
  const terminal = [...rawEvents].reverse().find((e) => e?.type === "run_end") as Extract<AgentEvent, { type: "run_end" }> | undefined;
  const recoveredStatus = terminal?.status ?? t.status;
  const wasInterrupted = !terminal && t.status === "running";
  const events = wasInterrupted
    ? [...rawEvents, { type: "run_end", status: "aborted", summary: "应用在任务完成前退出，已保留执行记录，可从未完成步骤继续" } satisfies AgentEvent]
    : rawEvents;
  const status = (DONE.has(recoveredStatus as TaskStatus) ? recoveredStatus : "aborted") as TaskStatus;
  return {
    id: t.id,
    seq: t.seq,
    sessionId: s.id,
    goal: t.goal,
    status,
    collapsed: false,
    events,
    summary: t.summary ?? terminal?.summary ?? (wasInterrupted ? "应用在任务完成前退出，已保留执行记录，可从未完成步骤继续" : null),
    pendingConfirm: null,
    pendingPlan: null,
    override: null,
    lock: t.lock,
    permission: (t.permission as PermissionMode) ?? "confirm",
    onboarding: false,
    files: t.files,
    multi: t.multi,
    startedAt: t.startedAt,
    endedAt: t.endedAt ?? t.startedAt,
    proposal: null,
    projectId: s.project_id,
    goalId: t.goalId,
    mode: (t.mode as TaskMode) ?? "quick",
    preference: (t.preference as Preference) ?? "balanced",
    preferenceSource: (t.preferenceSource as PreferenceSource) ?? "global",
    surfaceHint: t.surfaceHint === "chat" || t.surfaceHint === "work" || t.surfaceHint === "codex" ? t.surfaceHint : null,
    ...(wasInterrupted ? { recoveredFromRestart: true } : {}),
  };
}

/** 启动时：读回会话列表和回合；放在已有的（本次启动新建的）后面 */
export async function loadHistory(): Promise<string | null> {
  try {
    const stored = await getBackend().listSessions();
    const sessions: Session[] = stored.map((s) => ({ id: s.id, title: s.title, projectId: s.project_id, createdAt: s.created_at, updatedAt: s.updated_at }));
    const cards = stored.flatMap((s) => s.turns.map((t) => fromStoredTurn(t, s)));
    // running checkpoint 尚未写入 usage_calls；恢复完成后要重新统计它包含的全部调用。
    for (const storedTurn of stored.flatMap((s) => s.turns)) {
      if (storedTurn.status !== "running") recorded.add(storedTurn.id);
    }
    useChat.setState((st) => ({ sessions: [...st.sessions, ...sessions.filter((x) => !st.sessions.some((y) => y.id === x.id))] }));
    useTasks.setState((st) => ({ tasks: [...st.tasks, ...cards.filter((c) => !st.tasks.some((x) => x.id === c.id))] }));
    // 有未完成 checkpoint 时直接打开对应会话，让“从未完成步骤继续”成为重启后的第一入口。
    // 只认 fromStoredTurn 标记的 running checkpoint；用户主动停止的 aborted 历史不会被强行带回。
    const recovered = cards
      .filter((c) => c.recoveredFromRestart && c.sessionId)
      .map((c) => sessions.find((s) => s.id === c.sessionId) ?? null)
      .filter((s): s is Session => s !== null)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (recovered && useChat.getState().activeId === null) {
      useChat.getState().select(recovered.id);
    }
    lastError = null;
    return null;
  } catch (e) {
    lastError = toAppError(e).message;
    return lastError;
  }
}

/** 把一个会话整条写回（含已结束回合和运行中 checkpoint）；同一会话的写入排队，后写的覆盖先写的 */
export function saveSession(id: string): Promise<unknown> {
  const prev = saving.get(id) ?? Promise.resolve();
  const next = prev
    .catch(() => {})
    .then(async () => {
      const s = useChat.getState().sessions.find((x) => x.id === id);
      if (!s) return;
      const turns = useTasks
        .getState()
        .tasks.filter((t) => t.sessionId === id && (DONE.has(t.status) || t.status === "running"))
        .sort((a, b) => a.seq - b.seq)
        .map(toStoredTurn);
      try {
        await getBackend().saveSession({ id, title: s.title, project_id: s.projectId, turns, created_at: s.createdAt, updated_at: s.updatedAt });
        lastError = null;
      } catch (e) {
        // 项目已被删除：这个会话随项目一起删了，不再写
        lastError = toAppError(e).message;
      }
    });
  saving.set(id, next);
  return next;
}

export async function deleteSession(id: string): Promise<string | null> {
  try {
    await (saving.get(id) ?? Promise.resolve()).catch(() => {});
    await getBackend().deleteSession(id);
    return null;
  } catch (e) {
    const err = toAppError(e);
    return err.code === "session_not_found" ? null : err.message;
  }
}

/** 一轮结束后：记下这一轮的模型调用（每个任务只记一次；目标模式的轮次也算） */
export async function recordTurnUsage(t: TaskCard): Promise<void> {
  if (recorded.has(t.id)) return;
  recorded.add(t.id);
  const s = useSettings.getState();
  const profiles = effectiveProfiles(s.overrides, s.custom);
  const availability = statusAvailability(s.statuses, s.custom, new HealthTracker(), s.providerPrefs);
  const decision = lastRoute(t.events)?.decision ?? null;
  const baseline = decision ? baselineFor(decision, profiles, availability) : null;
  const calls: UsageCall[] = [];
  let i = 0;
  for (const outer of t.events) {
    const e = outer.type === "subagent" ? outer.event : outer;
    if (e.type !== "llm" || !e.usage) continue;
    calls.push({
      id: `${t.id}-${i++}`,
      session_id: t.sessionId,
      task_id: t.id,
      goal_id: t.goalId,
      project_id: t.projectId,
      profile_id: e.profileId,
      input_tokens: e.usage.inputTokens,
      output_tokens: e.usage.outputTokens,
      baseline_profile_id: baseline,
      created_at: t.startedAt,
    });
  }
  try {
    await getBackend().recordUsage(calls);
    useUsage.getState().add(calls);
  } catch (e) {
    lastError = toAppError(e).message;
  }
}

/** 订阅：运行中事件和终态都写回会话；任务结束时另记调用。返回取消订阅 */
export function watchHistory(): () => void {
  const seen = new Map<string, { status: TaskStatus; events: number; sessionId: string | null }>();
  for (const t of useTasks.getState().tasks) seen.set(t.id, { status: t.status, events: t.events.length, sessionId: t.sessionId });
  return useTasks.subscribe((st) => {
    const present = new Set<string>();
    for (const t of st.tasks) {
      present.add(t.id);
      const before = seen.get(t.id);
      const statusChanged = before?.status !== t.status;
      const eventsChanged = before?.events !== t.events.length;
      seen.set(t.id, { status: t.status, events: t.events.length, sessionId: t.sessionId });
      if (t.sessionId && (statusChanged || (t.status === "running" && eventsChanged))) {
        // 运行中也写回脱敏事件；saveSession 的队列会把快速连续事件串行化。
        void saveSession(t.sessionId);
      }
      if (DONE.has(t.status) && before?.status !== t.status) {
        // 目标模式的轮次不属于会话（不写 sessions），但调用照样记进 usage_calls。
        void recordTurnUsage(t);
      }
    }
    // 关闭一张仍在运行的任务卡时，清掉已经写入的 running checkpoint；已结束历史仍保留。
    for (const [id, before] of seen) {
      if (present.has(id)) continue;
      if (before.status === "running" && before.sessionId) void saveSession(before.sessionId);
      seen.delete(id);
    }
  });
}

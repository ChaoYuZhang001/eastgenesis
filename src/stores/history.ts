// 会话持久化（迁移 5）：启动时读回会话和它们已结束的回合；每轮结束、改标题、删除时整条写回。
// 只存已结束的回合（进行中的不存：确认请求、AbortController 这些运行时状态存不了）。写入前在 decision/session.ts 脱敏。
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
  };
}

/** 读回的回合 → 任务卡片（只读回放：没有确认请求、没有运行中的状态） */
export function fromStoredTurn(t: StoredTurn, s: StoredSession): TaskCard {
  const status = (DONE.has(t.status as TaskStatus) ? t.status : "aborted") as TaskStatus;
  return {
    id: t.id,
    seq: t.seq,
    sessionId: s.id,
    goal: t.goal,
    status,
    collapsed: false,
    events: t.events as AgentEvent[],
    summary: t.summary,
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
  };
}

/** 启动时：读回会话列表和回合；放在已有的（本次启动新建的）后面 */
export async function loadHistory(): Promise<string | null> {
  try {
    const stored = await getBackend().listSessions();
    const sessions: Session[] = stored.map((s) => ({ id: s.id, title: s.title, projectId: s.project_id, createdAt: s.created_at, updatedAt: s.updated_at }));
    const cards = stored.flatMap((s) => s.turns.map((t) => fromStoredTurn(t, s)));
    for (const c of cards) recorded.add(c.id);
    useChat.setState((st) => ({ sessions: [...st.sessions, ...sessions.filter((x) => !st.sessions.some((y) => y.id === x.id))] }));
    useTasks.setState((st) => ({ tasks: [...st.tasks, ...cards.filter((c) => !st.tasks.some((x) => x.id === c.id))] }));
    lastError = null;
    return null;
  } catch (e) {
    lastError = toAppError(e).message;
    return lastError;
  }
}

/** 把一个会话整条写回（只含已结束的回合）；同一会话的写入排队，后写的覆盖先写的 */
export function saveSession(id: string): Promise<unknown> {
  const prev = saving.get(id) ?? Promise.resolve();
  const next = prev
    .catch(() => {})
    .then(async () => {
      const s = useChat.getState().sessions.find((x) => x.id === id);
      if (!s) return;
      const turns = useTasks
        .getState()
        .tasks.filter((t) => t.sessionId === id && DONE.has(t.status))
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

/** 一轮结束后：记下这一轮的模型调用（每个任务只记一次） */
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

/** 订阅：任务从进行中变为结束时写回会话、记调用。返回取消订阅 */
export function watchHistory(): () => void {
  const seen = new Map<string, TaskStatus>();
  for (const t of useTasks.getState().tasks) seen.set(t.id, t.status);
  return useTasks.subscribe((st) => {
    for (const t of st.tasks) {
      const before = seen.get(t.id);
      seen.set(t.id, t.status);
      if (before === "running" && DONE.has(t.status) && t.sessionId) {
        void saveSession(t.sessionId);
        void recordTurnUsage(t);
      }
    }
  });
}

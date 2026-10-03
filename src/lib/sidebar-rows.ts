// 内容栏的行（docs/UI_LAYOUT_V3.md 1.2）：项目、目标、会话三种，第二行是路由摘要。
// 只有纯函数，界面在 components/layout/ContentPanel.tsx。
import type { AgentEvent } from "@/agent";
import { GOAL_STATUS_LABEL, goalPhase, type Goal } from "@/decision/goal";
import { PREFERENCE_SOURCE_LABEL, preferenceSource, type Project } from "@/decision/project";
import type { Preference } from "@/decision";
import type { Session } from "@/stores/chat";
import type { TaskCard } from "@/stores/tasks";
import { displayModel } from "./route-summary";

export const PREFERENCE_LABEL: Record<Preference, string> = { economy: "省钱", balanced: "平衡", best: "最强" };

/** 一个任务里用过的模型（按首次出现），子 Agent 的调用也算 */
export function modelsOf(events: readonly AgentEvent[]): string[] {
  const out: string[] = [];
  for (const outer of events) {
    const e = outer.type === "subagent" ? outer.event : outer;
    if (e.type === "llm" && !out.includes(e.profileId)) out.push(e.profileId);
  }
  return out;
}

/** 项目行的第二行：生效的偏好；来源放悬停提示 */
export function projectSummary(p: Project, global: Preference): { text: string; title: string } {
  const { preference, source } = preferenceSource(null, null, p, global);
  return { text: PREFERENCE_LABEL[preference], title: `路由偏好：${PREFERENCE_LABEL[preference]}（来自${PREFERENCE_SOURCE_LABEL[source]}）` };
}

/** 目标行的第二行：状态；最后一轮拿不准时写「等你确认」 */
export function goalSummary(g: Goal): string {
  const phase = goalPhase(g);
  if (phase === "awaiting_user") return "等你确认";
  const label = GOAL_STATUS_LABEL[g.status];
  return g.rounds.length ? `${label} · 第 ${g.rounds.length} 轮` : label;
}

/** 会话行的第二行：主要模型；几个模型时写个数；还在执行时前面加「进行中」 */
export function sessionSummary(tasks: readonly TaskCard[]): string {
  const models: string[] = [];
  for (const t of tasks) for (const m of modelsOf(t.events)) if (!models.includes(m)) models.push(m);
  const running = tasks.some((t) => t.status === "running");
  const what = models.length === 0 ? (running ? "" : "没有调用模型") : models.length === 1 ? displayModel(models[0]) : `${models.length} 个模型`;
  return running ? (what ? `进行中 · ${what}` : "进行中") : what;
}

/** 「最近」组：会话和目标混排，按最近更新，最多 n 条 */
export type RecentItem = { kind: "session"; session: Session; at: number } | { kind: "goal"; goal: Goal; at: number };
export function recentItems(sessions: readonly Session[], goals: readonly Goal[], n = 20): RecentItem[] {
  const all: RecentItem[] = [
    ...sessions.map((s) => ({ kind: "session" as const, session: s, at: s.updatedAt })),
    ...goals.map((g) => ({ kind: "goal" as const, goal: g, at: g.updated_at })),
  ];
  return all.sort((a, b) => b.at - a.at).slice(0, n);
}

/** 历史视图的分组：今天 / 昨天 / 7 天内 / 更早（本地时区） */
export type HistoryBucket = "today" | "yesterday" | "week" | "older";
export const HISTORY_LABEL: Record<HistoryBucket, string> = { today: "今天", yesterday: "昨天", week: "7 天内", older: "更早" };
export function historyBucket(at: number, now: number): HistoryBucket {
  const d = new Date(now);
  const today = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  if (at >= today) return "today";
  if (at >= today - 86_400_000) return "yesterday";
  if (at >= today - 7 * 86_400_000) return "week";
  return "older";
}

export const matches = (text: string, q: string) => !q.trim() || text.toLowerCase().includes(q.trim().toLowerCase());

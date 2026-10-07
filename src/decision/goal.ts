import type { GoalQuotaProjection, GoalQuotaPublication } from "@/lib/goal-quota-storage";
// 目标：一个可以跑多轮的长任务。状态机、轮次和完成校验的数据结构，桌面端（lib/db-goal.ts）和浏览器模式（platform/mock-goal.ts）共用。
// 合法转换：idle → running；running → paused；paused → running；running → completed；running → failed（超过 max_llm_calls 或校验连续失败 3 次）；
// running → abandoned；paused → abandoned；任意状态 → deleted（软删除）。非法转换抛错。
// 每一轮：startRound（计划）→ updateItem / appendEvidence / recordLlmCalls（执行）→ finishRound（校验结论）或 failRound（执行出错）。
// 校验结论是 uncertain 时目标停在「等你确认」，不自动开下一轮，也不自动结束，由 resolveUncertain 处理。
import { redact } from "../core/redact";
import { emptyEvidence, sanitizeEvidence, type Evidence, type EvidenceResult, type EvidenceVerdict } from "./evidence";
import { PROJECT_ID, cleanLine, cleanText, fail, looksSecret, newId, normalizePreference, type ProjectError } from "./project";
import type { Preference } from "./router";
import { ACCOUNTING_CALL_LIMIT, ACCOUNTING_RUN_ID, normalizeRecoveryAccounting, normalizeTurn, type StoredTurn } from "./session";

export type GoalStatus = "idle" | "running" | "paused" | "completed" | "failed" | "abandoned" | "deleted";
export const GOAL_STATUSES: readonly GoalStatus[] = ["idle", "running", "paused", "completed", "failed", "abandoned", "deleted"];
export const GOAL_STATUS_LABEL: Record<GoalStatus, string> = {
  idle: "未开始",
  running: "进行中",
  paused: "已暂停",
  completed: "已完成",
  failed: "失败",
  abandoned: "已放弃",
  deleted: "已删除",
};

/** running：执行中；done / not_done / uncertain：校验结论；failed：执行出错；interrupted：暂停、放弃或删除时被打断 */
export type RoundStatus = "running" | "done" | "not_done" | "uncertain" | "failed" | "interrupted";
export const ROUND_STATUSES: readonly RoundStatus[] = ["running", "done", "not_done", "uncertain", "failed", "interrupted"];
export type ItemStatus = "pending" | "running" | "done" | "failed" | "skipped";
export const ITEM_STATUSES: readonly ItemStatus[] = ["pending", "running", "done", "failed", "skipped"];

export interface GoalItem {
  id: string;
  text: string;
  status: ItemStatus;
}

/** 这一轮的结论。by：rules / jev 来自 checkDoneWithEvidence，user 是你在「等你确认」时的选择，runtime 是执行出错 */
export interface RoundVerdict {
  verdict: EvidenceVerdict;
  reason: string;
  confidence?: number;
  by: "rules" | "jev" | "user" | "runtime";
}

export interface LlmSettlement { run_id: string; llm_calls: number }
export interface GoalRound {
  /** 从 1 开始 */
  index: number;
  title: string;
  items: GoalItem[];
  status: RoundStatus;
  evidence: Evidence;
  verdict: RoundVerdict | null;
  /** 执行这一轮的任务 id；M9 之前存下的轮次没有这个字段，读回时为 null */
  task_id: string | null;
  /** 脱敏后的任务账本快照。崩溃恢复只能复用这个任务，不得凭空新开一轮。 */
  task_checkpoint?: StoredTurn | null;
  /** 每次完整运行的绝对计数凭据；与 used_llm_calls 在同一次 Goal 保存中更新。 */
  llm_settlements?: LlmSettlement[];
  /** 应用在这一轮执行期间退出时写入；用户暂停/放弃不会填这个字段。 */
  interruption_reason?: string;
  started_at: number;
  finished_at: number | null;
}
export interface Goal {
  /** New desktop protocol: canonical occupied permits, never reconstructed from main receipts. */
  quota?: GoalQuotaProjection;
  id: string;
  /** null：不属于任何项目 */
  project_id: string | null;
  description: string;
  /** 目标级说明，按「任务 > 目标 > 项目」叠加（project.ts resolveInstructions） */
  instructions: string;
  /** null：不覆盖，沿用项目或全局设置 */
  routing_preference: Preference | null;
  status: GoalStatus;
  rounds: GoalRound[];
  max_llm_calls: number;
  used_llm_calls: number;
  created_at: number;
  updated_at: number;
}

/** 新建时不带 id；编辑时带 id，没给的字段保持原值 */
export interface GoalInput {
  id?: string;
  project_id?: string | null;
  description?: string;
  instructions?: string;
  routing_preference?: Preference | null;
  max_llm_calls?: number;
}

export const MAX_GOALS = 500;
export const MAX_GOAL_DESC = 2000;
export const MAX_GOAL_INSTRUCTIONS = 4000;
export const DEFAULT_MAX_LLM_CALLS = 50;
export const MAX_LLM_CALLS_LIMIT = 500;
/** 额外的安全上限：每轮至少一次模型调用，正常情况下先碰到 max_llm_calls；手动确认「继续」不花调用，用它兜底 */
export const MAX_ROUNDS = 100;
export const MAX_ROUND_ITEMS = 30;
export const MAX_ITEM_TEXT = 300;
export const MAX_ROUND_TITLE = 100;
export const MAX_REASON = 500;
/** 校验连续失败几轮就判失败 */
export const FAIL_STREAK = 3;
export const GOAL_ID = /^goal-[a-z0-9-]{1,48}$/;
/** 执行一轮的任务 id（stores/tasks.ts 的 TaskCard.id，形如 task-<uuid>）：轮次据此关联到任务卡 */
export const TASK_ID = /^task-[a-z0-9-]{1,48}$/;
/** 启动恢复时写入的固定原因；UI 用它区分崩溃恢复和用户主动暂停。 */
export const RESTART_INTERRUPTION_REASON = "应用在目标执行期间退出，上一轮已暂停；继续前会重新检查未完成步骤";

const bad = (message: string) => fail("invalid_goal", message);
export const goalNotFound = () => fail("goal_not_found", "没有找到这个目标");
export const goalFull = () => fail("goal_full", `最多保存 ${MAX_GOALS} 个目标，请先删除一些`);
export const invalidGoalId = () => fail("invalid_goal_id", "目标 ID 无效");
const badTransition = (from: GoalStatus, to: GoalStatus) =>
  fail("invalid_goal_transition", `目标${GOAL_STATUS_LABEL[from]}，不能改为「${GOAL_STATUS_LABEL[to]}」`);
const badRound = (message: string) => fail("invalid_goal_round", message);

// ---------- 状态机 ----------

const TRANSITIONS: Record<GoalStatus, readonly GoalStatus[]> = {
  idle: ["running", "deleted"],
  running: ["paused", "completed", "failed", "abandoned", "deleted"],
  paused: ["running", "abandoned", "deleted"],
  completed: ["deleted"],
  failed: ["deleted"],
  abandoned: ["deleted"],
  deleted: [],
};
export const isGoalStatus = (v: unknown): v is GoalStatus => typeof v === "string" && (GOAL_STATUSES as readonly string[]).includes(v);
const isStatus = isGoalStatus;
export const canTransition = (from: GoalStatus, to: GoalStatus) => TRANSITIONS[from]?.includes(to) ?? false;

export type FailCause = "budget" | "streak" | "rounds";
export const FAIL_CAUSE_LABEL: Record<FailCause, string> = {
  budget: "模型调用次数用完",
  streak: `校验连续 ${FAIL_STREAK} 轮没通过`,
  rounds: `轮数达到上限（${MAX_ROUNDS} 轮）`,
};

/** 从最后一轮往前数连续没通过（not_done 或执行出错）的轮数；你确认过的、被打断的、等你确认的都会中断计数 */
export function failStreak(g: Pick<Goal, "rounds">): number {
  let n = 0;
  for (let i = g.rounds.length - 1; i >= 0; i--) {
    const r = g.rounds[i];
    if (r.status === "running") continue;
    if ((r.status === "not_done" || r.status === "failed") && r.verdict?.by !== "user") n++;
    else break;
  }
  return n;
}

/** 目标该判失败的原因；null 表示还可以继续 */
export function failCause(g: Pick<Goal, "rounds" | "max_llm_calls" | "used_llm_calls">): FailCause | null {
  if (g.used_llm_calls >= g.max_llm_calls) return "budget";
  if (failStreak(g) >= FAIL_STREAK) return "streak";
  if (g.rounds.length >= MAX_ROUNDS) return "rounds";
  return null;
}
export const remainingLlmCalls = (g: Pick<Goal, "max_llm_calls" | "used_llm_calls">) => Math.max(0, g.max_llm_calls - g.used_llm_calls);

/** 只用于展示已保存的调用统计；不授权预算，也不补记缺失的历史凭据。 */
export function hasUnknownGoalCalls(g: Pick<Goal, "id" | "status" | "rounds">): boolean {
  return g.rounds.some((r) => {
    if (r.llm_settlements === undefined) return true;
    const checkpoint = r.task_checkpoint;
    if (!checkpoint) return g.status !== "running" || r.status !== "running";
    if (!r.task_id || checkpoint.id !== r.task_id || checkpoint.goalId !== g.id) return true;
    const accounting = normalizeRecoveryAccounting(checkpoint.recovery_accounting, r.task_id);
    if (!accounting) return true;
    const active = g.status === "running" && r.status === "running";
    // 正常运行中的下界还在增长；停止后的非终态记录不能冒充完整历史。
    if (!accounting.final) return !(active && checkpoint.status === "running");
    let latestRun: unknown;
    let terminal = false;
    for (let i = checkpoint.events.length - 1; i >= 0; i--) {
      const event = checkpoint.events[i];
      if (!event || typeof event !== "object") continue;
      const e = event as Record<string, unknown>;
      if (e.type === "run_end") terminal = true;
      if (e.type === "run_start") { latestRun = e.runId; break; }
    }
    if (!terminal || latestRun !== accounting.run_id) return true;
    // 当前运行的终态可能正在结算；不能因此把 live 运行误标成旧历史未知。
    if (active) return false;
    return !r.llm_settlements.some((receipt) => receipt.run_id === accounting.run_id && receipt.llm_calls === accounting.llm_calls);
  });
}

/** 进行中的目标再细分：working 正在跑一轮；ready 可以开下一轮；awaiting_user 上一轮结论是 uncertain，等你确认 */
export type GoalPhase = Exclude<GoalStatus, "running"> | "working" | "ready" | "awaiting_user";
export const lastRound = (g: Pick<Goal, "rounds">): GoalRound | undefined => g.rounds[g.rounds.length - 1];
export function goalPhase(g: Pick<Goal, "status" | "rounds">): GoalPhase {
  if (g.status !== "running") return g.status;
  const r = lastRound(g);
  if (r?.status === "running") return "working";
  if (r?.status === "uncertain") return "awaiting_user";
  return "ready";
}

/** 下一轮的提示：上一轮判定「未达成」时给出的原因（就是这一轮该解决的事）。没有上一轮或上一轮不是未达成时返回 null */
export function nextRoundHint(g: Pick<Goal, "rounds">): string | null {
  const v = lastRound(g)?.verdict;
  if (!v || v.verdict !== "not_done") return null;
  return clip(v.reason, MAX_ROUND_TITLE);
}

const interrupt = (r: GoalRound, now: number): GoalRound =>
  r.status === "running"
    ? { ...r, status: "interrupted", finished_at: now, items: r.items.map((i) => (i.status === "running" ? { ...i, status: "pending" } : i)) }
    : r;

/**
 * 页面进程退出后恢复目标状态。
 *
 * 目标轮次已经先写入 goals.rounds，再开始实际任务；如果进程在任务结束前退出，
 * 数据库里会留下 status=running 的目标或 running 的最后一轮。启动时把它转换为
 * 可继续的 paused/interrupted，而不是让 UI 永远显示“进行中”且没有任务卡。
 * 这不会自动重放步骤；下一次点击“继续”会重新走账本探测和权限闸门。
 */
export function recoverGoalAfterRestart(g: Goal, now: number): Goal {
  if (g.status !== "running") return g;
  const r = lastRound(g);
  // uncertain 表示已经正常停下来等用户裁决，不是进程退出的 checkpoint。
  if (r && r.status !== "running") return g;
  const rounds = r?.status === "running"
    ? [...g.rounds.slice(0, -1), {
        ...interrupt(r, now),
        interruption_reason: RESTART_INTERRUPTION_REASON,
      }]
    : g.rounds;
  return { ...g, status: "paused", rounds, updated_at: now };
}

/** 是否是本次启动刚刚恢复的目标；不把普通暂停或用户主动中断当成崩溃恢复。 */
export function wasGoalInterruptedByRestart(g: Goal): boolean {
  const last = lastRound(g);
  return g.status === "paused" && last?.status === "interrupted" && last.interruption_reason === RESTART_INTERRUPTION_REASON;
}

/**
 * 改状态。completed 要求最后一轮校验通过；failed 要求有失败原因（failCause）；
 * 暂停、放弃、删除时打断正在跑的一轮。已删除的再删一次不变（幂等）。
 */
export function transitionGoal(g: Goal, to: GoalStatus, now: number): Goal {
  if (!isStatus(to)) throw bad("目标状态无效");
  if (g.status === "deleted" && to === "deleted") return g;
  if (!canTransition(g.status, to)) throw badTransition(g.status, to);
  if (to === "completed" && lastRound(g)?.status !== "done") throw badTransition(g.status, to);
  if (to === "failed" && !failCause(g)) throw badTransition(g.status, to);
  const rounds = to === "paused" || to === "abandoned" || to === "deleted" ? g.rounds.map((r) => interrupt(r, now)) : g.rounds;
  return { ...g, status: to, rounds, updated_at: now };
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
/** 计划里的文字来自模型：规整、脱敏、截断 */
const planText = (s: unknown, n: number) => clip(redact(cleanLine(s)), n);
const needRunning = (g: Goal) => {
  if (g.status !== "running") throw badRound(`目标${GOAL_STATUS_LABEL[g.status]}，不能执行`);
};

export interface RoundPlan {
  title?: string;
  items?: readonly string[];
  /** 执行这一轮的任务 id；界面用它把轮次和任务卡关联起来（展开这一轮能看到当时的执行过程） */
  task_id?: string;
}

/** 开始新一轮。上一轮还在跑或在等你确认时不能开；已经到了失败条件时抛 goal_exhausted，调用方改成 failed */
export function startRound(g: Goal, plan: RoundPlan, now: number): Goal {
  needRunning(g);
  const phase = goalPhase(g);
  if (phase === "working") throw badRound("上一轮还没结束");
  if (phase === "awaiting_user") throw badRound("上一轮在等你确认，确认后才能开始下一轮");
  const cause = failCause(g);
  if (cause) throw fail("goal_exhausted", `不能开始新一轮：${FAIL_CAUSE_LABEL[cause]}`);
  const index = g.rounds.length + 1;
  const texts = (Array.isArray(plan.items) ? plan.items : []).map((t) => planText(t, MAX_ITEM_TEXT)).filter(Boolean).slice(0, MAX_ROUND_ITEMS);
  const round: GoalRound = {
    index,
    title: planText(plan.title, MAX_ROUND_TITLE) || `第 ${index} 轮`,
    items: texts.map((text, i) => ({ id: `r${index}-${i + 1}`, text, status: "pending" })),
    status: "running",
    evidence: emptyEvidence(),
    verdict: null,
    task_id: typeof plan.task_id === "string" && TASK_ID.test(plan.task_id) ? plan.task_id : null,
    ...(typeof plan.task_id === "string" && TASK_ID.test(plan.task_id) ? { llm_settlements: [] } : {}),
    started_at: now,
    finished_at: null,
  };
  return { ...g, rounds: [...g.rounds, round], updated_at: now };
}

const replaceLast = (g: Goal, r: GoalRound, now: number, extra: Partial<Goal> = {}): Goal => ({ ...g, ...extra, rounds: [...g.rounds.slice(0, -1), r], updated_at: now });
const runningRound = (g: Goal): GoalRound => {
  needRunning(g);
  const r = lastRound(g);
  if (!r || r.status !== "running") throw badRound("没有正在执行的一轮");
  return r;
};
const addEvidence = (r: GoalRound, e: unknown): Evidence => {
  const add = sanitizeEvidence(e);
  return sanitizeEvidence({
    tool_calls: [...r.evidence.tool_calls, ...add.tool_calls],
    file_changes: [...r.evidence.file_changes, ...add.file_changes],
    command_outputs: [...r.evidence.command_outputs, ...add.command_outputs],
    claim: add.claim ?? r.evidence.claim,
  });
};

/** 整轮替换步骤清单：一轮跑完后按实际执行的步骤记账（序号和状态都来自执行记录）。
 *  只认文本和状态；条数和每条长度按 startRound 的上限截断 */
export function setRoundItems(g: Goal, items: readonly { text: string; status: ItemStatus }[], now: number): Goal {
  const r = runningRound(g);
  const list = (Array.isArray(items) ? items : [])
    .map((it, i) => ({
      id: `r${r.index}-${i + 1}`,
      text: planText(it?.text, MAX_ITEM_TEXT),
      status: (ITEM_STATUSES as readonly unknown[]).includes(it?.status) ? (it.status as ItemStatus) : "skipped",
    }))
    .filter((it) => it.text)
    .slice(0, MAX_ROUND_ITEMS);
  return replaceLast(g, { ...r, items: list }, now);
}

export function updateItem(g: Goal, itemId: string, status: ItemStatus, now: number): Goal {
  if (!(ITEM_STATUSES as readonly string[]).includes(status)) throw badRound("步骤状态无效");
  const r = runningRound(g);
  if (!r.items.some((i) => i.id === itemId)) throw badRound("没有这个步骤");
  return replaceLast(g, { ...r, items: r.items.map((i) => (i.id === itemId ? { ...i, status } : i)) }, now);
}

/** 执行过程中追加实据。暂停时被打断的那一轮仍可补记（已经发出去的工具调用结果不丢） */
export function appendEvidence(g: Goal, e: unknown, now: number): Goal {
  const r = lastRound(g);
  const open = r && (r.status === "running" || (r.status === "interrupted" && (g.status === "paused" || g.status === "abandoned")));
  if (!r || !open || !(g.status === "running" || g.status === "paused" || g.status === "abandoned")) throw badRound("没有可以记录实据的一轮");
  return replaceLast(g, { ...r, evidence: addEvidence(r, e) }, now);
}

/** 记录模型调用次数。暂停或结束后才返回的调用也要记上（钱已经花了）；已删除的不记 */
export function recordLlmCalls(g: Goal, n: number, now: number, identity?: { task_id: string; run_id: string }): Goal {
  if (identity) {
    if (!Number.isInteger(n) || n < 0 || n > ACCOUNTING_CALL_LIMIT || !TASK_ID.test(identity.task_id) || !ACCOUNTING_RUN_ID.test(identity.run_id)) throw badRound("调用结算身份或次数无效");
    if (g.status === "deleted") throw goalNotFound();
    const index = g.rounds.findIndex((r) => r.task_id === identity.task_id);
    if (index < 0) throw badRound("调用结算不属于这个目标");
    const r = g.rounds[index];
    const receipts = r.llm_settlements;
    if (!receipts) throw badRound("历史运行调用结算未知，不能自动补记或分配预算");
    const previous = receipts.find((x) => x.run_id === identity.run_id);
    // 已存在的完整凭据可幂等重送，包括下一次恢复已经替换 checkpoint 的情况。
    if (previous) {
      if (previous.llm_calls !== n) throw badRound("同一运行的调用结算次数不一致");
      return g;
    }
    const checkpoint = r.task_checkpoint;
    const a = normalizeRecoveryAccounting(checkpoint?.recovery_accounting, identity.task_id);
    let terminal = false;
    let latestRun: unknown;
    for (let i = (checkpoint?.events.length ?? 0) - 1; i >= 0; i--) {
      const event = checkpoint!.events[i];
      if (!event || typeof event !== "object") continue;
      const e = event as Record<string, unknown>;
      if (e.type === "run_end") terminal = true;
      if (e.type === "run_start") { latestRun = e.runId; break; }
    }
    if (!checkpoint || checkpoint.id !== identity.task_id || checkpoint.goalId !== g.id || !a?.final || !terminal || latestRun !== a.run_id || a.run_id !== identity.run_id || a.llm_calls !== n) throw badRound("完整调用结算记录尚未保存，请检查本地存储后继续");
    if (receipts.length >= ACCOUNTING_CALL_LIMIT) throw badRound("调用结算记录达到上限");
    const rounds = g.rounds.map((round, i) => i === index ? { ...round, llm_settlements: [...receipts, { run_id: identity.run_id, llm_calls: n }] } : round);
    return { ...g, rounds, used_llm_calls: g.quota ? g.used_llm_calls : g.used_llm_calls + n, updated_at: now };
  }
  if (g.quota) throw badRound("新目标的额度只由持久许可账本计量，主模型结算必须带原任务和运行身份");
  if (!Number.isInteger(n) || n < 1 || n > MAX_LLM_CALLS_LIMIT) throw badRound("调用次数无效");
  if (g.status === "deleted") throw goalNotFound();
  return { ...g, used_llm_calls: g.used_llm_calls + n, updated_at: now };
}

function normalizeVerdict(v: Partial<RoundVerdict>, by?: RoundVerdict["by"]): RoundVerdict {
  const verdict = v.verdict;
  if (verdict !== "done" && verdict !== "not_done" && verdict !== "uncertain") throw badRound("校验结论无效");
  const src = by ?? v.by;
  if (src !== "rules" && src !== "jev" && src !== "user" && src !== "runtime") throw badRound("校验来源无效");
  const out: RoundVerdict = { verdict, reason: planText(v.reason, MAX_REASON) || "（没有说明）", by: src };
  if (typeof v.confidence === "number" && v.confidence >= 0 && v.confidence <= 1) out.confidence = v.confidence;
  return out;
}

/**
 * 用校验结论结束这一轮（结论来自 DecisionLayer.checkDoneWithEvidence）。
 * done → 目标完成；uncertain → 停下等你确认；not_done → 达到失败条件时目标失败，否则可以开下一轮。
 */
export function finishRound(g: Goal, result: EvidenceResult | RoundVerdict, now: number, evidence?: unknown): Goal {
  const r = runningRound(g);
  const verdict = normalizeVerdict(result);
  const closed: GoalRound = { ...r, status: verdict.verdict, verdict, evidence: evidence === undefined ? r.evidence : addEvidence(r, evidence), finished_at: now };
  const next = replaceLast(g, closed, now);
  if (verdict.verdict === "done") return transitionGoal(next, "completed", now);
  if (verdict.verdict === "not_done" && failCause(next)) return transitionGoal(next, "failed", now);
  return next;
}

/** 这一轮执行出错（模型不可用、工具异常等）：计入连续失败，避免一直重试 */
export function failRound(g: Goal, message: string, now: number, evidence?: unknown): Goal {
  const r = runningRound(g);
  const verdict: RoundVerdict = { verdict: "not_done", reason: `执行出错：${planText(message, MAX_REASON - 6) || "未知错误"}`, by: "runtime" };
  const closed: GoalRound = {
    ...r,
    status: "failed",
    verdict,
    evidence: evidence === undefined ? r.evidence : addEvidence(r, evidence),
    items: r.items.map((i) => (i.status === "running" ? { ...i, status: "failed" } : i)),
    finished_at: now,
  };
  const next = replaceLast(g, closed, now);
  return failCause(next) ? transitionGoal(next, "failed", now) : next;
}

/** 你在「AI 声称完成，但无实据」时的选择：done 确认完成；continue 再跑一轮（到了失败条件时目标失败） */
export function resolveUncertain(g: Goal, choice: "done" | "continue", now: number): Goal {
  needRunning(g);
  const r = lastRound(g);
  if (!r || r.status !== "uncertain") throw badRound("没有等你确认的一轮");
  if (choice !== "done" && choice !== "continue") throw badRound("确认选项无效");
  const ai = r.verdict?.reason ? `（AI 的判断：${r.verdict.reason}）` : "";
  const verdict: RoundVerdict = {
    verdict: choice === "done" ? "done" : "not_done",
    reason: clip(`${choice === "done" ? "你确认已完成" : "你选择继续"}${ai}`, MAX_REASON),
    by: "user",
  };
  const next = replaceLast(g, { ...r, status: verdict.verdict, verdict }, now);
  if (choice === "done") return transitionGoal(next, "completed", now);
  return failCause(next) ? transitionGoal(next, "failed", now) : next;
}

/** 将任务快照写入当前轮次；快照只能属于当前目标和当前任务，避免串目标恢复。 */
export function checkpointRound(g: Goal, task: StoredTurn, now: number): Goal {
  const r = lastRound(g);
  if (!r || !task || task.goalId !== g.id || task.id !== r.task_id || !TASK_ID.test(task.id)) throw badRound("任务恢复记录与目标轮次不匹配");
  if (g.status === "deleted" || (r.status !== "running" && r.status !== "interrupted")) throw badRound("当前轮次不能写入恢复记录");
  return replaceLast(g, { ...r, task_checkpoint: task }, now);
}

/** 重启恢复时重新打开原轮次；不接受没有 checkpoint 的轮次。 */
export function resumeRound(g: Goal, now: number): Goal {
  needRunning(g);
  const r = lastRound(g);
  if (!r || r.status !== "interrupted" || !r.task_id || !r.task_checkpoint) throw badRound("这一轮缺少可验证的恢复记录");
  return replaceLast(g, { ...r, status: "running", interruption_reason: undefined, finished_at: null }, now);
}

// ---------- 新建与编辑 ----------

export interface NormalizedGoal {
  project_id: string | null;
  description: string;
  instructions: string;
  routing_preference: Preference | null;
  max_llm_calls: number;
}

/** 规整并校验；错误信息不回显内容 */
export function normalizeGoal(p: GoalInput): NormalizedGoal {
  const description = cleanText(p.description);
  const instructions = cleanText(p.instructions);
  if (!description || description.length > MAX_GOAL_DESC) throw bad(`目标描述应为 1–${MAX_GOAL_DESC} 个字符`);
  if (instructions.length > MAX_GOAL_INSTRUCTIONS) throw bad(`目标说明最多 ${MAX_GOAL_INSTRUCTIONS} 个字符`);
  if ([description, instructions].some(looksSecret)) throw bad("内容看起来包含密钥或令牌，不能保存");
  const max = p.max_llm_calls ?? DEFAULT_MAX_LLM_CALLS;
  if (!Number.isInteger(max) || max < 1 || max > MAX_LLM_CALLS_LIMIT) throw bad(`模型调用上限应为 1–${MAX_LLM_CALLS_LIMIT} 的整数`);
  const project_id = p.project_id ?? null;
  if (project_id !== null && !PROJECT_ID.test(project_id)) throw fail("invalid_project_id", "项目 ID 无效");
  return { project_id, description, instructions, routing_preference: normalizePreference(p.routing_preference), max_llm_calls: max };
}

export const newGoalId = () => newId("goal");

export function newGoal(n: NormalizedGoal, now: number, id = newGoalId()): Goal {
  return { id, ...n, status: "idle", rounds: [], used_llm_calls: 0, created_at: now, updated_at: now };
}

/** 编辑：只能改未结束的目标；没给的字段保持原值；不能换项目；调用上限不能低于已用次数 */
export function editGoal(g: Goal, p: GoalInput, now: number): Goal {
  if (g.quota && p.max_llm_calls !== undefined && p.max_llm_calls !== g.max_llm_calls) throw fail("quota_cap_fixed", "本目标调用额度创建时固定，当前版本不支持修改");
  if (g.status !== "idle" && g.status !== "running" && g.status !== "paused") throw fail("goal_locked", `目标${GOAL_STATUS_LABEL[g.status]}，不能再编辑`);
  const n = normalizeGoal({
    project_id: p.project_id === undefined ? g.project_id : p.project_id,
    description: p.description ?? g.description,
    instructions: p.instructions ?? g.instructions,
    routing_preference: p.routing_preference === undefined ? g.routing_preference : p.routing_preference,
    max_llm_calls: p.max_llm_calls ?? g.max_llm_calls,
  });
  if (n.project_id !== g.project_id) throw bad("目标不能换到别的项目");
  if (n.max_llm_calls < g.used_llm_calls) throw bad(`已经用了 ${g.used_llm_calls} 次模型调用，上限不能更低`);
  return { ...g, ...n, updated_at: now };
}

// ---------- 存储共用 ----------

/** updateGoal 的操作：桌面端和浏览器模式都在读出当前值后调用 applyGoalChange，再写回 */
type GoalChangeOperation =
  | { op: "transition"; to: GoalStatus }
  /** 应用启动时把没有完成终态的目标轮次转成可继续的暂停状态。 */
  | { op: "recover_after_restart" }
  | { op: "start_round"; plan: RoundPlan }
  | { op: "checkpoint_round"; task: StoredTurn }
  | { op: "resume_round" }
  | { op: "update_item"; item_id: string; status: ItemStatus }
  | { op: "set_round_items"; items: readonly { text: string; status: ItemStatus }[] }
  | { op: "append_evidence"; evidence: Evidence }
  | { op: "record_llm_calls"; count: number; task_id?: string; run_id?: string }
  | { op: "finish_round"; result: EvidenceResult | RoundVerdict; evidence?: Evidence }
  | { op: "fail_round"; message: string; evidence?: Evidence }
  | { op: "resolve_uncertain"; choice: "done" | "continue" };

export type GoalChange = GoalChangeOperation & { quota_publication?: GoalQuotaPublication };

export function applyGoalChange(g: Goal, c: GoalChange, now: number): Goal {
  switch (c?.op) {
    case "transition":
      return transitionGoal(g, c.to, now);
    case "recover_after_restart":
      return recoverGoalAfterRestart(g, now);
    case "start_round":
      return startRound(g, c.plan ?? {}, now);
    case "checkpoint_round":
      return checkpointRound(g, c.task, now);
    case "resume_round":
      return resumeRound(g, now);
    case "update_item":
      return updateItem(g, c.item_id, c.status, now);
    case "set_round_items":
      return setRoundItems(g, c.items, now);
    case "append_evidence":
      return appendEvidence(g, c.evidence, now);
    case "record_llm_calls":
      if ((c.task_id === undefined) !== (c.run_id === undefined)) throw badRound("调用结算身份不完整");
      return recordLlmCalls(g, c.count, now, c.task_id === undefined ? undefined : { task_id: c.task_id, run_id: c.run_id! });
    case "finish_round":
      return finishRound(g, c.result, now, c.evidence);
    case "fail_round":
      return failRound(g, c.message, now, c.evidence);
    case "resolve_uncertain":
      return resolveUncertain(g, c.choice, now);
    default:
      throw bad("未知的目标操作");
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const VERDICTS = ["done", "not_done", "uncertain"];
const SOURCES = ["rules", "jev", "user", "runtime"];

function reviveRound(v: unknown): GoalRound | null {
  if (!isObj(v)) return null;
  const { index, status, started_at, finished_at } = v;
  if (!Number.isInteger(index) || (index as number) < 1) return null;
  if (!(ROUND_STATUSES as readonly unknown[]).includes(status)) return null;
  if (typeof started_at !== "number" || !(finished_at === null || typeof finished_at === "number")) return null;
  if (!Array.isArray(v.items)) return null;
  const items: GoalItem[] = [];
  for (const i of v.items) {
    if (!isObj(i) || typeof i.id !== "string" || typeof i.text !== "string" || !(ITEM_STATUSES as readonly unknown[]).includes(i.status)) return null;
    items.push({ id: i.id, text: i.text, status: i.status as ItemStatus });
  }
  let verdict: RoundVerdict | null = null;
  if (v.verdict !== null && v.verdict !== undefined) {
    const d = v.verdict;
    if (!isObj(d) || !VERDICTS.includes(d.verdict as string) || !SOURCES.includes(d.by as string) || typeof d.reason !== "string") return null;
    verdict = { verdict: d.verdict as EvidenceVerdict, reason: d.reason, by: d.by as RoundVerdict["by"] };
    if (typeof d.confidence === "number") verdict.confidence = d.confidence;
  }
  const round: GoalRound = {
    index: index as number,
    title: typeof v.title === "string" ? v.title : `第 ${index} 轮`,
    items,
    status: status as RoundStatus,
    evidence: sanitizeEvidence(v.evidence),
    verdict,
    task_id: typeof v.task_id === "string" && TASK_ID.test(v.task_id) ? v.task_id : null,
    interruption_reason: typeof v.interruption_reason === "string" && v.interruption_reason.trim() ? v.interruption_reason : undefined,
    started_at,
    finished_at,
  };
  if (round.interruption_reason === undefined) delete round.interruption_reason;
  if (v.task_checkpoint && typeof v.task_checkpoint === "object") {
    const checkpoint = normalizeTurn(v.task_checkpoint as Partial<StoredTurn>);
    if (TASK_ID.test(checkpoint.id) && typeof checkpoint.goalId === "string" && GOAL_ID.test(checkpoint.goalId)) round.task_checkpoint = checkpoint;
  }
  if (v.llm_settlements !== undefined) {
    if (!Array.isArray(v.llm_settlements) || v.llm_settlements.length > ACCOUNTING_CALL_LIMIT || !round.task_id) return null;
    const seen = new Set<string>();
    const receipts: LlmSettlement[] = [];
    for (const receipt of v.llm_settlements) {
      if (!isObj(receipt) || typeof receipt.run_id !== "string" || !ACCOUNTING_RUN_ID.test(receipt.run_id)
        || !Number.isInteger(receipt.llm_calls) || (receipt.llm_calls as number) < 0 || (receipt.llm_calls as number) > ACCOUNTING_CALL_LIMIT || seen.has(receipt.run_id)) return null;
      seen.add(receipt.run_id);
      receipts.push({ run_id: receipt.run_id, llm_calls: receipt.llm_calls as number });
    }
    round.llm_settlements = receipts;
  }
  return round;
}

/** 读回 rounds 列；内容损坏时返回 null（调用方跳过这一行，和技能库的处理一致） */
export function parseRounds(json: unknown): GoalRound[] | null {
  if (typeof json !== "string") return null;
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    return null;
  }
  if (!Array.isArray(v)) return null;
  const out: GoalRound[] = [];
  for (const x of v) {
    const r = reviveRound(x);
    if (!r) return null;
    out.push(r);
  }
  return out;
}

export type { ProjectError as GoalError };

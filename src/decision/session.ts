// 会话持久化（迁移 5，docs/UI_LAYOUT_V3.md 第 10 节第 4 条）：会话标题 + 已结束的回合，只存本机。
// 写入前脱敏（redact），附件正文不存（只存文件名），事件里的长文本截断；读回时逐项校验，坏数据跳过，不让整个列表消失。
// 调用记录（usage_calls）只存模型和 tokens，不存金额：金额按当前价目表在显示时计算（5.1）。
import { redact } from "../core/redact";
import { PROJECT_ID, fail, newId, type ProjectError } from "./project";
import type { WorkSurface } from "./types";

export const SESSION_ID = /^ses-[a-z0-9-]{1,48}$/;
export const MAX_SESSIONS = 500;
export const MAX_TURNS = 200;
export const MAX_TITLE_LEN = 60;
/** 一个回合存进数据库的事件上限：超出时保留开头和结尾 */
export const MAX_STORED_EVENTS = 300;
/** 事件里单个字符串字段的上限（工具输出、模型思考摘要等） */
export const MAX_FIELD = 4000;
/** 一个会话的 JSON 总大小上限；超出时从最早的回合开始丢 */
export const MAX_SESSION_BYTES = 2_000_000;

export const sessionNotFound = (): ProjectError => fail("session_not_found", "没有找到这个会话");
export const invalidSessionId = (): ProjectError => fail("invalid_session_id", "会话 ID 无效");
export const sessionFull = (): ProjectError => fail("session_full", `最多保存 ${MAX_SESSIONS} 个会话，请先删除一些`);
export const newSessionId = () => newId("ses");

/** 一次主运行的完整调用计数；非终态只能作为下界，不能据此释放恢复预算。 */
export interface RecoveryAccounting {
  version: 1;
  task_id: string;
  run_id: string;
  llm_calls: number;
  final: boolean;
}
export const ACCOUNTING_RUN_ID = /^run-[a-z0-9-]{1,96}$/;
export const ACCOUNTING_CALL_LIMIT = 500;
export function normalizeRecoveryAccounting(v: unknown, taskId: string): RecoveryAccounting | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const a = v as Record<string, unknown>;
  if (a.version !== 1 || a.task_id !== taskId || !/^task-[a-z0-9-]{1,48}$/.test(taskId)
    || typeof a.run_id !== "string" || !ACCOUNTING_RUN_ID.test(a.run_id)
    || !Number.isInteger(a.llm_calls) || (a.llm_calls as number) < 0 || (a.llm_calls as number) > ACCOUNTING_CALL_LIMIT
    || typeof a.final !== "boolean") return null;
  return { version: 1, task_id: taskId, run_id: a.run_id, llm_calls: a.llm_calls as number, final: a.final };
}

/** 存下来的一个回合：和 stores/tasks.ts 的 TaskCard 对应，只留回放需要的字段 */
export interface StoredTurn {
  id: string;
  seq: number;
  goal: string;
  status: string;
  summary: string | null;
  events: unknown[];
  lock: string | null;
  permission: string;
  files: string[];
  multi: boolean;
  startedAt: number;
  endedAt: number | null;
  goalId: string | null;
  mode: string;
  preference: string;
  preferenceSource: string;
  /** 能力面提示；旧会话没有此字段时按自动判断恢复。 */
  surfaceHint?: WorkSurface | null;
  /** 进程在流式输出期间退出时，保存已经收到的有限文本，供重启后回放。 */
  streamingText?: string;
  /** 流式输出尚未收到终态；恢复回放时保持「部分输出」提示。 */
  streamingInterrupted?: boolean;
  /** null / 缺省：历史调用结算信息未知，不从有界事件或目标总数猜测。 */
  recovery_accounting?: RecoveryAccounting | null;
}

export interface StoredSession {
  id: string;
  title: string;
  project_id: string | null;
  turns: StoredTurn[];
  created_at: number;
  updated_at: number;
}

export interface SessionInput {
  id: string;
  title: string;
  project_id: string | null;
  turns: readonly StoredTurn[];
  created_at: number;
  updated_at: number;
}

/** 一次模型调用：桌面端存 usage_calls 表，供「本月省了多少」和使用情况页按月统计 */
export interface UsageCall {
  id: string;
  session_id: string | null;
  task_id: string;
  goal_id: string | null;
  project_id: string | null;
  profile_id: string;
  input_tokens: number;
  output_tokens: number;
  baseline_profile_id: string | null;
  created_at: number;
}

const str = (v: unknown, max: number) => redact(String(v ?? "")).slice(0, max);
const strOrNull = (v: unknown, max: number) => (typeof v === "string" ? str(v, max) : null);
const num = (v: unknown, d = 0) => (typeof v === "number" && Number.isFinite(v) ? v : d);

/** 事件里的字符串一律脱敏并截断；对象、数组逐层处理；深度和大小都有上限 */
export function scrub(v: unknown, depth = 0): unknown {
  if (depth > 12) return null;
  if (typeof v === "string") return str(v, MAX_FIELD);
  if (typeof v === "number" || typeof v === "boolean" || v === null) return v;
  if (Array.isArray(v)) return v.slice(0, 200).map((x) => scrub(x, depth + 1));
  if (typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, 100)) out[k] = scrub(x, depth + 1);
    return out;
  }
  return null;
}

function trimEvents(list: readonly unknown[], runId?: string): unknown[] {
  if (list.length <= MAX_STORED_EVENTS) return [...list];
  const head = 20;
  const kept = [...list.slice(0, head), ...list.slice(list.length - (MAX_STORED_EVENTS - head))];
  const isStart = (e: unknown) => !!e && typeof e === "object" && (e as Record<string, unknown>).type === "run_start" && (e as Record<string, unknown>).runId === runId;
  if (runId && !kept.some(isStart)) {
    const anchor = list.find(isStart);
    if (anchor) {
      const context = kept.findIndex((e, i) => i < head && !!e && typeof e === "object" && ["route", "memory", "skill"].includes(String((e as Record<string, unknown>).type)));
      const omit = context < 0 ? 0 : context;
      return [...kept.slice(0, head).filter((_, i) => i !== omit), anchor, ...kept.slice(head)];
    }
  }
  return kept;
}

export function normalizeTurn(t: Partial<StoredTurn>): StoredTurn {
  return {
    id: str(t.id, 64),
    seq: num(t.seq),
    goal: str(t.goal, 4000),
    status: str(t.status, 32),
    summary: strOrNull(t.summary, 20000),
    events: trimEvents(Array.isArray(t.events) ? t.events : [], normalizeRecoveryAccounting(t.recovery_accounting, t.id ?? "")?.run_id).map((e) => scrub(e)),
    lock: strOrNull(t.lock, 200),
    permission: str(t.permission ?? "confirm", 16),
    files: (Array.isArray(t.files) ? t.files : []).slice(0, 20).map((f) => str(f, 200)),
    multi: t.multi === true,
    startedAt: num(t.startedAt),
    endedAt: typeof t.endedAt === "number" ? t.endedAt : null,
    goalId: strOrNull(t.goalId, 64),
    mode: str(t.mode ?? "quick", 16),
    preference: str(t.preference ?? "balanced", 16),
    preferenceSource: str(t.preferenceSource ?? "global", 16),
    surfaceHint: t.surfaceHint === "chat" || t.surfaceHint === "work" || t.surfaceHint === "codex" ? t.surfaceHint : null,
    streamingText: strOrNull(t.streamingText, 200_000) ?? "",
    streamingInterrupted: t.streamingInterrupted === true,
    recovery_accounting: normalizeRecoveryAccounting(t.recovery_accounting, t.id ?? ""),
  };
}

/** 写入前：校验 ID、脱敏、截断；超出大小上限时从最早的回合开始丢 */
export function normalizeSession(s: SessionInput): StoredSession {
  if (!SESSION_ID.test(s.id)) throw invalidSessionId();
  if (s.project_id !== null && !PROJECT_ID.test(s.project_id)) throw fail("invalid_project_id", "项目 ID 无效");
  let turns = s.turns.slice(-MAX_TURNS).map(normalizeTurn);
  while (turns.length > 1 && JSON.stringify(turns).length > MAX_SESSION_BYTES) turns = turns.slice(1);
  return {
    id: s.id,
    title: str(s.title, MAX_TITLE_LEN).replace(/\s+/g, " ").trim() || "新会话",
    project_id: s.project_id,
    turns,
    created_at: num(s.created_at),
    updated_at: num(s.updated_at),
  };
}

/** 读回：JSON 坏了当作没有回合（会话本身保留）；单个回合坏了跳过 */
export function parseTurns(json: string): StoredTurn[] {
  try {
    const v: unknown = JSON.parse(json);
    if (!Array.isArray(v)) return [];
    return v.filter((t): t is Partial<StoredTurn> => !!t && typeof t === "object" && typeof (t as StoredTurn).id === "string").map(normalizeTurn);
  } catch {
    return [];
  }
}

export function normalizeUsage(c: UsageCall): UsageCall {
  const id = (s: string | null, re?: RegExp) => (s && (!re || re.test(s)) ? s.slice(0, 200) : null);
  return {
    id: str(c.id, 80),
    session_id: id(c.session_id, SESSION_ID),
    task_id: str(c.task_id, 80),
    goal_id: id(c.goal_id),
    project_id: id(c.project_id, PROJECT_ID),
    profile_id: str(c.profile_id, 200),
    input_tokens: Math.max(0, Math.round(num(c.input_tokens))),
    output_tokens: Math.max(0, Math.round(num(c.output_tokens))),
    baseline_profile_id: id(c.baseline_profile_id),
    created_at: num(c.created_at),
  };
}

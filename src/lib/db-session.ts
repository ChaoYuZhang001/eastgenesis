// 会话与调用记录的 SQLite 读写（桌面端）：sessions、usage_calls 两张表由 eg-core 的迁移 5 创建。浏览器模式用 platform/mock-session.ts。
// 会话按整条写入（标题 + 全部已结束的回合，JSON），写入前在 decision/session.ts 里脱敏、截断。删除是软删除。
// 占位符规则同 db-memory.ts：每条语句里 $1、$2… 按出现顺序递增，不重复使用。
import { MAX_SESSIONS, SESSION_ID, invalidSessionId, normalizeSession, normalizeUsage, parseTurns, sessionFull, sessionNotFound, type SessionInput, type StoredSession, type UsageCall } from "@/decision/session";
import { projectNotFound } from "@/decision/project";
import { withDb } from "./db";
import { projectAlive } from "./db-project";

const COLS = "id, project_id, title, turns, created_at, updated_at";
export const SESSION_SQL = {
  list: `SELECT ${COLS} FROM sessions WHERE deleted_at IS NULL ORDER BY updated_at DESC, created_at DESC LIMIT ${MAX_SESSIONS}`,
  exists: "SELECT 1 AS ok FROM sessions WHERE id = $1 AND deleted_at IS NULL",
  count: "SELECT COUNT(*) AS n FROM sessions WHERE deleted_at IS NULL",
  insert: "INSERT INTO sessions (id, project_id, title, turns, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6)",
  update: "UPDATE sessions SET project_id = $1, title = $2, turns = $3, updated_at = $4 WHERE id = $5 AND deleted_at IS NULL",
  remove: "UPDATE sessions SET deleted_at = $1, updated_at = $2 WHERE id = $3 AND deleted_at IS NULL",
  countByProject: "SELECT COUNT(*) AS n FROM sessions WHERE project_id = $1 AND deleted_at IS NULL",
  removeByProject: "UPDATE sessions SET deleted_at = $1, updated_at = $2 WHERE project_id = $3 AND deleted_at IS NULL",
  insertUsage:
    "INSERT OR IGNORE INTO usage_calls (id, session_id, task_id, goal_id, project_id, profile_id, input_tokens, output_tokens, baseline_profile_id, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
  usageSince: "SELECT id, session_id, task_id, goal_id, project_id, profile_id, input_tokens, output_tokens, baseline_profile_id, created_at FROM usage_calls WHERE created_at >= $1 ORDER BY created_at",
} as const;

type Row = Omit<StoredSession, "turns"> & { turns: string };
const fromRow = (r: Row): StoredSession => ({ ...r, turns: parseTurns(r.turns) });

export const listSessions = (): Promise<StoredSession[]> => withDb(async (db) => (await db.select<Row[]>(SESSION_SQL.list)).map(fromRow));

/**
 * 整条写入：没有就新建（先查数量上限），有就覆盖标题和回合。项目已删除时不写。
 * updated_at 用会话自己的「最近活动时间」（输入里带的），不用写入时间：重存一次不会把会话顶到最前
 */
export async function saveSession(s: SessionInput): Promise<StoredSession> {
  const v = normalizeSession(s);
  return withDb(async (db) => {
    if (v.project_id && !(await projectAlive(db, v.project_id))) throw projectNotFound();
    const turns = JSON.stringify(v.turns);
    const found = await db.select<{ ok: number }[]>(SESSION_SQL.exists, [v.id]);
    if (found.length) {
      await db.execute(SESSION_SQL.update, [v.project_id, v.title, turns, v.updated_at, v.id]);
      return v;
    }
    const [c] = await db.select<{ n: number }[]>(SESSION_SQL.count);
    if (Number(c?.n ?? 0) >= MAX_SESSIONS) throw sessionFull();
    await db.execute(SESSION_SQL.insert, [v.id, v.project_id, v.title, turns, v.created_at, v.updated_at]);
    return v;
  });
}

export async function deleteSession(id: string, now = Date.now()): Promise<void> {
  if (!SESSION_ID.test(id)) throw invalidSessionId();
  await withDb(async (db) => {
    const found = await db.select<{ ok: number }[]>(SESSION_SQL.exists, [id]);
    if (!found.length) throw sessionNotFound();
    await db.execute(SESSION_SQL.remove, [now, now, id]);
  });
}

/** 调用记录：同一个 id 只记一次（重复写入忽略） */
export async function recordUsage(calls: readonly UsageCall[]): Promise<void> {
  if (!calls.length) return;
  await withDb(async (db) => {
    for (const raw of calls) {
      const c = normalizeUsage(raw);
      await db.execute(SESSION_SQL.insertUsage, [c.id, c.session_id, c.task_id, c.goal_id, c.project_id, c.profile_id, c.input_tokens, c.output_tokens, c.baseline_profile_id, c.created_at]);
    }
  });
}

export const listUsage = (since: number): Promise<UsageCall[]> => withDb((db) => db.select<UsageCall[]>(SESSION_SQL.usageSince, [since]));

// 目标的 SQLite 读写（桌面端）：goals 表由 eg-core 的迁移 4 创建，rounds 列存 JSON。浏览器模式用 platform/mock-goal.ts。
// 状态转换和轮次操作都是「读出 → decision/goal.ts applyGoalChange → 写回」；同一个目标的读写排队执行，避免并发时互相覆盖。
// 删除是软删除（status = 'deleted' 并写 deleted_at），查询只看 deleted_at IS NULL 的行。占位符规则同 db-memory.ts。
import { GOAL_ID, MAX_GOALS, applyGoalChange, editGoal, goalFull, goalNotFound, invalidGoalId, isGoalStatus, newGoal, normalizeGoal, parseRounds } from "@/decision/goal";
import { PROJECT_ID, invalidProjectId, isPreference, projectNotFound } from "@/decision/project";
import type { Goal, GoalChange, GoalInput } from "@/platform/types";
import { withDb, type Db } from "./db";
import { projectAlive } from "./db-project";

const COLS = "id, project_id, description, instructions, routing_preference, status, rounds, max_llm_calls, used_llm_calls, created_at, updated_at";
export const GOAL_SQL = {
  list: `SELECT ${COLS} FROM goals WHERE deleted_at IS NULL ORDER BY updated_at DESC, created_at DESC`,
  listByProject: `SELECT ${COLS} FROM goals WHERE project_id = $1 AND deleted_at IS NULL ORDER BY updated_at DESC, created_at DESC`,
  get: `SELECT ${COLS} FROM goals WHERE id = $1 AND deleted_at IS NULL`,
  count: "SELECT COUNT(*) AS n FROM goals WHERE deleted_at IS NULL",
  insert:
    "INSERT INTO goals (id, project_id, description, instructions, routing_preference, status, rounds, max_llm_calls, used_llm_calls, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)",
  // 可变字段一次写回；status 改成 deleted 时 deleted_at 写这次的时间，否则仍为 NULL（只更新还没删的行）
  update:
    "UPDATE goals SET description = $1, instructions = $2, routing_preference = $3, status = $4, rounds = $5, max_llm_calls = $6, used_llm_calls = $7, updated_at = $8, deleted_at = $9 WHERE id = $10 AND deleted_at IS NULL",
} as const;

type Row = Omit<Goal, "rounds" | "routing_preference" | "status"> & { rounds: string; routing_preference: string | null; status: string };

/** rounds 列损坏或状态不认识的行不返回：一条坏数据不拖垮整个列表（同技能库） */
function fromRow(r: Row): Goal | null {
  const rounds = parseRounds(r.rounds);
  if (!rounds || !isGoalStatus(r.status)) return null;
  return {
    ...r,
    status: r.status,
    rounds,
    routing_preference: isPreference(r.routing_preference) ? r.routing_preference : null,
    max_llm_calls: Number(r.max_llm_calls),
    used_llm_calls: Number(r.used_llm_calls),
  };
}
const parsed = (rows: Row[]) => rows.map(fromRow).filter((g): g is Goal => g !== null);

async function getGoal(db: Db, id: string): Promise<Goal> {
  const [g] = parsed(await db.select<Row[]>(GOAL_SQL.get, [id]));
  if (!g) throw goalNotFound();
  return g;
}

async function write(db: Db, g: Goal): Promise<Goal> {
  const r = (await db.execute(GOAL_SQL.update, [
    g.description,
    g.instructions,
    g.routing_preference,
    g.status,
    JSON.stringify(g.rounds),
    g.max_llm_calls,
    g.used_llm_calls,
    g.updated_at,
    g.status === "deleted" ? g.updated_at : null,
    g.id,
  ])) as { rowsAffected?: number } | undefined;
  // 读出之后被连带删除了（例如同时删了项目）
  if (r?.rowsAffected === 0) throw goalNotFound();
  return g;
}

// 同一个目标的读写排队：前一个结束（成功或失败）后才开始下一个
const queues = new Map<string, Promise<unknown>>();
function serial<T>(id: string, f: () => Promise<T>): Promise<T> {
  const prev = queues.get(id) ?? Promise.resolve();
  const run = prev.then(f, f);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  queues.set(id, tail);
  void tail.then(() => {
    if (queues.get(id) === tail) queues.delete(id);
  });
  return run;
}

export async function listGoals(projectId?: string): Promise<Goal[]> {
  if (projectId !== undefined && !PROJECT_ID.test(projectId)) throw invalidProjectId();
  return withDb(async (db) => parsed(projectId === undefined ? await db.select<Row[]>(GOAL_SQL.list) : await db.select<Row[]>(GOAL_SQL.listByProject, [projectId])));
}

/** 新建：先查项目还在、数量没满，状态 idle。编辑：没给的字段保持原值，不能换项目，结束后不能改 */
export async function saveGoal(p: GoalInput, now = Date.now()): Promise<Goal> {
  if (p.id !== undefined && !GOAL_ID.test(p.id)) throw invalidGoalId();
  const id = p.id;
  if (id) return serial(id, () => withDb(async (db) => write(db, editGoal(await getGoal(db, id), p, now))));
  const v = normalizeGoal(p);
  return withDb(async (db) => {
    if (v.project_id !== null && !(await projectAlive(db, v.project_id))) throw projectNotFound();
    const rows = await db.select<{ n: number }[]>(GOAL_SQL.count);
    if (Number(rows[0]?.n ?? 0) >= MAX_GOALS) throw goalFull();
    const g = newGoal(v, now);
    await db.execute(GOAL_SQL.insert, [
      g.id,
      g.project_id,
      g.description,
      g.instructions,
      g.routing_preference,
      g.status,
      JSON.stringify(g.rounds),
      g.max_llm_calls,
      g.used_llm_calls,
      g.created_at,
      g.updated_at,
    ]);
    return getGoal(db, g.id);
  });
}

/** 状态转换和轮次操作；非法转换抛 invalid_goal_transition，数据库不变 */
export async function updateGoal(id: string, change: GoalChange, now = Date.now()): Promise<Goal> {
  if (!GOAL_ID.test(id)) throw invalidGoalId();
  return serial(id, () =>
    withDb(async (db) => {
      const cur = await getGoal(db, id);
      const next = applyGoalChange(cur, change, now);
      return next === cur ? cur : write(db, next);
    }),
  );
}

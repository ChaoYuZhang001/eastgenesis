// 项目的 SQLite 读写（桌面端）：projects 表由 eg-core 的迁移 4 创建，context_folders 列存 JSON。浏览器模式用 platform/mock-project.ts。
// 删除是软删除：写 deleted_at，同一个时间戳连带写到这个项目的目标和记忆；所有查询都只看 deleted_at IS NULL 的行。
// 占位符规则同 db-memory.ts：每条语句里 $1、$2… 按出现顺序递增，不重复使用。
import { MAX_PROJECTS, PROJECT_ID, invalidProjectId, isPreference, mergeProject, newProjectId, normalizeProject, projectFull, projectNotFound } from "@/decision/project";
import type { Project, ProjectInput, ProjectUsage } from "@/platform/types";
import { withDb, type Db } from "./db";

const COLS = "id, name, description, instructions, context_folders, routing_preference, archived, created_at, updated_at";
export const PROJECT_SQL = {
  list: `SELECT ${COLS} FROM projects WHERE deleted_at IS NULL ORDER BY updated_at DESC, created_at DESC`,
  get: `SELECT ${COLS} FROM projects WHERE id = $1 AND deleted_at IS NULL`,
  count: "SELECT COUNT(*) AS n FROM projects WHERE deleted_at IS NULL",
  insert:
    "INSERT INTO projects (id, name, description, instructions, context_folders, routing_preference, archived, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, 0, $7, $8)",
  update:
    "UPDATE projects SET name = $1, description = $2, instructions = $3, context_folders = $4, routing_preference = $5, updated_at = $6 WHERE id = $7 AND deleted_at IS NULL",
  archive: "UPDATE projects SET archived = $1, updated_at = $2 WHERE id = $3 AND deleted_at IS NULL",
  usage:
    "SELECT (SELECT COUNT(*) FROM goals WHERE project_id = $1 AND deleted_at IS NULL) AS goals, (SELECT COUNT(*) FROM memories WHERE project_id = $2 AND deleted_at IS NULL) AS memories",
  // 连带删除：先记忆、再目标、最后项目。中途失败时项目还在，可以再删一次；每条都只改还没删的行，重复执行无副作用
  removeMemories: "UPDATE memories SET deleted_at = $1 WHERE project_id = $2 AND deleted_at IS NULL",
  removeGoals: "UPDATE goals SET status = 'deleted', deleted_at = $1, updated_at = $2 WHERE project_id = $3 AND deleted_at IS NULL",
  remove: "UPDATE projects SET deleted_at = $1, updated_at = $2 WHERE id = $3 AND deleted_at IS NULL",
  alive: "SELECT 1 AS ok FROM projects WHERE id = $1 AND deleted_at IS NULL",
} as const;

type Row = Omit<Project, "context_folders" | "archived" | "routing_preference"> & { context_folders: string; archived: number; routing_preference: string | null };

/** context_folders 损坏时当作空列表：项目本身不能因为一列坏数据消失（它的目标和记忆还挂在下面） */
function folders(json: string): string[] {
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
const fromRow = (r: Row): Project => ({
  ...r,
  context_folders: folders(r.context_folders),
  routing_preference: isPreference(r.routing_preference) ? r.routing_preference : null,
  archived: Number(r.archived) === 1,
});

async function getProject(db: Db, id: string): Promise<Project> {
  const [row] = await db.select<Row[]>(PROJECT_SQL.get, [id]);
  if (!row) throw projectNotFound();
  return fromRow(row);
}

/** 项目存在且没删除（目标、记忆挂到项目下之前查） */
export async function projectAlive(db: Db, id: string): Promise<boolean> {
  const rows = await db.select<{ ok: number }[]>(PROJECT_SQL.alive, [id]);
  return rows.length > 0;
}

export const listProjects = (): Promise<Project[]> => withDb(async (db) => (await db.select<Row[]>(PROJECT_SQL.list)).map(fromRow));

/** 新建时先查数量；编辑时没给的字段保持原值，归档状态不变 */
export async function saveProject(p: ProjectInput, now = Date.now()): Promise<Project> {
  if (p.id !== undefined && !PROJECT_ID.test(p.id)) throw invalidProjectId();
  if (p.id === undefined) normalizeProject(p);
  return withDb(async (db) => {
    let id = p.id;
    if (id) {
      const v = mergeProject(await getProject(db, id), p);
      await db.execute(PROJECT_SQL.update, [v.name, v.description, v.instructions, JSON.stringify(v.context_folders), v.routing_preference, now, id]);
    } else {
      const v = normalizeProject(p);
      const rows = await db.select<{ n: number }[]>(PROJECT_SQL.count);
      if (Number(rows[0]?.n ?? 0) >= MAX_PROJECTS) throw projectFull();
      id = newProjectId();
      await db.execute(PROJECT_SQL.insert, [id, v.name, v.description, v.instructions, JSON.stringify(v.context_folders), v.routing_preference, now, now]);
    }
    return getProject(db, id);
  });
}

async function setArchived(id: string, archived: boolean, now: number): Promise<Project> {
  if (!PROJECT_ID.test(id)) throw invalidProjectId();
  return withDb(async (db) => {
    await getProject(db, id);
    // archived 列有 CHECK (0, 1)：绑定数字，不绑定布尔值
    await db.execute(PROJECT_SQL.archive, [archived ? 1 : 0, now, id]);
    return getProject(db, id);
  });
}
export const archiveProject = (id: string, now = Date.now()) => setArchived(id, true, now);
export const unarchiveProject = (id: string, now = Date.now()) => setArchived(id, false, now);

async function usage(db: Db, id: string): Promise<ProjectUsage> {
  const [r] = await db.select<{ goals: number; memories: number }[]>(PROJECT_SQL.usage, [id, id]);
  return { goals: Number(r?.goals ?? 0), memories: Number(r?.memories ?? 0) };
}

export async function projectUsage(id: string): Promise<ProjectUsage> {
  if (!PROJECT_ID.test(id)) throw invalidProjectId();
  return withDb(async (db) => {
    await getProject(db, id);
    return usage(db, id);
  });
}

/** 软删除项目，连带删除它的目标和记忆；返回连带删除的数量 */
export async function deleteProject(id: string, now = Date.now()): Promise<ProjectUsage> {
  if (!PROJECT_ID.test(id)) throw invalidProjectId();
  return withDb(async (db) => {
    await getProject(db, id);
    const n = await usage(db, id);
    await db.execute(PROJECT_SQL.removeMemories, [now, id]);
    await db.execute(PROJECT_SQL.removeGoals, [now, now, id]);
    await db.execute(PROJECT_SQL.remove, [now, now, id]);
    return n;
  });
}

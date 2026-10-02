// 技能的 SQLite 读写（桌面端）：skills 表由 eg-core 的迁移 3 创建，steps 列存 JSON。浏览器模式用 platform/mock-skill.ts。
// 占位符规则同 db-memory.ts：每条语句里 $1、$2… 按出现顺序递增。
import type { Skill, SkillInput } from "@/platform/types";
import { withDb } from "./db";
import { MAX_SKILLS, SKILL_ID, invalidSkillId, newSkillId, normalizeSkill, skillFull, skillNotFound } from "./skill";

const COLS = "id, name, description, steps, source, created_at, updated_at, use_count, last_used_at";
export const SKILL_SQL = {
  list: `SELECT ${COLS} FROM skills ORDER BY updated_at DESC, created_at DESC`,
  get: `SELECT ${COLS} FROM skills WHERE id = $1`,
  count: "SELECT COUNT(*) AS n FROM skills",
  insert: "INSERT INTO skills (id, name, description, steps, source, created_at, updated_at, use_count, last_used_at) VALUES ($1, $2, $3, $4, $5, $6, $7, 0, NULL)",
  update: "UPDATE skills SET name = $1, description = $2, steps = $3, updated_at = $4 WHERE id = $5",
  remove: "DELETE FROM skills WHERE id = $1",
  touch: "UPDATE skills SET use_count = use_count + 1, last_used_at = $1 WHERE id = $2",
} as const;

type Row = Omit<Skill, "steps"> & { steps: string };

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
/** 只读步骤的参数和逐项参数名原样带回；类型不对的字段丢掉 */
function stepFromJson(s: { goal?: unknown; tool?: unknown; args?: unknown; each?: unknown }): Skill["steps"][number] {
  const tool = typeof s?.tool === "string" ? s.tool : null;
  return {
    goal: String(s?.goal ?? ""),
    tool,
    ...(tool && isPlain(s.args) ? { args: s.args } : {}),
    ...(tool && typeof s.each === "string" ? { each: s.each } : {}),
  };
}

/** steps 列损坏的行不返回：一条坏数据不拖垮整个列表 */
function fromRow(r: Row): Skill | null {
  try {
    const steps: unknown = JSON.parse(r.steps);
    if (!Array.isArray(steps) || steps.length === 0) return null;
    return { ...r, steps: steps.map(stepFromJson) };
  } catch {
    return null;
  }
}
const parsed = (rows: Row[]): Skill[] => rows.map(fromRow).filter((s): s is Skill => s !== null);

export const listSkills = (): Promise<Skill[]> => withDb(async (db) => parsed(await db.select<Row[]>(SKILL_SQL.list)));

/** 新建时先查数量；编辑改名称、说明、步骤和更新时间，来源不变 */
export async function saveSkill(s: SkillInput, now = Date.now()): Promise<Skill> {
  if (s.id !== undefined && !SKILL_ID.test(s.id)) throw invalidSkillId();
  const v = normalizeSkill(s);
  const steps = JSON.stringify(v.steps);
  return withDb(async (db) => {
    let id = s.id;
    if (id) {
      await db.execute(SKILL_SQL.update, [v.name, v.description, steps, now, id]);
    } else {
      const rows = await db.select<{ n: number }[]>(SKILL_SQL.count);
      if (Number(rows[0]?.n ?? 0) >= MAX_SKILLS) throw skillFull();
      id = newSkillId();
      await db.execute(SKILL_SQL.insert, [id, v.name, v.description, steps, v.source, now, now]);
    }
    const [skill] = parsed(await db.select<Row[]>(SKILL_SQL.get, [id]));
    if (!skill) throw skillNotFound();
    return skill;
  });
}

export async function deleteSkill(id: string): Promise<void> {
  if (!SKILL_ID.test(id)) throw invalidSkillId();
  await withDb((db) => db.execute(SKILL_SQL.remove, [id]));
}

export async function touchSkills(ids: readonly string[], now = Date.now()): Promise<void> {
  const valid = ids.filter((id) => SKILL_ID.test(id)).slice(0, 20);
  if (valid.length === 0) return;
  await withDb(async (db) => {
    for (const id of valid) await db.execute(SKILL_SQL.touch, [now, id]);
  });
}

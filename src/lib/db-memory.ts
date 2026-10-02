// 记忆的 SQLite 读写（桌面端）：memories 表由 eg-core 的迁移 2 创建。浏览器模式用 platform/mock-memory.ts。
// 每条语句里的占位符 $1、$2… 按出现顺序递增：SQLite 按首次出现的顺序给这类参数编号。
import type { Memory, MemoryInput } from "@/platform/types";
import { withDb } from "./db";
import { MAX_MEMORIES, MEMORY_ID, invalidMemoryId, memoryFull, memoryNotFound, newMemoryId, normalizeMemory } from "./memory";

const COLS = "id, kind, text, source, created_at, updated_at, use_count, last_used_at";
export const MEMORY_SQL = {
  list: `SELECT ${COLS} FROM memories ORDER BY updated_at DESC, created_at DESC`,
  get: `SELECT ${COLS} FROM memories WHERE id = $1`,
  count: "SELECT COUNT(*) AS n FROM memories",
  insert: "INSERT INTO memories (id, kind, text, source, created_at, updated_at, use_count, last_used_at) VALUES ($1, $2, $3, $4, $5, $6, 0, NULL)",
  update: "UPDATE memories SET kind = $1, text = $2, updated_at = $3 WHERE id = $4",
  remove: "DELETE FROM memories WHERE id = $1",
  touch: "UPDATE memories SET use_count = use_count + 1, last_used_at = $1 WHERE id = $2",
} as const;

export const listMemories = (): Promise<Memory[]> => withDb((db) => db.select<Memory[]>(MEMORY_SQL.list));

/** 新建时先查数量；编辑只改类型、内容和更新时间，来源不变 */
export async function saveMemory(m: MemoryInput, now = Date.now()): Promise<Memory> {
  if (m.id !== undefined && !MEMORY_ID.test(m.id)) throw invalidMemoryId();
  const v = normalizeMemory(m);
  return withDb(async (db) => {
    let id = m.id;
    if (id) {
      await db.execute(MEMORY_SQL.update, [v.kind, v.text, now, id]);
    } else {
      const rows = await db.select<{ n: number }[]>(MEMORY_SQL.count);
      if (Number(rows[0]?.n ?? 0) >= MAX_MEMORIES) throw memoryFull();
      id = newMemoryId();
      await db.execute(MEMORY_SQL.insert, [id, v.kind, v.text, v.source, now, now]);
    }
    const [row] = await db.select<Memory[]>(MEMORY_SQL.get, [id]);
    if (!row) throw memoryNotFound();
    return row;
  });
}

export async function deleteMemory(id: string): Promise<void> {
  if (!MEMORY_ID.test(id)) throw invalidMemoryId();
  await withDb((db) => db.execute(MEMORY_SQL.remove, [id]));
}

export async function touchMemories(ids: readonly string[], now = Date.now()): Promise<void> {
  const valid = ids.filter((id) => MEMORY_ID.test(id)).slice(0, 50);
  if (valid.length === 0) return;
  await withDb(async (db) => {
    for (const id of valid) await db.execute(MEMORY_SQL.touch, [now, id]);
  });
}

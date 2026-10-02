// 浏览器模式的记忆：内存 Map，规则与桌面端（lib/db-memory.ts）相同。
import { MAX_MEMORIES, MEMORY_ID, invalidMemoryId, memoryFull, memoryNotFound, newMemoryId, normalizeMemory } from "@/lib/memory";
import type { Backend, Memory } from "./types";

type MemoryBackend = Pick<Backend, "listMemories" | "saveMemory" | "deleteMemory" | "touchMemories">;

export function createMockMemory(now: () => number = Date.now): MemoryBackend {
  const items = new Map<string, Memory>();
  return {
    // 更新时间相同时后加入的在前，与 SQL 的 ORDER BY updated_at DESC, created_at DESC 一致
    listMemories: async () => [...items.values()].reverse().sort((a, b) => b.updated_at - a.updated_at).map((m) => ({ ...m })),
    async saveMemory(m) {
      if (m.id !== undefined && !MEMORY_ID.test(m.id)) throw invalidMemoryId();
      const v = normalizeMemory(m);
      const t = now();
      if (m.id) {
        const cur = items.get(m.id);
        if (!cur) throw memoryNotFound();
        const next: Memory = { ...cur, kind: v.kind, text: v.text, updated_at: t };
        items.set(m.id, next);
        return { ...next };
      }
      if (items.size >= MAX_MEMORIES) throw memoryFull();
      const created: Memory = { id: newMemoryId(), ...v, created_at: t, updated_at: t, use_count: 0, last_used_at: null };
      items.set(created.id, created);
      return { ...created };
    },
    async deleteMemory(id) {
      if (!MEMORY_ID.test(id)) throw invalidMemoryId();
      items.delete(id);
    },
    async touchMemories(ids) {
      const t = now();
      for (const id of ids) {
        const m = items.get(id);
        if (m) items.set(id, { ...m, use_count: m.use_count + 1, last_used_at: t });
      }
    },
  };
}

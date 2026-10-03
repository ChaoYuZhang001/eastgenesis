// 浏览器模式的记忆：内存 Map，规则与桌面端（lib/db-memory.ts）相同。
import { projectNotFound } from "@/decision/project";
import { MAX_MEMORIES, MEMORY_ID, invalidMemoryId, memoryFull, memoryNotFound, newMemoryId, normalizeMemory } from "@/lib/memory";
import type { Backend, Memory } from "./types";

type MemoryBackend = Pick<Backend, "listMemories" | "saveMemory" | "deleteMemory" | "touchMemories">;

export interface MockMemory {
  api: MemoryBackend;
  /** 删除项目时连带删除：数量和删除（与桌面端的软删除对外表现一致：之后查不到） */
  countByProject(projectId: string): number;
  removeByProject(projectId: string): number;
}

/** projectAlive：挂到项目下之前查项目还在（mock-backend 接到 mock-project） */
export function createMockMemoryStore(now: () => number = Date.now, projectAlive: (id: string) => boolean = () => false): MockMemory {
  const items = new Map<string, Memory>();
  const ofProject = (projectId: string) => [...items.values()].filter((m) => m.project_id === projectId);
  const api: MemoryBackend = {
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
      if (v.project_id !== null && !projectAlive(v.project_id)) throw projectNotFound();
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
  return {
    api,
    countByProject: (projectId) => ofProject(projectId).length,
    removeByProject(projectId) {
      const list = ofProject(projectId);
      for (const m of list) items.delete(m.id);
      return list.length;
    },
  };
}

/** 只要记忆接口时用（不接项目：挂到项目下的记忆一律报项目不存在） */
export const createMockMemory = (now: () => number = Date.now): MemoryBackend => createMockMemoryStore(now).api;

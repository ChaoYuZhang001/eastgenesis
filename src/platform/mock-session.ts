// 浏览器模式的会话与调用记录：内存，规则与桌面端（lib/db-session.ts）相同；刷新页面就没了。
import { MAX_SESSIONS, SESSION_ID, invalidSessionId, normalizeSession, normalizeUsage, sessionFull, sessionNotFound, type StoredSession, type UsageCall } from "@/decision/session";
import { projectNotFound } from "@/decision/project";
import type { Backend } from "./types";

type SessionBackend = Pick<Backend, "listSessions" | "saveSession" | "deleteSession" | "recordUsage" | "listUsage">;

export interface MockSessions {
  api: SessionBackend;
  countByProject(projectId: string): number;
  removeByProject(projectId: string): number;
}

export function createMockSessions(projectAlive: (id: string) => boolean = () => false): MockSessions {
  const items = new Map<string, StoredSession>();
  const usage = new Map<string, UsageCall>();
  const copy = (s: StoredSession): StoredSession => JSON.parse(JSON.stringify(s)) as StoredSession;
  const ofProject = (id: string) => [...items.values()].filter((s) => s.project_id === id);
  const api: SessionBackend = {
    // 与 SQL 的 ORDER BY updated_at DESC, created_at DESC 一致
    listSessions: async () => [...items.values()].sort((a, b) => b.updated_at - a.updated_at || b.created_at - a.created_at).slice(0, MAX_SESSIONS).map(copy),
    async saveSession(s) {
      const v = normalizeSession(s);
      if (v.project_id && !projectAlive(v.project_id)) throw projectNotFound();
      if (!items.has(v.id) && items.size >= MAX_SESSIONS) throw sessionFull();
      const saved = { ...v, created_at: items.get(v.id)?.created_at ?? v.created_at };
      items.set(v.id, saved);
      return copy(saved);
    },
    async deleteSession(id) {
      if (!SESSION_ID.test(id)) throw invalidSessionId();
      if (!items.delete(id)) throw sessionNotFound();
    },
    async recordUsage(calls) {
      for (const c of calls) if (!usage.has(c.id)) usage.set(c.id, normalizeUsage(c));
    },
    listUsage: async (since) => [...usage.values()].filter((c) => c.created_at >= since).sort((a, b) => a.created_at - b.created_at).map((c) => ({ ...c })),
  };
  return {
    api,
    countByProject: (id) => ofProject(id).length,
    removeByProject(id) {
      const list = ofProject(id);
      for (const s of list) items.delete(s.id);
      return list.length;
    },
  };
}

// 浏览器模式的项目：内存 Map，规则与桌面端（lib/db-project.ts）相同。
// 删除时连带删除它的目标和记忆（cascade 由 mock-backend 接到 mock-goal、mock-memory）；删除后查不到，与桌面端的软删除对外表现一致。
import { MAX_PROJECTS, PROJECT_ID, invalidProjectId, mergeProject, newProjectId, normalizeProject, projectFull, projectNotFound } from "@/decision/project";
import type { Backend, Project, ProjectUsage } from "./types";

type ProjectBackend = Pick<Backend, "listProjects" | "saveProject" | "archiveProject" | "unarchiveProject" | "projectUsage" | "deleteProject">;

export interface ProjectCascade {
  usage(projectId: string): ProjectUsage;
  remove(projectId: string): void;
}

export interface MockProjects {
  api: ProjectBackend;
  alive(id: string): boolean;
}

export function createMockProjects(now: () => number = Date.now, cascade: ProjectCascade = { usage: () => ({ goals: 0, memories: 0 }), remove: () => {} }): MockProjects {
  const items = new Map<string, Project>();
  const get = (id: string): Project => {
    if (!PROJECT_ID.test(id)) throw invalidProjectId();
    const p = items.get(id);
    if (!p) throw projectNotFound();
    return p;
  };
  const copy = (p: Project): Project => ({ ...p, context_folders: [...p.context_folders] });
  const setArchived = (id: string, archived: boolean): Project => {
    const next: Project = { ...get(id), archived, updated_at: now() };
    items.set(id, next);
    return copy(next);
  };
  const api: ProjectBackend = {
    // 与 SQL 的 ORDER BY updated_at DESC, created_at DESC 一致：时间相同时后加入的在前
    listProjects: async () => [...items.values()].reverse().sort((a, b) => b.updated_at - a.updated_at).map(copy),
    async saveProject(p) {
      if (p.id !== undefined && !PROJECT_ID.test(p.id)) throw invalidProjectId();
      const t = now();
      if (p.id) {
        const cur = get(p.id);
        const next: Project = { ...cur, ...mergeProject(cur, p), updated_at: t };
        items.set(p.id, next);
        return copy(next);
      }
      const v = normalizeProject(p);
      if (items.size >= MAX_PROJECTS) throw projectFull();
      const created: Project = { id: newProjectId(), ...v, archived: false, created_at: t, updated_at: t };
      items.set(created.id, created);
      return copy(created);
    },
    archiveProject: async (id) => setArchived(id, true),
    unarchiveProject: async (id) => setArchived(id, false),
    async projectUsage(id) {
      get(id);
      return cascade.usage(id);
    },
    async deleteProject(id) {
      get(id);
      const n = cascade.usage(id);
      cascade.remove(id);
      items.delete(id);
      return n;
    },
  };
  return { api, alive: (id) => items.has(id) };
}

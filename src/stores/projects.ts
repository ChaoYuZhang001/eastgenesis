// 项目：内容栏「项目」分组的数据来源。新建、编辑、归档、取消归档；删除分两步：
// 先 requestDelete 查出会连带删除多少目标和记忆，用户在确认框里再确认一次才 confirmDelete（软删除）。
// 说明和路由偏好的继承在 decision/project.ts（resolveInstructions / resolveRoutingPreference），这里只管数据。
import { create } from "zustand";
import { toAppError } from "@/lib/ipc";
import { getBackend, type Project, type ProjectInput, type ProjectUsage } from "@/platform";
import { useGoals } from "./goals";
import { useMemory } from "./memory";

/** 等待二次确认的删除：确认框里显示名称和会连带删除的数量 */
export interface PendingProjectDelete {
  id: string;
  name: string;
  usage: ProjectUsage;
}

interface ProjectState {
  loaded: boolean;
  /** 按最近更新排序，含已归档的（UI 按 archived 分组） */
  items: Project[];
  error: string | null;
  pendingDelete: PendingProjectDelete | null;
  load(): Promise<void>;
  /** 不带 id 是新建，带 id 是编辑（没给的字段保持原值）；成功返回保存后的项目，失败返回错误说明 */
  save(p: ProjectInput): Promise<Project | string>;
  archive(id: string): Promise<string | null>;
  unarchive(id: string): Promise<string | null>;
  /** 删除第一步：查出连带数量，填进 pendingDelete；失败返回错误说明 */
  requestDelete(id: string): Promise<string | null>;
  cancelDelete(): void;
  /** 删除第二步：软删除项目和它的目标、记忆；成功返回实际删除的数量 */
  confirmDelete(): Promise<ProjectUsage | string>;
}

// 连续点了两个项目的删除时，只保留最后一次的确认框
let deleteSeq = 0;

export const useProjects = create<ProjectState>((set, get) => {
  async function mutate(f: () => Promise<unknown>): Promise<string | null> {
    try {
      await f();
      await get().load();
      return null;
    } catch (e) {
      return toAppError(e).message;
    }
  }

  return {
    loaded: false,
    items: [],
    error: null,
    pendingDelete: null,
    async load() {
      try {
        set({ items: await getBackend().listProjects(), loaded: true, error: null });
      } catch (e) {
        set({ loaded: true, error: toAppError(e).message });
      }
    },
    async save(p) {
      try {
        const r = await getBackend().saveProject(p);
        await get().load();
        return r;
      } catch (e) {
        return toAppError(e).message;
      }
    },
    archive: (id) => mutate(() => getBackend().archiveProject(id)),
    unarchive: (id) => mutate(() => getBackend().unarchiveProject(id)),
    async requestDelete(id) {
      const n = ++deleteSeq;
      try {
        const usage = await getBackend().projectUsage(id);
        if (n !== deleteSeq) return null;
        const name = get().items.find((p) => p.id === id)?.name ?? "";
        set({ pendingDelete: { id, name, usage } });
        return null;
      } catch (e) {
        if (n === deleteSeq) set({ pendingDelete: null });
        return toAppError(e).message;
      }
    },
    cancelDelete() {
      deleteSeq++;
      set({ pendingDelete: null });
    },
    async confirmDelete() {
      const p = get().pendingDelete;
      if (!p) return "没有待确认的删除";
      deleteSeq++;
      set({ pendingDelete: null });
      try {
        return await getBackend().deleteProject(p.id);
      } catch (e) {
        return toAppError(e).message;
      } finally {
        // 成功或失败（例如已经被删）都以数据库为准刷新；目标和记忆已加载过的才刷新
        await Promise.all([
          get().load(),
          useGoals.getState().loaded ? useGoals.getState().load() : null,
          useMemory.getState().loaded ? useMemory.getState().load() : null,
        ]);
      }
    },
  };
});

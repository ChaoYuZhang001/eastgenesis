// 记忆：设置页查看、添加、修改、删除；任务开始时按目标挑出相关的几条。
// 只有用户在设置页添加、或在任务卡片上确认的内容才会进来。
import { create } from "zustand";
import { selectMemories } from "@/agent";
import { toAppError } from "@/lib/ipc";
import { getBackend, type Memory, type MemoryInput } from "@/platform";

interface MemoryState {
  loaded: boolean;
  items: Memory[];
  error: string | null;
  load(): Promise<void>;
  /** 成功返回保存后的条目，失败返回错误说明 */
  save(m: MemoryInput): Promise<Memory | string>;
  remove(id: string): Promise<string | null>;
  /** 与目标相关的记忆：偏好全部带上，事实按词重叠挑选 */
  pick(goal: string): Memory[];
  /** 任务用过的记忆计数；失败不影响任务 */
  markUsed(ids: readonly string[]): void;
}

export const useMemory = create<MemoryState>((set, get) => ({
  loaded: false,
  items: [],
  error: null,
  async load() {
    try {
      set({ items: await getBackend().listMemories(), loaded: true, error: null });
    } catch (e) {
      set({ loaded: true, error: toAppError(e).message });
    }
  },
  async save(m) {
    try {
      const r = await getBackend().saveMemory(m);
      await get().load();
      return r;
    } catch (e) {
      return toAppError(e).message;
    }
  },
  async remove(id) {
    try {
      await getBackend().deleteMemory(id);
      await get().load();
      return null;
    } catch (e) {
      return toAppError(e).message;
    }
  },
  pick: (goal) => selectMemories(get().items, goal),
  markUsed(ids) {
    if (ids.length === 0) return;
    void getBackend()
      .touchMemories(ids)
      .then(() => get().load())
      .catch(() => {});
  },
}));

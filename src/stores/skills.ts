// 技能库：设置页查看、添加、修改、删除；完成的任务可以保存为技能；规划时按目标挑出一两个作参考。
import { create } from "zustand";
import { selectSkills } from "@/agent";
import { toAppError } from "@/lib/ipc";
import { getBackend, type Skill, type SkillInput } from "@/platform";

interface SkillState {
  loaded: boolean;
  items: Skill[];
  error: string | null;
  load(): Promise<void>;
  /** 成功返回保存后的技能，失败返回错误说明 */
  save(s: SkillInput): Promise<Skill | string>;
  remove(id: string): Promise<string | null>;
  /** 与目标最相关的一两个技能 */
  pick(goal: string): Skill[];
  /** 规划参考过的技能计数；失败不影响任务 */
  markUsed(ids: readonly string[]): void;
}

export const useSkills = create<SkillState>((set, get) => ({
  loaded: false,
  items: [],
  error: null,
  async load() {
    try {
      set({ items: await getBackend().listSkills(), loaded: true, error: null });
    } catch (e) {
      set({ loaded: true, error: toAppError(e).message });
    }
  },
  async save(s) {
    try {
      const r = await getBackend().saveSkill(s);
      await get().load();
      return r;
    } catch (e) {
      return toAppError(e).message;
    }
  },
  async remove(id) {
    try {
      await getBackend().deleteSkill(id);
      await get().load();
      return null;
    } catch (e) {
      return toAppError(e).message;
    }
  },
  pick: (goal) => selectSkills(get().items, goal),
  markUsed(ids) {
    if (ids.length === 0) return;
    void getBackend()
      .touchSkills(ids)
      .then(() => get().load())
      .catch(() => {});
  },
}));

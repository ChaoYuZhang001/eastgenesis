// 目标：长任务的数据来源。新建、编辑、开始/继续、暂停、放弃（保留历史）、删除（软删除），
// 以及「AI 声称完成，但无实据」时由用户裁决。运行时（M10）的轮次操作也走 apply：读出 → decision/goal.ts 状态机 → 写回，
// 非法转换由状态机抛错，数据库不变。这里不自动开下一轮、不自动收尾。
import { create } from "zustand";
import { toAppError, type AppError } from "@/lib/ipc";
import { getBackend, type Goal, type GoalChange, type GoalInput } from "@/platform";

interface GoalState {
  loaded: boolean;
  /** 全部未删除的目标，按最近更新排序；按项目筛选用 goalsOfProject */
  items: Goal[];
  error: string | null;
  load(): Promise<void>;
  /** 不带 id 是新建（状态 idle），带 id 是编辑；成功返回保存后的目标，失败返回错误说明 */
  save(g: GoalInput): Promise<Goal | string>;
  /** 未开始 → 进行中；已暂停 → 进行中（继续） */
  start(id: string): Promise<string | null>;
  pause(id: string): Promise<string | null>;
  /** 放弃：保留轮次和执行记录 */
  abandon(id: string): Promise<string | null>;
  /** 删除：软删除，列表里不再出现；已经删掉的当作成功 */
  remove(id: string): Promise<string | null>;
  /** 本轮结论是「拿不准」时用户裁决：done 判为完成，continue 继续下一轮 */
  resolve(id: string, choice: "done" | "continue"): Promise<string | null>;
  /** 任意一次状态或轮次变更；成功返回变更后的目标 */
  apply(id: string, change: GoalChange): Promise<Goal | string>;
}

/** 某个项目下的目标；projectId 为 null 时是不属于任何项目的目标。返回新数组，组件里配合 useMemo 使用 */
export function goalsOfProject(items: readonly Goal[], projectId: string | null): Goal[] {
  return items.filter((g) => g.project_id === projectId);
}

// 与数据库 list 的排序一致：最近更新在前，同一时间按创建时间
const order = (a: Goal, b: Goal) => b.updated_at - a.updated_at || b.created_at - a.created_at;

export const useGoals = create<GoalState>((set) => {
  // 写入成功后只替换这一条，不整表重读（运行时一轮里会有多次写入）；已删除的从列表移除
  const put = (g: Goal) =>
    set((s) => {
      const rest = s.items.filter((x) => x.id !== g.id);
      return { items: g.status === "deleted" ? rest : [...rest, g].sort(order) };
    });
  const drop = (id: string) => set((s) => ({ items: s.items.filter((x) => x.id !== id) }));

  async function change(id: string, c: GoalChange): Promise<Goal | AppError> {
    try {
      const g = await getBackend().updateGoal(id, c);
      put(g);
      return g;
    } catch (e) {
      const err = toAppError(e);
      // 目标已不在（被删除，或所属项目被删除）：列表里也去掉
      if (err.code === "goal_not_found") drop(id);
      return err;
    }
  }
  const message = (r: Goal | AppError) => ("code" in r ? r.message : null);

  return {
    loaded: false,
    items: [],
    error: null,
    async load() {
      try {
        set({ items: await getBackend().listGoals(), loaded: true, error: null });
      } catch (e) {
        set({ loaded: true, error: toAppError(e).message });
      }
    },
    async save(g) {
      try {
        const r = await getBackend().saveGoal(g);
        put(r);
        return r;
      } catch (e) {
        const err = toAppError(e);
        if (err.code === "goal_not_found" && g.id) drop(g.id);
        return err.message;
      }
    },
    start: async (id) => message(await change(id, { op: "transition", to: "running" })),
    pause: async (id) => message(await change(id, { op: "transition", to: "paused" })),
    abandon: async (id) => message(await change(id, { op: "transition", to: "abandoned" })),
    async remove(id) {
      const r = await change(id, { op: "transition", to: "deleted" });
      return "code" in r && r.code !== "goal_not_found" ? r.message : null;
    },
    resolve: async (id, choice) => message(await change(id, { op: "resolve_uncertain", choice })),
    async apply(id, c) {
      const r = await change(id, c);
      return "code" in r ? r.message : r;
    },
  };
});

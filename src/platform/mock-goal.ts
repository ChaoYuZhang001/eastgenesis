// 浏览器模式的目标：内存 Map，规则与桌面端（lib/db-goal.ts）相同，状态转换和轮次操作同样走 decision/goal.ts applyGoalChange。
import { GOAL_ID, MAX_GOALS, applyGoalChange, editGoal, goalFull, goalNotFound, invalidGoalId, newGoal, normalizeGoal } from "@/decision/goal";
import { PROJECT_ID, invalidProjectId, projectNotFound } from "@/decision/project";
import type { Backend, Goal } from "./types";

type GoalBackend = Pick<Backend, "listGoals" | "saveGoal" | "updateGoal">;

export interface MockGoals {
  api: GoalBackend;
  countByProject(projectId: string): number;
  /** 删除项目时连带删除；删除后查不到，与桌面端的软删除对外表现一致 */
  removeByProject(projectId: string): number;
}

// 深拷贝：调用方改返回值不会影响存着的数据（桌面端每次都是从数据库读出的新对象）
const copy = (g: Goal): Goal => JSON.parse(JSON.stringify(g)) as Goal;

export function createMockGoals(now: () => number = Date.now, projectAlive: (id: string) => boolean = () => false): MockGoals {
  const items = new Map<string, Goal>();
  const get = (id: string): Goal => {
    if (!GOAL_ID.test(id)) throw invalidGoalId();
    const g = items.get(id);
    if (!g) throw goalNotFound();
    return g;
  };
  const put = (g: Goal): Goal => {
    if (g.status === "deleted") items.delete(g.id);
    else items.set(g.id, g);
    return copy(g);
  };
  const ofProject = (projectId: string) => [...items.values()].filter((g) => g.project_id === projectId);
  const api: GoalBackend = {
    async listGoals(projectId) {
      if (projectId !== undefined && !PROJECT_ID.test(projectId)) throw invalidProjectId();
      const all = [...items.values()].reverse().sort((a, b) => b.updated_at - a.updated_at);
      return (projectId === undefined ? all : all.filter((g) => g.project_id === projectId)).map(copy);
    },
    async saveGoal(p) {
      if (p.id !== undefined && !GOAL_ID.test(p.id)) throw invalidGoalId();
      if (p.id) return put(editGoal(get(p.id), p, now()));
      const v = normalizeGoal(p);
      if (v.project_id !== null && !projectAlive(v.project_id)) throw projectNotFound();
      if (items.size >= MAX_GOALS) throw goalFull();
      return put(newGoal(v, now()));
    },
    async updateGoal(id, change) {
      return put(applyGoalChange(get(id), change, now()));
    },
  };
  return {
    api,
    countByProject: (projectId) => ofProject(projectId).length,
    removeByProject(projectId) {
      const list = ofProject(projectId);
      for (const g of list) items.delete(g.id);
      return list.length;
    },
  };
}

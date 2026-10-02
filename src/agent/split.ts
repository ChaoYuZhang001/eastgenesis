// 多 Agent 协同的拆分：提示词与解析。协调器用它把目标拆成 2–4 个可以并行、互不依赖的子任务。
import { extractJson } from "./planner";
import type { SubAgentSpec } from "./types";

export const MAX_SUBAGENTS = 4;
export const COORDINATOR_MARK = "你是 EastGenesis 的协调器";

export const SPLIT_SYSTEM = [
  `${COORDINATOR_MARK}。把用户目标拆成 2 到 ${MAX_SUBAGENTS} 个可以并行、互不依赖的子任务，每个交给一个角色。`,
  '只输出一个 JSON 对象：{"agents":[{"role":"角色名","goal":"子任务（写清楚要产出什么，不依赖其他子任务的结果）"}]}',
  '目标不适合拆分时只给一个角色：{"agents":[{"role":"通用智能体","goal":"原目标"}]}',
].join("\n");

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/** 单个条目：角色名规整空白后最多 20 字，子任务最多 1000 字 */
const specOf = (a: unknown) =>
  isObj(a) && typeof a.role === "string" && typeof a.goal === "string"
    ? [{ role: a.role.replace(/\s+/g, " ").trim().slice(0, 20), goal: a.goal.trim().slice(0, 1000) }]
    : [];

/** 解析拆分结果：丢掉无效条目，最多保留 4 个并重新编号；一个都没有时返回 null */
export function parseSplit(text: string): SubAgentSpec[] | null {
  const j = extractJson(text);
  const arr: unknown[] = isObj(j) && Array.isArray(j.agents) ? j.agents : [];
  const specs = arr
    .flatMap(specOf)
    .filter((a) => a.role && a.goal)
    .slice(0, MAX_SUBAGENTS)
    .map((a, i) => ({ id: `a${i + 1}`, ...a }));
  return specs.length ? specs : null;
}

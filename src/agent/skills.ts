// 技能进入规划：按目标挑出最相关的一两个用户保存过的流程，作为参考交给规划器，不强制照做。
// 只放进规划提示；回答和总结不带技能。
import { memoryTokens } from "./memory";

export interface SkillNote {
  id: string;
  name: string;
  description: string;
  steps: readonly { goal: string; tool: string | null; args?: Record<string, unknown>; each?: string }[];
  use_count: number;
  updated_at: number;
  last_used_at?: number | null;
}

export const MAX_SKILLS_IN_PROMPT = 2;
/** 至少这么多个词与目标重叠才算相关，避免一个常见词就把技能带进来 */
const MIN_OVERLAP = 2;

const skillText = (s: SkillNote) => [s.name, s.description, ...s.steps.map((x) => x.goal)].join(" ");

/** 「再整理一次」「照上次那样」「again」：重复上一次做过的事 */
export const REPEAT_INTENT = /再(?:来|做|整理|跑|执行|处理|弄|分类|归类)?一(?:次|遍)|照(?:着)?上次|和上次一样|跟上次一样|按上次的?|\b(?:again|same as last time)\b/i;
export const isRepeat = (goal: string) => REPEAT_INTENT.test(goal);

const lastTouched = (s: SkillNote) => Math.max(s.last_used_at ?? 0, s.updated_at);

/** 重叠多的优先，其次用得多的，再其次最近更新的；「再…一次」没有词重叠时，取最近用过或保存的那个 */
export function selectSkills<T extends SkillNote>(skills: readonly T[], goal: string): T[] {
  const g = memoryTokens(goal);
  const hit = g.size === 0 ? [] : rank(skills, g);
  if (hit.length || !isRepeat(goal) || skills.length === 0) return hit;
  return [[...skills].sort((a, b) => lastTouched(b) - lastTouched(a))[0]];
}

function rank<T extends SkillNote>(skills: readonly T[], g: Set<string>): T[] {
  return skills
    .map((s) => ({ s, score: [...memoryTokens(skillText(s))].filter((t) => g.has(t)).length }))
    .filter((x) => x.score >= MIN_OVERLAP)
    .sort((a, b) => b.score - a.score || b.s.use_count - a.s.use_count || b.s.updated_at - a.s.updated_at)
    .slice(0, MAX_SKILLS_IN_PROMPT)
    .map((x) => x.s);
}

/** 规划提示里的技能段；没有技能时为空串 */
export function skillBlock(skills: readonly Pick<SkillNote, "name" | "steps">[]): string {
  if (skills.length === 0) return "";
  const body = skills.flatMap((s) => [
    `技能「${s.name}」：`,
    ...s.steps.map((x, i) => `  ${i + 1}. ${x.goal}${x.tool ? `（工具：${x.tool}）` : ""}`),
  ]);
  return ["以下是用户保存的技能（做过的类似任务的步骤），可以参考；不适用就忽略，工具只能从上面的可用工具里选：", ...body].join("\n");
}

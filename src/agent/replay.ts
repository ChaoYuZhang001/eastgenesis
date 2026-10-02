// 技能重放：用户说「再整理一次」这类话，且挑中的技能开头是带参数的只读步骤时，运行时直接按技能执行这些步骤，
// 不再请规划器重新想一遍；后面要模型判断的步骤（例如按内容分类、移动）仍交给规划器续写，写入类操作照常逐个确认。
// 重放出来的步骤和普通步骤走同一条执行路径：权限闸门、超时、反思、错误恢复都不变。
import { truncate } from "./tools";
import { isRepeat, type SkillNote } from "./skills";
import type { PlanStep, StepRecord, Tool } from "./types";

type SkillStep = SkillNote["steps"][number];

/** 技能名或原话完全一致，也算重复执行 */
const same = (a: string, b: string) => a.replace(/\s+/g, "") === b.replace(/\s+/g, "");

/**
 * 可以直接执行的开头几步：工具存在、没有副作用、保存了参数。
 * 只在明确要求重复（「再…一次」、目标与技能名相同）时才重放，避免相似但不同的任务照搬上次的路径。
 */
export function replayPlan(skill: SkillNote | undefined, goal: string, tool: (name: string) => Tool | undefined): { steps: SkillStep[]; rest: number } | null {
  if (!skill || !(isRepeat(goal) || same(goal, skill.name))) return null;
  const steps: SkillStep[] = [];
  for (const s of skill.steps) {
    const t = s.tool ? tool(s.tool) : undefined;
    if (!t || t.sideEffect !== "none" || !s.args) break;
    steps.push(s);
  }
  // 第一步就要逐项展开，没有可展开的来源
  if (steps.length === 0 || steps[0].each) return null;
  return { steps, rest: skill.steps.length - steps.length };
}

interface Item {
  name: string;
  path: string;
}
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const DIR = /^(?:dir|directory|folder)$/i;

/** 从上一步的结构化结果里取出要逐项处理的条目：entries / files / items 数组里带 path 的文件 */
export function listedItems(output: string | undefined): Item[] {
  let j: unknown;
  try {
    j = JSON.parse(output ?? "");
  } catch {
    return [];
  }
  const arr = Array.isArray(j) ? j : isObj(j) ? [j.entries, j.files, j.items].find(Array.isArray) : undefined;
  if (!Array.isArray(arr)) return [];
  return arr.flatMap((e): Item[] => {
    if (!isObj(e) || typeof e.path !== "string" || !e.path) return [];
    if (typeof e.type === "string" && DIR.test(e.type)) return [];
    const name = typeof e.name === "string" && e.name ? e.name : (e.path.split(/[\\/]/).pop() ?? e.path);
    return [{ name, path: e.path }];
  });
}

/** 把技能的一步变成可执行的步骤；each 步骤按上一步列出的条目展开，没有条目时返回空数组 */
export function expandStep(s: SkillStep, prefix: string, records: readonly StepRecord[], max: number): PlanStep[] {
  const args = { ...(s.args ?? {}) };
  if (!s.each) return [{ id: `${prefix}1`, goal: s.goal, tool: s.tool, args }];
  const last = [...records].reverse().find((r) => r.status === "done");
  return listedItems(last?.output)
    .slice(0, max)
    .map((it, k) => ({ id: `${prefix}${k + 1}`, goal: s.goal.split("{名称}").join(it.name), tool: s.tool, args: { ...args, [s.each!]: it.path } }));
}

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();

/** 工具结果的一句话：src/dst → 「原 → 新」，path → 路径，其余截断原文 */
function brief(output: string | undefined): string {
  try {
    const j: unknown = JSON.parse(output ?? "");
    if (isObj(j)) {
      if (typeof j.src === "string" && typeof j.dst === "string") return `${j.src} → ${j.dst}`;
      if (typeof j.path === "string") return j.path;
    }
  } catch {
    // 不是 JSON：用原文
  }
  return truncate(output ?? "", 120);
}

/**
 * 技能重放的成果报告：直接由执行记录生成，不再调模型总结。
 * 有副作用的步骤（建目录、移动等）逐行列出子目标和结果；没有时列出全部步骤。
 */
export function replayReport(name: string, records: readonly StepRecord[], tool: (name: string) => Tool | undefined): string {
  const done = records.filter((r) => r.status === "done");
  const writes = done.filter((r) => r.step.tool && (tool(r.step.tool)?.sideEffect ?? "none") !== "none");
  const failed = records.length - done.length;
  const rows = (writes.length ? writes : done).map((r) => `| ${cell(r.step.goal)} | ${cell(brief(r.output))} |`);
  return [
    `按技能「${name}」重复执行，完成 ${done.length} 步（其中写入 ${writes.length} 步）${failed ? `，${failed} 步没有完成` : ""}。`,
    "",
    "| 操作 | 结果 |",
    "| --- | --- |",
    ...rows,
  ].join("\n");
}

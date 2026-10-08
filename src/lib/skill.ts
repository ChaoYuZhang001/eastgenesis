// 技能的校验、步骤文本的解析与生成、从任务事件里取出实际完成的步骤。桌面端（db-skill.ts）和浏览器模式（mock-skill.ts）共用。
// 技能保存子目标和工具名；只读步骤（权限闸门直接放行、低风险）额外保存脱敏后的参数，「再…一次」时由运行时直接执行。
// 写入、移动、删除类步骤不保存参数：重复执行时仍由模型根据新结果决定，并照常逐个确认。
import type { AgentEvent } from "@/agent";
import { TOOL_NAME } from "@/agent/tools";
import { redact } from "@/core/redact";
import type { AppError } from "./ipc";
import type { SkillInput, SkillStep } from "@/platform/types";

export const MAX_SKILLS = 100;
export const MAX_SKILL_NAME = 60;
export const MAX_SKILL_DESC = 300;
export const MAX_SKILL_STEPS = 12;
export const MAX_STEP_GOAL = 200;
export const SKILL_ID = /^skill-[a-z0-9-]{1,48}$/;
/** 一步的参数 JSON 最多这么长 */
export const MAX_STEP_ARGS = 2000;
const ARG_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;

const fail = (code: string, message: string): AppError => ({ code, message, detail: null });
export const skillNotFound = () => fail("skill_not_found", "没有找到这个技能");
export const skillFull = () => fail("skill_full", `最多保存 ${MAX_SKILLS} 个技能，请先删除一些`);
export const invalidSkillId = () => fail("invalid_skill_id", "技能 ID 无效");
const bad = (message: string) => fail("invalid_skill", message);
const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const clean = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim();

/** 规整并校验；不回显内容 */
export function normalizeSkill(s: SkillInput): { name: string; description: string; steps: SkillStep[]; source: "manual" | "task" } {
  const name = clean(s.name);
  const description = clean(s.description);
  if (!name || name.length > MAX_SKILL_NAME) throw bad(`名称应为 1–${MAX_SKILL_NAME} 个字符`);
  if (description.length > MAX_SKILL_DESC) throw bad(`说明最多 ${MAX_SKILL_DESC} 个字符`);
  if (!Array.isArray(s.steps) || s.steps.length === 0 || s.steps.length > MAX_SKILL_STEPS) throw bad(`步骤应为 1–${MAX_SKILL_STEPS} 步`);
  const steps = s.steps.map((st, i) => {
    const goal = clean(st?.goal);
    const tool = clean(st?.tool) || null;
    if (!goal || goal.length > MAX_STEP_GOAL) throw bad(`第 ${i + 1} 步的子目标应为 1–${MAX_STEP_GOAL} 个字符`);
    if (tool && !TOOL_NAME.test(tool)) throw bad(`第 ${i + 1} 步的工具名无效`);
    const out: SkillStep = { goal, tool };
    if (tool && st.args !== undefined) {
      const json = isPlain(st.args) ? JSON.stringify(st.args) : "";
      if (!json || json.length > MAX_STEP_ARGS) throw bad(`第 ${i + 1} 步的参数无效`);
      out.args = JSON.parse(json) as Record<string, unknown>;
    }
    if (tool && st.each !== undefined) {
      if (typeof st.each !== "string" || !ARG_KEY.test(st.each)) throw bad(`第 ${i + 1} 步的逐项参数名无效`);
      out.each = st.each;
    }
    return out;
  });
  const texts = [name, description, ...steps.flatMap((x) => [x.goal, x.args ? JSON.stringify(x.args) : ""])];
  if (texts.some((t) => redact(t) !== t)) throw bad("内容看起来包含密钥或令牌，不能保存为技能");
  return { name, description, steps, source: s.source === "task" ? "task" : "manual" };
}

export function newSkillId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (typeof c?.randomUUID === "function") return `skill-${c.randomUUID()}`;
  return `skill-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 表单改完步骤文本后：子目标和工具都没变的行，保留原来保存的参数 */
export function keepStepArgs(parsed: readonly SkillStep[], before: readonly SkillStep[]): SkillStep[] {
  return parsed.map((p, i) => {
    const b = before[i];
    if (!b || b.goal !== p.goal || b.tool !== p.tool) return p;
    return { ...p, ...(b.args ? { args: b.args } : {}), ...(b.each ? { each: b.each } : {}) };
  });
}

/** 每行一步，写成「子目标 | 工具名」，工具名可省略；按最后一个 | 分开 */
export function parseStepLines(text: string): SkillStep[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const i = l.lastIndexOf("|");
      return i < 0 ? { goal: l, tool: null } : { goal: l.slice(0, i).trim(), tool: l.slice(i + 1).trim() || null };
    });
}

export function formatStepLines(steps: readonly SkillStep[]): string {
  return steps.map((s) => (s.tool ? `${s.goal} | ${s.tool}` : s.goal)).join("\n");
}

type StepState = "running" | "done" | "failed";

/** 任务里实际做完的步骤：按首次开始的顺序，跨重新规划累计；失败、被拒绝和没做完的不算，重试成功只算一次 */
export function stepsFromEvents(events: readonly AgentEvent[]): SkillStep[] {
  const steps = new Map<string, { goal: string; tool: string | null; state: StepState }>();
  const mark = (id: string, state: StepState) => {
    const s = steps.get(id);
    if (s) s.state = state;
  };
  for (const e of events) {
    if (e.type === "step_start") steps.set(e.step.id, { goal: e.step.goal, tool: e.step.tool, state: "running" });
    else if (e.type === "tool_result") mark(e.step.id, e.ok ? "done" : "failed");
    else if ((e.type === "confirm" && !e.approved) || (e.type === "gate" && e.verdict === "deny") || e.type === "recover") mark(e.step.id, "failed");
    else if (e.type === "reflect" && e.step) {
      if (e.accepted === false) mark(e.step.id, "failed");
      else if (e.accepted === true || steps.get(e.step.id)?.state === "running") mark(e.step.id, "done");
    }
    else if (e.type === "run_end") for (const s of steps.values()) if (s.state === "running") s.state = e.status === "completed" ? "done" : "failed";
  }
  return [...steps.values()].filter((s) => s.state === "done").map((s) => ({ goal: s.goal.slice(0, MAX_STEP_GOAL), tool: s.tool }));
}

interface RecipeStep {
  goal: string;
  tool: string | null;
  args?: Record<string, unknown>;
  readOnly: boolean;
}

const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;

/** 同一工具连续做了多步：参数里只有一个字符串参数在变时，合成一步「逐项」，其余参数原样保存 */
function fold(run: RecipeStep[]): SkillStep {
  const first = run[0];
  const n = run.length;
  if (n === 1) return { goal: first.goal, tool: first.tool, ...(first.readOnly && first.args ? { args: first.args } : {}) };
  if (first.readOnly && run.every((r) => r.args)) {
    const keys = [...new Set(run.flatMap((r) => Object.keys(r.args!)))];
    const varying = keys.filter((k) => new Set(run.map((r) => JSON.stringify(r.args![k]))).size > 1);
    const key = varying[0];
    if (varying.length === 1 && run.every((r) => typeof r.args![key] === "string")) {
      const { [key]: v, ...rest } = first.args!;
      const name = baseName(String(v));
      const goal = name && first.goal.includes(name) ? first.goal.split(name).join("{名称}") : `逐项处理上一步列出的内容（${first.tool}）`;
      return { goal: goal.slice(0, MAX_STEP_GOAL), tool: first.tool, args: rest, each: key };
    }
  }
  return { goal: `${first.goal}（同类操作共 ${n} 步）`.slice(0, MAX_STEP_GOAL), tool: first.tool };
}

/**
 * 保存技能用的步骤：在 stepsFromEvents 的基础上，只读步骤保留脱敏后的参数，同一工具的连续步骤合成一步。
 * 只读：工具本身没有副作用（以权限闸门的判断为准）。写入类步骤不保存参数。
 */
export function recipeFromEvents(events: readonly AgentEvent[]): SkillStep[] {
  const done = new Set(doneIds(events));
  const info = new Map<string, RecipeStep>();
  for (const e of events) {
    if (e.type === "step_start" && !info.has(e.step.id)) info.set(e.step.id, { goal: e.step.goal.slice(0, MAX_STEP_GOAL), tool: e.step.tool, readOnly: false });
    else if (e.type === "gate") {
      const s = info.get(e.step.id);
      if (s) {
        // 工具本身没有副作用（闸门没写「工具有副作用」）才算只读；重放时照样过闸门，该确认的仍会确认
        s.readOnly = e.verdict !== "deny" && !e.reasons.some((r) => r.startsWith("工具有副作用"));
        if (e.step.args) s.args = e.step.args;
      }
    }
  }
  const steps = [...info.entries()].filter(([id]) => done.has(id)).map(([, s]) => s);
  const out: SkillStep[] = [];
  for (let i = 0; i < steps.length; ) {
    let j = i + 1;
    while (j < steps.length && steps[i].tool !== null && steps[j].tool === steps[i].tool && steps[j].readOnly === steps[i].readOnly) j++;
    out.push(fold(steps.slice(i, j)));
    i = j;
  }
  return out.slice(0, MAX_SKILL_STEPS);
}

/** 与 stepsFromEvents 同样的判定，返回做完的步骤 ID */
function doneIds(events: readonly AgentEvent[]): string[] {
  const state = new Map<string, StepState>();
  const mark = (id: string, s: StepState) => state.has(id) && state.set(id, s);
  for (const e of events) {
    if (e.type === "step_start") state.set(e.step.id, "running");
    else if (e.type === "tool_result") mark(e.step.id, e.ok ? "done" : "failed");
    else if ((e.type === "confirm" && !e.approved) || (e.type === "gate" && e.verdict === "deny") || e.type === "recover") mark(e.step.id, "failed");
    else if (e.type === "reflect" && e.step) {
      if (e.accepted === false) mark(e.step.id, "failed");
      else if (e.accepted === true || state.get(e.step.id) === "running") mark(e.step.id, "done");
    }
    else if (e.type === "run_end") for (const [id, s] of state) if (s === "running") state.set(id, e.status === "completed" ? "done" : "failed");
  }
  return [...state].filter(([, s]) => s === "done").map(([id]) => id);
}

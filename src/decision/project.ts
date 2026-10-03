// 项目：一组目标和任务共用的说明、上下文文件夹和路由偏好。桌面端（lib/db-project.ts）和浏览器模式（platform/mock-project.ts）共用这里的校验。
// 继承：说明按「全局系统提示 < 项目 < 目标 < 任务」叠加，同层内后写的覆盖先写的；
// 路由偏好按「任务 > 目标 > 项目 > 全局默认 balanced」取第一个设了的。
import { redact } from "../core/redact";
import type { Preference } from "./router";

export interface Project {
  id: string;
  name: string;
  description: string;
  /** 项目级说明：这个项目下的每个目标和任务都会带上 */
  instructions: string;
  /** 允许这个项目使用的文件夹（绝对路径，可以用 ~/ 开头） */
  context_folders: string[];
  /** null：不覆盖，沿用全局设置 */
  routing_preference: Preference | null;
  /** 归档只是从默认列表里隐藏，目标和记忆不受影响 */
  archived: boolean;
  created_at: number;
  updated_at: number;
}

/** 新建时不带 id、必须有名称；编辑时带 id，没给的字段保持原值。归档状态只能用 archiveProject / unarchiveProject 改 */
export interface ProjectInput {
  id?: string;
  name?: string;
  description?: string;
  instructions?: string;
  context_folders?: readonly string[];
  routing_preference?: Preference | null;
}

/** 删除项目时会连带删除的数量（二次确认里显示） */
export interface ProjectUsage {
  goals: number;
  memories: number;
}

export interface ProjectError {
  code: string;
  message: string;
  detail: string | null;
}

export const MAX_PROJECTS = 100;
export const MAX_PROJECT_NAME = 60;
export const MAX_PROJECT_DESC = 500;
export const MAX_INSTRUCTIONS = 4000;
export const MAX_CONTEXT_FOLDERS = 16;
export const MAX_FOLDER_PATH = 1024;
export const PROJECT_ID = /^prj-[a-z0-9-]{1,48}$/;
export const PREFERENCES: readonly Preference[] = ["economy", "balanced", "best"];
export const DEFAULT_PREFERENCE: Preference = "balanced";

export const fail = (code: string, message: string): ProjectError => ({ code, message, detail: null });
const bad = (message: string) => fail("invalid_project", message);
export const projectNotFound = () => fail("project_not_found", "没有找到这个项目");
export const projectFull = () => fail("project_full", `最多保存 ${MAX_PROJECTS} 个项目，请先删除一些`);
export const invalidProjectId = () => fail("invalid_project_id", "项目 ID 无效");

/** 单行文本：空白折叠成一个空格 */
export const cleanLine = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim();

/** 多行说明：统一换行符，去掉控制字符（保留换行和制表符），最多保留一个空行 */
export function cleanText(s: unknown): string {
  return String(s ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 内容像密钥或令牌：不保存（规则同记忆和技能） */
export const looksSecret = (s: string) => redact(s) !== s;

// POSIX 绝对路径、~/ 开头、Windows 盘符路径
const ABSOLUTE = /^(?:\/|~\/|[A-Za-z]:[\\/])/;
const ROOTS = /^(?:\/|~|~\/|[A-Za-z]:[\\/]?)$/;

/** 上下文文件夹：绝对路径、不含 ..、去掉末尾分隔符后去重；不允许整个磁盘或整个家目录 */
export function normalizeFolders(v: unknown): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw bad("上下文文件夹应是路径列表");
  const out: string[] = [];
  for (const raw of v) {
    const p = String(raw ?? "").trim();
    if (!p) continue;
    if (p.length > MAX_FOLDER_PATH || /[\u0000-\u001f\u007f]/.test(p)) throw bad("上下文文件夹路径无效");
    // 连续分隔符合并成一个，去掉末尾分隔符（根目录本身除外）
    const collapsed = p.replace(/([\\/])[\\/]+/g, "$1");
    const path = collapsed.length > 1 ? collapsed.replace(/[\\/]$/, "") : collapsed;
    if (ROOTS.test(path)) throw bad("上下文文件夹不能是整个磁盘或整个家目录");
    if (!ABSOLUTE.test(path)) throw bad("上下文文件夹要写绝对路径（可以用 ~/ 开头）");
    if (path.split(/[\\/]/).includes("..")) throw bad("上下文文件夹路径不能包含 ..");
    if (!out.includes(path)) out.push(path);
  }
  if (out.length > MAX_CONTEXT_FOLDERS) throw bad(`上下文文件夹最多 ${MAX_CONTEXT_FOLDERS} 个`);
  return out;
}

export const isPreference = (v: unknown): v is Preference => typeof v === "string" && (PREFERENCES as readonly string[]).includes(v);

/** 输入：空表示不覆盖；其他值必须是三档之一 */
export function normalizePreference(v: unknown): Preference | null {
  if (v === undefined || v === null || v === "") return null;
  if (!isPreference(v)) throw fail("invalid_preference", "路由偏好只能是省钱、平衡或最强");
  return v;
}

export interface NormalizedProject {
  name: string;
  description: string;
  instructions: string;
  context_folders: string[];
  routing_preference: Preference | null;
}

/** 规整并校验；错误信息不回显内容（用户可能误粘贴了密钥） */
export function normalizeProject(p: ProjectInput): NormalizedProject {
  const name = cleanLine(p.name);
  const description = cleanLine(p.description);
  const instructions = cleanText(p.instructions);
  if (!name || name.length > MAX_PROJECT_NAME) throw bad(`项目名称应为 1–${MAX_PROJECT_NAME} 个字符`);
  if (description.length > MAX_PROJECT_DESC) throw bad(`项目说明最多 ${MAX_PROJECT_DESC} 个字符`);
  if (instructions.length > MAX_INSTRUCTIONS) throw bad(`项目指令最多 ${MAX_INSTRUCTIONS} 个字符`);
  if ([name, description, instructions].some(looksSecret)) throw bad("内容看起来包含密钥或令牌，不能保存");
  return { name, description, instructions, context_folders: normalizeFolders(p.context_folders), routing_preference: normalizePreference(p.routing_preference) };
}

/** 编辑：没给的字段用原值补上，再整体校验；routing_preference 给 null 表示改回「不覆盖」 */
export function mergeProject(cur: Project, p: ProjectInput): NormalizedProject {
  return normalizeProject({
    name: p.name ?? cur.name,
    description: p.description ?? cur.description,
    instructions: p.instructions ?? cur.instructions,
    context_folders: p.context_folders ?? cur.context_folders,
    routing_preference: p.routing_preference === undefined ? cur.routing_preference : p.routing_preference,
  });
}

export function newId(prefix: string): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (typeof c?.randomUUID === "function") return `${prefix}-${c.randomUUID()}`;
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
export const newProjectId = () => newId("prj");

// ---------- 继承 ----------

/** 参与继承的一层：项目、目标、任务都只需要这两个字段 */
export interface Layer {
  instructions?: string | null;
  routing_preference?: Preference | string | null;
}
type Maybe = Layer | null | undefined;

export const INSTRUCTIONS_HEADER =
  "以下是用户对这次任务的要求，按「项目 → 目标 → 任务」从宽到窄排列。和前面的通用说明（包括系统提示里的默认做法）冲突时，以后写的为准；同一层里，后出现的覆盖先出现的。安全规则和权限确认由程序执行，不受这里的要求影响。";

/**
 * 叠加三层说明，放在全局系统提示之后：任务 > 目标 > 项目 > 全局系统提示。
 * 说明是自由文本，没法逐条合并；这里按从宽到窄排好，并写明「后写的为准」，由模型按顺序理解。全部为空时返回空串。
 */
export function resolveInstructions(task: Maybe, goal: Maybe, project: Maybe): string {
  const layers = [
    ["项目", project],
    ["目标", goal],
    ["任务", task],
  ] as const;
  const parts = layers.map(([title, l]) => [title, cleanText(l?.instructions)] as const).filter(([, text]) => text);
  if (parts.length === 0) return "";
  return [INSTRUCTIONS_HEADER, ...parts.map(([title, text]) => `【${title}】\n${text}`)].join("\n\n");
}

export type PreferenceSource = "task" | "goal" | "project" | "global";
export const PREFERENCE_SOURCE_LABEL: Record<PreferenceSource, string> = { task: "任务", goal: "目标", project: "项目", global: "全局设置" };

/** 路由偏好取自哪一层：路由面板据此写明「省钱（来自项目）」 */
export function preferenceSource(task: Maybe, goal: Maybe, project: Maybe, fallback: Preference = DEFAULT_PREFERENCE): { preference: Preference; source: PreferenceSource } {
  for (const [source, l] of [
    ["task", task],
    ["goal", goal],
    ["project", project],
  ] as const) {
    const p = l?.routing_preference;
    if (isPreference(p)) return { preference: p, source };
  }
  return { preference: isPreference(fallback) ? fallback : DEFAULT_PREFERENCE, source: "global" };
}

/** 任务 > 目标 > 项目 > 全局默认（设置页的路由偏好，没有时为 balanced）；无效值当作没设 */
export function resolveRoutingPreference(task: Maybe, goal: Maybe, project: Maybe, fallback: Preference = DEFAULT_PREFERENCE): Preference {
  return preferenceSource(task, goal, project, fallback).preference;
}

// 一轮任务碰过哪些文件、跑过哪些命令：取自工具调用记录（tool_result 之前的 step.args）。
// 用于回答里的「改动」列表和右侧面板的入口（docs/UI_LAYOUT_V3.md 2.2、第 7 节）。只读，不推断。
import type { AgentEvent } from "@/agent";

export type FileAction = "created" | "modified" | "deleted" | "moved" | "read";
export interface FileTouch {
  path: string;
  action: FileAction;
  to?: string;
  ok: boolean;
}
export interface CommandRun {
  command: string;
  ok: boolean;
  output: string;
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
/** 工具名去掉 mcp__<服务器>__ 前缀 */
const base = (tool: string) => tool.replace(/^mcp__[a-z0-9_]+__/, "");

function classify(tool: string): FileAction | "command" | null {
  const t = base(tool).toLowerCase();
  if (/^(move|rename)(_file)?$|move_file/.test(t)) return "moved";
  if (/delete|remove/.test(t)) return "deleted";
  if (/write|save|create_file|append|edit|patch/.test(t)) return "modified";
  if (/create_directory|mkdir/.test(t)) return "created";
  if (/read_(file|pdf)|get_file_info|get_pdf_metadata|list_directory/.test(t)) return "read";
  if (/(^|_)(run|exec|shell|bash|command)/.test(t)) return "command";
  return null;
}

export function artifactsOf(events: readonly AgentEvent[]): { files: FileTouch[]; commands: CommandRun[] } {
  const files: FileTouch[] = [];
  const commands: CommandRun[] = [];
  for (const outer of events) {
    const e = outer.type === "subagent" ? outer.event : outer;
    if (e.type !== "tool_result" || !e.step.tool) continue;
    const kind = classify(e.step.tool);
    if (!kind) continue;
    const args = e.step.args ?? {};
    if (kind === "command") {
      const command = str(args.command) ?? str(args.cmd) ?? e.step.tool;
      commands.push({ command, ok: e.ok, output: e.content });
      continue;
    }
    const path = str(args.path) ?? str(args.source) ?? str(args.from);
    if (!path) continue;
    const to = kind === "moved" ? (str(args.destination) ?? str(args.to) ?? undefined) : undefined;
    const prev = files.findIndex((f) => f.path === path && f.action === kind);
    const item: FileTouch = { path, action: kind, ok: e.ok, ...(to && { to }) };
    if (prev >= 0) files[prev] = item;
    else files.push(item);
  }
  return { files, commands };
}

/** 写入、移动、删除、建目录（不含只读） */
export const changesOf = (files: readonly FileTouch[]) => files.filter((f) => f.action !== "read" && f.ok);

export const ACTION_LABEL: Record<FileAction, string> = { created: "新建", modified: "写入", deleted: "删除", moved: "移动", read: "读取" };

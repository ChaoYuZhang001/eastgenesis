import type { Capability, TaskInput, WorkSurface } from "./types";

export interface WorkSurfaceDecision {
  surface: WorkSurface;
  reason: string;
}

// 工具名本身也是能力证据：同一个“处理文件”目标，调用 read_file 与调用终端脚本
// 的执行面不同。这里只把开发工具标成 Codex 线索，最终仍由 inferWorkSurface
// 结合步骤目标做可解释判断，不把任何工具名直接等同于高权限操作。
const CODEX_TOOL = /(?:terminal|shell|run[_-]?command|execute[_-]?code|apply[_-]?patch|git|test|debug|compile|build|deploy)/i;
const WORK_TOOL = /(?:read[_-]?file|write[_-]?file|list[_-]?directory|directory|folder|filesystem|document|spreadsheet|presentation)/i;

// 只有“代码 + 本地开发动作”才进入 Codex；单纯问代码概念仍留在 Chat。
const CODEX_ACTION =
  /仓库|代码库|项目代码|工作树|终端|命令行|运行(?:测试|代码|脚本)|执行(?:测试|命令)|编译|构建|部署|调试|重构|修改(?:代码|文件)|修复(?:代码|bug|问题)|提交|推送|拉取|git|repo(?:sitory)?|worktree|terminal|shell|debug|refactor|build|compile|deploy|run\s+(?:the|this|my)\s+(?:code|test|script)|pull\s+request/i;

// 文件、研究和交付物属于 Work；是否真的执行写操作仍由权限闸门决定。
const WORK_ACTION =
  /研究|调研|报告|文档|合同|表格|电子表格|演示|演示文稿|幻灯片|整理|归类|分类|归档|总结(?:文件|文档|报告)|生成(?:报告|文档|表格|演示)|分析(?:文件|文档|数据|资料)|下载文件夹|本地文件|文件夹|目录|local\s+file|pdf|document|spreadsheet|presentation|slides?|report|research|organ(?:i|z)e|archive|summari[sz]e|analy[sz]e/i;

const LOCAL_CONTEXT = /~\/|\/Users\/|\/home\/|\b[A-Z]:\\|本地|电脑|桌面|下载|文件夹|目录|仓库|repo(?:sitory)?|workspace|worktree/i;

/**
 * 从用户目标和已识别能力推断统一工作台的能力面。
 *
 * 这一步故意保持为可解释的本地函数：云端 Jev 负责模型/能力判断，
 * 但不能偷偷把普通代码问答或普通文件问答变成高权限本地任务。
 */
export function inferWorkSurface(input: TaskInput, capabilities: readonly Capability[] = []): WorkSurfaceDecision {
  if (input.surfaceHint) return { surface: input.surfaceHint, reason: "用户指定能力面" };

  const text = input.text ?? "";
  const hasCode = capabilities.includes("code") || (input.attachments ?? []).some((a) => a.kind === "code");
  const hasTool = capabilities.includes("tool_use");
  const local = LOCAL_CONTEXT.test(text);
  const codexAction = CODEX_ACTION.test(text);
  // 某些真实任务只有“仓库 / 终端 / 测试”信号，规则分类器未必同时打上 code 标签；
  // 只要明确涉及本地开发上下文和工具执行，就应进入 Codex 能力面。
  if (codexAction && (hasCode || hasTool) && (local || /仓库|代码库|repo(?:sitory)?|git|worktree|terminal|shell/i.test(text))) {
    return { surface: "codex", reason: "需要代码仓库、终端或开发操作" };
  }

  const hasDocumentAttachment = (input.attachments ?? []).some((a) => a.kind === "pdf" || a.kind === "text");
  if (WORK_ACTION.test(text) || local || hasDocumentAttachment || capabilities.includes("long_context")) {
    return { surface: "work", reason: "需要研究、本地文件或交付物能力" };
  }

  return { surface: "chat", reason: "以对话和问答为主" };
}

/** 把工具的能力线索加入步骤路由文本；不包含参数和文件正文，避免把敏感数据送入分类器。 */
export function stepRoutingText(goal: string, tool: string | null): string {
  const toolName = tool ?? "";
  const isCodexTool = CODEX_TOOL.test(toolName);
  const isWorkTool = WORK_TOOL.test(toolName);
  return [goal, toolName, isCodexTool ? "terminal development" : "", isWorkTool ? "local file" : ""].filter(Boolean).join("\n");
}

/**
 * 推断单个执行步骤的能力面。
 *
 * 任务入口的分类描述“整件事”需要什么；步骤分类则只看当前子目标和工具，
 * 因而一个 Goal 可以在 Work 读取资料、Chat 总结、Codex 运行测试之间自然切换。
 */
export function inferStepWorkSurface(goal: string, tool: string | null, surfaceHint?: WorkSurface): WorkSurfaceDecision {
  const toolName = tool ?? "";
  const isCodexTool = CODEX_TOOL.test(toolName);
  const text = stepRoutingText(goal, tool);
  const capabilities: Capability[] = [];
  if (tool) capabilities.push("tool_use");
  if (isCodexTool) capabilities.push("code");
  return inferWorkSurface({ text, surfaceHint }, capabilities);
}

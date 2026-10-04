// 渐进式执行：运行中只显示当前在做什么，做完折叠成一行。
// 说人话，不暴露内部术语（步骤 id、工具名的原样拼接都不出现在这里）。
import type { AgentEvent } from "@/agent";
import { PURPOSE_ING } from "./purpose";
import { stepProgress } from "./steps";

export interface Progress {
  /** 当前在做什么，例如「正在读取文件…」 */
  text: string;
  /** 已完成的步骤数 */
  done: number;
  /** 计划里的总步骤数；还没规划出来时是 0 */
  total: number;
  /** 正在等用户确认 */
  waiting: boolean;
}

/** 工具名 → 人话。认不出的工具退回「调用 <名字>」 */
export function toolText(tool: string): string {
  const t = tool.toLowerCase();
  if (/(^|[._-])(read|cat|get|fetch|list|search|find|grep)/.test(t)) return "正在读取";
  if (/(^|[._-])(write|create|save|append|edit|patch|update)/.test(t)) return "正在写入";
  if (/(^|[._-])(run|exec|shell|bash|command)/.test(t)) return "正在执行命令";
  if (/(^|[._-])(delete|remove|rm)/.test(t)) return "正在删除";
  return `正在调用 ${tool}`;
}

/** 从事件流里算出「现在在做什么」。多 Agent 协同时统计子 Agent 的进度 */
export function progressOf(events: readonly AgentEvent[]): Progress {
  const steps = stepProgress(events);
  const total = steps.length;
  const done = steps.filter((s) => s.state === "done" || s.state === "failed").length;
  let text = "正在分析任务…";
  let waiting = false;
  let subs = 0;
  let subsDone = 0;

  for (const e of events) {
    switch (e.type) {
      case "route":
        text = "正在选择模型…";
        break;
      case "llm":
      case "llm_failed":
        text = `${PURPOSE_ING[e.purpose]}…`;
        break;
      case "plan":
        text = "正在按计划执行…";
        break;
      case "step_start":
        text = `${e.step.tool ? toolText(e.step.tool) : "正在处理"}：${e.step.goal}`;
        waiting = false;
        break;
      case "gate":
        if (e.verdict === "confirm") waiting = true;
        break;
      case "confirm":
      case "plan_review":
        waiting = false;
        break;
      case "recover":
        text = "上一步失败了，正在换个办法…";
        break;
      case "split":
        subs = e.agents.length;
        text = `已拆成 ${subs} 个子任务，正在并行执行…`;
        break;
      case "subagent":
        if (e.event.type === "run_end") {
          subsDone++;
          text = `子任务已完成 ${subsDone}/${subs}…`;
        }
        break;
      default:
        break;
    }
  }
  if (waiting) text = "等你确认这一步";
  return { text, done, total: subs || total, waiting };
}

/** 做完之后折叠成的一行：「已完成 · 5 步 · 12.4s」 */
export function doneText(status: string, p: Progress, duration: string): string {
  const steps = p.total > 0 ? ` · ${status === "completed" ? `${p.total} 步` : `${p.done}/${p.total} 步`}` : "";
  const label =
    status === "completed" ? "已完成" : status === "aborted" ? "已停止" : status === "needs_user" ? "需要你处理" : status === "budget_exceeded" ? "超出预算" : "失败";
  return `${label}${steps} · ${duration}`;
}

// 一轮的实据（M10）：从这一轮任务的事件里提取工具调用、文件改动、命令输出，交给决策层判定完成没有。
// 只从事件里读，不推断、不补充：模型的自述（summary）单独放在 claim，只用来区分「只有自述」和「什么都没做」。
import type { AgentEvent } from "@/agent";
import type { CommandEvidence, Evidence, FileChangeEvidence, ToolCallEvidence } from "@/decision/evidence";
import type { ItemStatus } from "@/decision/goal";
import { artifactsOf } from "./artifacts";
import { stepProgress } from "./steps";
import type { RoundResult } from "./goal-runner";
import type { TaskCard } from "@/stores/tasks";

/** 子 Agent 的事件也计入：多 Agent 协同时实据分散在子事件里 */
const each = (events: readonly AgentEvent[]): AgentEvent[] => events.map((e) => (e.type === "subagent" ? e.event : e));

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

/** 工具的操作对象：路径或网址 */
const targetOf = (args: Record<string, unknown>): string | undefined =>
  str(args.path) ?? str(args.url) ?? str(args.file) ?? str(args.src) ?? str(args.source) ?? str(args.from) ?? undefined;

/**
 * 事件 → 实据。readOnly 回答「这个工具是不是只读的」；不知道的工具按会写入处理（evidence.ts 的口径）。
 * 文件改动和命令复用界面同一份解析（lib/artifacts.ts）：界面看到什么，判定就用什么。
 */
export function evidenceOf(events: readonly AgentEvent[], readOnly: (tool: string) => boolean): Evidence {
  const list = each(events);
  const tool_calls: ToolCallEvidence[] = [];
  const file_changes: FileChangeEvidence[] = [];
  const command_outputs: CommandEvidence[] = [];
  for (const e of list) {
    if (e.type !== "tool_result" || !e.step.tool) continue;
    const target = targetOf(e.step.args ?? {});
    tool_calls.push({ tool: e.step.tool, read_only: readOnly(e.step.tool), ok: e.ok, ...(target ? { target } : {}) });
  }
  const { files, commands } = artifactsOf(list);
  for (const f of files) {
    if (!f.ok || f.action === "read") continue;
    if (f.action === "moved" && f.to) file_changes.push({ path: f.path, action: "moved", to: f.to });
    else if (f.action === "created") file_changes.push({ path: f.path, action: "created" });
    else if (f.action === "deleted") file_changes.push({ path: f.path, action: "deleted" });
    else if (f.action === "modified") file_changes.push({ path: f.path, action: "modified" });
  }
  for (const c of commands) {
    // 工具只回成功或失败，拿不到真实退出码：成功写 0，失败写 1（证据里写个假退出码不如只写「没成功」，
    // 但 rules 的测试规则需要区分「没通过」，所以这里按成败给码，并在 docs/TASKS.md 里记明局限）
    command_outputs.push({ command: c.command, exit_code: c.ok ? 0 : 1, output: c.output });
  }
  return { tool_calls, file_changes, command_outputs };
}

/** 一轮执行完之后的记账：实据、步骤清单、模型调用次数 */
export function outcomeOf(card: TaskCard, readOnly: (tool: string) => boolean): RoundResult {
  const events = card.events;
  const items = stepProgress(events).map((s) => ({ text: s.goal, status: itemStatus(s.state) }));
  let llmCalls = 0;
  for (const e of each(events)) if (e.type === "llm" || e.type === "llm_failed") llmCalls++;
  const summary = card.summary ?? "这一轮没有给出结果";
  return {
    taskId: card.id,
    status: card.status as RoundResult["status"],
    summary,
    evidence: { ...evidenceOf(events, readOnly), claim: summary },
    llmCalls,
    items,
  };
}

/** 步骤状态 → 轮次步骤状态：这一轮已经结束，还停在「进行中」的按未开始记 */
const itemStatus = (s: "pending" | "running" | "done" | "failed"): ItemStatus => (s === "done" ? "done" : s === "failed" ? "failed" : "pending");

// 一轮的实据提取（M10）：从运行事件算出工具调用、文件改动、命令输出和步骤清单。
// 全部用合成事件，不跑运行时。
import type { AgentEvent, RunStatus } from "@/agent";
import { emptyEvidence } from "@/decision/evidence";
import type { ItemStatus } from "@/decision/goal";
import { evidenceOf, outcomeOf } from "@/lib/run-evidence";
import type { TaskCard, TaskStatus } from "@/stores/tasks";

const step = (tool: string | null, args: Record<string, unknown> = {}) => ({ id: "s1", goal: "做一件事", tool, args });
const toolResult = (tool: string, ok: boolean, args: Record<string, unknown> = {}, content = "ok"): AgentEvent => ({
  type: "tool_result",
  step: step(tool, args),
  ok,
  content,
  latencyMs: 1,
});

const READ_ONLY = new Set(["mcp__files__read_file", "mcp__files__list_directory", "mcp__files__get_file_info"]);

describe("evidenceOf：工具调用", () => {
  it("每一次工具调用都记下来，只读与否按工具自己的声明；带上操作对象", () => {
    const e = evidenceOf(
      [toolResult("mcp__files__read_file", true, { path: "~/Downloads/a.pdf" }), toolResult("mcp__files__write_file", false, { path: "~/Downloads/b.md" })],
      (t) => READ_ONLY.has(t),
    );
    expect(e.tool_calls).toEqual([
      { tool: "mcp__files__read_file", read_only: true, ok: true, target: "~/Downloads/a.pdf" },
      { tool: "mcp__files__write_file", read_only: false, ok: false, target: "~/Downloads/b.md" },
    ]);
  });

  it("不知道的工具按「会写入」处理；网址也能作为操作对象；没有参数对象时不带 target", () => {
    const e = evidenceOf([toolResult("mcp__other__fetch", true, { url: "https://example.test/x" }), { type: "tool_result", step: { id: "s2", goal: "g", tool: "mcp__other__ping" }, ok: true, content: "pong", latencyMs: 1 }], () => false);
    expect(e.tool_calls[0]).toEqual({ tool: "mcp__other__fetch", read_only: false, ok: true, target: "https://example.test/x" });
    expect(e.tool_calls[1]).toEqual({ tool: "mcp__other__ping", read_only: false, ok: true });
  });

  it("子 Agent 的事件也计入（多 Agent 协同时实据在子事件里）", () => {
    const e = evidenceOf([{ type: "subagent", agent: "调研员", event: toolResult("mcp__files__read_file", true, { path: "/a" }) }], () => true);
    expect(e.tool_calls).toHaveLength(1);
    expect(e.tool_calls[0]).toMatchObject({ tool: "mcp__files__read_file", read_only: true });
  });
});

describe("evidenceOf：文件改动与命令", () => {
  it("写入、建目录、移动、删除都算改动；读取不算；失败的不算", () => {
    const e = evidenceOf(
      [
        toolResult("mcp__files__write_file", true, { path: "~/Downloads/归档/x.md" }),
        toolResult("mcp__files__create_directory", true, { path: "~/Downloads/归档" }),
        toolResult("mcp__files__move_file", true, { path: "~/Downloads/a.pdf", dst: "~/Downloads/归档/a.pdf" }),
        toolResult("mcp__files__delete_file", true, { path: "~/Downloads/旧.md" }),
        toolResult("mcp__files__read_file", true, { path: "~/Downloads/读一下.md" }),
        toolResult("mcp__files__write_file", false, { path: "~/Downloads/没写成.md" }),
      ],
      () => false,
    );
    expect(e.file_changes).toEqual([
      { path: "~/Downloads/归档/x.md", action: "modified" },
      { path: "~/Downloads/归档", action: "created" },
      { path: "~/Downloads/a.pdf", action: "moved", to: "~/Downloads/归档/a.pdf" },
      { path: "~/Downloads/旧.md", action: "deleted" },
    ]);
  });

  it("命令工具的成改写进退出码：成功 0、失败 1，输出原样带上", () => {
    const e = evidenceOf(
      [toolResult("mcp__shell__run_command", true, { command: "pnpm test" }, "Tests 4 passed"), toolResult("mcp__shell__run_command", false, { command: "pnpm build" }, "报错了")],
      () => false,
    );
    expect(e.command_outputs).toEqual([
      { command: "pnpm test", exit_code: 0, output: "Tests 4 passed" },
      { command: "pnpm build", exit_code: 1, output: "报错了" },
    ]);
  });

  it("没有任何执行记录时是空的实据（不是 undefined）", () => {
    expect(evidenceOf([{ type: "run_start", runId: "run-1", goal: "g" }], () => false)).toEqual(emptyEvidence());
  });
});

describe("outcomeOf：一轮跑完的记账", () => {
  const card = (events: AgentEvent[], status: Exclude<TaskStatus, "running"> = "completed", summary: string | null = "已经归档好了"): TaskCard =>
    ({
      id: "task-1",
      seq: 1,
      sessionId: null,
      goal: "把下载文件夹里的合同归档",
      status,
      collapsed: false,
      events,
      summary,
      pendingConfirm: null,
      pendingPlan: null,
      override: null,
      lock: null,
      permission: "confirm",
      onboarding: false,
      files: [],
      multi: false,
      startedAt: 1,
      endedAt: 2,
      proposal: null,
      projectId: null,
      goalId: "goal-1",
      mode: "goal",
      preference: "balanced",
      preferenceSource: "global",
    }) satisfies TaskCard;

  it("步骤取自执行记录，还在「进行中」的按未开始记；模型自述放进 claim", () => {
    const events: AgentEvent[] = [
      { type: "plan", plan: { steps: [step("mcp__files__list_directory"), step("mcp__files__write_file"), { id: "s3", goal: "写总结", tool: null }], source: "llm" }, revision: 0 },
      { type: "step_start", step: step("mcp__files__list_directory"), attempt: 1 },
      toolResult("mcp__files__list_directory", true, { path: "~/Downloads" }),
      { type: "step_start", step: step("mcp__files__write_file"), attempt: 1 },
      toolResult("mcp__files__write_file", true, { path: "~/Downloads/清单.md" }),
      { type: "run_end", status: "completed", summary: "已经归档好了" },
    ];
    const r = outcomeOf(card(events), (t) => READ_ONLY.has(t));
    expect(r.taskId).toBe("task-1");
    expect(r.status).toBe("completed");
    expect(r.items.map((i) => i.status)).toEqual<ItemStatus[]>(["done", "done", "pending"]);
    expect(r.items.map((i) => i.text)).toEqual(["做一件事", "做一件事", "写总结"]);
    expect(r.evidence.claim).toBe("已经归档好了");
    expect(r.evidence.file_changes).toEqual([{ path: "~/Downloads/清单.md", action: "modified" }]);
  });

  it("模型调用次数按 llm / llm_failed 事件数（子 Agent 的也算）", () => {
    const llm = (profileId: string): AgentEvent => ({ type: "llm", purpose: "plan", profileId, latencyMs: 5, usage: { inputTokens: 1, outputTokens: 1 } });
    const failed: AgentEvent = { type: "llm_failed", purpose: "answer", attempts: [{ profileId: "openai/gpt-5.6-luna", reason: "超时" }] };
    const r = outcomeOf(card([llm("a"), llm("b"), failed, { type: "subagent", agent: "撰写员", event: llm("c") }]), () => false);
    expect(r.llmCalls).toBe(4);
  });

  it("没有总结时写「这一轮没有给出结果」，claim 也是它（失败的一轮也要有可读的说明）", () => {
    const r = outcomeOf(card([], "failed", null), () => false);
    expect(r.summary).toBe("这一轮没有给出结果");
    expect(r.evidence.claim).toBe("这一轮没有给出结果");
    expect(r.status).toBe<RunStatus>("failed");
  });
});

// 多 Agent 协同的展示数据：子 Agent 视图、任务卡片步骤、时间线和用量统计。
import type { AgentEvent, LlmPurpose } from "@/agent";
import { appendEvent, subAgentSteps, subAgentViews } from "@/lib/subagents";
import { toTimeline, usageTotals } from "@/lib/timeline";

const SPLIT: AgentEvent = { type: "split", agents: [{ id: "a1", role: "调研员", goal: "调研现状" }, { id: "a2", role: "撰写员", goal: "撰写报告" }] };
const sub = (agent: string, event: AgentEvent): AgentEvent => ({ type: "subagent", agent, event });
const step = (goal: string) => ({ id: "s1", goal, tool: null });
const llm = (purpose: LlmPurpose, profileId: string): AgentEvent => ({ type: "llm", purpose, profileId, latencyMs: 1, usage: { inputTokens: 10, outputTokens: 5 } });

const EVENTS: AgentEvent[] = [
  { type: "run_start", runId: "m", goal: "调研并撰写报告" },
  llm("split", "deepseek/deepseek-chat"),
  SPLIT,
  sub("a1", { type: "run_start", runId: "m-a1", goal: "调研现状" }),
  sub("a1", llm("plan", "deepseek/deepseek-chat")),
  sub("a1", { type: "step_start", step: step("检索资料"), attempt: 1 }),
  sub("a2", { type: "run_start", runId: "m-a2", goal: "撰写报告" }),
  sub("a2", llm("plan", "openai/gpt-4o")),
];

describe("子 Agent 视图", () => {
  it("从事件还原每个子 Agent 的角色、状态、模型和当前步骤", () => {
    expect(subAgentViews(EVENTS)).toEqual([
      { id: "a1", role: "调研员", goal: "调研现状", status: "running", profileId: "deepseek/deepseek-chat", step: "检索资料" },
      { id: "a2", role: "撰写员", goal: "撰写报告", status: "running", profileId: "openai/gpt-4o", step: null },
    ]);
    const ended = [...EVENTS, sub("a1", { type: "run_end", status: "completed", summary: "ok" }), sub("a2", { type: "run_end", status: "needs_user", summary: "x" })];
    const views = subAgentViews(ended);
    expect(views.map((v) => [v.status, v.step])).toEqual([["completed", null], ["needs_user", null]]);
    expect(subAgentSteps(views)).toEqual([
      { id: "a1", goal: "调研员：调研现状", tool: "deepseek/deepseek-chat", state: "done" },
      { id: "a2", goal: "撰写员：撰写报告", tool: "openai/gpt-4o", state: "failed" },
    ]);
  });

  it("还没开始的子 Agent 显示为等待；没有拆分时为空，未知的子 Agent 忽略", () => {
    expect(subAgentViews([SPLIT]).map((v) => v.status)).toEqual(["pending", "pending"]);
    expect(subAgentSteps(subAgentViews([SPLIT])).map((s) => s.state)).toEqual(["pending", "pending"]);
    expect(subAgentViews(EVENTS.filter((e) => e.type !== "split"))).toEqual([]);
    expect(subAgentViews([SPLIT, sub("a9", { type: "run_start", runId: "x", goal: "x" })]).map((v) => v.status)).toEqual(["pending", "pending"]);
  });
});

describe("多 Agent 的时间线与用量", () => {
  it("子 Agent 的事件带角色前缀；子 Agent 的开始不重复列出，结束归到反思阶段", () => {
    const items = toTimeline([...EVENTS, sub("a1", { type: "run_end", status: "completed", summary: "调研完成" })], []);
    const titles = items.map((i) => i.title);
    expect(titles.filter((t) => t.includes("开始分析任务"))).toEqual(["开始分析任务"]);
    expect(titles).toContain("拆分为 2 个子 Agent");
    expect(titles).toContain("「调研员」步骤：检索资料");
    expect(titles).toContain("「撰写员」规划 · openai/gpt-4o");
    expect(items.find((i) => i.title === "「调研员」已完成")?.stage).toBe("reflect");
    expect(new Set(items.map((i) => i.key)).size).toBe(items.length);
  });

  it("用量统计包含子 Agent 的模型调用", () => {
    expect(usageTotals(EVENTS)).toEqual({ calls: 3, tokens: 45 });
  });

  it("事件超出上限时保留开头（含拆分），其余只留最新的", () => {
    let list: AgentEvent[] = [];
    for (const e of [EVENTS[0], SPLIT]) list = appendEvent(list, e, 20);
    for (let i = 0; i < 30; i++) list = appendEvent(list, sub("a1", { type: "step_start", step: step(`步骤 ${i}`), attempt: 1 }), 20);
    expect(list).toHaveLength(20);
    expect(list[1]).toBe(SPLIT);
    expect(subAgentViews(list)[0].step).toBe("步骤 29");
  });
});

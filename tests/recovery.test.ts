// @vitest-environment node
import type { AgentEvent } from "@/agent";
import { recoveryCheckpoint } from "@/lib/recovery";

const plan: AgentEvent = {
  type: "plan",
  revision: 0,
  plan: {
    source: "llm",
    steps: [
      { id: "s1", goal: "读取资料", tool: "read_file", args: { path: "notes.md" } },
      { id: "s2", goal: "写入报告", tool: "write_file", args: { path: "report.md", content: "secret" } },
    ],
  },
};

describe("失败任务恢复 checkpoint", () => {
  it("跳过已经完成的步骤，从失败步骤继续，并清掉旧参数", () => {
    const events: AgentEvent[] = [
      plan,
      { type: "step_start", step: plan.plan.steps[0], attempt: 1, surface: "work" },
      { type: "tool_result", step: plan.plan.steps[0], ok: true, content: "已读取", latencyMs: 1 },
      { type: "reflect", step: plan.plan.steps[0], done: true, score: 1, backend: "rules" },
      { type: "step_start", step: plan.plan.steps[1], attempt: 1, surface: "work" },
      { type: "recover", step: plan.plan.steps[1], strategy: "ask_user", error: "需要确认", backend: "rules" },
      { type: "run_end", status: "needs_user", summary: "需要用户协助：需要确认" },
    ];
    const checkpoint = recoveryCheckpoint(events);
    expect(checkpoint).toMatchObject({ nextStepIndex: 1, status: "needs_user", failedStep: { id: "s2" } });
    expect(checkpoint?.records.map((r) => [r.step.id, r.status])).toEqual([["s1", "done"], ["s2", "failed"]]);
    expect(checkpoint?.records[0]?.output).toBe("已读取");
    expect(checkpoint?.uncertainSteps.map((s) => s.id)).toEqual(["s2"]);
    expect(checkpoint?.plan.steps.every((s) => !s.args)).toBe(true);
  });

  it("中断时没有 recover 事件也能把运行中的步骤标成失败", () => {
    const events: AgentEvent[] = [
      plan,
      { type: "step_start", step: plan.plan.steps[0], attempt: 1, surface: "work" },
      { type: "run_end", status: "aborted", summary: "任务已取消" },
    ];
    expect(recoveryCheckpoint(events)).toMatchObject({ nextStepIndex: 0, status: "aborted", reason: "任务已取消", uncertainSteps: [{ id: "s1" }] });
  });

  it("完成任务和没有计划的失败不可恢复", () => {
    expect(recoveryCheckpoint([{ type: "run_end", status: "failed", summary: "没有可用模型" }])).toBeNull();
    expect(recoveryCheckpoint([plan, { type: "run_end", status: "completed", summary: "完成" }])).toBeNull();
  });
});

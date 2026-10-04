// @vitest-environment node
// 计划模式（docs/UI_LAYOUT_V3.md 第 4 节）：规划完先给用户看，批准后才执行第一步；取消就一步都不执行。
import { DecisionLayer } from "@/decision/decision-layer";
import { AgentRuntime, type AgentDeps } from "@/agent/runtime";
import { Coordinator } from "@/agent/coordinator";
import { ToolRegistry } from "@/agent/tools";
import type { AgentEvent, LlmCall, LlmPurpose, Plan, Tool } from "@/agent/types";

const ENV = { OPENAI_API_KEY: "x" };
const plan = (...steps: object[]) => JSON.stringify({ steps });

function setup(script: Partial<Record<LlmPurpose, string[]>>, extra: Partial<AgentDeps> = {}) {
  const run = vi.fn(async () => ({ ok: true, content: "notes.md：路由已完成" }));
  const read: Tool = { name: "read_file", description: "读取本地文件内容", sideEffect: "none", run };
  const tools = new ToolRegistry([read]);
  const decision = DecisionLayer.fromEnv(ENV, { tools: tools.defs() });
  const llm: LlmCall = async (req) => ({ text: script[req.purpose]?.shift() ?? (req.purpose === "summary" ? "总结：完成" : "{}"), profileId: "openai/fake", latencyMs: 1, usage: null });
  const events: AgentEvent[] = [];
  const deps: AgentDeps = { decision, tools, llm: () => llm, onEvent: (e) => events.push(e), ...extra };
  return { run, events, deps };
}
const STEPS = { plan: [plan({ goal: "读取 notes.md", tool: "read_file", args: { path: "notes.md" } }, { goal: "总结要点", tool: null })], answer: ["要点：路由已完成"] };

describe("计划模式", () => {
  it("批准前不执行任何工具；批准后照常执行；事件里记下你的决定", async () => {
    let seen: Plan | null = null;
    let release!: (ok: boolean) => void;
    const approvePlan = vi.fn((p: Plan) => {
      seen = p;
      return new Promise<boolean>((r) => (release = r));
    });
    const { run, events, deps } = setup(STEPS, { approvePlan });
    const done = new AgentRuntime(deps).run("总结 notes.md 的要点");
    await vi.waitFor(() => expect(approvePlan).toHaveBeenCalledTimes(1));
    expect(seen!.steps.map((s) => s.goal)).toEqual(["读取 notes.md", "总结要点"]);
    expect(run).not.toHaveBeenCalled();
    expect(events.some((e) => e.type === "step_start")).toBe(false);
    release(true);
    const r = await done;
    expect(r.status).toBe("completed");
    expect(run).toHaveBeenCalledTimes(1);
    const types = events.map((e) => e.type);
    expect(types.indexOf("plan_review")).toBeLessThan(types.indexOf("step_start"));
    expect(events.find((e) => e.type === "plan_review")).toEqual({ type: "plan_review", approved: true });
  });

  it("取消：任务停止（已停止），一步都不执行，如实写明原因", async () => {
    const { run, events, deps } = setup(STEPS, { approvePlan: async () => false });
    const r = await new AgentRuntime(deps).run("总结 notes.md 的要点");
    expect(r.status).toBe("aborted");
    expect(r.summary).toBe("你取消了这个计划，没有执行任何步骤");
    expect(run).not.toHaveBeenCalled();
    expect(events.some((e) => e.type === "step_start")).toBe(false);
  });

  it("没有提供回调时不停（快速模式行为不变）；简单问答不经规划，也不问", async () => {
    const quick = setup(STEPS);
    expect((await new AgentRuntime(quick.deps).run("总结 notes.md 的要点")).status).toBe("completed");
    expect(quick.events.some((e) => e.type === "plan_review")).toBe(false);

    const approvePlan = vi.fn(async () => false);
    const simple = setup({ answer: ["你好，我是 EastGenesis。"] }, { approvePlan });
    expect((await new AgentRuntime(simple.deps).run("你好")).status).toBe("completed");
    expect(approvePlan).not.toHaveBeenCalled();
  });

  it("等批准时取消任务：视为不批准，任务停止", async () => {
    const ctrl = new AbortController();
    const approvePlan = vi.fn(() => new Promise<boolean>((r) => ctrl.signal.addEventListener("abort", () => r(false))));
    const { run, deps } = setup(STEPS, { approvePlan });
    const done = new AgentRuntime(deps).run("总结 notes.md 的要点", { signal: ctrl.signal });
    await vi.waitFor(() => expect(approvePlan).toHaveBeenCalled());
    ctrl.abort();
    expect((await done).status).toBe("aborted");
    expect(run).not.toHaveBeenCalled();
  });

  it("多 Agent 协同批准后：子 Agent 各自规划时不再问计划（一共只问一次）", async () => {
    const approvePlan = vi.fn(async (_p: Plan) => true);
    const split = JSON.stringify({ agents: [{ id: "a1", role: "调研员", goal: "调研" }, { id: "a2", role: "撰写员", goal: "撰写" }] });
    const sub = plan({ goal: "读取 notes.md", tool: "read_file", args: { path: "notes.md" } });
    const { deps } = setup({ split: [split], plan: [sub, sub], answer: ["a", "b", "c"] }, { approvePlan });
    expect((await new Coordinator(deps).run("调研并撰写")).status).toBe("completed");
    expect(approvePlan).toHaveBeenCalledTimes(1);
  });

  it("多 Agent 协同：拆分就是计划，只问一次；取消后子 Agent 都不启动", async () => {
    const approvePlan = vi.fn(async (_p: Plan) => false);
    const split = JSON.stringify({ agents: [{ id: "a1", role: "调研员", goal: "调研" }, { id: "a2", role: "撰写员", goal: "撰写" }] });
    const { run, events, deps } = setup({ split: [split], ...STEPS }, { approvePlan });
    const r = await new Coordinator(deps).run("调研并撰写");
    expect(r.status).toBe("aborted");
    expect(approvePlan).toHaveBeenCalledTimes(1);
    expect(approvePlan.mock.calls[0]![0].steps.map((s) => s.goal)).toEqual(["调研员：调研", "撰写员：撰写"]);
    expect(events.some((e) => e.type === "subagent")).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });
});

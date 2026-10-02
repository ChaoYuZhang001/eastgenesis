// @vitest-environment node
// 多 Agent 协同。模型用按用途应答的假实现，决策层走第 3 级规则（没有配置 TYPESAFE_API_KEY）。
import { Coordinator, type CoordinatorDeps } from "@/agent/coordinator";
import type { MemoryNote } from "@/agent/memory";
import type { SkillNote } from "@/agent/skills";
import { parseSplit } from "@/agent/split";
import { ToolRegistry } from "@/agent/tools";
import type { AgentEvent, ConfirmRequest, LlmCall, LlmRequest, Tool } from "@/agent/types";
import { DecisionLayer } from "@/decision/decision-layer";

const ENV = { OPENAI_API_KEY: "x" };
const TWO = JSON.stringify({ agents: [{ role: "调研员", goal: "调研国产大模型的现状" }, { role: "撰写员", goal: "撰写国产大模型现状的报告" }] });
const GOAL = "调研并撰写国产大模型现状报告";

/** 取行首「标记：」之后到行尾的文字 */
const field = (text: string, label: string) => text.match(new RegExp(`(?:^|\\n)${label}：(.*)`))?.[1]?.trim() ?? "";

interface FakeOpts {
  split?: string;
  /** 规划时每个子目标都用这个工具；不给则由模型直接回答 */
  tool?: string;
  /** 这些子目标的回答抛错 */
  failAnswer?: (goal: string) => boolean;
  failMerge?: boolean;
}

function reply(req: LlmRequest, o: FakeOpts): string {
  const user = req.messages.at(-1)?.content ?? "";
  switch (req.purpose) {
    case "split":
      return o.split ?? TWO;
    case "plan": {
      const goal = field(user, "目标");
      return JSON.stringify({ steps: [o.tool ? { goal, tool: o.tool, args: { text: goal } } : { goal, tool: null }] });
    }
    case "answer": {
      const goal = field(user, "当前子目标");
      if (o.failAnswer?.(goal)) throw new Error("模型不可用");
      return `${goal}：已整理出三条要点`;
    }
    case "summary":
      return `子任务成果：${field(user, "总目标")}`;
    case "merge":
      if (o.failMerge) throw new Error("模型不可用");
      return "合并后的成果";
    default:
      return "{}";
  }
}

function setup(o: FakeOpts = {}, extra: Partial<CoordinatorDeps> = {}, tools: Tool[] = []) {
  const registry = new ToolRegistry(tools);
  const decision = DecisionLayer.fromEnv(ENV, { tools: registry.defs() });
  const reqs: LlmRequest[] = [];
  const llm: LlmCall = async (req) => {
    reqs.push(req);
    return { text: reply(req, o), profileId: "openai/fake", latencyMs: 1, usage: null };
  };
  const events: AgentEvent[] = [];
  const co = new Coordinator({ decision, tools: registry, llm: () => llm, onEvent: (e) => events.push(e), idGen: () => "multi-t", ...extra });
  return { co, events, reqs };
}
const top = (reqs: LlmRequest[]) => reqs.filter((q) => q.purpose === "split" || q.purpose === "merge").map((q) => q.purpose);
const inner = (events: AgentEvent[]) => events.flatMap((e) => (e.type === "subagent" ? [e] : []));
const writeNote = (run: Tool["run"]): Tool => ({ name: "write_note", description: "写入笔记", sideEffect: "local_write", run });

describe("多 Agent 协同", () => {
  it("拆分 → 子 Agent 执行 → 合并；子 Agent 的成果作为不可信数据交给模型", async () => {
    const { co, events, reqs } = setup();
    const r = await co.run(GOAL);
    expect(r).toMatchObject({ status: "completed", summary: "合并后的成果" });
    expect(events.find((e) => e.type === "split")).toMatchObject({ agents: [{ id: "a1", role: "调研员" }, { id: "a2", role: "撰写员" }] });
    expect(top(reqs)).toEqual(["split", "merge"]);
    const ends = Object.fromEntries(inner(events).flatMap((e) => (e.event.type === "run_end" ? [[e.agent, e.event.status]] : [])));
    expect(ends).toEqual({ a1: "completed", a2: "completed" });
    expect(inner(events).find((e) => e.event.type === "run_start")?.event).toMatchObject({ runId: expect.stringMatching(/^multi-t-a[12]$/) });
    const merge = reqs.find((q) => q.purpose === "merge")!.messages[1].content;
    expect(merge).toContain('<tool_output source="subagent" untrusted="true">');
    expect(merge).toContain("子任务成果：调研国产大模型的现状");
    expect(r.plan.steps.map((s) => s.goal)).toEqual(["调研员：调研国产大模型的现状", "撰写员：撰写国产大模型现状的报告"]);
    expect(r.steps.map((s) => s.status)).toEqual(["done", "done"]);
    expect(events.at(-1)).toMatchObject({ type: "run_end", status: "completed" });
  });

  it("最多同时运行 2 个子 Agent；确认排队，一次只请用户处理一个，并标明来自哪个子 Agent", async () => {
    const three = JSON.stringify({ agents: ["甲组", "乙组", "丙组"].map((role) => ({ role, goal: `${role}写入调研笔记` })) });
    const write = vi.fn(async () => ({ ok: true, content: "已写入调研笔记" }));
    let active = 0;
    let peak = 0;
    const confirm = vi.fn(async (_req: ConfirmRequest) => {
      peak = Math.max(peak, ++active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return true;
    });
    const { co, events } = setup({ split: three, tool: "write_note" }, { confirm }, [writeNote(write)]);
    expect((await co.run("三个小组分别写入调研笔记")).status).toBe("completed");
    expect(write).toHaveBeenCalledTimes(3);
    expect(confirm).toHaveBeenCalledTimes(3);
    expect(peak).toBe(1);
    expect(confirm.mock.calls.map(([q]) => q.agent).sort()).toEqual(["甲组", "乙组", "丙组"].sort());
    let running = 0;
    let most = 0;
    for (const e of inner(events)) {
      if (e.event.type === "run_start") most = Math.max(most, ++running);
      if (e.event.type === "run_end") running--;
    }
    expect(most).toBe(2);
  });

  it("拆分结果无法解析时改为单个智能体执行，不再合并", async () => {
    const { co, events, reqs } = setup({ split: "我觉得不用拆分" });
    const r = await co.run("总结国产大模型的现状");
    expect(r).toMatchObject({ status: "completed", summary: "子任务成果：总结国产大模型的现状" });
    expect(r.plan.source).toBe("fallback");
    expect(events.find((e) => e.type === "split")).toMatchObject({
      agents: [{ id: "a1", role: "通用智能体", goal: "总结国产大模型的现状" }],
      note: expect.stringMatching(/无法解析/),
    });
    expect(top(reqs)).toEqual(["split"]);
  });

  it("子 Agent 全部失败时不合并，逐个说明状态", async () => {
    const { co, reqs } = setup({ failAnswer: () => true });
    const r = await co.run(GOAL);
    expect(r).toMatchObject({ status: "failed", summary: "没有子 Agent 完成：「调研员」失败；「撰写员」失败" });
    expect(top(reqs)).toEqual(["split"]);
  });

  it("合并失败时直接拼接已完成的成果，并列出没完成的子任务", async () => {
    const { co } = setup({ failAnswer: (g) => g.startsWith("撰写"), failMerge: true });
    const r = await co.run(GOAL);
    expect(r.status).toBe("completed");
    expect(r.summary).toBe("【调研员】\n子任务成果：调研国产大模型的现状\n\n未完成的子任务：「撰写员」失败");
  });

  it("取消后排队中的确认直接视为不同意，任务停止且不合并", async () => {
    const ctl = new AbortController();
    const write = vi.fn(async () => ({ ok: true, content: "已写入调研笔记" }));
    const confirm = vi.fn(async (_req: ConfirmRequest) => {
      ctl.abort();
      return false;
    });
    const { co, reqs } = setup({ tool: "write_note" }, { confirm }, [writeNote(write)]);
    const r = await co.run(GOAL, { signal: ctl.signal });
    expect(r).toMatchObject({ status: "aborted", summary: "任务已取消" });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(write).not.toHaveBeenCalled();
    expect(top(reqs)).toEqual(["split"]);
  });

  it("记忆进入拆分与合并的提示词；技能不交给子 Agent", async () => {
    const memories: MemoryNote[] = [{ id: "mem-1", kind: "preference", text: "报告一律用中文", updated_at: 1 }];
    const skills = [{ id: "skill-1", name: "调研报告", description: "", steps: [{ goal: "调研", tool: null }], use_count: 0, updated_at: 1 }] as SkillNote[];
    const { co, events, reqs } = setup({}, { memories, skills });
    await co.run(GOAL);
    for (const p of ["split", "merge"]) expect(reqs.find((q) => q.purpose === p)!.messages[0].content).toContain("报告一律用中文");
    expect(events.filter((e) => e.type === "memory")).toHaveLength(1);
    expect(inner(events).some((e) => e.event.type === "skill")).toBe(false);
    expect(reqs.filter((q) => q.purpose === "plan").some((q) => q.messages[0].content.includes("技能「"))).toBe(false);
  });
});

describe("parseSplit", () => {
  it("丢掉无效条目，最多保留 4 个并重新编号；角色名规整空白并截断", () => {
    const agents = [
      { role: "  调研\n员 ", goal: " 调研现状 " },
      { role: "", goal: "没有角色" },
      { role: "撰写员", goal: 42 },
      "不是对象",
      ...["甲", "乙", "丙", "丁"].map((role) => ({ role, goal: `${role}的任务` })),
    ];
    expect(parseSplit(`好的：${JSON.stringify({ agents })}`)).toEqual([
      { id: "a1", role: "调研 员", goal: "调研现状" },
      { id: "a2", role: "甲", goal: "甲的任务" },
      { id: "a3", role: "乙", goal: "乙的任务" },
      { id: "a4", role: "丙", goal: "丙的任务" },
    ]);
    expect(parseSplit(JSON.stringify({ agents: [{ role: "很".repeat(30), goal: "x" }] }))?.[0].role).toHaveLength(20);
  });

  it("没有可用条目时返回 null", () => {
    for (const t of ["{}", '{"agents":[]}', '{"agents":"调研员"}', "不用拆分", '{"agents":[{"role":" ","goal":"x"}]}']) expect(parseSplit(t)).toBeNull();
  });
});

// @vitest-environment node
// 记忆和技能沉淀的验证（模拟模型，不调真实 API）：
// 1. 第一次说「我偏好简洁输出」→ 提出一条偏好记忆；第二次「介绍一下你自己」走快速路径，系统提示里带着这条偏好，回答遵循简洁。
// 2. 第一次跑杀手场景 → 把做完的步骤保存为技能；第二次说「再整理一次」→ 直接按技能执行只读步骤，模型调用更少，用时 < 第一次的 50%。
import { existsSync } from "node:fs";
import { AgentRuntime, PERSONA } from "@/agent/runtime";
import { selectSkills, type SkillNote } from "@/agent/skills";
import { taskTier } from "@/agent/tier";
import { ToolRegistry } from "@/agent/tools";
import type { LlmCall, LlmRequest } from "@/agent/types";
import { DecisionLayer } from "@/decision/decision-layer";
import { classifyTask } from "@/decision/rules";
import { proposeMemory } from "@/lib/memory";
import { normalizeSkill, recipeFromEvents } from "@/lib/skill";
import { killerMockLlm } from "./killer-mock-llm";
import { BIN, prepareHome, runScenario } from "./killer-scenario-harness";

describe("记忆：偏好进入下一次回答", () => {
  it("「我偏好简洁输出」提出偏好记忆，并且走快速路径", () => {
    expect(proposeMemory("我偏好简洁输出")).toEqual({ kind: "preference", text: "我偏好简洁输出" });
    expect(proposeMemory("我喜欢先看结论，再看细节")).toEqual({ kind: "preference", text: "我喜欢先看结论" });
    expect(proposeMemory("I prefer short answers")).toEqual({ kind: "preference", text: "I prefer short answers" });
    // 不是偏好陈述的不提
    expect(proposeMemory("帮我整理下载文件夹")).toBeNull();
    expect(proposeMemory("你偏好哪个模型")).toBeNull();
    expect(taskTier("我偏好简洁输出", classifyTask({ text: "我偏好简洁输出" })).tier).toBe("simple");
  });

  it("第二次「介绍一下你自己」：系统提示带着偏好，只调一次模型，回答简洁", async () => {
    const registry = new ToolRegistry([]);
    const decision = DecisionLayer.fromEnv({ OPENAI_API_KEY: "x" }, { tools: registry.defs() });
    const reqs: LlmRequest[] = [];
    const LONG = `${PERSONA}我可以帮你整理文件、汇总资料、审查代码，也能连接 MCP 工具完成多步任务。每一步都会在时间线上展示，写入类操作会先请你确认。`;
    // 模拟模型：系统提示里有「简洁」偏好时只回一句人设，否则回长版
    const llm: LlmCall = async (req) => {
      reqs.push(req);
      const sys = String(req.messages[0]?.content ?? "");
      return { text: /偏好：[\s\S]*简洁/.test(sys) ? PERSONA : LONG, profileId: "mock/memory", latencyMs: 0, usage: null };
    };
    const run = (memories: { id: string; kind: "preference" | "fact"; text: string; updated_at: number }[]) =>
      new AgentRuntime({ decision, tools: registry, llm: () => llm, memories }).run("介绍一下你自己");

    const before = await run([]);
    const p = proposeMemory("我偏好简洁输出")!;
    const after = await run([{ id: "mem-1", kind: p.kind, text: p.text, updated_at: 1 }]);

    expect(reqs.map((r) => r.purpose)).toEqual(["answer", "answer"]);
    const sys = String(reqs[1].messages[0].content);
    expect(sys).toContain("偏好：");
    expect(sys).toContain("我偏好简洁输出");
    expect(after.events.find((e) => e.type === "memory")).toMatchObject({ items: [{ text: "我偏好简洁输出" }] });
    expect(after.summary).toBe(PERSONA);
    expect(after.summary.length).toBeLessThan(before.summary.length);
  });
});

describe("技能：「再…一次」找到上次保存的技能", () => {
  const sk = (id: string, name: string, updated_at: number, last_used_at: number | null = null): SkillNote => ({
    id,
    name,
    description: "",
    steps: [{ goal: "列出文件", tool: "mcp__files__list_directory" }],
    use_count: 0,
    updated_at,
    last_used_at,
  });
  it("没有词重叠时取最近用过或保存的技能；不是重复意图时不乱带", () => {
    const a = sk("a", "整理下载文件夹里的 PDF", 1, 50);
    const b = sk("b", "整理周报", 10);
    expect(selectSkills([a, b], "再整理一次").map((s) => s.id)).toEqual(["a"]);
    expect(selectSkills([a, b], "照上次那样来").map((s) => s.id)).toEqual(["a"]);
    expect(selectSkills([a, b], "解释一下时区换算")).toEqual([]);
    expect(selectSkills([], "再整理一次")).toEqual([]);
  });
});

describe.skipIf(!existsSync(BIN))("技能沉淀：第二次整理明显更快", () => {
  it("第一次跑完保存为技能；「再整理一次」直接按技能执行，用时 < 第一次的 50%", async () => {
    // 每次模型调用真实等待 300ms，近似真实模型的响应时间；工具是真实的 eg-mcp-files 子进程
    const DELAY = 300;
    const first = prepareHome();
    const m1 = killerMockLlm({ delayMs: DELAY });
    const r1 = await runScenario({ llm: m1.llm, ...first });
    expect(r1.checks.filter((c) => !c.ok)).toEqual([]);

    // 用户确认后保存：界面上「保存为技能」用的是同一个 recipeFromEvents，再经 normalizeSkill 校验
    const recipe = recipeFromEvents(r1.result.events);
    const saved = normalizeSkill({ name: "整理下载文件夹里的 PDF", description: "", steps: recipe, source: "task" });
    expect(saved.steps[0]).toMatchObject({ tool: "mcp__files__list_directory", args: { path: "~/Downloads", extension: "pdf", modified_within_days: 30 } });
    expect(saved.steps[1]).toMatchObject({ tool: "mcp__files__read_pdf", each: "path", goal: "读取 {名称} 的标题和前几页" });
    // 写入类步骤不保存参数
    for (const s of saved.steps.filter((x) => x.tool === "mcp__files__create_directory" || x.tool === "mcp__files__move_file")) expect(s.args).toBeUndefined();
    const skill: SkillNote = { id: "skill-1", ...saved, use_count: 0, updated_at: 1 };

    const second = prepareHome();
    const m2 = killerMockLlm({ delayMs: DELAY });
    const picked = selectSkills([skill], "再整理一次");
    expect(picked).toHaveLength(1);
    const r2 = await runScenario({ llm: m2.llm, ...second, goal: "再整理一次", skills: picked });
    expect(r2.checks.filter((c) => !c.ok)).toEqual([]);
    // 第一份计划来自技能，不是规划器
    expect(r2.result.events.find((e) => e.type === "plan")).toMatchObject({ plan: { source: "skill", note: expect.stringContaining("跳过规划") } });
    expect(r2.result.events.find((e) => e.type === "skill")).toMatchObject({ items: [{ id: "skill-1" }] });
    // 移动仍然逐个确认
    expect(r2.confirms.filter((c) => c.tool === "move_file")).toHaveLength(7);
    // 第一次：规划 3 轮 + 总结；第二次：只剩一轮续写（判断主题并移动）
    expect(m1.calls.map((c) => c.purpose)).toEqual(["plan", "plan", "plan", "summary"]);
    expect(m2.calls.map((c) => c.purpose)).toEqual(["plan"]);
    expect(r2.ms / r1.ms).toBeLessThan(0.5);
    console.log(`技能沉淀：第一次 ${r1.ms}ms（模型调用 ${r1.llmCalls} 次），第二次 ${r2.ms}ms（${r2.llmCalls} 次），比例 ${(r2.ms / r1.ms).toFixed(2)}`);
  });
});

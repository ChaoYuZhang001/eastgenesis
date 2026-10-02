import { expandStep, listedItems, replayPlan, replayReport, selectSkills, skillBlock, type AgentEvent, type SkillNote, type Tool } from "@/agent";
import { formatStepLines, keepStepArgs, normalizeSkill, parseStepLines, recipeFromEvents, stepsFromEvents } from "@/lib/skill";
import { toTimeline } from "@/lib/timeline";
import { createMockBackend } from "@/platform";

const errOf = (f: () => unknown): { code: string; message: string } | null => {
  try {
    f();
    return null;
  } catch (e) {
    return e as { code: string; message: string };
  }
};
const code = (p: Promise<unknown>) => p.then(() => "ok", (e: { code: string }) => e.code);
const one = [{ goal: "a", tool: null }];

describe("技能校验与步骤文本", () => {
  it("规整空白、默认手动来源；拒绝空名称、步数不对、工具名无效和像密钥的内容", () => {
    expect(normalizeSkill({ name: "  整理  周报 ", description: "", steps: [{ goal: " 汇总 本周进展 ", tool: " demo_search " }] })).toEqual({
      name: "整理 周报",
      description: "",
      steps: [{ goal: "汇总 本周进展", tool: "demo_search" }],
      source: "manual",
    });
    expect(errOf(() => normalizeSkill({ name: " ", description: "", steps: one }))?.code).toBe("invalid_skill");
    expect(errOf(() => normalizeSkill({ name: "x", description: "", steps: [] }))?.code).toBe("invalid_skill");
    expect(errOf(() => normalizeSkill({ name: "x", description: "", steps: Array(13).fill(one[0]) }))?.code).toBe("invalid_skill");
    expect(errOf(() => normalizeSkill({ name: "x", description: "", steps: [{ goal: "a", tool: "Rm -rf" }] }))?.message).toBe("第 1 步的工具名无效");
    const e = errOf(() => normalizeSkill({ name: "x", description: "用 token=abcdef123456 登录", steps: one }));
    expect(e?.message).toContain("密钥");
    expect(e?.message).not.toContain("abcdef");
  });

  it("每行一步，「子目标 | 工具名」，可以来回转换", () => {
    const steps = parseStepLines(" 汇总本周进展 | demo_search \n\n按模板写成周报\n");
    expect(steps).toEqual([
      { goal: "汇总本周进展", tool: "demo_search" },
      { goal: "按模板写成周报", tool: null },
    ]);
    expect(formatStepLines(steps)).toBe("汇总本周进展 | demo_search\n按模板写成周报");
    expect(parseStepLines(formatStepLines(steps))).toEqual(steps);
  });
});

describe("从任务事件取出做完的步骤", () => {
  const st = (id: string, goal: string, tool: string | null = null) => ({ id, goal, tool });
  const a = st("s1", "分析需求");
  const b = st("s2", "检索资料", "demo_search");
  const b2 = st("r1-s1", "换个关键词检索", "demo_search");
  const c = st("r1-s2", "写入文件", "demo_write_file");
  const d = st("r1-s3", "汇总成果");

  it("跨重新规划累计；失败、被拒绝、没做完的不算；重试成功只算一次", () => {
    const events = [
      { type: "step_start", step: a, attempt: 1 },
      { type: "reflect", step: a, done: true, score: 0.9, backend: "rules" },
      { type: "step_start", step: b, attempt: 1 },
      { type: "tool_result", step: b, ok: false, content: "超时", latencyMs: 1 },
      { type: "recover", step: b, strategy: "new_plan", error: "超时", backend: "rules" },
      { type: "step_start", step: b2, attempt: 1 },
      { type: "tool_result", step: b2, ok: false, content: "超时", latencyMs: 1 },
      { type: "recover", step: b2, strategy: "retry", error: "超时", backend: "rules" },
      { type: "step_start", step: b2, attempt: 2 },
      { type: "tool_result", step: b2, ok: true, content: "结果", latencyMs: 1 },
      { type: "reflect", step: b2, done: true, score: 0.8, backend: "rules" },
      { type: "step_start", step: c, attempt: 1 },
      { type: "confirm", step: c, approved: false },
      { type: "step_start", step: d, attempt: 1 },
      { type: "run_end", status: "needs_user", summary: "" },
    ] as AgentEvent[];
    expect(stepsFromEvents(events)).toEqual([
      { goal: "分析需求", tool: null },
      { goal: "换个关键词检索", tool: "demo_search" },
    ]);
    const completed = [{ type: "step_start", step: d, attempt: 1 }, { type: "run_end", status: "completed", summary: "" }] as AgentEvent[];
    expect(stepsFromEvents(completed)).toEqual([{ goal: "汇总成果", tool: null }]);
  });
});

describe("按目标挑选技能", () => {
  const sk = (id: string, name: string, goals: string[], use_count = 0): SkillNote => ({ id, name, description: "", steps: goals.map((g) => ({ goal: g, tool: null })), use_count, updated_at: 1 });
  const weekly = sk("w", "整理周报", ["汇总本周进展", "按模板写成周报"]);
  const sort = sk("s", "排序算法讲解", ["解释快速排序"]);

  it("至少两个词和目标重叠才参考；最多两个，重叠多的优先，其次用得多的", () => {
    expect(selectSkills([weekly, sort], "帮我整理本周周报").map((s) => s.id)).toEqual(["w"]);
    expect(selectSkills([weekly, sort], "解释一下时区换算")).toEqual([]);
    const x = sk("x", "整理周报", ["汇总本周进展"], 5);
    const y = sk("y", "整理周报", ["汇总本周进展"], 1);
    const z = sk("z", "整理周报", ["汇总本周进展"], 9);
    expect(selectSkills([x, y, z], "整理本周周报").map((s) => s.id)).toEqual(["z", "x"]);
    const best = sk("b", "整理本周周报", ["整理本周周报"]);
    expect(selectSkills([x, y, z, best], "整理本周周报").map((s) => s.id)).toEqual(["b", "z"]);
  });

  it("规划提示里的技能段说明只是参考；时间线列出参考的技能", () => {
    expect(skillBlock([])).toBe("");
    const block = skillBlock([{ name: "整理周报", steps: [{ goal: "汇总本周进展", tool: "demo_search" }, { goal: "按模板写成周报", tool: null }] }]);
    expect(block).toContain("可以参考；不适用就忽略");
    expect(block).toContain("技能「整理周报」：\n  1. 汇总本周进展（工具：demo_search）\n  2. 按模板写成周报");
    const items = toTimeline([{ type: "skill", items: [{ id: "w", name: "整理周报" }] }], []);
    expect(items[0]).toMatchObject({ stage: "analysis", title: "参考了 1 个技能", detail: "「整理周报」" });
  });
});

describe("浏览器模式的技能库", () => {
  it("新建、编辑（来源不变）、计数、删除；ID 和上限都会校验", async () => {
    const b = createMockBackend();
    const s = await b.saveSkill({ name: "整理周报", description: "", steps: [{ goal: "汇总本周进展", tool: "demo_search" }], source: "task" });
    expect(s).toMatchObject({ name: "整理周报", source: "task", use_count: 0, last_used_at: null });
    expect(s.id).toMatch(/^skill-/);
    const e = await b.saveSkill({ id: s.id, name: "整理月报", description: "每月一次", steps: [{ goal: "汇总本月进展", tool: null }] });
    expect(e).toMatchObject({ id: s.id, name: "整理月报", description: "每月一次", source: "task" });
    await b.touchSkills([s.id, "skill-missing"]);
    expect((await b.listSkills())[0]).toMatchObject({ use_count: 1 });
    expect(await code(b.saveSkill({ id: "skill-missing", name: "x", description: "", steps: one }))).toBe("skill_not_found");
    expect(await code(b.saveSkill({ id: "../jev", name: "x", description: "", steps: one }))).toBe("invalid_skill_id");
    await b.deleteSkill(s.id);
    expect(await b.listSkills()).toEqual([]);
    for (let i = 0; i < 100; i++) await b.saveSkill({ name: `技能 ${i}`, description: "", steps: one });
    expect(await code(b.saveSkill({ name: "再来一个", description: "", steps: one }))).toBe("skill_full");
  });
});

describe("技能的参数与重放", () => {
  const ro = (id: string, goal: string, tool: string, args: Record<string, unknown>) => [
    { type: "step_start", step: { id, goal, tool, args }, attempt: 1 },
    { type: "gate", step: { id, goal, tool, args }, verdict: "allow", risk: "low", reasons: ["只读操作，决策层评估为低风险"], backend: "rules" },
    { type: "tool_result", step: { id, goal, tool }, ok: true, content: "{}", latencyMs: 1 },
  ];
  const rw = (id: string, goal: string, tool: string, args: Record<string, unknown>) => [
    { type: "step_start", step: { id, goal, tool, args }, attempt: 1 },
    { type: "gate", step: { id, goal, tool, args }, verdict: "confirm", risk: "medium", reasons: ["工具有副作用（本地写入）"], backend: "rules" },
    { type: "confirm", step: { id, goal, tool }, approved: true },
    { type: "tool_result", step: { id, goal, tool }, ok: true, content: "{}", latencyMs: 1 },
  ];

  it("只读步骤保留参数，同一工具连续多步合成逐项步骤；写入类不保存参数", () => {
    const events = [
      ...ro("s1", "列出 ~/Downloads 的 PDF", "mcp__files__list_directory", { path: "~/Downloads", extension: "pdf" }),
      ...ro("s2", "读取 a.pdf 的标题", "mcp__files__read_pdf", { path: "~/Downloads/a.pdf", max_pages: 3 }),
      ...ro("s3", "读取 b.pdf 的标题", "mcp__files__read_pdf", { path: "~/Downloads/b.pdf", max_pages: 3 }),
      ...rw("s4", "把 a.pdf 移到 合同", "mcp__files__move_file", { src: "~/Downloads/a.pdf", dst: "~/Downloads/合同" }),
      { type: "run_end", status: "completed", summary: "" },
    ] as AgentEvent[];
    expect(recipeFromEvents(events)).toEqual([
      { goal: "列出 ~/Downloads 的 PDF", tool: "mcp__files__list_directory", args: { path: "~/Downloads", extension: "pdf" } },
      { goal: "读取 {名称} 的标题", tool: "mcp__files__read_pdf", args: { max_pages: 3 }, each: "path" },
      { goal: "把 a.pdf 移到 合同", tool: "mcp__files__move_file" },
    ]);
  });

  it("参数要是对象、不能太长、不能带密钥；表单改动过的行不再带参数", () => {
    const base = { name: "x", description: "" };
    expect(normalizeSkill({ ...base, steps: [{ goal: "列出", tool: "t", args: { path: "~" } }] }).steps[0].args).toEqual({ path: "~" });
    expect(errOf(() => normalizeSkill({ ...base, steps: [{ goal: "a", tool: "t", args: [1] as never }] }))?.message).toBe("第 1 步的参数无效");
    expect(errOf(() => normalizeSkill({ ...base, steps: [{ goal: "a", tool: "t", args: { q: "x".repeat(3000) } }] }))?.message).toBe("第 1 步的参数无效");
    expect(errOf(() => normalizeSkill({ ...base, steps: [{ goal: "a", tool: "t", each: "../p" }] }))?.message).toBe("第 1 步的逐项参数名无效");
    expect(errOf(() => normalizeSkill({ ...base, steps: [{ goal: "a", tool: "t", args: { key: "sk-abcdefghijklmnopqrstuvwx" } }] }))?.message).toContain("密钥");
    const before = [{ goal: "列出", tool: "t", args: { path: "~" } }, { goal: "读取 {名称}", tool: "r", args: {}, each: "path" }];
    expect(keepStepArgs([{ goal: "列出", tool: "t" }, { goal: "改过的", tool: "r" }], before)).toEqual([{ goal: "列出", tool: "t", args: { path: "~" } }, { goal: "改过的", tool: "r" }]);
  });

  const tool = (name: string, sideEffect: Tool["sideEffect"]): Tool => ({ name, description: "", sideEffect, run: async () => ({ ok: true, content: "" }) });
  const tools = new Map([tool("list", "none"), tool("read", "none"), tool("move", "destructive")].map((t) => [t.name, t]));
  const skill: SkillNote = {
    id: "k",
    name: "整理下载",
    description: "",
    steps: [{ goal: "列出", tool: "list", args: { path: "~/Downloads" } }, { goal: "读取 {名称}", tool: "read", args: { max_pages: 3 }, each: "path" }, { goal: "移动", tool: "move" }],
    use_count: 0,
    updated_at: 1,
  };

  it("只在明确要求重复时重放；只重放开头带参数的只读步骤", () => {
    expect(replayPlan(skill, "再整理一次", (n) => tools.get(n))).toEqual({ steps: skill.steps.slice(0, 2), rest: 1 });
    expect(replayPlan(skill, "整理下载", (n) => tools.get(n))?.rest).toBe(1);
    expect(replayPlan(skill, "整理一下下载文件夹的图片", (n) => tools.get(n))).toBeNull();
    expect(replayPlan({ ...skill, steps: [{ goal: "移动", tool: "move", args: {} }] }, "再整理一次", (n) => tools.get(n))).toBeNull();
    expect(replayPlan(undefined, "再整理一次", (n) => tools.get(n))).toBeNull();
  });

  it("逐项步骤按上一步列出的文件展开；目录和坏数据跳过", () => {
    const out = JSON.stringify({ entries: [{ name: "a.pdf", path: "~/Downloads/a.pdf", type: "file" }, { name: "sub", path: "~/Downloads/sub", type: "dir" }, { name: 1 }] });
    const records = [{ step: { id: "k1-s1", goal: "列出", tool: "list" }, status: "done" as const, attempts: 1, output: out }];
    expect(expandStep(skill.steps[1], "k2-s", records, 12)).toEqual([{ id: "k2-s1", goal: "读取 a.pdf", tool: "read", args: { max_pages: 3, path: "~/Downloads/a.pdf" } }]);
    expect(listedItems("不是 JSON")).toEqual([]);
    const report = replayReport("整理下载", [{ step: { id: "m", goal: "把 a.pdf 移到 合同", tool: "move" }, status: "done", attempts: 1, output: JSON.stringify({ src: "~/Downloads/a.pdf", dst: "~/Downloads/合同/a.pdf" }) }], (n) => tools.get(n));
    expect(report).toContain("按技能「整理下载」重复执行");
    expect(report).toContain("| 把 a.pdf 移到 合同 | ~/Downloads/a.pdf → ~/Downloads/合同/a.pdf |");
  });
});

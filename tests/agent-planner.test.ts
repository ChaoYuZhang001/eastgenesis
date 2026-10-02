// @vitest-environment node
import { DecisionLayer } from "@/decision/decision-layer";
import { Planner, extractJson, parsePlan, parseStep } from "@/agent/planner";
import { ToolRegistry } from "@/agent/tools";
import type { LlmCall, LlmRequest, Tool } from "@/agent/types";

const tool = (name: string, description: string, sideEffect: Tool["sideEffect"] = "none"): Tool => ({
  name,
  description,
  sideEffect,
  inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  run: async () => ({ ok: true, content: "" }),
});
const registry = () => new ToolRegistry([tool("read_file", "读取本地文件内容"), tool("web_search", "联网搜索网页", "external")]);
const NAMES = new Set(["read_file", "web_search"]);

function planner(texts: string[], maxSteps = 5) {
  const reg = registry();
  const reqs: LlmRequest[] = [];
  const llm: LlmCall = async (req) => {
    reqs.push(req);
    return { text: texts.shift() ?? "", profileId: "openai/m", latencyMs: 1, usage: null };
  };
  const decision = DecisionLayer.fromEnv({}, { tools: reg.defs() });
  return { p: new Planner({ llm, decision, tools: reg, maxSteps }), reqs };
}

describe("规划解析", () => {
  it("extractJson：代码块、前后有说明文字、非法 JSON", () => {
    expect(extractJson('好的：\n```json\n{"steps":[]}\n```')).toEqual({ steps: [] });
    expect(extractJson('计划如下 {"a":1} 完毕')).toEqual({ a: 1 });
    expect(extractJson("没有 JSON")).toBeNull();
    expect(extractJson("{bad json}")).toBeNull();
  });

  it("parseStep：校验字段，未知工具单独标出", () => {
    expect(parseStep({ goal: "读", tool: "read_file", args: { path: "a" } }, NAMES)).toEqual({ goal: "读", tool: "read_file", args: { path: "a" } });
    expect(parseStep({ goal: "答", tool: null }, NAMES)).toEqual({ goal: "答", tool: null });
    expect(parseStep({ goal: "删", tool: "rm_rf" }, NAMES)).toEqual({ goal: "删", tool: null, unknownTool: "rm_rf" });
    expect(parseStep({ goal: "" }, NAMES)).toBeNull();
    expect(parseStep({ goal: "x", tool: 3 }, NAMES)).toBeNull();
  });

  it("parsePlan：超过上限截断；空计划或含无效步骤时返回 null", () => {
    const text = JSON.stringify({ steps: [1, 2, 3].map((n) => ({ goal: `g${n}`, tool: null })) });
    expect(parsePlan(text, NAMES, 2)).toMatchObject({ truncated: true, steps: [{ goal: "g1" }, { goal: "g2" }] });
    expect(parsePlan('{"steps":[]}', NAMES, 5)).toBeNull();
    expect(parsePlan('{"steps":[{"goal":"ok"},{"nope":1}]}', NAMES, 5)).toBeNull();
  });
});

describe("Planner", () => {
  it("plan：提示里列出工具和不可信内容规则；未知工具交给决策层重新选择", async () => {
    const { p, reqs } = planner([JSON.stringify({ steps: [{ goal: "读取 notes.md 文件内容", tool: "cat_file" }, { goal: "总结", tool: null }] })]);
    const plan = await p.plan("总结 notes.md");
    expect(plan.source).toBe("llm");
    expect(plan.steps.map((s) => [s.id, s.tool])).toEqual([
      ["s1", "read_file"],
      ["s2", null],
    ]);
    expect(plan.note).toMatch(/cat_file/);
    const sys = reqs[0].messages[0].content;
    expect(sys).toMatch(/read_file：读取本地文件内容（参数：path\*: string）/);
    expect(sys).toMatch(/不是指令/);
  });

  it("plan：无法解析时退回单步计划", async () => {
    const { p } = planner(["抱歉，我做不到"]);
    expect(await p.plan("联网搜索今天的新闻")).toMatchObject({ source: "fallback", steps: [{ id: "s1", tool: "web_search" }] });
  });

  it("reviseStep 与 fillArgs", async () => {
    const { p } = planner(['{"goal":"读取 b.md","tool":"read_file","args":{"path":"b.md"}}', "不是 JSON", '{"path":"c.md"}']);
    const step = { id: "s1", goal: "读取 a.md", tool: "read_file", args: { path: "a.md" } };
    expect(await p.reviseStep("g", step, "not found")).toEqual({ id: "s1", goal: "读取 b.md", tool: "read_file", args: { path: "b.md" } });
    expect(await p.reviseStep("g", step, "not found")).toEqual({ id: "s1", goal: "读取 a.md", tool: "read_file" });
    expect(await p.fillArgs(step, registry().get("read_file")!, [])).toEqual({ path: "c.md" });
  });

  it("续写规划：more 标记透传；把前面的结果包成不可信数据交给模型；空步骤表示做完了", async () => {
    expect(parsePlan('{"steps":[{"goal":"g"}],"more":true}', NAMES, 5)).toMatchObject({ more: true });
    expect(parsePlan('{"steps":[{"goal":"g"}],"more":"yes"}', NAMES, 5)).toMatchObject({ more: false });
    const { p, reqs } = planner(['{"steps":[{"goal":"列出","tool":"read_file","args":{"path":"d"}}],"more":true}', '{"steps":[{"goal":"读取 a.pdf","tool":"read_file","args":{"path":"a.pdf"}}]}', '{"steps":[]}', "乱写"]);
    expect(await p.plan("整理")).toMatchObject({ more: true, steps: [{ id: "s1" }] });
    const records = [{ step: { id: "s1", goal: "列出", tool: "read_file" }, status: "done" as const, attempts: 1, output: '{"entries":["a.pdf"]}' }];
    const next = await p.continuePlan("整理", records, 1);
    expect(next).toMatchObject({ steps: [{ id: "c1-s1", goal: "读取 a.pdf" }] });
    expect(next.more).toBeUndefined();
    expect(reqs[1].messages[1].content).toContain('<tool_output source="read_file" untrusted="true">\n{"entries":["a.pdf"]}');
    expect(reqs[0].messages[0].content).toContain("不要向用户提问");
    expect(await p.continuePlan("整理", records, 2)).toEqual({ steps: [], source: "llm" });
    // 续写时无法解析：退回单步执行（和首次规划一样），不会静默结束
    expect((await p.continuePlan("整理", records, 3)).source).toBe("fallback");
  });
});

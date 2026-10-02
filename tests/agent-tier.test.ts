// @vitest-environment node
// 任务分级：简单问答跳过规划直接回答；多步任务走完整规划。判断只用规则引擎，不额外调模型。
import { AgentRuntime, PERSONA } from "@/agent/runtime";
import { taskTier } from "@/agent/tier";
import { ToolRegistry } from "@/agent/tools";
import type { LlmCall, LlmRequest, Tool } from "@/agent/types";
import { DecisionLayer } from "@/decision/decision-layer";
import { classifyTask } from "@/decision/rules";

const tier = (goal: string, tools: Tool[] = []) => taskTier(goal, classifyTask({ text: goal }), tools).tier;
const fsTool = (name: string, description: string): Tool => ({ name, description, sideEffect: "none", run: async () => ({ ok: true, content: "" }) });

describe("任务分级规则", () => {
  it("简单问答：自我介绍、翻译、解释概念、闲聊", () => {
    for (const g of ["简单介绍一下你自己", "你是谁", "把这句话翻译成英文：今天天气很好", "解释一下量子纠缠", "什么是向量数据库", "你好", "谢谢！", "Who are you?"]) {
      expect(tier(g), g).toBe("simple");
    }
  });

  it("多步任务：文件整理、信息汇总、代码审查、需要工具或包含多个步骤", () => {
    for (const g of [
      "把下载文件夹的 PDF 分类",
      "把下载文件夹里最近 30 天的 PDF 按主题分类",
      "汇总一下本周的新闻",
      "帮我审查这段代码",
      "整理周报并保存",
      "先读取 notes.md 再总结要点",
      "调研国产大模型的现状",
      "删除旧文件",
      "清理磁盘",
    ]) {
      expect(tier(g), g).toBe("multi");
    }
  });

  it("目标能匹配上可用工具时走规划（路由分类不认识的 MCP 工具）", () => {
    expect(tier("查询服务状态")).toBe("multi");
    expect(tier("解释服务状态", [fsTool("fetch_status", "查询服务状态")])).toBe("multi");
    expect(tier("解释一下量子纠缠", [fsTool("fetch_status", "查询服务状态")])).toBe("simple");
  });
});
function rig(tools: Tool[] = [], latencyMs = 0) {
  const registry = new ToolRegistry(tools);
  const decision = DecisionLayer.fromEnv({ OPENAI_API_KEY: "x" }, { tools: registry.defs() });
  const reqs: LlmRequest[] = [];
  const llm: LlmCall = async (req) => {
    reqs.push(req);
    // 模拟每次模型调用的耗时：一次调用 latencyMs 毫秒
    if (latencyMs) await new Promise((r) => setTimeout(r, latencyMs));
    const text = req.purpose === "plan" ? JSON.stringify({ steps: [{ goal: "回答", tool: null }] }) : PERSONA;
    return { text, profileId: "openai/fake", latencyMs, usage: null };
  };
  return { rt: new AgentRuntime({ decision, tools: registry, llm: () => llm }), reqs };
}

describe("简单问答的快速路径", () => {
  it("「简单介绍一下你自己」只调一次模型，不规划、不反思、不总结；单次调用 1 秒时总耗时 < 5 秒", async () => {
    const { rt, reqs } = rig([], 1000);
    const t0 = Date.now();
    const r = await rt.run("简单介绍一下你自己");
    const ms = Date.now() - t0;
    expect(r).toMatchObject({ status: "completed", summary: PERSONA, plan: { source: "direct" } });
    expect(reqs.map((q) => q.purpose)).toEqual(["answer"]);
    expect(String(reqs[0].messages[0].content)).toContain(PERSONA);
    expect(r.events.map((e) => e.type)).toEqual(["run_start", "route", "plan", "step_start", "llm", "run_end"]);
    expect(ms).toBeLessThan(5000);
  });

  it("多步任务仍走完整规划：规划 → 执行 → 总结", async () => {
    const { rt, reqs } = rig([fsTool("mcp__files__list_directory", "列出目录内容")]);
    const r = await rt.run("把下载文件夹的 PDF 分类");
    expect(r.plan.source).toBe("llm");
    expect(reqs.map((q) => q.purpose)).toEqual(["plan", "answer", "summary"]);
  });
});

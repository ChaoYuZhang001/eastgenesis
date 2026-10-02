// CloudJevBackend 的决策方法（模拟 SDK 返回）。真实 API 的验证见 tools/jev-smoke-test.mjs、tools/jev-route-test.mjs、tools/jev-eval.ts。
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SystemOneResult } from "@typesafe-ai/sdk";
import { CloudJevBackend, FallbackChain, RuleBasedBackend } from "@/decision/fallback";
import type { JevClient } from "@/decision/jev-client";

describe("CloudJevBackend", () => {
  let backend: CloudJevBackend;

  beforeEach(() => {
    const mockClient = {
      model: "jev-latest",
      ask: vi.fn(async (_state: any, questions: any, _signal?: AbortSignal) => {
        const answers: Record<string, any> = {};
        for (const [k, q] of Object.entries(questions) as [string, any][]) {
          if (q.type === "noul") answers[k] = { type: "noul", noul: 0.8, confidence: 0.85 };
          else if (q.type === "choice") {
            const keys = Object.keys(q.criteria);
            answers[k] = { type: "choice", choice: keys[0], confidence: 0.9 };
          } else if (q.type === "score") {
            answers[k] = { type: "score", score: 1.2, confidence: 0.88 };
          }
        }
        return { answers } as SystemOneResult<any>;
      }),
      choice: vi.fn(async (_state: any, _question: string, criteria: Record<string, any>, _signal?: AbortSignal) => {
        const keys = Object.keys(criteria);
        return { choice: keys[0], confidence: 0.9 };
      }),
      noul: vi.fn(async (_state: any, _question: string, _signal?: AbortSignal) => ({ noul: 0.8, confidence: 0.85 })),
      score: vi.fn(async (_state: any, _question: string, _labels: string[], _signal?: AbortSignal) => ({ score: 1.2, confidence: 0.88 })),
    } as any;
    backend = new CloudJevBackend(mockClient);
  });

  it("unavailableReason 返回 null（有 client）", () => {
    expect(backend.unavailableReason()).toBeNull();
  });

  it("classifyTask 返回分类和置信度", async () => {
    const r = await backend.classifyTask({ text: "重构这个函数" });
    expect(r.value.type).toBeTruthy();
    expect(r.value.capabilities).toContain("code");
    expect(r.confidence).toBeGreaterThan(0.5);
  });

  it("chooseTool 在候选里选一个或返回 null", async () => {
    const tools = [
      { name: "read_file", description: "读文件" },
      { name: "write_file", description: "写文件" },
    ];
    const r = await backend.chooseTool("读取 package.json", tools);
    expect(r.confidence).toBeGreaterThan(0.5);
  });

  it("checkDone 判断任务是否完成", async () => {
    const r = await backend.checkDone("列出 PDF 文件", "找到 7 个 PDF");
    expect(r.value).toBe(true);
    expect(r.confidence).toBeGreaterThan(0.5);
  });

  it("assessRisk 判断风险级别", async () => {
    const r = await backend.assessRisk("删除 ~/Downloads 里所有文件");
    expect(["low", "medium", "high"]).toContain(r.value);
    expect(r.confidence).toBeGreaterThan(0.5);
  });

  it("evaluateResult 给结果打分", async () => {
    const r = await backend.evaluateResult("读取 README.md", "# EastGenesis\n\n多模型中立的 Agent 桌面应用。");
    expect(r.value).toBeGreaterThanOrEqual(0);
    expect(r.value).toBeLessThanOrEqual(1);
    expect(r.confidence).toBeGreaterThan(0.5);
  });

  it("replan 判断重新规划策略", async () => {
    const r = await backend.replan({ goal: "移动文件", failedStep: "move_file", error: "权限不足", attempts: 1 });
    expect(["retry", "modify_step", "new_plan", "ask_user", "abort"]).toContain(r.value);
    expect(r.confidence).toBeGreaterThan(0.5);
  });
});

describe("CloudJevBackend 无 client", () => {
  it("unavailableReason 返回原因", () => {
    const b = new CloudJevBackend(null);
    expect(b.unavailableReason()).toContain("TYPESAFE_API_KEY");
  });
});

function clientWith(probs: Record<string, number>) {
  const ask = vi.fn(async (_state: unknown, _questions: Record<string, unknown>) => ({
    answers: Object.fromEntries(Object.entries(probs).map(([k, p]) => [k, { type: "noul", noul: p }])),
  }));
  return { client: { ask } as unknown as JevClient, ask };
}

describe("CloudJevBackend 分类：一个请求并行问全部能力，置信度只计入会改变结果的判断", () => {
  // 真实 Jev 对「帮我写一个快速排序」的回答（2026-10-02）：code 很确定，reasoning 在 0.5 附近
  const QUICKSORT = { code: 0.97, reasoning: 0.55, tool_use: 0.04 };
  // tool_use 在 0.5 附近：会改变主类型，也是硬性能力
  const TOOL_AMBIGUOUS = { code: 0.97, reasoning: 0.04, tool_use: 0.55 };
  const input = { text: "帮我写一个快速排序" };

  it("fan-out：一次调用问完 code / reasoning / tool_use，有图片时加 vision", async () => {
    const { client, ask } = clientWith(QUICKSORT);
    const b = new CloudJevBackend(client);
    await b.classifyTask(input);
    await b.classifyTask({ text: "这是什么？", attachments: [{ kind: "image", name: "a.png" }] });
    expect(ask).toHaveBeenCalledTimes(2);
    expect(Object.keys(ask.mock.calls[0][1])).toEqual(["code", "reasoning", "tool_use"]);
    expect(Object.keys(ask.mock.calls[1][1])).toEqual(["code", "reasoning", "tool_use", "vision"]);
  });

  it("reasoning 含糊不影响结果：置信度 0.92，由 cloud-jev 采用", async () => {
    const chain = new FallbackChain([new CloudJevBackend(clientWith(QUICKSORT).client), new RuleBasedBackend()]);
    const { value, meta } = await chain.run((b) => b.classifyTask(input));
    expect(value.type).toBe("code");
    expect(meta).toMatchObject({ backend: "cloud-jev", level: 1, degraded: false });
    expect(meta.confidence).toBeCloseTo(0.92, 5);
  });

  it("tool_use 含糊会改变结果：交给规则引擎，并记下原因", async () => {
    const chain = new FallbackChain([new CloudJevBackend(clientWith(TOOL_AMBIGUOUS).client), new RuleBasedBackend()]);
    const { meta } = await chain.run((b) => b.classifyTask(input));
    expect(meta).toMatchObject({ backend: "rules", level: 3, degraded: true });
    expect(meta.skipped).toEqual([{ backend: "cloud-jev", reason: "置信度 0.10 低于阈值 0.6" }]);
  });
});

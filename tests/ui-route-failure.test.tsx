import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { AgentEvent } from "@/agent";
import { emittingLlm, routedLlm } from "@/agent/llm";
import { RouteLine } from "@/components/chat/RouteLine";
import { ProviderError } from "@/core/llm/errors";
import type { LLMProvider } from "@/core/llm/types";
import { HealthTracker, type ChainEntry } from "@/decision";
import { routeLineText, routeSummary } from "@/lib/route-summary";
import { resetStores } from "./ui-helpers";

const ids = ["custom:first/alpha", "custom:second/beta", "custom:third/gamma"];
const chain: ChainEntry[] = ids.map((profileId, i) => ({
  profileId, provider: ["custom:first", "custom:second", "custom:third"][i],
  stage: i === 0 ? "primary" : "fallback", score: 1,
  breakdown: { capability: 1, quality: 1, cost: 1, latency: 1, availability: 1, total: 1 }, reason: "匹配任务",
}));
const route: Extract<AgentEvent, { type: "route" }> = {
  type: "route", profileId: ids[0], reasons: [],
  decision: {
    classification: { type: "qa", capabilities: [], confidence: 1, signals: [], estTokens: 10, lang: "zh" },
    primary: chain[0], chain, weights: { capability: 0.3, quality: 0.35, cost: 0.2, latency: 0.15 }, reasons: [], excluded: [],
  },
  meta: { backend: "rules", level: 3, degraded: false, confidence: 1, skipped: [], latencyMs: 0 },
};
const failure = (attempts: Extract<AgentEvent, { type: "llm_failed" }>["attempts"], partialOutput = false): AgentEvent => ({
  type: "llm_failed", purpose: "answer", attempts, ...(partialOutput ? { partialOutput: true } : {}),
});
const attempt = (profileId: string, code = "network") => ({ profileId, code, reason: code === "network" ? "网络连接中断" : "停止调用" });

function open(events: AgentEvent[]) {
  const summary = routeSummary(route, events)!;
  render(<RouteLine summary={summary} durationMs={10} />);
  fireEvent.click(screen.getByRole("button", { name: /查看路由决策/ }));
  return { summary, details: within(screen.getByRole("region", { name: "路由决策详情" })) };
}

beforeEach(() => resetStores());
afterEach(() => cleanup());

describe("路由失败的实际调用证据", () => {
  it("实际流式输出中断后只展示已调用的模型，并解释停止自动降级", async () => {
    const events: AgentEvent[] = [];
    const providerFor = vi.fn(async (entry: ChainEntry) => ({
      chat: vi.fn(async () => { throw new ProviderError("network", entry.provider); }),
      async *stream() {
        yield { type: "delta" as const, text: "已收到的部分正文" };
        throw new ProviderError("network", entry.provider);
      },
    }) as never);
    const call = emittingLlm(routedLlm(route.decision, providerFor), (event) => events.push(event));
    await expect(call({ purpose: "answer", messages: [] })).rejects.toMatchObject({ partialOutput: true });
    expect(providerFor).toHaveBeenCalledTimes(1);
    expect(events.find((event) => event.type === "llm_failed")).toMatchObject({ partialOutput: true, attempts: [{ profileId: ids[0], code: "network" }] });

    const { summary, details } = open(events);
    expect(summary.models).toEqual([ids[0]]);
    expect(screen.getByRole("button", { name: /查看路由决策/ })).toHaveTextContent("部分输出后已停止自动降级");
    expect(details.getByText("部分输出后已停止自动降级")).toBeInTheDocument();
    expect(details.getByText("已保留部分输出，为避免拼接不同模型的回答，本次停止自动降级。")).toBeInTheDocument();
    const records = within(details.getByRole("list", { name: "失败记录" }));
    expect(records.getAllByRole("listitem")).toHaveLength(1);
    expect(records.getByText(/first\/alpha/)).toBeInTheDocument();
    expect(records.queryByText(/second\/beta|third\/gamma/)).not.toBeInTheDocument();
    expect(details.queryByText("降级链上的模型都没有成功")).not.toBeInTheDocument();
  });

  it("降级后输出中断仍只列实际两次尝试，不把剩余候选列为失败", () => {
    const { details } = open([failure([attempt(ids[0], "server"), attempt(ids[1])], true)]);
    expect(details.getByText("部分输出后已停止自动降级")).toBeInTheDocument();
    const records = within(details.getByRole("list", { name: "失败记录" }));
    expect(records.getAllByRole("listitem")).toHaveLength(2);
    expect(records.queryByText(/third\/gamma/)).not.toBeInTheDocument();
  });

  it("没有部分输出的提前安全停止也不会声称全链都调用过", () => {
    const { summary, details } = open([failure([attempt(ids[0], "response_too_large")])]);
    expect(details.getByText("本次尝试的 1 个模型均未成功")).toBeInTheDocument();
    expect(routeLineText(summary)).toBe("本次尝试的 1 个模型均未成功");
    expect(details.queryByText("降级链上的模型都没有成功")).not.toBeInTheDocument();
    expect(details.queryByText(/已保留部分输出/)).not.toBeInTheDocument();
  });

  it("实际完整链耗尽时仍准确列出全部失败尝试", async () => {
    const events: AgentEvent[] = [];
    const providerFor = vi.fn(async (entry: ChainEntry) => ({
      chat: async () => { throw new ProviderError("server", entry.provider); },
    }) as never);
    await expect(emittingLlm(routedLlm(route.decision, providerFor), (event) => events.push(event))({ purpose: "plan", messages: [] })).rejects.toMatchObject({ code: "route_exhausted" });
    expect(providerFor).toHaveBeenCalledTimes(3);
    const { summary, details } = open(events);
    expect(summary.models).toEqual(ids);
    expect(details.getByText("本次尝试的 3 个模型均未成功")).toBeInTheDocument();
    expect(within(details.getByRole("list", { name: "失败记录" })).getAllByRole("listitem")).toHaveLength(3);
    expect(details.queryByText(/已保留部分输出/)).not.toBeInTheDocument();
  });

  it("停用和熔断跳过的模型单列原因，不计入实际尝试和失败数", () => {
    const skipped = [attempt(ids[0], "provider_down"), attempt(ids[1], "unhealthy")];
    const { summary, details } = open([failure([...skipped, attempt(ids[2])])]);
    expect(summary.models).toEqual([ids[2]]);
    expect(details.getByText("本次尝试的 1 个模型均未成功")).toBeInTheDocument();
    const records = within(details.getByRole("list", { name: "失败记录" }));
    expect(records.getAllByRole("listitem")).toHaveLength(1);
    expect(records.queryByText(/first\/alpha|second\/beta/)).not.toBeInTheDocument();
    expect(within(details.getByRole("list", { name: "跳过记录" })).getAllByRole("listitem")).toHaveLength(2);
  });

  it("兼容没有 partialOutput 字段的旧失败记录", () => {
    const { summary, details } = open([failure([attempt(ids[0]), attempt(ids[1])])]);
    expect(routeLineText(summary)).toBe("本次尝试的 2 个模型均未成功");
    expect(details.getByText("本次尝试的 2 个模型均未成功")).toBeInTheDocument();
    expect(details.queryByText(/已保留部分输出/)).not.toBeInTheDocument();
  });

  it("后续调用成功后不再把此前的部分输出停止当成当前失败", () => {
    const summary = routeSummary(route, [failure([attempt(ids[0])], true), {
      type: "llm", purpose: "answer", profileId: ids[1], latencyMs: 1, usage: null,
    }])!;
    expect(summary.failures).toEqual([]);
    expect(routeLineText(summary)).toBe("使用 second/beta（共 2 个模型）");
  });

  it("此前规划成功也不会掩盖当前回答的部分输出停止", () => {
    const { summary, details } = open([{
      type: "llm", purpose: "plan", profileId: ids[0], latencyMs: 1, usage: null,
    }, failure([attempt(ids[1])], true)]);
    expect(summary.used).toBe(ids[0]);
    expect(routeLineText(summary)).toBe("部分输出后已停止自动降级");
    expect(details.getByText("部分输出后已停止自动降级")).toBeInTheDocument();
    expect(within(details.getByRole("list", { name: "失败记录" })).getAllByRole("listitem")).toHaveLength(1);
  });

  it("下一次失败调用只展示它的尝试，不沿用前一次的部分输出或跳过状态", () => {
    const { summary, details } = open([
      failure([attempt(ids[0], "unhealthy"), attempt(ids[1])], true),
      failure([attempt(ids[2], "server")]),
    ]);
    expect(routeLineText(summary)).toBe("本次尝试的 1 个模型均未成功");
    expect(details.queryByText(/已保留部分输出/)).not.toBeInTheDocument();
    expect(details.queryByRole("list", { name: "跳过记录" })).not.toBeInTheDocument();
    expect(within(details.getByRole("list", { name: "失败记录" })).getByText(/third\/gamma/)).toBeInTheDocument();
  });

  it("全跳过的兼容记录明确未发起调用，不折叠成准备使用", () => {
    const { summary, details } = open([failure([attempt(ids[0], "unhealthy"), attempt(ids[1], "provider_down")])]);
    expect(routeLineText(summary)).toBe("候选模型均已跳过，本次未发起调用");
    expect(details.getByText("候选模型均已跳过，本次未发起调用")).toBeInTheDocument();
    expect(details.queryByRole("list", { name: "失败记录" })).not.toBeInTheDocument();
    expect(within(details.getByRole("list", { name: "跳过记录" })).getAllByRole("listitem")).toHaveLength(2);
  });

  it("真实熔断跳过后成功不把跳过候选描述为失败或实际降级调用", async () => {
    const events: AgentEvent[] = [];
    const health = new HealthTracker();
    for (let i = 0; i < 3; i++) health.recordFailure(ids[0]);
    const providerFor = vi.fn(async (entry: ChainEntry): Promise<LLMProvider> => ({
      id: entry.provider, kind: "openai-compatible", label: "合成测试 Provider",
      capabilities: { streaming: false, systemPrompt: true, recovery: { abortSignal: true, streamTerminal: false, partialOutput: true, normalizedErrors: true } },
      chat: async () => ({ providerId: entry.provider, model: "beta", text: "成功正文", usage: null, finishReason: "stop" as const, latencyMs: 1 }),
      async *stream() { throw new Error("此合成 Provider 禁用流式"); },
    }));
    await emittingLlm(routedLlm(route.decision, providerFor, health), (event) => events.push(event))({ purpose: "answer", messages: [] });
    expect(providerFor).toHaveBeenCalledTimes(1);
    expect(providerFor.mock.calls[0][0].profileId).toBe(ids[1]);
    const { summary, details } = open(events);
    expect(routeLineText(summary)).toBe("使用 second/beta · 跳过候选 1 次（未调用）");
    const records = within(details.getByRole("list", { name: "降级与跳过记录" }));
    expect(records.getAllByRole("listitem")).toHaveLength(1);
    expect(records.getByText(/已跳过 first\/alpha（未调用）/)).toBeInTheDocument();
    expect(records.queryByText(/失败：/)).not.toBeInTheDocument();
    expect(records.getByText(/连续失败/)).toBeInTheDocument();
  });

  it("真实失败与跳过混合后成功，降级目标只指向真正调用的后续模型", async () => {
    const events: AgentEvent[] = [];
    const health = new HealthTracker();
    for (let i = 0; i < 3; i++) health.recordFailure(ids[1]);
    const providerFor = vi.fn(async (entry: ChainEntry): Promise<LLMProvider> => ({
      id: entry.provider, kind: "openai-compatible", label: "合成测试 Provider",
      capabilities: { streaming: false, systemPrompt: true, recovery: { abortSignal: true, streamTerminal: false, partialOutput: true, normalizedErrors: true } },
      chat: async () => {
        if (entry.profileId === ids[0]) throw new ProviderError("server", entry.provider);
        return { providerId: entry.provider, model: "gamma", text: "成功正文", usage: null, finishReason: "stop" as const, latencyMs: 1 };
      },
      async *stream() { throw new Error("此合成 Provider 禁用流式"); },
    }));
    await emittingLlm(routedLlm(route.decision, providerFor, health), (event) => events.push(event))({ purpose: "answer", messages: [] });
    expect(providerFor.mock.calls.map(([entry]) => entry.profileId)).toEqual([ids[0], ids[2]]);
    const { summary, details } = open(events);
    expect(routeLineText(summary)).toContain("降级 1 次 · 跳过候选 1 次（未调用）");
    const records = within(details.getByRole("list", { name: "降级与跳过记录" }));
    expect(records.getByText(/降级到 third\/gamma（first\/alpha 失败：/)).toBeInTheDocument();
    expect(records.queryByText(/降级到 second\/beta/)).not.toBeInTheDocument();
    expect(records.getByText(/已跳过 second\/beta（未调用）/)).toBeInTheDocument();
  });
});

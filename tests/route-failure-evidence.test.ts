// @vitest-environment node
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import type { AgentEvent } from "@/agent";
import { emittingLlm, llmFailedEvent, routedLlm } from "@/agent/llm";
import { ProviderError } from "@/core/llm/errors";
import type { LLMProvider } from "@/core/llm/types";
import { HealthTracker, type ChainEntry, type RouteDecision } from "@/decision";
import { RouteExhaustedError } from "@/decision/router";
import { desktopEvidenceOf } from "@/lib/desktop-evidence";
import { toTimeline } from "@/lib/timeline";
import type { TaskCard } from "@/stores/tasks";

const validator = resolve("tools/desktop-evidence-validate.mjs");
const ids = ["custom:first/alpha", "custom:second/beta", "custom:third/gamma"];
const entry = (profileId: string, provider = profileId.split("/")[0]): ChainEntry => ({
  profileId, provider, stage: "primary", score: 1,
  breakdown: { capability: 1, quality: 1, cost: 1, latency: 1, availability: 1, total: 1 }, reason: "匹配任务",
});

describe("专家时间线只描述实际调用和跳过记录", () => {
  it("真实熔断跳过后成功保留最终模型，不把未调用候选描述为先试", async () => {
    const health = new HealthTracker();
    for (let i = 0; i < 3; i++) health.recordFailure(ids[0]);
    const result = await execute(ids.slice(0, 2).map((id) => entry(id)), () => "ok", health);
    const [item] = toTimeline(result.events, []);
    expect(result.invoked).toEqual([ids[1]]);
    expect(item.title).toContain(ids[1]);
    expect(item.detail).toContain(`已跳过（未调用）：${ids[0]}`);
    expect(item.detail).toContain(`最终使用 ${ids[1]}`);
    expect(item.detail).not.toContain("先试");
    expect(item.detail).not.toContain("已降级：");
  });

  it("真实部分输出停止与默认路由提示一致，不声称整条候选链失败", async () => {
    const result = await execute(ids.map((id) => entry(id)), () => "partial");
    const [item] = toTimeline(result.events, []);
    expect(result.invoked).toEqual([ids[0]]);
    expect(item.title).toContain("部分输出后已停止自动降级");
    expect(item.title).not.toContain("降级链上的");
    expect(item.detail).toContain("已保留部分输出，为避免拼接不同模型的回答，本次停止自动降级。");
    expect(item.detail).toContain(`失败：${ids[0]}`);
    expect(item.detail).not.toContain(ids[1]);
  });

  it("真实熔断跳过后失败单列未调用候选，失败计数为一", async () => {
    const health = new HealthTracker();
    for (let i = 0; i < 3; i++) health.recordFailure(ids[0]);
    const result = await execute(ids.slice(0, 2).map((id) => entry(id)), () => "server", health);
    const [item] = toTimeline(result.events, []);
    expect(result.invoked).toEqual([ids[1]]);
    expect(item.title).toContain("本次尝试的 1 个模型均未成功");
    expect(item.detail).toContain(`失败：${ids[1]}`);
    expect(item.detail).toContain(`已跳过（未调用）：${ids[0]}`);
    expect(item.detail).not.toContain(`失败：${ids[0]}`);
  });

  it("兼容的全跳过事件明确没有调用，不出现失败记录", () => {
    const error = new RouteExhaustedError([
      { profileId: ids[0], stage: "primary", ok: false, latencyMs: 0, action: "skipped", errorCode: "unhealthy" },
      { profileId: ids[1], stage: "fallback", ok: false, latencyMs: 0, action: "skipped", errorCode: "provider_down" },
    ], null);
    const [item] = toTimeline([llmFailedEvent("answer", error)!], []);
    expect(item.title).toContain("候选模型均已跳过，本次未发起调用");
    expect(item.detail).toContain("已跳过（未调用）");
    expect(item.detail).not.toContain("失败：");
  });

  it.each([
    ["response_too_large", 1],
    ["server", 3],
  ] as const)("真实 %s 的时间线只统计实际失败数 %i", async (behavior, called) => {
    const result = await execute(ids.map((id) => entry(id)), () => behavior);
    const [item] = toTimeline(result.events, []);
    expect(result.invoked).toHaveLength(called);
    expect(item.title).toContain(`本次尝试的 ${called} 个模型均未成功`);
    expect(item.title).not.toContain("降级链上的");
    expect(item.detail).not.toContain("已跳过（未调用）");
  });

  it("真实无候选事件不虚构零个模型失败", async () => {
    const result = await execute([], () => "server");
    const [item] = toTimeline(result.events, []);
    expect(item.title).toContain("没有发起模型调用");
    expect(item.title).not.toContain("模型都没有成功");
    expect(item.detail).toBeUndefined();
  });
});
const decision = (chain: ChainEntry[]): RouteDecision => ({
  classification: { type: "qa", capabilities: [], lang: "zh", confidence: 1, signals: [], estTokens: 10 },
  primary: chain[0] ?? null, chain, weights: { capability: 0.3, quality: 0.35, cost: 0.2, latency: 0.15 }, reasons: [], excluded: [],
});
function card(events: AgentEvent[]): TaskCard {
  return {
    id: "task-route-evidence", seq: 1, sessionId: "session-route-evidence", goal: "目标正文不导出", status: "failed", collapsed: false,
    events, summary: "结果正文不导出", pendingConfirm: null, pendingPlan: null, override: null, lock: null, permission: "confirm", onboarding: false,
    files: [], multi: false, startedAt: 1, endedAt: 2, proposal: null, projectId: null, goalId: null, mode: "quick", preference: "balanced", preferenceSource: "global",
  };
}
function validate(evidence: unknown) {
  const result = spawnSync(process.execPath, [validator], { input: JSON.stringify(evidence), encoding: "utf8", timeout: 5000 });
  expect(result.stderr).toBe("");
  return { status: result.status, report: JSON.parse(result.stdout) };
}
type Behavior = "partial" | "server" | "bad_request" | "response_too_large" | "auth" | "ok";
async function execute(chain: ChainEntry[], behavior: (id: string) => Behavior, health?: HealthTracker) {
  const events: AgentEvent[] = [];
  const invoked: string[] = [];
  const providerFor = async (e: ChainEntry): Promise<LLMProvider> => ({
    id: e.provider, kind: "openai-compatible", label: "合成测试 Provider",
    capabilities: { streaming: true, systemPrompt: true, recovery: { abortSignal: true, streamTerminal: "sse_done", partialOutput: true, normalizedErrors: true } },
    chat: async () => {
      invoked.push(e.profileId);
      const kind = behavior(e.profileId);
      if (kind !== "ok" && kind !== "partial") throw new ProviderError(kind, e.provider);
      return { providerId: e.provider, model: e.profileId.slice(e.profileId.indexOf("/") + 1), text: "结果正文不导出", usage: null, finishReason: "stop" as const, latencyMs: 1 };
    },
    async *stream() {
      invoked.push(e.profileId);
      const kind = behavior(e.profileId);
      if (kind === "partial") {
        yield { type: "delta" as const, text: "部分正文不导出" };
        throw new ProviderError("network", e.provider);
      }
      if (kind !== "ok") throw new ProviderError(kind, e.provider);
      yield { type: "done" as const, response: { providerId: e.provider, model: e.profileId.slice(e.profileId.indexOf("/") + 1), text: "结果正文不导出", usage: null, finishReason: "stop" as const, latencyMs: 1 } };
    },
  });
  const call = emittingLlm(routedLlm(decision(chain), providerFor, health, { sleep: async () => {} }), (e) => events.push(e));
  let error: RouteExhaustedError | null = null;
  try { await call({ purpose: "answer", messages: [] }); }
  catch (e) { expect(e).toBeInstanceOf(RouteExhaustedError); error = e as RouteExhaustedError; }
  return { events, invoked, error, evidence: desktopEvidenceOf(card(events), 10) };
}

describe("实际路由错误和公开证据的调用边界", () => {
  it("流式正文后停止保留部分输出，不声称调用了后续候选", async () => {
    const result = await execute(ids.map((id) => entry(id)), () => "partial");
    expect(result.invoked).toEqual([ids[0]]);
    expect(result.error!.partialOutput).toBe(true);
    expect(result.error!.message).toContain("部分输出后已停止自动降级，已保留部分输出");
    expect(result.error!.message).toContain("实际尝试的 1 个模型均未成功");
    expect(result.error!.message).not.toContain("降级链已耗尽");
    expect(result.error!.message).not.toContain(ids[1]);
    expect(result.error!.toAppError().message).toBe(result.error!.message);
    expect(result.evidence.models.attempted).toEqual([ids[0]]);
    expect(result.evidence.models.providers).toEqual(["custom:first"]);
    expect(validate(result.evidence)).toMatchObject({ status: 0, report: { valid: true } });
    expect(JSON.stringify(result.evidence)).not.toContain("部分正文不导出");
  });

  it("读取上限导致的提前停止仅说明一次实际尝试", async () => {
    const result = await execute(ids.map((id) => entry(id)), () => "response_too_large");
    expect(result.invoked).toEqual([ids[0]]);
    expect(result.error!.partialOutput).toBe(false);
    expect(result.error!.message).toContain("已安全停止模型调用");
    expect(result.error!.message).toContain("实际尝试的 1 个模型均未成功");
    expect(result.error!.message).not.toContain("降级链已耗尽");
    expect(result.error!.message).not.toContain(ids[1]);
  });

  it("连续请求错误停止后不把未调用的第三个候选计为失败", async () => {
    const result = await execute(ids.map((id) => entry(id)), () => "bad_request");
    expect(result.invoked).toEqual(ids.slice(0, 2));
    expect(result.error!.message).toContain("已安全停止模型调用");
    expect(result.error!.message).toContain("实际尝试的 2 个模型均未成功");
    expect(result.error!.message).not.toContain(ids[2]);
    expect(result.evidence.models.attempted).toEqual(ids.slice(0, 2));
  });

  it("真正遍历耗尽时明确说明耗尽及全部实际失败", async () => {
    const result = await execute(ids.map((id) => entry(id)), () => "server");
    expect(result.invoked).toEqual(ids);
    expect(result.error!.message).toContain("降级链已耗尽");
    expect(result.error!.message).toContain("实际尝试的 3 个模型均未成功");
    expect(result.evidence.models.attempted).toEqual(ids);
    expect(result.evidence.models.providers).toEqual(["custom:first", "custom:second", "custom:third"]);
  });

  it("熔断候选仅跳过，不计入失败模型和实际Provider", async () => {
    const health = new HealthTracker();
    for (let i = 0; i < 3; i++) health.recordFailure(ids[0]);
    const result = await execute(ids.slice(0, 2).map((id) => entry(id)), () => "server", health);
    expect(result.invoked).toEqual([ids[1]]);
    expect(result.error!.message).toContain("实际尝试的 1 个模型均未成功");
    expect(result.error!.message).toContain("已跳过 1 个候选（未调用）");
    expect(result.evidence.models.attempted).toEqual([ids[1]]);
    expect(result.evidence.models.providers).toEqual(["custom:second"]);
    expect(result.evidence.models.fallbackCount).toBe(1);
    expect(result.evidence.models).toMatchObject({ skipped: [{ profileId: ids[0], code: "unhealthy" }] });
    expect(validate(result.evidence)).toMatchObject({ status: 0, report: { valid: true, providerCount: 1 } });
  });

  it("成功事件中的跳过fallback也不被导出为实际调用", async () => {
    const health = new HealthTracker();
    for (let i = 0; i < 3; i++) health.recordFailure(ids[0]);
    const result = await execute(ids.slice(0, 2).map((id) => entry(id)), () => "ok", health);
    expect(result.error).toBeNull();
    expect(result.invoked).toEqual([ids[1]]);
    expect(result.evidence.models.attempted).toEqual([ids[1]]);
    expect(result.evidence.models.providers).toEqual(["custom:second"]);
    expect(result.evidence.models.fallbackCount).toBe(0);
    expect(result.evidence.models).toMatchObject({ skipped: [{ profileId: ids[0], code: "unhealthy" }] });
    expect(validate(result.evidence)).toMatchObject({ status: 0, report: { valid: true } });
  });

  it("鉴权失败后跳过同一Provider其余模型，实际只调用一次", async () => {
    const sameProvider = ["custom:first/alpha", "custom:first/beta", "custom:first/gamma"];
    const result = await execute(sameProvider.map((id) => entry(id)), () => "auth");
    expect(result.invoked).toEqual([sameProvider[0]]);
    expect(result.error!.message).toContain("实际尝试的 1 个模型均未成功");
    expect(result.error!.message).toContain("已跳过 2 个候选（未调用）");
    expect(result.evidence.models.attempted).toEqual([sameProvider[0]]);
    expect(result.evidence.models.fallbackCount).toBe(1);
    expect(result.evidence.models).toMatchObject({ skipped: sameProvider.slice(1).map((profileId) => ({ profileId, code: "provider_down" })) });
    expect(validate(result.evidence)).toMatchObject({ status: 0, report: { valid: true } });
  });

  it("兼容的全跳过错误记录明确没有调用，并不导出原始跳过正文", () => {
    // The normal router attempts its final candidate. This directly validates
    // the public error/event contract for a compatibility record of only skips.
    const error = new RouteExhaustedError([
      { profileId: ids[0], stage: "primary", ok: false, latencyMs: 0, action: "skipped", errorCode: "unhealthy", reason: "跳过正文不导出" },
      { profileId: ids[1], stage: "fallback", ok: false, latencyMs: 0, action: "skipped", errorCode: "provider_down" },
    ], null);
    expect(error.message).toContain("没有发起模型调用");
    expect(error.message).toContain("已跳过 2 个候选（未调用）");
    expect(error.message).not.toContain("模型均未成功");
    const evidence = desktopEvidenceOf(card([llmFailedEvent("answer", error)!]), 10);
    expect(evidence.models.attempted).toEqual([]);
    expect(evidence.models.providers).toEqual([]);
    expect(evidence.models.fallbackCount).toBe(0);
    expect(evidence.models).toMatchObject({ skipped: [{ profileId: ids[0], code: "unhealthy" }, { profileId: ids[1], code: "provider_down" }] });
    expect(JSON.stringify(evidence)).not.toContain("跳过正文不导出");
    expect(validate(evidence)).toMatchObject({ status: 0, report: { valid: true, providerCount: 0 } });
  });

  it("没有候选时不虚构全跳过或模型失败", async () => {
    const result = await execute([], () => "server");
    expect(result.invoked).toEqual([]);
    expect(result.error!.message).toBe("没有发起模型调用，没有可尝试的候选模型");
    expect(result.evidence.models.attempted).toEqual([]);
    expect(result.evidence.models.providers).toEqual([]);
    expect(validate(result.evidence)).toMatchObject({ status: 0, report: { valid: true } });
  });

  it.each([
    [{ profileId: ids[0], code: "unknown" }],
    [{ profileId: 123, code: "unhealthy" }],
    [{ profileId: ids[0], code: "unhealthy", reason: "原始正文不应进入metadata" }],
  ].map((item) => [item]))("validator拒绝扩展跳过metadata中的未知值或原始字段 %j", (item) => {
    const evidence = desktopEvidenceOf(card([]), 10);
    const result = validate({ ...evidence, models: { ...evidence.models, skipped: item } });
    expect(result).toMatchObject({ status: 1, report: { valid: false } });
    expect(JSON.stringify(result.report)).not.toContain("原始正文不应进入metadata");
  });
});

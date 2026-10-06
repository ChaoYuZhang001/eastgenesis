// @vitest-environment node
import { ProviderError } from "@/core/llm/errors";
import { HealthTracker } from "@/decision/health";
import {
  RouteExhaustedError,
  attemptText,
  defaultAvailability,
  executeWithFallback,
  failurePolicy,
  replayRouteDecision,
  route,
  ROUTER_POLICY_VERSION,
  type Availability,
  type ChainEntry,
} from "@/decision/router";
import type { Capability, ModelProfile } from "@/decision/types";

const P = (id: string, caps: Capability[], cost: number, quality: number, latency: number, ctx = 1_000_000, enabled = true): ModelProfile => ({
  id,
  provider: id.split("/")[0],
  capabilities: caps,
  cost_tier: cost,
  quality_tier: quality,
  latency_tier: latency,
  context_window: ctx,
  enabled,
  is_custom: false,
});

// 合成的能力矩阵：与 config/model_profiles.json 解耦，调整真实数据不影响这些断言
const PROFILES = [
  P("openai/big", ["code", "long_context", "reasoning", "tool_use", "vision"], 5, 5, 4),
  P("openai/small", ["long_context", "reasoning", "tool_use", "vision"], 2, 3, 1),
  P("anthropic/mid", ["code", "long_context", "reasoning", "tool_use", "vision"], 4, 4, 3),
  P("deepseek/zh", ["code", "long_context", "reasoning", "tool_use", "zh"], 3, 5, 4),
  P("ollama/local", ["reasoning", "tool_use", "zh"], 1, 2, 3, 32768),
  P("google/off", ["code", "vision"], 1, 5, 1, 1_000_000, false),
];
const ALL_OK: Availability = () => ({ ok: true, health: 1 });
const byId = (id: string) => PROFILES.find((p) => p.id === id)!;
const run = (text: string, extra: Record<string, unknown> = {}, availability = ALL_OK) =>
  route({ text, ...extra }, { profiles: PROFILES, availability });

describe("路由评分", () => {
  it("路由追踪只保存策略版本和脱敏输入摘要", () => {
    const d = run("秘密任务", {
      preference: "economy",
      latency: "fast",
      maxCostTier: 3,
      surfaceHint: "work",
      attachments: [
        { kind: "text", name: "/Users/alice/secret.pdf", chars: 42 },
        { kind: "image", name: "token-name", chars: 0 },
      ],
    });
    expect(d.trace).toMatchObject({
      policyVersion: ROUTER_POLICY_VERSION,
      input: {
        textChars: 4,
        attachmentCount: 2,
        attachmentKinds: ["image", "text"],
        attachmentChars: 42,
        surfaceHint: "work",
        preference: "economy",
        latency: "fast",
        maxCostTier: 3,
      },
    });
    expect(d.trace?.snapshot).toMatchObject({
      profileSetId: expect.stringMatching(/^[0-9a-f]{8}$/),
      availabilitySetId: expect.stringMatching(/^[0-9a-f]{8}$/),
      profiles: expect.arrayContaining([expect.objectContaining({ id: "openai/big", provider: "openai", costTier: 5 })]),
      availability: expect.arrayContaining([expect.objectContaining({ profileId: "openai/big", ok: true, health: 1 })]),
    });
    const serialized = JSON.stringify(d.trace);
    expect(serialized).not.toContain("秘密");
    expect(serialized).not.toContain("secret.pdf");
    expect(serialized).not.toContain("Users");
  });

  it("可以用脱敏路由记录在当前健康状态下回放，不需要原始正文", () => {
    const source = run("这是不会被回放读取的正文", { preference: "economy", latency: "fast" });
    const same = replayRouteDecision(source, { profiles: PROFILES, availability: ALL_OK });
    expect(same.changed).toBe(false);
    expect(same.sourceSnapshotAvailable).toBe(true);
    expect(same.sourceSnapshotConsistent).toBe(true);
    expect(same.profileSnapshotChanged).toBe(false);
    expect(same.availabilitySnapshotChanged).toBe(false);
    expect(same.sourcePrimary).toBe(source.primary?.profileId ?? null);
    expect(same.currentChain).toEqual(source.chain.map((entry) => entry.profileId));
    const changed = replayRouteDecision(source, {
      profiles: PROFILES,
      availability: (p) => (p.id === source.primary?.profileId ? { ok: false, reason: "回放时 Provider 不可用" } : { ok: true, health: 1 }),
    });
    expect(changed.changed).toBe(true);
    expect(changed.profileSnapshotChanged).toBe(false);
    expect(changed.availabilitySnapshotChanged).toBe(true);
    expect(changed.sourceTrace.input.textChars).toBe(Array.from("这是不会被回放读取的正文").length);

    const changedProfiles = PROFILES.map((p) => (p.id === source.primary?.profileId ? { ...p, quality_tier: 1 } : p));
    const profileChanged = replayRouteDecision(source, { profiles: changedProfiles, availability: ALL_OK });
    expect(profileChanged.profileSnapshotChanged).toBe(true);
    expect(profileChanged.currentProfileSetId).not.toBe(profileChanged.sourceProfileSetId);
  });

  it("代码任务 + 最强：质量相同时选更便宜的；备选换 Provider；最后是规则兜底", () => {
    const d = run("Refactor this function to remove the recursion", { preference: "best" });
    expect(d.classification.type).toBe("code");
    expect(d.chain.map((c) => c.profileId)).toEqual(["deepseek/zh", "openai/big", "anthropic/mid", "ollama/local"]);
    expect(d.chain.map((c) => c.stage)).toEqual(["primary", "fallback", "fallback", "rule_fallback"]);
    expect(new Set(d.chain.slice(0, 3).map((c) => c.provider)).size).toBe(3);
    expect(d.excluded).toContainEqual({ profileId: "google/off", reason: "已停用" });
    expect(d.reasons.join("\n")).toMatch(/主模型 deepseek\/zh：总分/);
  });

  it("简单问答 + 省钱：选便宜档位", () => {
    const d = run("What is the capital of Australia?", { preference: "economy" });
    expect(byId(d.primary!.profileId).cost_tier).toBeLessThanOrEqual(2);
  });

  it("视觉任务排除不支持视觉的模型", () => {
    const d = run("What's in this picture?", { attachments: [{ kind: "image" }] });
    const ids = d.chain.map((c) => c.profileId);
    expect(ids).not.toContain("deepseek/zh");
    expect(ids).not.toContain("ollama/local");
    expect(d.excluded).toContainEqual({ profileId: "deepseek/zh", reason: "不支持视觉" });
  });

  it("长文本按估算 token 过滤上下文窗口", () => {
    const d = run("Summarize this", { attachments: [{ kind: "text", chars: 180_000 }] });
    expect(d.classification.capabilities).toContain("long_context");
    expect(d.excluded.find((e) => e.profileId === "ollama/local")?.reason).toMatch(/上下文窗口不足/);
  });

  it("成本上限是硬性约束", () => {
    const d = run("Write a Python function to parse CSV", { maxCostTier: 2 });
    expect(d.chain.length).toBeGreaterThan(0);
    for (const c of d.chain) expect(byId(c.profileId).cost_tier).toBeLessThanOrEqual(2);
    expect(d.excluded.some((e) => e.reason.startsWith("超出成本上限"))).toBe(true);
  });

  it("延迟偏好：要快时选快模型，不赶时间时更看重质量", () => {
    const fast = run("What is the capital of Australia?", { latency: "fast" });
    const patient = run("What is the capital of Australia?", { latency: "patient" });
    expect(byId(fast.primary!.profileId).latency_tier).toBeLessThan(byId(patient.primary!.profileId).latency_tier);
  });

  it("健康度降低会降权", () => {
    const sick: Availability = (p) => ({ ok: true, health: p.id === "openai/small" ? 0.3 : 1 });
    const d = run("What is the capital of Australia?", { preference: "economy" }, sick);
    expect(d.primary!.profileId).not.toBe("openai/small");
    expect(d.chain.find((c) => c.profileId === "openai/small")?.breakdown.availability).toBe(0.3);
  });

  it("中文代码任务：同时具备 code 与 zh 的模型能力分更高", () => {
    const d = run("帮我重构这个函数，去掉递归", { preference: "best" });
    expect(d.primary!.profileId).toBe("deepseek/zh");
    expect(d.primary!.breakdown.capability).toBe(1);
    expect(d.chain.find((c) => c.profileId === "openai/big")?.breakdown.capability).toBe(0.5);
  });

  it("exclude 排除本次已尝试的模型", () => {
    const d = run("Refactor this function", { exclude: ["deepseek/zh"] });
    expect(d.excluded).toContainEqual({ profileId: "deepseek/zh", reason: "本次已尝试" });
  });

  it("没有可用模型时给出可操作的原因", () => {
    const d = run("hi", {}, () => ({ ok: false, reason: "缺少 API Key（OPENAI_API_KEY）" }));
    expect(d.primary).toBeNull();
    expect(d.chain).toEqual([]);
    expect(d.reasons.at(-1)).toMatch(/没有可用模型/);
  });

  it("真实能力矩阵：只配置 OpenAI、Anthropic 的 Key 时，其他 Provider 因缺 Key 或未启用被排除", () => {
    const d = route(
      { text: "What's in this picture?", attachments: [{ kind: "image" }] },
      { availability: defaultAvailability({ OPENAI_API_KEY: "x", ANTHROPIC_API_KEY: "y" }) },
    );
    expect(["openai", "anthropic"]).toContain(d.primary!.provider);
    expect(d.excluded.find((e) => e.profileId === "deepseek/deepseek-v4-pro")?.reason).toBe("不支持视觉");
    expect(d.excluded.find((e) => e.profileId === "qwen/qwen3.8-max")?.reason).toBe("缺少 API Key（DASHSCOPE_API_KEY）");
    expect(d.excluded.find((e) => e.profileId === "ollama/qwen3-vl:8b")?.reason).toMatch(/Ollama 未启用/);
    expect(route({ text: "hi" }, { availability: defaultAvailability({}) }).primary).toBeNull();
  });

  it("适配器集合仍可收窄：不在集合里的 Provider 按「适配器未实现」排除", () => {
    const d = route({ text: "hi" }, { availability: defaultAvailability({ OPENAI_API_KEY: "x", DEEPSEEK_API_KEY: "y" }, undefined, new Set(["openai"])) });
    expect(d.primary!.provider).toBe("openai");
    expect(d.excluded.find((e) => e.profileId === "deepseek/deepseek-flash")?.reason).toBe("适配器未实现");
  });
});

describe("手动锁定模型", () => {
  it("跳过评分和降级：链上只有锁定的模型，成本上限不适用", () => {
    const d = run("What is the capital of Australia?", { preference: "economy", maxCostTier: 2, lock: "openai/big" });
    expect(d.chain.map((c) => [c.profileId, c.stage, c.reason])).toEqual([["openai/big", "primary", "手动锁定"]]);
    expect(d.primary?.profileId).toBe("openai/big");
    expect(d.trace?.input.lock).toBe("openai/big");
    expect(d.reasons).toContain("手动锁定：openai/big，跳过路由决策");
    expect(d.reasons.join("\n")).not.toMatch(/总分|权重/);
  });

  it("锁定的模型不存在、已停用或不可用时如实报错，不悄悄换模型", () => {
    const missing = run("hi", { lock: "openai/nope" });
    expect(missing.primary).toBeNull();
    expect(missing.reasons.at(-1)).toMatch(/^锁定的模型不存在：openai\/nope/);
    expect(run("hi", { lock: "google/off" }).reasons.at(-1)).toMatch(/^锁定的模型已停用/);
    const down = run("hi", { lock: "anthropic/mid" }, (p) => (p.provider === "anthropic" ? { ok: false, reason: "缺少 API Key（在设置页配置）" } : { ok: true, health: 1 }));
    expect(down.chain).toEqual([]);
    expect(down.reasons.at(-1)).toBe("锁定的模型不可用：缺少 API Key（在设置页配置）（改回「自动路由」可以自动换模型）");
  });

  it("能力不匹配只提示不拦截：用户明确选了它", () => {
    const d = run("What's in this picture?", { attachments: [{ kind: "image" }], lock: "deepseek/zh" });
    expect(d.primary?.profileId).toBe("deepseek/zh");
    expect(d.reasons.at(-1)).toMatch(/没有标注视觉，按你的选择照常使用/);
  });
});

const E = (id: string): ChainEntry => ({
  profileId: id,
  provider: id.split("/")[0],
  stage: "fallback",
  score: 0,
  breakdown: { capability: 0, quality: 0, cost: 0, latency: 0, availability: 1, total: 0 },
  reason: "",
});
const fail = (code: ConstructorParameters<typeof ProviderError>[0]) => new ProviderError(code, "x");
const NO_WAIT = async () => {};

describe("执行降级链", () => {
  it("失败策略矩阵：每种错误只对应一种可解释的恢复动作", () => {
    expect(failurePolicy("timeout")).toEqual({ disposition: "retry", recordsHealthFailure: false, userAborted: false });
    expect(failurePolicy("timeout", { retried: true })).toEqual({ disposition: "next", recordsHealthFailure: true, userAborted: false });
    expect(failurePolicy("auth")).toEqual({ disposition: "skip_provider", recordsHealthFailure: false, userAborted: false });
    expect(failurePolicy("billing")).toEqual({ disposition: "skip_provider", recordsHealthFailure: false, userAborted: false });
    expect(failurePolicy("config")).toEqual({ disposition: "skip_provider", recordsHealthFailure: false, userAborted: false });
    expect(failurePolicy("bad_request", { badRequests: 1 })).toEqual({ disposition: "stop", recordsHealthFailure: false, userAborted: false });
    expect(failurePolicy("bad_request", { badRequests: 0 })).toEqual({ disposition: "next", recordsHealthFailure: true, userAborted: false });
    expect(failurePolicy("rate_limit")).toEqual({ disposition: "next", recordsHealthFailure: true, userAborted: false });
    expect(failurePolicy("network")).toEqual({ disposition: "next", recordsHealthFailure: true, userAborted: false });
    expect(failurePolicy("server")).toEqual({ disposition: "next", recordsHealthFailure: true, userAborted: false });
    expect(failurePolicy("unknown")).toEqual({ disposition: "next", recordsHealthFailure: true, userAborted: false });
    expect(failurePolicy("aborted")).toEqual({ disposition: "stop", recordsHealthFailure: false, userAborted: true });
  });

  it("限流换下一个，并记入健康度", async () => {
    const health = new HealthTracker();
    const r = await executeWithFallback([E("a/1"), E("b/1")], async (e) => {
      if (e.profileId === "a/1") throw fail("rate_limit");
      return "ok";
    }, { health });
    expect(r.result).toBe("ok");
    expect(r.entry.profileId).toBe("b/1");
    expect(r.attempts.map((a) => a.action)).toEqual(["next", "done"]);
    expect(health.status("a/1", "a")).toMatchObject({ ok: true });
    expect((health.status("a/1", "a") as { health: number }).health).toBeLessThan(1);
  });

  it("鉴权失败：整个 Provider 下线，跳过它的其他模型", async () => {
    const health = new HealthTracker();
    const r = await executeWithFallback([E("a/1"), E("a/2"), E("b/1")], async (e) => {
      if (e.provider === "a") throw fail("auth");
      return e.profileId;
    }, { health });
    expect(r.result).toBe("b/1");
    expect(r.attempts.map((a) => a.action)).toEqual(["skip_provider", "skipped", "done"]);
    expect(health.status("a/2", "a")).toEqual({ ok: false, reason: "Provider 已停用：鉴权失败" });
  });

  it("用户取消立即停止", async () => {
    const calls: string[] = [];
    await expect(
      executeWithFallback([E("a/1"), E("b/1")], async (e) => {
        calls.push(e.profileId);
        throw fail("aborted");
      }),
    ).rejects.toMatchObject({ code: "aborted" });
    expect(calls).toEqual(["a/1"]);
  });

  it("连续两个模型报请求错误时停止", async () => {
    const e = await executeWithFallback([E("a/1"), E("b/1"), E("c/1")], async () => {
      throw fail("bad_request");
    }).catch((x) => x);
    expect(e).toBeInstanceOf(RouteExhaustedError);
    expect(e.attempts).toHaveLength(2);
  });

  it("全部失败时抛出 RouteExhaustedError，带每一步的记录", async () => {
    const e: RouteExhaustedError = await executeWithFallback([E("a/1"), E("b/1")], async () => {
      throw fail("server");
    }).catch((x) => x);
    expect(e.attempts.map((a) => a.errorCode)).toEqual(["server", "server"]);
    expect(e.toAppError()).toMatchObject({ code: "route_exhausted", detail: "a/1:server, b/1:server" });
    // 用户看到的文字逐个写明模型和原因，错误码换成中文说明
    expect(e.message).toBe("降级链上的 2 个模型都没有成功：a/1（服务端错误）、b/1（服务端错误）");
  });

  it("同一任务里已熔断的模型直接跳过，不再等它失败；链上最后一个照试", async () => {
    const health = new HealthTracker();
    for (let i = 0; i < 3; i++) health.recordFailure("a/1");
    const calls: string[] = [];
    const r = await executeWithFallback([E("a/1"), E("b/1")], async (e) => (calls.push(e.profileId), e.profileId), { health });
    expect(calls).toEqual(["b/1"]);
    expect(r.attempts[0]).toMatchObject({ action: "skipped", errorCode: "unhealthy" });
    expect(attemptText(r.attempts[0])).toMatch(/^连续失败 3 次，熔断中/);
    // 只剩它一个时仍然尝试，失败原因如实报出（超时先重试一次，文字里写明）
    for (let i = 0; i < 3; i++) health.recordFailure("b/1");
    const e: RouteExhaustedError = await executeWithFallback([E("a/1"), E("b/1")], async () => { throw fail("timeout"); }, { health, sleep: NO_WAIT }).catch((x) => x);
    expect(e.message).toMatch(/^降级链上的 2 个模型都没有成功：a\/1（连续失败 3 次，熔断中.*）、b\/1（请求超时（已重试 1 次））$/);
  });

  it("超时：等 2 秒对同一个模型重试一次，成功就不换模型，健康度不记失败", async () => {
    const health = new HealthTracker();
    const waits: number[] = [];
    let n = 0;
    const r = await executeWithFallback([E("a/1"), E("b/1")], async (e) => {
      if (e.profileId === "a/1" && n++ === 0) throw fail("timeout");
      return e.profileId;
    }, { health, sleep: async (ms) => void waits.push(ms) });
    expect(r.result).toBe("a/1");
    expect(waits).toEqual([2000]);
    expect(r.attempts.map((a) => a.action)).toEqual(["retry", "done"]);
    expect(r.attempts[1].retried).toBe(true);
    expect(attemptText(r.attempts[0])).toBe("请求超时，2 秒后重试");
    expect(health.status("a/1", "a")).toEqual({ ok: true, health: 1 });
  });

  it("超时重试后仍失败：记一次失败，换下一个；每一步写明原因，状态码一并记录", async () => {
    const health = new HealthTracker();
    const calls: string[] = [];
    const r = await executeWithFallback([E("a/1"), E("b/1"), E("c/1")], async (e) => {
      calls.push(e.profileId);
      if (e.profileId === "a/1") throw fail("timeout");
      if (e.profileId === "b/1") throw new ProviderError("server", "b", { status: 502 });
      return e.profileId;
    }, { health, sleep: NO_WAIT });
    expect(calls).toEqual(["a/1", "a/1", "b/1", "c/1"]);
    expect(r.attempts.map((a) => [a.profileId, a.action])).toEqual([["a/1", "retry"], ["a/1", "next"], ["b/1", "next"], ["c/1", "done"]]);
    expect(r.attempts.map(attemptText)).toEqual(["请求超时，2 秒后重试", "请求超时（已重试 1 次）", "服务端错误", "done"]);
    expect(r.attempts[2].status).toBe(502);
    expect((health.status("a/1", "a") as { health: number }).health).toBeLessThan(1);
    // 只重试超时：限流、服务端错误不重试
    const e: RouteExhaustedError = await executeWithFallback([E("x/1")], async () => { throw fail("rate_limit"); }, { sleep: NO_WAIT }).catch((x) => x);
    expect(e.attempts.map((a) => a.action)).toEqual(["next"]);
  });

  it("重试前的等待可以被用户取消", async () => {
    const ctrl = new AbortController();
    const p = executeWithFallback([E("a/1"), E("b/1")], async () => {
      setTimeout(() => ctrl.abort(), 5);
      throw fail("timeout");
    }, { signal: ctrl.signal });
    await expect(p).rejects.toMatchObject({ code: "aborted" });
  });

  it("失败原因的中文说明：Provider 错误码、同 Provider 跳过、未知错误", () => {
    const A = (errorCode?: string) => ({ profileId: "a/1", stage: "primary" as const, ok: false, latencyMs: 0, action: "next" as const, errorCode });
    expect(attemptText(A("auth"))).toBe("鉴权失败，请检查 API Key");
    expect(attemptText(A("provider_down"))).toBe("同一 Provider 刚才鉴权或配置失败，已跳过");
    expect(attemptText(A("unknown"))).toBe("未知错误");
    expect(attemptText(A("constructor"))).toBe("未知错误");
  });
});

describe("健康度与熔断", () => {
  it("窗口内连续失败 3 次熔断，冷却后半开，成功后恢复", () => {
    let t = 0;
    const h = new HealthTracker({ now: () => t });
    for (let i = 0; i < 3; i++) {
      t += 1000;
      h.recordFailure("m");
    }
    expect(h.status("m", "p")).toMatchObject({ ok: false, reason: expect.stringMatching(/熔断中/) });
    t += 61_000;
    expect(h.status("m", "p")).toEqual({ ok: true, health: 0.5 });
    h.recordFailure("m");
    expect(h.status("m", "p").ok).toBe(false);
    t += 61_000;
    h.recordSuccess("m");
    expect(h.status("m", "p")).toEqual({ ok: true, health: 1 });
  });

  it("失败间隔超过窗口不累计", () => {
    let t = 0;
    const h = new HealthTracker({ now: () => t });
    for (let i = 0; i < 5; i++) {
      t += 70_000;
      h.recordFailure("m");
    }
    expect(h.status("m", "p").ok).toBe(true);
  });

  it("resetProvider 只清这个 Provider 的停用和熔断记录", () => {
    const h = new HealthTracker();
    h.markProviderDown("a", "鉴权失败");
    h.markProviderDown("b", "鉴权失败");
    for (const id of ["a/1", "ab/1", "local-jev"]) for (let i = 0; i < 3; i++) h.recordFailure(id);
    h.resetProvider("a");
    expect(h.status("a/1", "a")).toEqual({ ok: true, health: 1 });
    expect(h.status("b/1", "b").ok).toBe(false);
    // 名字只是前缀相同的 Provider 不受影响
    expect(h.status("ab/1", "ab").ok).toBe(false);
    h.resetProvider("local-jev");
    expect(h.status("local-jev", "local-jev")).toEqual({ ok: true, health: 1 });
  });
});

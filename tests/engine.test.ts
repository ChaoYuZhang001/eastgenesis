import { DEFAULT_REQUEST_TIMEOUT_S, createEngine, effectiveProfiles, parseProviderPrefs, parseTimeout, providerFactory, statusAvailability, withLockedModel, type ModelOverride } from "@/lib/engine";
import { HealthTracker } from "@/decision";
import { createMockBackend, DEMO_TOOLS, type KeyStatus } from "@/platform";
import type { AgentEvent } from "@/agent";

const relay = { id: "custom:relay", label: "中转站", base_url: "https://relay.example.com/v1", default_model: "gpt-x", headers: {} };

async function setup(opts: Parameters<typeof createMockBackend>[0] = {}) {
  const backend = createMockBackend(opts);
  return { backend, statuses: await backend.providerStatus(), jev: await backend.jevStatus() };
}

describe("引擎组装", () => {
  it("能力矩阵叠加用户调整和自定义 Provider", () => {
    const ps = effectiveProfiles({ "openai/gpt-5.6-luna": { enabled: false, quality_tier: 5 } }, [relay]);
    const luna = ps.find((p) => p.id === "openai/gpt-5.6-luna")!;
    expect(luna).toMatchObject({ enabled: false, quality_tier: 5, provider: "openai" });
    expect(ps.find((p) => p.id === "custom:relay/gpt-x")).toMatchObject({ provider: "custom:relay", is_custom: true, capabilities: [] });
  });

  it("可用性只依据 Key 状态、适配器和本机服务开关", () => {
    const st: KeyStatus[] = [
      { id: "openai", configured: true, source: "keychain", needs_key: true },
      { id: "anthropic", configured: false, source: "none", needs_key: true },
      { id: "deepseek", configured: true, source: "env", needs_key: true },
      { id: "ollama", configured: true, source: "none", needs_key: false },
    ];
    const ps = effectiveProfiles({}, [relay]);
    const avail = statusAvailability(st, [relay], new HealthTracker());
    const of = (provider: string, a = avail) => a(ps.find((p) => p.provider === provider)!);
    expect(of("openai")).toEqual({ ok: true, health: 1 });
    expect(of("anthropic")).toMatchObject({ ok: false, reason: expect.stringContaining("缺少 API Key") });
    expect(of("deepseek")).toEqual({ ok: true, health: 1 });
    expect(of("qwen")).toMatchObject({ ok: false, reason: expect.stringContaining("缺少 API Key") });
    expect(of("custom:relay")).toMatchObject({ ok: false });
    // Ollama 默认不参与路由，用户启用后才可用
    expect(of("ollama")).toMatchObject({ ok: false, reason: expect.stringContaining("Ollama 未启用") });
    const on = statusAvailability(st, [relay], new HealthTracker(), { regions: {}, ollama: true, localJev: null });
    expect(of("ollama", on)).toEqual({ ok: true, health: 1 });
    const narrow = statusAvailability(st, [relay], new HealthTracker(), undefined, new Set(["openai"]));
    expect(of("deepseek", narrow)).toMatchObject({ ok: false, reason: "适配器未实现" });
  });

  it("自定义 Provider 的未知协议 fail-closed，不进入自动路由也不静默当成 OpenAI", async () => {
    const future = { ...relay, id: "custom:future", protocol: "future" as never };
    const profile = effectiveProfiles({}, [future]).find((p) => p.provider === future.id)!;
    const statuses: KeyStatus[] = [{ id: future.id, configured: true, source: "keychain", needs_key: true }];
    const available = statusAvailability(statuses, [future], new HealthTracker());
    expect(available(profile)).toEqual({ ok: false, reason: "自定义 Provider 协议未声明可恢复契约" });
    await expect(providerFactory(createMockBackend(), [future])({ provider: future.id })).rejects.toMatchObject({ code: "config" });
  });

  it("地域偏好：providerFactory 按地域拼 base URL，未知地域回到默认", async () => {
    const seen: string[] = [];
    const b = createMockBackend({ configured: ["qwen", "kimi"] });
    const spy = { ...b, providerRequest: (r: Parameters<typeof b.providerRequest>[0]) => (seen.push(r.url), b.providerRequest(r)) };
    const make = providerFactory(spy, [], { qwen: "intl", kimi: "nowhere" });
    const msg = { model: "m", messages: [{ role: "user" as const, content: "hi" }] };
    await (await make({ provider: "qwen" })).chat(msg);
    await (await make({ provider: "kimi" })).chat(msg);
    expect(seen).toEqual(["https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions", "https://api.moonshot.cn/v1/chat/completions"]);
  });

  it("解析 Provider 偏好：丢弃未知 Provider、未知地域和单地域的 Provider", () => {
    expect(parseProviderPrefs(JSON.stringify({ regions: { qwen: "intl", kimi: "mars", openai: "default", x: "cn" }, ollama: true }))).toEqual({
      regions: { qwen: "intl" },
      ollama: true,
      localJev: null,
    });
    expect(parseProviderPrefs("{bad")).toEqual({ regions: {}, ollama: false, localJev: null });
    expect(parseProviderPrefs(null)).toEqual({ regions: {}, ollama: false, localJev: null });
    // 本地决策模型只接受本机服务的 profile id 格式
    const lj = (v: unknown) => parseProviderPrefs(JSON.stringify({ localJev: v })).localJev;
    expect(lj("ollama/qwen3:8b")).toBe("ollama/qwen3:8b");
    expect(lj("custom:lan/llama-3.1-8b")).toBe("custom:lan/llama-3.1-8b");
    expect(lj("openai/gpt-5.6-luna")).toBeNull();
    expect(lj("ollama/has space")).toBeNull();
    expect(lj("ollama/")).toBeNull();
    expect(lj(42)).toBeNull();
  });
});

describe("浏览器模式端到端（mock 后端）", () => {
  it("提交任务：路由 → 规划 → 工具 → 反思 → 总结，事件完整", async () => {
    const s = await setup();
    const events: AgentEvent[] = [];
    const { runtime } = createEngine({ ...s, tools: DEMO_TOOLS, onEvent: (e) => events.push(e) });
    const r = await runtime.run("调研国产大模型的现状", { route: { preference: "economy" } });
    expect(r.status).toBe("completed");
    expect(r.summary).toContain("（模拟）");
    const types = new Set(events.map((e) => e.type));
    for (const t of ["route", "plan", "step_start", "gate", "tool_result", "reflect", "llm", "run_end"]) expect(types.has(t as AgentEvent["type"])).toBe(true);
    const route = events.find((e) => e.type === "route");
    expect(route?.type === "route" && route.decision.chain.length).toBeGreaterThan(0);
    expect(route?.type === "route" && route.meta.backend).toBe("rules");
  });

  it("需要确认的操作走确认回调；拒绝后任务停止", async () => {
    const s = await setup();
    const asked: string[] = [];
    // 只读检索也可能因为目标文字含「保存」被规则收紧为需要确认；这里批准检索、拒绝写入
    const { runtime } = createEngine({ ...s, tools: DEMO_TOOLS, confirm: async (req) => (asked.push(req.tool), req.tool !== "demo_write_file") });
    const r = await runtime.run("整理周报并保存");
    expect(asked.at(-1)).toBe("demo_write_file");
    expect(r.status).toBe("aborted");
  });

  it("手动干预：lock 固定模型，next 只影响下一次调用", async () => {
    const s = await setup();
    let o: ModelOverride | null = { mode: "next", profileId: "anthropic/claude-sonnet-5-5" };
    const used: string[] = [];
    const { runtime } = createEngine({
      ...s,
      override: () => o,
      consumeNext: () => (o = null),
      onEvent: (e) => e.type === "llm" && used.push(e.profileId),
    });
    await runtime.run("写一段问候语");
    expect(used[0]).toBe("anthropic/claude-sonnet-5-5");
    expect(new Set(used.slice(1)).has("anthropic/claude-sonnet-5-5")).toBe(false);

    used.length = 0;
    o = { mode: "lock", profileId: "openai/gpt-5.6-luna" };
    await runtime.run("写一段问候语");
    expect(new Set(used)).toEqual(new Set(["openai/gpt-5.6-luna"]));
  });

  it("输入框锁定模型：整次任务只用它，路由记录写明跳过了路由决策", async () => {
    const s = await setup();
    const events: AgentEvent[] = [];
    const { runtime } = createEngine({ ...s, onEvent: (e) => events.push(e) });
    const r = await runtime.run("写一段问候语", { route: { lock: "anthropic/claude-sonnet-5-5" } });
    expect(r.status).toBe("completed");
    const route = events.find((e) => e.type === "route");
    expect(route?.type === "route" && route.decision.chain.map((c) => c.profileId)).toEqual(["anthropic/claude-sonnet-5-5"]);
    expect(route?.type === "route" && route.decision.reasons).toContain("手动锁定：anthropic/claude-sonnet-5-5，跳过路由决策");
    const used = new Set(events.flatMap((e) => (e.type === "llm" ? [e.profileId] : [])));
    expect(used).toEqual(new Set(["anthropic/claude-sonnet-5-5"]));
  });

  it("锁定 /models 发现但没登记的中转站模型：只给这一次任务补进模型列表", () => {
    expect(withLockedModel([relay], "custom:relay/deepseek-v4-pro")[0].models).toEqual(["deepseek-v4-pro"]);
    expect(withLockedModel([relay], "custom:relay/gpt-x")).toEqual([relay]);
    expect(withLockedModel([relay], "openai/gpt-5.6-luna")).toEqual([relay]);
    expect(withLockedModel([relay], "custom:relay/has space")).toEqual([relay]);
    expect(withLockedModel([relay], null)).toEqual([relay]);
    expect(relay).not.toHaveProperty("models");
  });

  it("权限开关：只读拒绝写入并说明原因；完全访问下普通写入不再询问", async () => {
    const s = await setup();
    const ro = createEngine({ ...s, tools: DEMO_TOOLS, permission: "readonly", confirm: async () => true });
    const r = await ro.runtime.run("整理周报并保存");
    expect(r.status).toBe("needs_user");
    expect(r.summary).toMatch(/只读模式/);
    const asked: string[] = [];
    const full = createEngine({ ...s, tools: DEMO_TOOLS, permission: "full", confirm: async (q) => (asked.push(q.tool), true) });
    expect((await full.runtime.run("整理周报并保存")).status).toBe("completed");
    expect(asked).not.toContain("demo_write_file");
  });

  it("超时设置传给适配器：请求超过设定时间按超时处理", async () => {
    const b = createMockBackend();
    const hang = { ...b, providerRequest: () => new Promise<never>(() => {}) };
    const make = providerFactory(hang, [], {}, 30);
    await expect((await make({ provider: "openai" })).chat({ model: "m", messages: [{ role: "user", content: "hi" }] })).rejects.toMatchObject({ code: "timeout" });
    // 默认 90 秒；用户选过的值照用，非法值回到默认
    expect(DEFAULT_REQUEST_TIMEOUT_S).toBe(90);
    expect(parseTimeout("60")).toBe(60);
    expect(parseTimeout("150")).toBe(150);
    expect(parseTimeout("7")).toBe(90);
    expect(parseTimeout("{bad")).toBe(90);
    expect(parseTimeout(null)).toBe(90);
  });

  it("模型全部不可用时如实失败，不崩溃", async () => {
    const s = await setup({ failRequests: true });
    const { runtime } = createEngine(s);
    const r = await runtime.run("写一段问候语");
    expect(r.status).toBe("failed");
  });

  it("Jev 已配置但不可达时降级到规则引擎，并在 meta 中说明", async () => {
    const s = await setup({ jevConfigured: true });
    const events: AgentEvent[] = [];
    const { runtime } = createEngine({ ...s, onEvent: (e) => events.push(e) });
    await runtime.run("写一段问候语");
    const route = events.find((e) => e.type === "route");
    expect(route?.type === "route" && route.meta).toMatchObject({ backend: "rules", degraded: true });
  }, 20_000);
});

// @vitest-environment node
// 本地决策模型接入三级降级链与桌面端组装：生效、把握不够时降级、熔断、权限闸门只收紧、候选只限本机服务。
// 模型全部是假的或走 mock 后端，不调用任何真实服务。
import type { AgentEvent } from "@/agent";
import type { LLMProvider } from "@/core/llm";
import { ProviderError } from "@/core/llm/errors";
import { DecisionLayer, type LocalDecisionModel, type ToolDef } from "@/decision";
import { createEngine, effectiveProfiles } from "@/lib/engine";
import { localJevBackend, localJevCandidates } from "@/lib/local-decision";
import { createMockBackend, DEMO_TOOLS, type CustomProvider } from "@/platform";
import { mockDecision } from "@/platform/mock-decision";

const TOOLS: ToolDef[] = [
  { name: "read_file", description: "读取本地文件内容", sideEffect: "none" },
  { name: "write_file", description: "写入本地文件", sideEffect: "local_write" },
];
const ENV = { OPENAI_API_KEY: "x" };
const local = (reply: (user: string) => string | Promise<string>): LocalDecisionModel & { calls: string[] } => {
  const calls: string[] = [];
  return { id: "ollama/qwen3:8b", calls, ask: async (_s, user) => (calls.push(user), reply(user)) };
};
const layer = (m: LocalDecisionModel) => DecisionLayer.fromEnv(ENV, { tools: TOOLS, local: m });

describe("本地决策模型 · 三级降级", () => {
  it("没有 Jev Key 时由第 2 级判断；把握不够时交给规则引擎，并注明原因", async () => {
    const m = local(mockDecision);
    const d = layer(m);
    const done = await d.checkDone("写问候语", "你好，欢迎使用。");
    expect(done.value).toBe(true);
    expect(done.meta).toMatchObject({ backend: "local-jev", level: 2, degraded: true, confidence: 0.8 });
    expect(done.meta.skipped).toEqual([{ backend: "cloud-jev", reason: expect.stringMatching(/TYPESAFE_API_KEY/) }]);

    // 模拟模型对分类没把握（各项 0.5）：置信度 0，交给规则
    const { decision, meta } = await d.routeTask({ text: "写一首关于秋天的诗" });
    expect(meta.backend).toBe("rules");
    expect(meta.skipped[1]).toEqual({ backend: "local-jev", reason: "置信度 0.00 低于阈值 0.6" });
    expect(decision.reasons[0]).toMatch(/^决策来源：rules（第 3 级，已降级/);
    expect(m.calls).toHaveLength(2);
  });

  it("本机服务连不上：连续失败 3 次后熔断，之后直接交给规则，不再等待", async () => {
    const m = local(() => Promise.reject(new ProviderError("network", "ollama")));
    const d = layer(m);
    for (let i = 0; i < 3; i++) {
      const r = await d.checkDone("g", "r");
      expect(r.meta.backend).toBe("rules");
      expect(r.meta.skipped[1]).toEqual({ backend: "local-jev", reason: "调用失败（network）" });
    }
    const r = await d.checkDone("g", "r");
    expect(r.meta.skipped[1].reason).toMatch(/^连续失败 3 次，熔断中/);
    expect(m.calls).toHaveLength(3);
  });

  it("权限闸门：只有只读操作才问本地模型，而且只能收紧", async () => {
    const risky = local(() => '{"level":2,"confidence":0.9}');
    const g = await layer(risky).gateAction({ tool: "read_file", summary: "读取 notes.txt", args: { path: "notes.txt" } });
    expect(g.value).toMatchObject({ verdict: "confirm", risk: "high" });
    expect(g.value.reasons).toContain("决策层评估风险为 high，改为需要确认");
    expect(g.meta).toMatchObject({ backend: "local-jev", level: 2 });
    expect(risky.calls[0]).toContain('<data name="action" untrusted="true">');

    // 本地模型说「无害」也改变不了规则：写文件照样要确认，不在白名单的工具照样拒绝
    const lax = local(() => '{"level":0,"confidence":0.9}');
    const w = await layer(lax).gateAction({ tool: "write_file", summary: "写入 notes.txt" });
    expect(w.value).toMatchObject({ verdict: "confirm", risk: "medium" });
    expect(w.meta.backend).toBe("rules");
    expect((await layer(lax).gateAction({ tool: "run_command", summary: "ls" })).value.verdict).toBe("deny");
    expect(lax.calls).toHaveLength(0);
  });
});

describe("本地决策模型 · 桌面端组装", () => {
  const custom: CustomProvider[] = [
    { id: "custom:lan", label: "本机推理", base_url: "http://127.0.0.1:8000/v1", default_model: "llama-3.1-8b", headers: {} },
    { id: "custom:relay", label: "中转站", base_url: "https://relay.example.com/v1", default_model: "gpt-x", headers: {} },
  ];
  const profiles = effectiveProfiles({}, custom);
  const never = async (): Promise<LLMProvider> => {
    throw new Error("不应请求模型");
  };

  it("候选只限本机服务：Ollama 和地址在本机的自定义 Provider", () => {
    const ids = localJevCandidates(profiles, custom).map((p) => p.id);
    expect(ids).toContain("ollama/qwen3:8b");
    expect(ids).toContain("custom:lan/llama-3.1-8b");
    expect(ids.some((id) => id.startsWith("custom:relay/") || id.startsWith("openai/"))).toBe(false);
  });

  it("没有选择、已不可用或不是本机服务时跳过并说明原因；选中后经共用的适配器请求", async () => {
    expect(localJevBackend(null, profiles, custom, never).unavailableReason()).toBe("没有选择本地决策模型（在设置页选择）");
    expect(localJevBackend("ollama/gone:1b", profiles, custom, never).unavailableReason()).toBe("本地决策模型 ollama/gone:1b 不可用（在设置页重新选择）");
    expect(localJevBackend("custom:relay/gpt-x", profiles, custom, never).unavailableReason()).toMatch(/不可用/);

    const seen: { provider: string; model: string; temperature?: number; maxTokens?: number; signal?: AbortSignal }[] = [];
    const providerFor = async (e: { provider: string }) =>
      ({
        chat: async (req) => (seen.push({ provider: e.provider, ...req }), { text: '{"p":0.1}' }),
      }) as LLMProvider;
    const b = localJevBackend("custom:lan/llama-3.1-8b", profiles, custom, providerFor);
    expect(b.unavailableReason()).toBeNull();
    expect(await b.checkDone("g", "r")).toEqual({ value: false, confidence: 0.8 });
    expect(seen[0]).toMatchObject({ provider: "custom:lan", model: "llama-3.1-8b", temperature: 0, maxTokens: 300 });
    expect(seen[0].signal).toBeInstanceOf(AbortSignal);
  });

  it("浏览器模式端到端：选了 Ollama 模型后，反思由本地模型判断，路由把握不够时交给规则", async () => {
    const backend = createMockBackend();
    const events: AgentEvent[] = [];
    const { runtime } = createEngine({
      backend,
      statuses: await backend.providerStatus(),
      jev: await backend.jevStatus(),
      tools: DEMO_TOOLS,
      providerPrefs: { regions: {}, ollama: false, localJev: "ollama/qwen3:8b" },
      onEvent: (e) => events.push(e),
    });
    const r = await runtime.run("调研国产大模型的现状");
    expect(r.status).toBe("completed");
    const route = events.find((e) => e.type === "route");
    expect(route?.type === "route" && route.meta.backend).toBe("rules");
    expect(route?.type === "route" && route.meta.skipped.map((s) => s.reason)).toContain("置信度 0.00 低于阈值 0.6");
    const reflects = events.filter((e) => e.type === "reflect");
    expect(reflects.length).toBeGreaterThan(0);
    for (const e of reflects) expect(e.type === "reflect" && e.backend).toBe("local-jev");
    // 本地决策模型只做判断，不参与路由：Ollama 没启用，任务仍由云端模型执行
    for (const e of events) if (e.type === "llm") expect(e.profileId.startsWith("ollama/")).toBe(false);
  });
});

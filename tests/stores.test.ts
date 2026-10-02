import { createMockBackend, setBackend, type CustomProvider } from "@/platform";
import { health } from "@/stores/health";
import { DEFAULT_ROUTING, parseRouting, useSettings } from "@/stores/settings";
import { useTasks } from "@/stores/tasks";
import { lastRoute, toTimeline, usageTotals } from "@/lib/timeline";
import { effectiveProfiles } from "@/lib/engine";

const KEY = "sk-test-0123456789abcdef";

beforeEach(async () => {
  setBackend(createMockBackend());
  useSettings.setState({ loaded: false, statuses: [], jev: null, custom: [], routing: DEFAULT_ROUTING, overrides: {}, error: null });
  useTasks.setState({ tasks: [], activeId: null });
  await useSettings.getState().load();
});

const task = (id: string) => useTasks.getState().tasks.find((t) => t.id === id)!;

describe("设置 store", () => {
  it("加载 Key 状态；配置、删除后刷新；store 里没有 Key", async () => {
    const s = useSettings.getState();
    expect(s.statuses.find((x) => x.id === "openai")?.configured).toBe(true);
    expect(await s.setKey("google", KEY)).toBeNull();
    expect(useSettings.getState().statuses.find((x) => x.id === "google")?.configured).toBe(true);
    expect((await s.setKey("google", "bad"))?.code).toBe("invalid_key");
    expect(JSON.stringify(useSettings.getState())).not.toContain(KEY);
  });

  it("测试连接：7 家官方 Provider 都走代理，报告实测耗时和模型列表，未配置 Key 时如实提示", async () => {
    const s = useSettings.getState();
    // 成功时带上实测耗时和服务返回的模型列表
    expect(await s.testConnection("openai")).toMatchObject({ ok: true, message: "连接正常（HTTP 200），可用模型 2 个", models: ["mock-model", "gpt-5.6-luna"] });
    expect((await s.testConnection("openai")).latencyMs).toBeTypeOf("number");
    expect((await s.testConnection("anthropic")).ok).toBe(true);
    expect(await s.testConnection("google")).toMatchObject({ ok: false, message: "这个 Provider 还没有配置 API Key" });
    expect((await s.testConnection("ollama")).ok).toBe(true);
    expect(await s.testConnection("mistral")).toEqual({ ok: false, message: "未知的 Provider" });
  });

  it("测试连接返回 404 时说明可能的原因，不当成 Key 错误", async () => {
    setBackend({ ...createMockBackend(), providerRequest: async () => ({ status: 404, body: "" }) });
    const r = await useSettings.getState().testConnection("qwen");
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/HTTP 404.*模型列表/);
    expect(r.message).not.toContain("请检查 Key");
  });

  it("地域和 Ollama 开关会持久化；测试连接按所选地域发请求", async () => {
    const b = createMockBackend({ configured: ["qwen"] });
    const seen: string[] = [];
    setBackend({ ...b, providerRequest: (r) => (seen.push(r.url), b.providerRequest(r)) });
    useSettings.getState().setRegion("qwen", "intl");
    // 未知地域、单地域或未知的 Provider 都被忽略，保留原来的选择
    useSettings.getState().setRegion("qwen", "mars");
    useSettings.getState().setRegion("openai", "intl");
    useSettings.getState().setRegion("constructor", "intl");
    useSettings.getState().setOllamaEnabled(true);
    useSettings.getState().setLocalJev("ollama/qwen3:8b");
    await useSettings.getState().testConnection("qwen");
    expect(seen).toEqual(["https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models"]);
    await new Promise((r) => setTimeout(r, 0));
    useSettings.setState({ providerPrefs: { regions: {}, ollama: false, localJev: null } });
    await useSettings.getState().load();
    expect(useSettings.getState().providerPrefs).toEqual({ regions: { qwen: "intl" }, ollama: true, localJev: "ollama/qwen3:8b" });
  });

  it("改了 Key、地域、自定义 Provider 或本地决策模型后，清掉之前的停用和熔断记录，不用重启", async () => {
    const s = useSettings.getState();
    const down = (...ids: string[]) => ids.forEach((id) => health.markProviderDown(id, "鉴权失败"));
    const ok = (id: string) => health.status(id, id).ok;
    down("google", "qwen", "cloud-jev", "local-jev", "custom:lan");
    // 保存失败不算改了配置
    await s.setKey("google", "bad");
    expect(ok("google")).toBe(false);
    expect(await s.setKey("google", KEY)).toBeNull();
    expect(ok("google")).toBe(true);
    s.setRegion("qwen", "intl");
    expect(ok("qwen")).toBe(true);
    expect(await s.setJevKey(KEY)).toBeNull();
    expect(ok("cloud-jev")).toBe(true);
    // 只有本地决策模型用的正是这个 Provider 时才一起清
    s.setLocalJev("ollama/qwen3:8b");
    expect(ok("local-jev")).toBe(true);
    down("local-jev");
    const lan: CustomProvider = { id: "custom:lan", label: "局域网", base_url: "http://127.0.0.1:8000/v1", default_model: "llama-3.1-8b", headers: {} };
    expect(await s.saveCustom(lan)).toMatchObject({ provider: { id: "custom:lan" } });
    expect(ok("custom:lan")).toBe(true);
    expect(ok("local-jev")).toBe(false);
    s.setLocalJev("custom:lan/llama-3.1-8b");
    down("local-jev");
    await s.saveCustom(lan);
    expect(ok("local-jev")).toBe(true);
  });

  it("路由偏好和能力矩阵调整会持久化，重新加载后保留", async () => {
    useSettings.getState().setRouting({ preference: "economy", maxCostTier: 2 });
    useSettings.getState().setOverride("openai/gpt-5.6-luna", { enabled: false });
    await new Promise((r) => setTimeout(r, 0));
    useSettings.setState({ routing: DEFAULT_ROUTING, overrides: {} });
    await useSettings.getState().load();
    expect(useSettings.getState().routing).toEqual({ preference: "economy", latency: "normal", maxCostTier: 2 });
    expect(useSettings.getState().overrides["openai/gpt-5.6-luna"]).toEqual({ enabled: false });
  });

  it("解析设置时容忍损坏或越界的值", () => {
    expect(parseRouting("{bad")).toEqual(DEFAULT_ROUTING);
    expect(parseRouting('{"preference":"cheap","maxCostTier":9}')).toEqual(DEFAULT_ROUTING);
  });
});

describe("任务 store", () => {
  it("提交任务生成卡片并跑完，时间线覆盖各阶段", async () => {
    const id = useTasks.getState().submit("  调研国产大模型的现状  ")!;
    expect(task(id)).toMatchObject({ goal: "调研国产大模型的现状", status: "running" });
    expect(useTasks.getState().activeId).toBe(id);
    await vi.waitFor(() => expect(task(id).status).toBe("completed"));
    const items = toTimeline(task(id).events, effectiveProfiles());
    expect(new Set(items.map((i) => i.stage))).toEqual(new Set(["analysis", "routing", "tool", "model", "reflect", "done"]));
    expect(items.find((i) => i.stage === "routing")?.costTier).toBeGreaterThan(0);
    expect(lastRoute(task(id).events)?.decision.chain.length).toBeGreaterThan(0);
    expect(usageTotals(task(id).events).calls).toBeGreaterThan(0);
    expect(useTasks.getState().submit("   ")).toBeNull();
  });

  it("需要确认时卡片挂起，批准后继续", async () => {
    const id = useTasks.getState().submit("整理周报并保存")!;
    await vi.waitFor(() => expect(task(id).pendingConfirm).not.toBeNull());
    while (task(id).status === "running") {
      if (task(id).pendingConfirm) useTasks.getState().respond(id, true);
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(task(id).status).toBe("completed");
    expect(task(id).events.some((e) => e.type === "confirm" && e.approved)).toBe(true);
  });

  it("折叠、排序、关闭；关闭运行中的任务会取消它", async () => {
    const a = useTasks.getState().submit("任务 A")!;
    const b = useTasks.getState().submit("任务 B")!;
    expect(useTasks.getState().tasks.map((t) => t.id)).toEqual([b, a]);
    useTasks.getState().move(b, 1);
    expect(useTasks.getState().tasks.map((t) => t.id)).toEqual([a, b]);
    useTasks.getState().toggleCollapse(a);
    expect(task(a).collapsed).toBe(true);
    useTasks.getState().close(a);
    expect(useTasks.getState().tasks.map((t) => t.id)).toEqual([b]);
    expect(useTasks.getState().activeId).toBe(b);
    await vi.waitFor(() => expect(task(b).status).not.toBe("running"));
  });

  it("手动干预：锁定模型后所有调用都用它", async () => {
    const id = useTasks.getState().submit("写一段问候语")!;
    useTasks.getState().setOverride(id, { mode: "lock", profileId: "anthropic/claude-sonnet-5-5" });
    await vi.waitFor(() => expect(task(id).status).not.toBe("running"));
    const used = new Set(task(id).events.flatMap((e) => (e.type === "llm" ? [e.profileId] : [])));
    expect(used).toEqual(new Set(["anthropic/claude-sonnet-5-5"]));
  });
});

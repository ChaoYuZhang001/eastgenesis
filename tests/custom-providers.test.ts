// 自定义 Provider 完整支持：协议、多模型、模型发现、能力参照
import { customReference, effectiveProfiles, officialMatch, providerFactory } from "@/lib/engine";
import { waitFor } from "@testing-library/react";
import { discoverModels, MAX_DISCOVERED, probeModel, probeModels } from "@/lib/discover";
import { modelGroups } from "@/lib/model-options";
import { createMockBackend, customModels, MAX_CUSTOM_MODELS, type Backend, type CustomProvider } from "@/platform";
import { parseModelCache, useSettings } from "@/stores/settings";
import { resetStores } from "./ui-helpers";

const KEY = "sk-relay-0123456789abcdef";
const relay = (over: Partial<CustomProvider> = {}): CustomProvider => ({
  id: "custom:relay",
  label: "中转站",
  base_url: "https://relay.example.com/v1",
  default_model: "gpt-x",
  headers: {},
  ...over,
});

const code = (p: Promise<unknown>) => p.then(() => "ok", (e: { code: string }) => e.code);

describe("自定义 Provider：协议与多模型", () => {
  it("保存时规整模型列表：默认模型在第一个、去重、去空白；超过上限或含空白报错", async () => {
    const b = createMockBackend();
    const s = await b.saveCustomProvider(relay({ protocol: "anthropic", models: [" claude-x ", "gpt-x", "", "openai/gpt-5.6-luna", "claude-x"] }), KEY);
    expect(s.provider).toMatchObject({ protocol: "anthropic", models: ["gpt-x", "claude-x", "openai/gpt-5.6-luna"] });
    expect(await code(b.saveCustomProvider(relay({ models: ["has space"] })))).toBe("invalid_provider_config");
    const many = Array.from({ length: MAX_CUSTOM_MODELS }, (_, i) => `m${i}`);
    expect(await code(b.saveCustomProvider(relay({ models: many })))).toBe("invalid_provider_config");
    expect((await b.saveCustomProvider(relay({ models: many.slice(1) }))).provider.models).toHaveLength(MAX_CUSTOM_MODELS);
    // 旧数据没有 protocol / models
    expect(customModels({ default_model: "m" })).toEqual(["m"]);
  });

  it("Anthropic 协议只放行 /messages 和 /models；适配器按协议构造", async () => {
    const b = createMockBackend();
    const c = (await b.saveCustomProvider(relay({ protocol: "anthropic" }), KEY)).provider;
    const req = (url: string) => b.providerRequest({ target: c.id, method: "POST", url, body: "{}" });
    expect(await code(req("https://relay.example.com/v1/chat/completions"))).toBe("proxy_url_not_allowed");
    const seen: string[] = [];
    const spy: Backend = { ...b, providerRequest: (r) => (seen.push(r.url), b.providerRequest(r)) };
    const p = await providerFactory(spy, [c])({ provider: c.id });
    expect(p.kind).toBe("anthropic");
    const r = await p.chat({ model: "claude-x", messages: [{ role: "user", content: "你好" }] });
    expect(seen).toEqual(["https://relay.example.com/v1/messages"]);
    expect(r.text.length).toBeGreaterThan(0);
    expect((await providerFactory(spy, [relay()])({ provider: "custom:relay" })).kind).toBe("openai-compatible");
  });

  it("能力矩阵：每个模型一条；同名内置型号（可带 vendor/ 前缀、不分大小写）沿用其档位并标出参照", () => {
    const c = relay({ default_model: "OpenAI/GPT-5.6-Luna", models: ["mystery-model", "qwen3:8b"] });
    const ps = effectiveProfiles({ "custom:relay/mystery-model": { cost_tier: 1 } }, [c]).filter((p) => p.provider === c.id);
    expect(ps.map((p) => p.id)).toEqual(["custom:relay/OpenAI/GPT-5.6-Luna", "custom:relay/mystery-model", "custom:relay/qwen3:8b"]);
    const luna = effectiveProfiles().find((p) => p.id === "openai/gpt-5.6-luna")!;
    expect(ps[0]).toMatchObject({ capabilities: luna.capabilities, cost_tier: luna.cost_tier, quality_tier: luna.quality_tier, is_custom: true, enabled: true });
    expect(customReference(ps[0])).toBe("openai/gpt-5.6-luna");
    // 没有参照：保守默认值，用户调整照常叠加
    expect(ps[1]).toMatchObject({ capabilities: [], cost_tier: 1, quality_tier: 3, context_window: 128_000 });
    expect(customReference(ps[1])).toBeNull();
    // 不参照本机 Ollama 的条目：成本、延迟档位不适用于远端
    expect(officialMatch("qwen3:8b")).toBeUndefined();
    expect(ps[2]).toMatchObject({ cost_tier: 3, latency_tier: 3 });
    // 内置条目默认停用也不影响用户登记的型号
    expect(effectiveProfiles({}, [relay({ default_model: "claude-haiku-4-5" })]).find((p) => p.id === "custom:relay/claude-haiku-4-5")?.enabled).toBe(true);
  });
});

describe("模型发现", () => {
  const withBody = (status: number, body: string): Backend => ({ ...createMockBackend(), providerRequest: async () => ({ status, body }) });

  it("读取 /models：兼容 { data } 和数组两种格式，去重，丢弃无效名字", async () => {
    const b = createMockBackend();
    const c = (await b.saveCustomProvider(relay(), KEY)).provider;
    expect(await discoverModels(b, c)).toEqual({ ok: true, models: ["mock-model", "gpt-5.6-luna"] });
    const arr = JSON.stringify([{ id: "a" }, { id: "a" }, { id: "has space" }, { id: 3 }, null, { id: " b " }]);
    expect(await discoverModels(withBody(200, arr), c)).toEqual({ ok: true, models: ["a", "b"] });
    const big = JSON.stringify({ data: Array.from({ length: MAX_DISCOVERED + 10 }, (_, i) => ({ id: `m${i}` })) });
    expect(await discoverModels(withBody(200, big), c)).toMatchObject({ ok: true, models: expect.any(Array) });
    expect(((await discoverModels(withBody(200, big), c)) as { models: string[] }).models).toHaveLength(MAX_DISCOVERED);
  });

  it("失败时说明原因：未配置 Key、认证失败、不提供列表、格式无法识别", async () => {
    const c = relay();
    expect(await discoverModels(createMockBackend(), c)).toMatchObject({ ok: false, message: "没有找到这个自定义 Provider" });
    expect(await discoverModels(withBody(401, ""), c)).toMatchObject({ ok: false, message: expect.stringContaining("认证失败") });
    expect(await discoverModels(withBody(404, ""), c)).toMatchObject({ ok: false, message: expect.stringContaining("手动填写") });
    expect(await discoverModels(withBody(200, "<html>"), c)).toMatchObject({ ok: false, message: expect.stringContaining("格式无法识别") });
    expect(await discoverModels(withBody(200, '{"data":[]}'), c)).toMatchObject({ ok: false, message: "服务没有返回任何模型" });
    expect(await discoverModels(withBody(502, ""), c)).toMatchObject({ ok: false, message: "服务返回 HTTP 502" });
  });
});

describe("模型探测", () => {
  it("每个模型发一个 max_tokens 1 的请求；只有 404 / model_not_found 算不存在，超时和 5xx 不隐藏", async () => {
    const b = createMockBackend({ missingModels: ["ghost"] });
    const c = (await b.saveCustomProvider(relay(), KEY)).provider;
    const seen: { url: string; body: { model: string; max_tokens: number } }[] = [];
    const spy: Backend = { ...b, providerRequest: (r) => (seen.push({ url: r.url, body: JSON.parse(r.body ?? "{}") }), b.providerRequest(r)) };
    expect(await probeModel(spy, c, "gpt-x")).toBe("ok");
    expect(await probeModel(spy, c, "ghost")).toBe("missing");
    expect(seen[0]).toEqual({ url: "https://relay.example.com/v1/chat/completions", body: expect.objectContaining({ model: "gpt-x", max_tokens: 1 }) });

    const withCode = (status: number, body = "") => ({ ...b, providerRequest: async () => ({ status, body }) }) as Backend;
    expect(await probeModel(withCode(400, JSON.stringify({ error: { code: "model_not_found" } })), c, "x")).toBe("missing");
    expect(await probeModel(withCode(503), c, "x")).toBe("unknown");
    expect(await probeModel(withCode(429), c, "x")).toBe("unknown");
    const hang = { ...b, providerRequest: () => new Promise(() => {}) } as Backend;
    expect(await probeModel(hang, c, "x", 10)).toBe("unknown");
    const boom = { ...b, providerRequest: async () => Promise.reject({ code: "proxy_failed", message: "x" }) } as Backend;
    expect(await probeModel(boom, c, "x")).toBe("unknown");
  });

  it("Anthropic 协议探测 /messages", async () => {
    const b = createMockBackend();
    const c = (await b.saveCustomProvider(relay({ protocol: "anthropic" }), KEY)).provider;
    expect(await probeModel(b, c, "claude-x")).toBe("ok");
  });

  it("并发受限；全部 404 时判为地址可疑，不隐藏任何模型", async () => {
    const b = createMockBackend({ missingModels: ["a", "b", "c"] });
    const c = (await b.saveCustomProvider(relay(), KEY)).provider;
    let inflight = 0;
    let peak = 0;
    const slow: Backend = {
      ...b,
      providerRequest: async (r) => {
        peak = Math.max(peak, ++inflight);
        await new Promise((res) => setTimeout(res, 5));
        inflight--;
        return b.providerRequest(r);
      },
    };
    expect(await probeModels(slow, c, ["a", "ok1", "b", "ok2", "ok3", "ok4"], { concurrency: 2 })).toMatchObject({ unavailable: ["a", "b"], probed: 6, suspicious: false, ok: 4, missing: 2, unknown: 0, notProbed: 0 });
    expect(peak).toBe(2);
    expect(await probeModels(b, c, ["a", "b", "c"])).toMatchObject({ unavailable: [], probed: 3, suspicious: true });
    // 只有一个模型且 404：照实标记
    expect(await probeModels(b, c, ["a"])).toMatchObject({ unavailable: ["a"], probed: 1, suspicious: false });
    expect((await probeModels(b, c, ["x", "y", "z"], { max: 2 })).probed).toBe(2);
  });

  it("设置：目录读取不推理，用户明确检查后保存结果；刷新和测试连接不追加检查", async () => {
    const b = createMockBackend({ listModels: ["gpt-x", "ghost", "gpt-y"], missingModels: ["ghost"] });
    let probes = 0;
    const spy: Backend = { ...b, providerRequest: (r) => (r.method === "POST" && probes++, b.providerRequest(r)) };
    resetStores(spy);
    await useSettings.getState().saveCustom(relay(), KEY);
    await waitFor(() => expect(useSettings.getState().modelCache["custom:relay"]?.models).toHaveLength(3));
    expect(probes).toBe(0);
    expect(useSettings.getState().modelCache["custom:relay"]?.probedAt).toBeUndefined();
    await useSettings.getState().probeModels("custom:relay");
    const entry = useSettings.getState().modelCache["custom:relay"]!;
    expect(entry.models).toEqual(["gpt-x", "ghost", "gpt-y"]);
    expect(entry.unavailable).toEqual(["ghost"]);
    expect(probes).toBe(3);
    // 落盘后重新读出来，不可用标记还在
    expect(parseModelCache(await b.loadSetting("model_cache"))["custom:relay"]?.unavailable).toEqual(["ghost"]);

    const s = useSettings.getState();
    const labels = modelGroups(effectiveProfiles({}, s.custom), s.custom, () => ({ ok: true, health: 1 }), s.modelCache)
      .find((g) => g.provider === "custom:relay")!
      .options.map((o) => o.label);
    expect(labels).toEqual(["gpt-x", "gpt-y"]);

    await useSettings.getState().testConnection("custom:relay");
    expect(useSettings.getState().probingIds).toEqual([]);
    expect(probes).toBe(3);
    // 刷新只读目录，重新检查必须再次明确触发
    await useSettings.getState().refreshModels("custom:relay");
    expect(probes).toBe(3);
    expect(useSettings.getState().modelCache["custom:relay"]?.unavailable).toEqual(["ghost"]);
    expect(useSettings.getState().modelCache["custom:relay"]?.probeSummary).toMatchObject({ total: 3, probed: 3, ok: 2, missing: 1, unknown: 0, notProbed: 0, stopReason: null });
    await useSettings.getState().probeModels("custom:relay");
    expect(probes).toBe(6);
  });

  it("旧缓存没有探测字段也能读；不可用列表只保留仍在列表里的型号", () => {
    expect(parseModelCache(JSON.stringify({ a: { models: ["m1"], fetchedAt: 1 } }))).toEqual({ a: { models: ["m1"], fetchedAt: 1 } });
    expect(parseModelCache(JSON.stringify({ a: { models: ["m1", "m2"], fetchedAt: 1, probedAt: 2, unavailable: ["m2", "gone", 3] } }))).toEqual({
      a: { models: ["m1", "m2"], fetchedAt: 1, probedAt: 2, unavailable: ["m2"] },
    });
  });
});

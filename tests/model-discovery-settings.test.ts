import { waitFor } from "@testing-library/react";
import { effectiveProfiles } from "@/lib/engine";
import { modelGroups } from "@/lib/model-options";
import { createMockBackend, type Backend, type CustomProvider } from "@/platform";
import { parseModelCache, useSettings } from "@/stores/settings";
import { resetStores } from "./ui-helpers";

const provider: CustomProvider = {
  id: "custom:catalog-check", label: "目录检查测试", base_url: "http://127.0.0.1:8080/v1",
  default_model: "registered-model", headers: {},
};
const catalog = (models: string[]) => ({ status: 200, body: JSON.stringify({ data: models.map((id) => ({ id })) }) });

describe("模型目录与明确调用检查", () => {
  it.each([false, true])("启动时目录缓存=%s，不隐式推理，也不补检查旧缓存", async (cached) => {
    const b = createMockBackend({ listModels: ["registered-model", "directory-model"] });
    await b.saveCustomProvider(provider);
    if (cached) await b.saveSetting("model_cache", JSON.stringify({ [provider.id]: { models: ["legacy-model"], fetchedAt: 1 } }));
    const request = vi.fn(b.providerRequest);
    resetStores({ ...b, providerRequest: request });
    await useSettings.getState().load();
    await waitFor(() => expect(useSettings.getState().modelCache[provider.id]?.models).toEqual(cached ? ["legacy-model"] : ["registered-model", "directory-model"]));
    expect(request.mock.calls.every(([req]) => req.method === "GET")).toBe(true);
    expect(request).toHaveBeenCalledTimes(cached ? 0 : 1);
    expect(useSettings.getState().probingIds).toEqual([]);
    expect(useSettings.getState().modelCache[provider.id]?.probedAt).toBeUndefined();
  });

  it("保存、刷新、测试连接和表单目录读取都不推理，不要求先检查才能发现模型", async () => {
    const b = createMockBackend({ listModels: ["registered-model", "directory-model"] });
    const request = vi.fn(b.providerRequest);
    resetStores({ ...b, providerRequest: request });
    await useSettings.getState().saveCustom(provider);
    await waitFor(() => expect(useSettings.getState().modelCache[provider.id]?.models).toHaveLength(2));
    await useSettings.getState().refreshModels(provider.id);
    const connection = await useSettings.getState().testConnection(provider.id);
    expect(connection.message).toContain("尚未检查推理调用");
    expect(await useSettings.getState().discoverModels(provider.id)).toMatchObject({ ok: true });
    expect(request).toHaveBeenCalledTimes(4);
    expect(request.mock.calls.every(([req]) => req.method === "GET")).toBe(true);
    expect(useSettings.getState().modelCache[provider.id]?.probedAt).toBeUndefined();
  });

  it("429 与服务错误保留为未知，不把目录候选隐藏或把无404称为全部成功", async () => {
    const b = createMockBackend({ listModels: ["registered-model", "directory-model"] });
    const request: Backend["providerRequest"] = async (req) => req.method === "GET"
      ? b.providerRequest(req) : { status: JSON.parse(req.body!).model === "registered-model" ? 429 : 503, body: "{}" };
    resetStores({ ...b, providerRequest: request });
    await useSettings.getState().saveCustom(provider);
    await waitFor(() => expect(useSettings.getState().modelCache[provider.id]?.models).toHaveLength(2));
    expect(await useSettings.getState().probeModels(provider.id)).toMatchObject({ probed: 2, ok: 0, missing: 0, unknown: 2, notProbed: 0, unavailable: [] });
    const s = useSettings.getState();
    expect(modelGroups(effectiveProfiles({}, s.custom), s.custom, () => ({ ok: true, health: 1 }), s.modelCache).find((g) => g.provider === provider.id)?.options).toHaveLength(2);
    const persisted = parseModelCache(await b.loadSetting("model_cache"))[provider.id];
    expect(persisted?.probeSummary).toMatchObject({ ok: 0, unknown: 2 });
    expect(persisted?.unavailable).toBeUndefined();
  });

  it("用户停止保留已发起与未发起数量；没有自动重试，重复点击复用同一次检查", async () => {
    const models = Array.from({ length: 8 }, (_, i) => `model-${i}`);
    const b = createMockBackend({ listModels: models });
    const calls: string[] = [];
    resetStores({ ...b, providerRequest: (req) => {
      if (req.method === "GET") return b.providerRequest(req);
      calls.push(JSON.parse(req.body!).model);
      return new Promise(() => {});
    } });
    await useSettings.getState().saveCustom(provider);
    await waitFor(() => expect(useSettings.getState().modelCache[provider.id]?.models).toHaveLength(8));
    const first = useSettings.getState().probeModels(provider.id);
    expect(useSettings.getState().probeModels(provider.id)).toBe(first);
    await waitFor(() => expect(calls).toHaveLength(4));
    useSettings.getState().cancelModelProbe(provider.id);
    expect(await first).toMatchObject({ total: 8, probed: 4, unknown: 4, notProbed: 4, stopReason: "cancelled" });
    expect(calls).toHaveLength(4);
    expect(useSettings.getState().probingIds).toEqual([]);
    expect(useSettings.getState().modelCache[provider.id]?.probeSummary).toMatchObject({ stopReason: "cancelled", notProbed: 4 });
  });

  it("检查期间目录换成新版本，旧结果丢弃，不自动检查新目录", async () => {
    let models = ["old-model", "other-old"];
    const b = createMockBackend();
    const calls: string[] = [];
    resetStores({ ...b, providerRequest: (req) => {
      if (req.method === "GET") return Promise.resolve(catalog(models));
      calls.push(JSON.parse(req.body!).model);
      return new Promise(() => {});
    } });
    await useSettings.getState().saveCustom(provider);
    await waitFor(() => expect(useSettings.getState().modelCache[provider.id]?.models).toEqual(models));
    const checking = useSettings.getState().probeModels(provider.id);
    await waitFor(() => expect(calls).toHaveLength(2));
    models = ["new-model"];
    await useSettings.getState().refreshModels(provider.id);
    expect(await checking).toBeNull();
    expect(useSettings.getState().modelCache[provider.id]).toMatchObject({ models: ["new-model"] });
    expect(useSettings.getState().modelCache[provider.id]?.probeSummary).toBeUndefined();
    expect(calls).toEqual(["old-model", "other-old"]);
  });

  it("Provider 配置改变即使目录相同，也丢弃旧检查且不向新协议追加推理", async () => {
    const b = createMockBackend({ listModels: ["registered-model"] });
    const calls: string[] = [];
    resetStores({ ...b, providerRequest: (req) => {
      if (req.method === "GET") return b.providerRequest(req);
      calls.push(req.url);
      return new Promise(() => {});
    } });
    await useSettings.getState().saveCustom(provider);
    await waitFor(() => expect(useSettings.getState().modelCache[provider.id]?.models).toHaveLength(1));
    const checking = useSettings.getState().probeModels(provider.id);
    await waitFor(() => expect(calls).toHaveLength(1));
    await useSettings.getState().saveCustom({ ...provider, protocol: "anthropic" });
    expect(await checking).toBeNull();
    await waitFor(() => expect(useSettings.getState().modelCache[provider.id]?.models).toHaveLength(1));
    expect(useSettings.getState().modelCache[provider.id]?.probeSummary).toBeUndefined();
    expect(calls).toEqual([`${provider.base_url}/chat/completions`]);
  });

  it("旧目录请求晚于 Provider 删除返回，也不会恢复目录或触发推理", async () => {
    const b = createMockBackend();
    await b.saveCustomProvider(provider);
    let respond!: (value: { status: number; body: string }) => void;
    resetStores({ ...b, providerRequest: () => new Promise((resolve) => { respond = resolve; }) });
    useSettings.setState({ custom: [provider] });
    const read = useSettings.getState().refreshModels(provider.id);
    await useSettings.getState().deleteCustom(provider.id);
    respond(catalog(["late-model"]));
    await read;
    expect(useSettings.getState().modelCache[provider.id]).toBeUndefined();
    expect(useSettings.getState().custom).toEqual([]);
  });

  it.each(["refresh-first", "connection-first"])("同配置目录请求逆序返回=%s，旧目录不能覆盖新目录或取消新检查", async (order) => {
    const b = createMockBackend();
    await b.saveCustomProvider(provider);
    const respond: ((value: { status: number; body: string }) => void)[] = [];
    const calls: string[] = [];
    resetStores({ ...b, providerRequest: (req) => {
      if (req.method === "GET") return new Promise((resolve) => respond.push(resolve));
      calls.push(JSON.parse(req.body!).model);
      return new Promise(() => {});
    } });
    useSettings.setState({ custom: [provider], modelCache: { [provider.id]: { models: ["initial"], fetchedAt: 1 } } });
    const first = order === "refresh-first" ? useSettings.getState().refreshModels(provider.id) : useSettings.getState().testConnection(provider.id);
    const latest = order === "refresh-first" ? useSettings.getState().testConnection(provider.id) : useSettings.getState().refreshModels(provider.id);
    const newModels = Array.from({ length: 8 }, (_, i) => `new-${i}`);
    respond[1](catalog(newModels));
    await latest;
    const checking = useSettings.getState().probeModels(provider.id);
    await waitFor(() => expect(calls).toHaveLength(4));
    respond[0](catalog(["old-model"]));
    await first;
    expect(useSettings.getState().modelCache[provider.id]?.models).toEqual(newModels);
    expect(useSettings.getState().probingIds).toContain(provider.id);
    expect(calls).toEqual(newModels.slice(0, 4));
    useSettings.getState().cancelModelProbe(provider.id);
    expect(await checking).toMatchObject({ total: 8, probed: 4, stopReason: "cancelled" });
  });

  it.each([false, true])("配置变更后旧连接请求迟返，reject=%s，不能报告新配置连接成功", async (reject) => {
    const b = createMockBackend();
    await b.saveCustomProvider(provider);
    let respond!: (value: { status: number; body: string }) => void;
    let fail!: (error: unknown) => void;
    let hold = true;
    resetStores({ ...b, providerRequest: (req) => {
      if (hold) return new Promise((resolve, reject) => { respond = resolve; fail = reject; });
      return b.providerRequest(req);
    } });
    useSettings.setState({ custom: [provider] });
    const testing = useSettings.getState().testConnection(provider.id);
    hold = false;
    await useSettings.getState().saveCustom({ ...provider, protocol: "anthropic" });
    if (reject) fail({ code: "network", message: "synthetic-old-request-error" });
    else respond(catalog(["old-model"]));
    expect(await testing).toEqual({ ok: false, stale: true, message: "Provider 配置已变更，请重新测试当前连接" });
    expect(useSettings.getState().modelCache[provider.id]?.models).not.toContain("old-model");
  });

  it("损坏或矛盾的统计不作为检查证据，额外字段不进入持久化对象", () => {
    const summary = { total: 2, probed: 2, ok: 1, missing: 0, unknown: 1, notProbed: 0, stopReason: null };
    const parse = (probeSummary: unknown) => parseModelCache(JSON.stringify({ a: { models: ["m1", "m2"], fetchedAt: 1, probedAt: 2, probeSummary } })).a;
    expect(parse({ ...summary, detail: "synthetic-extra" })?.probeSummary).toEqual(summary);
    expect(parse({ ...summary, unknown: 3 })?.probeSummary).toBeUndefined();
    expect(parse({ ...summary, total: 99 })?.probeSummary).toBeUndefined();
    expect(parse({ ...summary, stopReason: "untrusted" })?.probeSummary).toBeUndefined();
    const inconsistent = parseModelCache(JSON.stringify({ a: { models: ["m1", "m2"], fetchedAt: 1, probedAt: 2, unavailable: ["m1"], probeSummary: summary } })).a;
    expect(inconsistent?.probeSummary).toBeUndefined();
    expect(inconsistent?.unavailable).toBeUndefined();
    expect(inconsistent?.probedAt).toBeUndefined();
    const large = parseModelCache(JSON.stringify({ a: { models: Array.from({ length: 101 }, (_, i) => `m${i}`), fetchedAt: 1, probedAt: 2,
      probeSummary: { total: 101, probed: 101, ok: 101, missing: 0, unknown: 0, notProbed: 0, stopReason: null } } })).a;
    expect(large?.probeSummary).toBeUndefined();
  });
});

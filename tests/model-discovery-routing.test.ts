import type { AgentEvent } from "@/agent";
import { HealthTracker } from "@/decision";
import { probeModels } from "@/lib/discover";
import { createEngine, statusAvailability, withLockedModel } from "@/lib/engine";
import { hasOption, modelGroups } from "@/lib/model-options";
import { createMockBackend, type CustomProvider, type ProxyRequest } from "@/platform";
import type { ModelCache } from "@/stores/settings";

const REGISTERED = "registered-greeting";
const CATALOG_ONLY = "catalog-only-greeting";
const UNKNOWN = "catalog-unknown";
const NOT_PROBED = "catalog-not-probed";
const GOAL = "Say one friendly greeting.";
const provider: CustomProvider = {
  id: "custom:discovery-routing",
  label: "Synthetic model directory",
  base_url: "https://synthetic.invalid/v1",
  default_model: REGISTERED,
  headers: {},
  protocol: "openai",
};
const profileId = (model: string) => `${provider.id}/${model}`;

async function fixture() {
  // The memory backend never performs network I/O or retains the synthetic key.
  const memory = createMockBackend({ configured: [], listModels: [CATALOG_ONLY, UNKNOWN, NOT_PROBED] });
  const saved = await memory.saveCustomProvider(provider, "synthetic-routing-key");
  const requests: ProxyRequest[] = [];
  const backend = {
    ...memory,
    providerRequest: async (request: ProxyRequest) => {
      requests.push({ ...request });
      const body = JSON.parse(request.body ?? "{}") as { model?: string };
      if (body.model === UNKNOWN) return { status: 503, body: JSON.stringify({ error: { code: "synthetic_unavailable" } }) };
      return memory.providerRequest(request);
    },
  };
  const statuses = (await backend.providerStatus()).filter((s) => s.id === provider.id);
  const custom = [saved.provider];
  return { backend, custom, statuses, requests };
}

function expectTaskRequests(requests: readonly ProxyRequest[], model: string) {
  expect(requests.length).toBeGreaterThan(0);
  for (const request of requests) {
    expect(request).toMatchObject({ target: provider.id, method: "POST", url: `${provider.base_url}/chat/completions` });
    const body = JSON.parse(request.body ?? "{}") as { model?: string; max_tokens?: number; messages?: { role: string; content: string }[] };
    expect(body.model).toBe(model);
    // Normal task inference is allowed. It must not introduce the availability
    // check's one-token request before or alongside the user's task.
    expect(body.max_tokens).not.toBe(1);
    expect(body.messages?.some((m) => m.role === "user" && m.content.includes(GOAL))).toBe(true);
  }
}

describe("模型目录与默认路由的边界", () => {
  it("未探测的登记模型仍经实际自动路由完成任务，不先读取目录或发起可用性检查", async () => {
    const f = await fixture();
    expect(await f.backend.loadSetting("model_cache")).toBeNull();
    const events: AgentEvent[] = [];
    const engine = createEngine({ ...f, jev: null, onEvent: (event) => events.push(event) });

    const route = await engine.decision.routeTask({ text: GOAL });
    expect(route.meta.backend).toBe("rules");
    expect(route.decision.primary?.profileId).toBe(profileId(REGISTERED));
    expect(f.requests).toEqual([]);

    const result = await engine.runtime.run(GOAL);
    expect(result.status).toBe("completed");
    const used = events.flatMap((event) => event.type === "llm" ? [event.profileId] : []);
    expect(used.length).toBeGreaterThan(0);
    expect(new Set(used)).toEqual(new Set([profileId(REGISTERED)]));
    expectTaskRequests(f.requests, REGISTERED);
  });

  it("保存的目录候选不自动登记，也不进入常规自动路由", async () => {
    const f = await fixture();
    const cache: ModelCache = { [provider.id]: { models: [CATALOG_ONLY], fetchedAt: 1 } };
    await f.backend.saveSetting("model_cache", JSON.stringify(cache));
    const engine = createEngine({ ...f, jev: null });
    const route = await engine.decision.routeTask({ text: GOAL });

    expect(engine.profiles.some((p) => p.id === profileId(CATALOG_ONLY))).toBe(false);
    expect(route.decision.chain.map((entry) => entry.profileId)).toEqual([profileId(REGISTERED)]);
    expect(f.requests).toEqual([]);
    expect((await engine.runtime.run(GOAL)).status).toBe("completed");
    expectTaskRequests(f.requests, REGISTERED);
    expect(await f.backend.listCustomProviders()).toEqual(f.custom);
    expect(JSON.parse((await f.backend.loadSetting("model_cache"))!)).toEqual(cache);
  });

  it("withLockedModel 让目录候选仅执行当前锁定任务，保存配置与后续自动路由保持登记模型", async () => {
    const f = await fixture();
    const before = structuredClone(await f.backend.listCustomProviders());
    const lockedId = profileId(CATALOG_ONLY);
    const taskCustom = withLockedModel(f.custom, lockedId);
    const events: AgentEvent[] = [];
    const locked = createEngine({ ...f, custom: taskCustom, jev: null, onEvent: (event) => events.push(event) });

    expect(locked.profiles.some((p) => p.id === lockedId)).toBe(true);
    const result = await locked.runtime.run(GOAL, { route: { lock: lockedId } });
    expect(result.status).toBe("completed");
    const routed = events.flatMap((event) => event.type === "route" ? [event.decision] : []);
    expect(routed.length).toBeGreaterThan(0);
    expect(routed.every((decision) => decision.chain.length === 1 && decision.primary?.profileId === lockedId)).toBe(true);
    expectTaskRequests(f.requests, CATALOG_ONLY);
    expect(f.custom).toEqual(before);
    expect(await f.backend.listCustomProviders()).toEqual(before);

    f.requests.length = 0;
    const nextTask = createEngine({ ...f, jev: null });
    expect(nextTask.profiles.some((p) => p.id === lockedId)).toBe(false);
    const nextRoute = await nextTask.decision.routeTask({ text: GOAL });
    expect(nextRoute.decision.chain.map((entry) => entry.profileId)).toEqual([profileId(REGISTERED)]);
    expect(f.requests).toEqual([]);
    expect((await nextTask.runtime.run(GOAL)).status).toBe("completed");
    expectTaskRequests(f.requests, REGISTERED);
    expect(await f.backend.listCustomProviders()).toEqual(before);
  });

  it("一次有上限的明确检查产生 unknown 与未发起候选，两者仍保留在实际手动选择模型组", async () => {
    const f = await fixture();
    const models = [UNKNOWN, NOT_PROBED];
    const result = await probeModels(f.backend, f.custom[0], models, { concurrency: 1, max: 1, timeoutMs: 1_000, batchTimeoutMs: 2_000 });
    expect(result).toMatchObject({ total: 2, probed: 1, ok: 0, missing: 0, unknown: 1, notProbed: 1, unavailable: [] });
    expect(f.requests).toHaveLength(1);
    expect(JSON.parse(f.requests[0].body!)).toMatchObject({ model: UNKNOWN, max_tokens: 1 });

    const { unavailable, suspicious, ...probeSummary } = result;
    const cache: ModelCache = { [provider.id]: { models, fetchedAt: 1, probedAt: 2, unavailable, probeSuspicious: suspicious, probeSummary } };
    const engine = createEngine({ ...f, jev: null });
    const groups = modelGroups(engine.profiles, f.custom, statusAvailability(f.statuses, f.custom, new HealthTracker()), cache);
    expect(groups.find((group) => group.provider === provider.id)?.options.map((option) => option.id)).toEqual(models.map(profileId));
    expect(hasOption(groups, profileId(UNKNOWN))).toBe(true);
    expect(hasOption(groups, profileId(NOT_PROBED))).toBe(true);
    // Menu membership is eligibility to try a task, not a successful inference
    // or quality assessment: the actual check above succeeded for zero models.
    expect(cache[provider.id].probeSummary?.ok).toBe(0);
    expect(f.requests).toHaveLength(1);
  });
});

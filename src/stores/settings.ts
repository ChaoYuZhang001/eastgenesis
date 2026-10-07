// 设置：Key 状态（只有「是否已配置」）、自定义 Provider、路由偏好、能力矩阵调整。
// Key 经后端写入钥匙串后立即丢弃，store 里从不保存 Key。
import { create } from "zustand";
import { officialEndpoint, regionBaseUrl } from "@/core/llm/official";
import { redact } from "@/core/redact";
import { PERMISSION_MODES, type LatencyPref, type PermissionMode, type Preference } from "@/decision";
import {
  DEFAULT_PROVIDER_PREFS,
  DEFAULT_REQUEST_TIMEOUT_S,
  REQUEST_TIMEOUT_OPTIONS,
  effectiveProfiles,
  parseProviderPrefs,
  parseTimeout,
  type ProfileOverride,
  type ProfileOverrides,
  type ProviderPrefs,
} from "@/lib/engine";
import { MAX_DISCOVERED, MAX_PROBED, discoverModels as discover, parseModels, probeModels, type DiscoverResult, type ProbeResult } from "@/lib/discover";
import { toAppError, type AppError } from "@/lib/ipc";
import { getBackend, isValidModelName, type CustomProvider, type KeyStatus, type SavedProvider } from "@/platform";
import { health } from "./health";

export interface RoutingPrefs {
  preference: Preference;
  latency: LatencyPref;
  /** 1–5；5 表示不限 */
  maxCostTier: number;
}

export const DEFAULT_ROUTING: RoutingPrefs = { preference: "balanced", latency: "normal", maxCostTier: 5 };

export interface TestResult {
  ok: boolean;
  message: string;
  /** 实测往返耗时 */
  latencyMs?: number;
  /** 服务返回的模型列表（只有模型名） */
  models?: string[];
  /** 服务返回的错误说明，已脱敏并截断 */
  detail?: string;
  /** 请求进行中配置发生变化；旧结果不能作为当前配置的连接证据 */
  stale?: true;
}

/** /models 的本地缓存，按 Provider 存；输入框的模型下拉用它 */
export interface ModelCacheEntry {
  models: string[];
  fetchedAt: number;
  /** 轻量探测确认不存在（HTTP 404 / model_not_found）的模型：下拉里不展示 */
  unavailable?: string[];
  /** 上次探测完成的时间；没有表示还没探测 */
  probedAt?: number;
  /** 上次探测全部 404：多半是对话地址不对，结果没有采用 */
  probeSuspicious?: boolean;
  /** 用户明确发起的调用检查；未知和未发起数量不能算成可用 */
  probeSummary?: Omit<ProbeResult, "unavailable" | "suspicious">;
}
export type ModelCache = Record<string, ModelCacheEntry>;

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((m, i) => m === b[i]);

const stringList =(v: unknown) => (Array.isArray(v) ? v.filter((m): m is string => typeof m === "string" && isValidModelName(m)) : []);

export function parseModelCache(raw: string | null): ModelCache {
  try {
    const v = JSON.parse(raw ?? "{}") as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out: ModelCache = {};
    for (const [id, e] of Object.entries(v as Record<string, unknown>)) {
      const x = e as Partial<ModelCacheEntry> | null;
      const models = stringList(x?.models).slice(0, MAX_DISCOVERED);
      if (!models.length) continue;
      const unavailable = stringList(x?.unavailable).filter((m) => models.includes(m));
      const summary = x?.probeSummary;
      const counts = summary && [summary.total, summary.probed, summary.ok, summary.missing, summary.unknown, summary.notProbed];
      const validSummary = summary && counts?.every((n) => Number.isSafeInteger(n) && n >= 0)
        && summary.total === models.length && summary.probed <= MAX_PROBED && summary.probed === summary.ok + summary.missing + summary.unknown
        && summary.total === summary.probed + summary.notProbed
        && [null, "cancelled", "timeout", "budget"].includes(summary.stopReason)
        && (x?.probeSuspicious === true
          ? unavailable.length === 0 && summary.probed > 1 && summary.missing === summary.probed && summary.stopReason === null
          : unavailable.length === summary.missing);
      const keepProbe = summary === undefined || validSummary;
      out[id] = {
        models,
        fetchedAt: typeof x?.fetchedAt === "number" ? x.fetchedAt : 0,
        ...(keepProbe && unavailable.length ? { unavailable } : {}),
        ...(keepProbe && typeof x?.probedAt === "number" ? { probedAt: x.probedAt } : {}),
        ...(keepProbe && x?.probeSuspicious === true ? { probeSuspicious: true } : {}),
        ...(validSummary ? { probeSummary: {
          total: summary.total, probed: summary.probed, ok: summary.ok, missing: summary.missing,
          unknown: summary.unknown, notProbed: summary.notProbed, stopReason: summary.stopReason,
        } } : {}),
      };
    }
    return out;
  } catch {
    return {};
  }
}

/** 从响应体里取服务给的错误说明；脱敏后截断 */
export function errorDetail(body: string): string | undefined {
  let text = "";
  try {
    const v = JSON.parse(body) as { error?: { message?: unknown } | string; message?: unknown };
    const e = typeof v.error === "object" && v.error ? v.error.message : v.error;
    text = String(e ?? v.message ?? "");
  } catch {
    // 不是 JSON：可能是网关的 HTML 错误页，去掉标签
    text = body.replace(/<[^>]*>/g, " ");
  }
  text = redact(text).replace(/\s+/g, " ").trim();
  return text ? text.slice(0, 200) : undefined;
}

/** 测试连接用的地址：与 Rust 侧白名单一致；官方 Provider 按当前选择的地域 */
function testUrl(target: string, prefs: ProviderPrefs, custom: readonly CustomProvider[]): string | null {
  if (target === "jev") return "https://api.typesafe.ai/v1/models";
  const c = custom.find((x) => x.id === target);
  if (c) return `${c.base_url}/models`;
  const e = officialEndpoint(target);
  return e ? `${regionBaseUrl(e, prefs.regions[target])}/models` : null;
}

interface SettingsState {
  loaded: boolean;
  statuses: KeyStatus[];
  jev: KeyStatus | null;
  custom: CustomProvider[];
  routing: RoutingPrefs;
  overrides: ProfileOverrides;
  providerPrefs: ProviderPrefs;
  /** 单次模型请求的超时（秒） */
  timeoutS: number;
  /** 各 Provider 的 /models 缓存 */
  modelCache: ModelCache;
  /** 已经和用户对齐过称呼、风格和边界 */
  onboarded: boolean;
  /** 回答下方显示模型思考过程的摘要；默认关闭 */
  showReasoning: boolean;
  /** 新任务默认的权限档（设置 › Agent › 权限默认值），默认「变更前确认」 */
  defaultPermission: PermissionMode;
  error: AppError | null;
  load(): Promise<void>;
  setTimeoutS(s: number): void;
  setShowReasoning(on: boolean): void;
  setDefaultPermission(p: PermissionMode): void;
  markOnboarded(): Promise<void>;
  /** 只读取 /models 并写入缓存，不发起推理 */
  refreshModels(id: string): Promise<DiscoverResult>;
  /** 用户明确发起可能计费的调用检查；缓存为空或 Provider 不存在时返回 null */
  probeModels(id: string): Promise<ProbeResult | null>;
  cancelModelProbe(id: string): void;
  /** 正在探测的 Provider */
  probingIds: string[];
  setRegion(provider: string, region: string): void;
  setOllamaEnabled(on: boolean): void;
  /** 第 2 级本地决策模型；null 表示不用 */
  setLocalJev(id: string | null): void;
  setKey(provider: string, key: string): Promise<AppError | null>;
  deleteKey(provider: string): Promise<AppError | null>;
  setJevKey(key: string): Promise<AppError | null>;
  deleteJevKey(): Promise<AppError | null>;
  saveCustom(p: CustomProvider, apiKey?: string): Promise<SavedProvider | AppError>;
  deleteCustom(id: string): Promise<AppError | null>;
  testConnection(target: string): Promise<TestResult>;
  /** 用已保存的地址和 Key 读取自定义 Provider 的模型列表 */
  discoverModels(id: string): Promise<DiscoverResult>;
  setRouting(patch: Partial<RoutingPrefs>): void;
  setOverride(profileId: string, patch: ProfileOverride | null): void;
}

const PREFS = new Set<Preference>(["economy", "balanced", "best"]);
const LATENCY = new Set<LatencyPref>(["fast", "normal", "patient"]);

export function parseRouting(raw: string | null): RoutingPrefs {
  try {
    const v = JSON.parse(raw ?? "null") as Partial<RoutingPrefs> | null;
    return {
      preference: v && PREFS.has(v.preference!) ? v.preference! : DEFAULT_ROUTING.preference,
      latency: v && LATENCY.has(v.latency!) ? v.latency! : DEFAULT_ROUTING.latency,
      maxCostTier: v && Number.isInteger(v.maxCostTier) && v.maxCostTier! >= 1 && v.maxCostTier! <= 5 ? v.maxCostTier! : DEFAULT_ROUTING.maxCostTier,
    };
  } catch {
    return DEFAULT_ROUTING;
  }
}

/** 默认权限档：只认三档之一，其余（含旧版本没有这个设置）当作「变更前确认」 */
export function parsePermission(raw: string | null): PermissionMode {
  try {
    const v = JSON.parse(raw ?? "null");
    return (PERMISSION_MODES as readonly unknown[]).includes(v) ? (v as PermissionMode) : "confirm";
  } catch {
    return "confirm";
  }
}

export function parseOverrides(raw: string | null): ProfileOverrides {
  try {
    const v = JSON.parse(raw ?? "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? (v as ProfileOverrides) : {};
  } catch {
    return {};
  }
}

const attempt = async (f: () => Promise<unknown>): Promise<AppError | null> => {
  try {
    await f();
    return null;
  } catch (e) {
    return toAppError(e);
  }
};

export const useSettings = create<SettingsState>((set, get) => {
  const refresh = async () => {
    const b = getBackend();
    const [statuses, jev, custom] = await Promise.all([b.providerStatus(), b.jevStatus(), b.listCustomProviders()]);
    set({ statuses, jev, custom });
  };
  const persist = (key: string, value: unknown) =>
    void getBackend()
      .saveSetting(key, JSON.stringify(value))
      .catch((e) => set({ error: toAppError(e) }));
  /** 写入或删除某个 Provider 的模型缓存并落盘 */
  const writeCache = (modelCache: ModelCache) => {
    set({ modelCache });
    persist("model_cache", modelCache);
  };
  /** 同一 Provider 的显式检查只跑一份，配置或目录变化时中断旧检查 */
  const probing = new Map<string, { promise: Promise<ProbeResult | null>; controller: AbortController }>();
  const probeVersions = new Map<string, number>();
  const configVersions = new Map<string, number>();
  const catalogReads = new Map<string, number>();
  const startCatalogRead = (id: string) => {
    const token = (catalogReads.get(id) ?? 0) + 1;
    catalogReads.set(id, token);
    return token;
  };
  const invalidateProbe = (id: string) => {
    probeVersions.set(id, (probeVersions.get(id) ?? 0) + 1);
    probing.get(id)?.controller.abort();
  };
  const invalidateConfig = (id: string) => {
    configVersions.set(id, (configVersions.get(id) ?? 0) + 1);
    invalidateProbe(id);
  };
  /** 目录读取与可能计费的推理检查分开；旧检查不扩展到新目录 */
  const cacheModels = (id: string, models: string[] | null) => {
    const modelCache = { ...get().modelCache };
    const prev = modelCache[id];
    if (!models) {
      invalidateProbe(id);
      delete modelCache[id];
      writeCache(modelCache);
      return;
    }
    const same = !!prev && sameList(prev.models, models);
    if (!same) invalidateProbe(id);
    modelCache[id] = {
      models,
      fetchedAt: Date.now(),
      ...(same && prev.probedAt !== undefined ? {
        probedAt: prev.probedAt,
        ...(prev.unavailable?.length ? { unavailable: prev.unavailable } : {}),
        ...(prev.probeSuspicious ? { probeSuspicious: true } : {}),
        ...(prev.probeSummary ? { probeSummary: prev.probeSummary } : {}),
      } : {}),
    };
    writeCache(modelCache);
  };

  return {
    loaded: false,
    statuses: [],
    jev: null,
    custom: [],
    routing: DEFAULT_ROUTING,
    overrides: {},
    providerPrefs: DEFAULT_PROVIDER_PREFS,
    timeoutS: DEFAULT_REQUEST_TIMEOUT_S,
    modelCache: {},
    probingIds: [],
    onboarded: false,
    showReasoning: false,
    defaultPermission: "confirm",
    error: null,

    async load() {
      try {
        const b = getBackend();
        const keys = ["routing", "profiles", "provider_prefs", "net_timeout", "model_cache", "onboarded", "show_reasoning", "default_permission"] as const;
        const [routing, overrides, prefs, timeout, cache, onboarded, reasoning, permission] = await Promise.all(keys.map((k) => b.loadSetting(k)));
        await refresh();
        set({
          loaded: true,
          error: null,
          routing: parseRouting(routing),
          overrides: parseOverrides(overrides),
          providerPrefs: parseProviderPrefs(prefs),
          timeoutS: parseTimeout(timeout),
          modelCache: parseModelCache(cache),
          onboarded: onboarded === "true",
          showReasoning: reasoning === "true",
          defaultPermission: parsePermission(permission),
        });
        // 有 Key 但还没缓存过模型列表的自定义 Provider：后台补一次，输入框的下拉里才有真实模型
        for (const c of get().custom) {
          const entry = get().modelCache[c.id];
          if (!entry) void get().refreshModels(c.id);
        }
      } catch (e) {
        set({ loaded: true, error: toAppError(e) });
      }
    },
    setTimeoutS(s) {
      const timeoutS = (REQUEST_TIMEOUT_OPTIONS as readonly number[]).includes(s) ? s : DEFAULT_REQUEST_TIMEOUT_S;
      set({ timeoutS });
      persist("net_timeout", timeoutS);
    },
    setShowReasoning(on) {
      set({ showReasoning: on });
      persist("show_reasoning", on);
    },
    setDefaultPermission(p) {
      if (!(PERMISSION_MODES as readonly string[]).includes(p)) return;
      set({ defaultPermission: p });
      persist("default_permission", p);
    },
    async markOnboarded() {
      if (get().onboarded) return;
      set({ onboarded: true });
      await getBackend()
        .saveSetting("onboarded", "true")
        .catch((e) => set({ error: toAppError(e) }));
    },
    async refreshModels(id) {
      const c = get().custom.find((x) => x.id === id);
      if (!c) return { ok: false, message: "请先保存这个 Provider" };
      const version = configVersions.get(id) ?? 0;
      const token = startCatalogRead(id);
      const r = await discover(getBackend(), c);
      if (r.ok && get().custom.some((x) => x.id === id) && (configVersions.get(id) ?? 0) === version
        && catalogReads.get(id) === token) cacheModels(id, r.models);
      return r;
    },
    probeModels(id) {
      const running = probing.get(id);
      if (running) return running.promise;
      const c = get().custom.find((x) => x.id === id);
      const start = get().modelCache[id];
      if (!c || !start) return Promise.resolve(null);
      const controller = new AbortController();
      const version = probeVersions.get(id) ?? 0;
      set({ probingIds: [...get().probingIds, id] });
      const job = (async (): Promise<ProbeResult | null> => {
        try {
          const r = await probeModels(getBackend(), c, start.models, { signal: controller.signal });
          // 检查期间目录或 Provider 变了：丢弃旧结果，不自动对新配置发起请求
          const cur = get().modelCache[id];
          if (!cur || !sameList(cur.models, start.models) || (probeVersions.get(id) ?? 0) !== version
            || !get().custom.some((x) => x.id === id)) return null;
          const { unavailable: _u, probeSuspicious: _s, ...rest } = cur;
          const { unavailable, suspicious, ...probeSummary } = r;
          writeCache({
            ...get().modelCache,
            [id]: { ...rest, probedAt: Date.now(), probeSummary, ...(unavailable.length ? { unavailable } : {}), ...(suspicious ? { probeSuspicious: true } : {}) },
          });
          return r;
        } finally {
          probing.delete(id);
          set({ probingIds: get().probingIds.filter((x) => x !== id) });
        }
      })();
      probing.set(id, { promise: job, controller });
      return job;
    },
    cancelModelProbe(id) {
      probing.get(id)?.controller.abort();
    },
    setRegion(provider, region) {
      // 未知的 Provider 或地域直接忽略，保留原来的选择
      const e = officialEndpoint(provider);
      if (!e || e.regions.length < 2 || !e.regions.some((r) => r.id === region)) return;
      invalidateConfig(provider);
      const cur = get().providerPrefs;
      const providerPrefs: ProviderPrefs = { ...cur, regions: { ...cur.regions, [provider]: region } };
      set({ providerPrefs });
      persist("provider_prefs", providerPrefs);
      health.resetProvider(provider);
    },
    setOllamaEnabled(on) {
      const providerPrefs = { ...get().providerPrefs, ollama: on };
      set({ providerPrefs });
      persist("provider_prefs", providerPrefs);
    },
    setLocalJev(id) {
      const providerPrefs = { ...get().providerPrefs, localJev: id };
      set({ providerPrefs });
      persist("provider_prefs", providerPrefs);
      health.resetProvider("local-jev");
    },
    // 改了配置就清掉这个 Provider 的停用和熔断记录（见 stores/health.ts）；保存失败时不清
    setKey: (provider, key) =>
      attempt(async () => {
        invalidateConfig(provider);
        await getBackend().setProviderKey(provider, key);
        if (provider.startsWith("custom:")) cacheModels(provider, null);
        health.resetProvider(provider);
        await refresh();
      }),
    deleteKey: (provider) => attempt(async () => {
      invalidateConfig(provider);
      await getBackend().deleteProviderKey(provider);
      if (provider.startsWith("custom:")) cacheModels(provider, null);
      await refresh();
    }),
    setJevKey: (key) =>
      attempt(async () => {
        set({ jev: await getBackend().setJevKey(key) });
        health.resetProvider("cloud-jev");
      }),
    deleteJevKey: () => attempt(async () => set({ jev: await getBackend().deleteJevKey() })),
    async saveCustom(p, apiKey) {
      invalidateConfig(p.id);
      const before = get().custom.find((x) => x.id === p.id);
      try {
        const r = await getBackend().saveCustomProvider(p, apiKey);
        health.resetProvider(r.provider.id);
        // 本地决策模型用的正是这个 Provider 时一起重试
        if (get().providerPrefs.localJev?.startsWith(`${r.provider.id}/`)) health.resetProvider("local-jev");
        await refresh();
        // 地址、协议、认证或请求头变了，旧调用检查不再适用
        if (before && (before.base_url !== r.provider.base_url || (before.protocol ?? "openai") !== (r.provider.protocol ?? "openai")
          || JSON.stringify(before.headers) !== JSON.stringify(r.provider.headers) || apiKey?.trim())) cacheModels(r.provider.id, null);
        void get().refreshModels(r.provider.id);
        return r;
      } catch (e) {
        return toAppError(e);
      }
    },
    deleteCustom: (id) =>
      attempt(async () => {
        invalidateConfig(id);
        await getBackend().deleteCustomProvider(id);
        cacheModels(id, null);
        await refresh();
      }),
    async testConnection(target) {
      const url = testUrl(target, get().providerPrefs, get().custom);
      if (!url) return { ok: false, message: "未知的 Provider" };
      const t0 = Date.now();
      const configVersion = configVersions.get(target) ?? 0;
      const token = startCatalogRead(target);
      const changed = () => (configVersions.get(target) ?? 0) !== configVersion || testUrl(target, get().providerPrefs, get().custom) !== url;
      const stale = (): TestResult => ({ ok: false, stale: true, message: "Provider 配置已变更，请重新测试当前连接" });
      let r;
      try {
        r = await getBackend().providerRequest({ target, method: "GET", url });
      } catch (e) {
        if (changed()) return stale();
        return { ok: false, message: toAppError(e).message, latencyMs: Date.now() - t0 };
      }
      if (changed()) return stale();
      const latencyMs = Date.now() - t0;
      const detail = r.status >= 200 && r.status < 300 ? undefined : errorDetail(r.body);
      const fail = (message: string): TestResult => ({ ok: false, message, latencyMs, ...(detail && { detail }) });
      if (r.status >= 200 && r.status < 300) {
        const models = parseModels(r.body);
        // 自定义 Provider 顺手把列表缓存下来：输入框的模型下拉直接用
        if (models.length && get().custom.some((x) => x.id === target) && catalogReads.get(target) === token) cacheModels(target, models);
        return { ok: true, message: models.length ? `模型目录连接正常（HTTP ${r.status}），列出 ${models.length} 个模型；尚未检查推理调用` : `模型目录连接正常（HTTP ${r.status}）；尚未检查推理调用`, latencyMs, ...(models.length && { models }) };
      }
      if (r.status === 401 || r.status === 403) return fail(`认证失败（HTTP ${r.status}），请检查 Key`);
      // 部分兼容端点（如百炼兼容模式、一些中转站）不提供 /models，404 不能说明 Key 有问题
      if (r.status === 404) return fail("服务返回 HTTP 404：可能是地址有误，也可能该服务不提供模型列表（/models），无法据此判断 Key 是否有效");
      return fail(`服务返回 HTTP ${r.status}`);
    },
    async discoverModels(id) {
      const c = get().custom.find((x) => x.id === id);
      return c ? discover(getBackend(), c) : { ok: false, message: "请先保存这个 Provider" };
    },
    setRouting(patch) {
      const routing = { ...get().routing, ...patch };
      set({ routing });
      persist("routing", routing);
    },
    setOverride(profileId, patch) {
      const overrides = { ...get().overrides };
      if (patch === null) delete overrides[profileId];
      else {
        // 只保存和内置值不同的字段：改回默认值时对应字段自动消失
        const base = effectiveProfiles({}, get().custom).find((p) => p.id === profileId);
        const merged: Record<string, unknown> = { ...overrides[profileId], ...patch };
        // 能力列表按集合比较，顺序不同也算相同
        const norm = (v: unknown) => JSON.stringify(Array.isArray(v) ? [...v].sort() : v);
        for (const k of Object.keys(merged)) {
          const b = base?.[k as keyof ProfileOverride];
          if (merged[k] === undefined || norm(merged[k]) === norm(b)) delete merged[k];
        }
        if (Object.keys(merged).length) overrides[profileId] = merged as ProfileOverride;
        else delete overrides[profileId];
      }
      set({ overrides });
      persist("profiles", overrides);
    },
  };
});

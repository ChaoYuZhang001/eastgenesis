// 桌面端和浏览器共用的引擎组装：把后端（Key 状态、代理请求）接到决策层与 Agent 运行时。
// webview 里不出现真实 Key：适配器拿到占位 Key，请求经 proxiedFetch 交给 Rust 注入认证。
import { AgentRuntime, Coordinator, ToolRegistry, routedLlm, type AgentDeps, type AgentEvent, type Budget, type ConfirmRequest, type LlmCall, type MemoryNote, type Plan, type RuntimeFaultPoint, type SkillNote, type Tool } from "@/agent";
import {
  CloudJevBackend,
  DecisionLayer,
  FallbackChain,
  HealthTracker,
  JevClient,
  MODEL_PROFILES,
  RuleBasedBackend,
  type Availability,
  type ChainEntry,
  type ModelProfile,
  type PermissionMode,
  type RouteDecision,
} from "@/decision";
import { MAX_CUSTOM_MODELS, PROXY_PLACEHOLDER_KEY, customModels, isValidModelName, proxiedFetch, type Backend, type CustomProvider, type KeyStatus } from "@/platform";
import { DEFAULT_PROVIDER_PREFS, providerFactory, statusAvailability, type ProviderPrefs } from "./providers";

import { customProfiles } from "./custom-profiles";
import { localJevBackend } from "./local-decision";

export {
  DEFAULT_PROVIDER_PREFS,
  DEFAULT_REQUEST_TIMEOUT_S,
  REQUEST_TIMEOUT_OPTIONS,
  isLocal,
  parseProviderPrefs,
  parseTimeout,
  providerFactory,
  statusAvailability,
  type ProviderPrefs,
} from "./providers";
export { customProfileId, customProfiles, customReference, officialMatch } from "./custom-profiles";

/** 能力矩阵的用户调整，按 profile id 存 */
export type ProfileOverride = Partial<Pick<ModelProfile, "enabled" | "capabilities" | "cost_tier" | "quality_tier" | "latency_tier" | "context_window">>;
export type ProfileOverrides = Record<string, ProfileOverride>;

/** 手动干预：lock 表示整次任务只用这个模型（不降级）；next 表示只有下一次模型调用用它 */
export interface ModelOverride {
  mode: "lock" | "next";
  profileId: string;
}

/** 内置能力矩阵 + 自定义 Provider 的每个模型（见 custom-profiles.ts）+ 用户调整 */
export function effectiveProfiles(overrides: ProfileOverrides = {}, custom: readonly CustomProvider[] = []): ModelProfile[] {
  return [...MODEL_PROFILES, ...customProfiles(custom)].map((p) => ({ ...p, ...overrides[p.id], id: p.id, provider: p.provider }));
}

export interface ProfileOption {
  id: string;
  ok: boolean;
  /** 不可用时的原因，给手动干预下拉框展示 */
  reason: string | null;
}

/** 手动干预可选的模型：已启用的 profile，附带当前是否可用 */
export function profileOptions(profiles: readonly ModelProfile[], available: Availability): ProfileOption[] {
  return profiles
    .filter((p) => p.enabled)
    .map((p) => {
      const s = available(p);
      return { id: p.id, ok: s.ok, reason: s.ok ? null : s.reason };
    });
}

/** 在路由结果之上套一层手动干预。每次模型调用前读取一次干预状态 */
export function withOverride(
  route: RouteDecision,
  make: (r: RouteDecision) => LlmCall,
  profiles: readonly ModelProfile[],
  read: () => ModelOverride | null,
  consumeNext: () => void,
): LlmCall {
  const normal = make(route);
  return async (req, signal) => {
    const o = read();
    const p = o && profiles.find((x) => x.id === o.profileId);
    if (!o || !p) return normal(req, signal);
    const entry: ChainEntry = {
      profileId: p.id,
      provider: p.provider,
      stage: "primary",
      score: 0,
      breakdown: { capability: 0, quality: 0, cost: 0, latency: 0, availability: 1, total: 0 },
      reason: o.mode === "lock" ? "用户锁定" : "用户指定下一步",
    };
    if (o.mode === "next") consumeNext();
    // lock：只用这一个模型，失败就报错，不悄悄换模型；next：指定模型失败后回到原路由链
    const chain = o.mode === "lock" ? [entry] : [entry, ...route.chain.filter((c) => c.profileId !== p.id)];
    return make({ ...route, primary: entry, chain })(req, signal);
  };
}

/**
 * 输入框锁定的是 /models 发现、但还没登记进 Provider 的模型时，给这一次任务临时补进模型列表（不改保存的配置），
 * 这样能力矩阵里有它，路由和适配器都认得。锁定官方模型或已登记的模型时原样返回。
 */
export function withLockedModel(custom: readonly CustomProvider[], lock: string | null | undefined): readonly CustomProvider[] {
  if (!lock) return custom;
  const i = lock.indexOf("/");
  if (i <= 0) return custom;
  const pid = lock.slice(0, i);
  const model = lock.slice(i + 1);
  return custom.map((c) =>
    c.id !== pid || !isValidModelName(model) || customModels(c).includes(model) ? c : { ...c, models: [...(c.models ?? []), model].slice(-MAX_CUSTOM_MODELS) },
  );
}

export interface EngineOptions {
  backend: Backend;
  /** 单次运行的预算（目标模式按目标剩余额度给每一轮设定模型调用上限）；不给用 DEFAULT_BUDGET */
  budget?: Partial<Budget>;
  statuses: readonly KeyStatus[];
  jev: KeyStatus | null;
  custom?: readonly CustomProvider[];
  overrides?: ProfileOverrides;
  /** 地域、本机服务是否启用 */
  providerPrefs?: ProviderPrefs;
  /** 输入框的权限开关，默认「变更前确认」 */
  permission?: PermissionMode;
  /** 单次模型请求超时（毫秒），默认 90 秒（DEFAULT_REQUEST_TIMEOUT_S） */
  timeoutMs?: number;
  /** 第一次对话：回答后顺带对齐称呼、风格和边界 */
  onboarding?: boolean;
  tools?: readonly Tool[];
  /** 用户确认过、已按目标挑选的记忆 */
  memories?: readonly MemoryNote[];
  /** 项目、目标、任务三层叠加的说明（decision/project.ts resolveInstructions） */
  instructions?: string;
  /** 用户保存、已按目标挑选的技能 */
  skills?: readonly SkillNote[];
  /** 跨任务共用，熔断状态才能保留 */
  health?: HealthTracker;
  confirm?: (req: ConfirmRequest) => Promise<boolean>;
  /** 计划模式：规划完先给用户看，批准后才执行 */
  approvePlan?: (plan: Plan) => Promise<boolean>;
  onEvent?: (e: AgentEvent) => void;
  /** 手动干预：每次模型调用前读取 */
  override?: () => ModelOverride | null;
  consumeNext?: () => void;
  /** QA 构建的桌面故障夹具；普通任务不提供。 */
  fault?: { point: RuntimeFaultPoint; trigger: (point: RuntimeFaultPoint) => Promise<void> };
}

export function createEngine(o: EngineOptions): { runtime: AgentRuntime; coordinator: Coordinator; decision: DecisionLayer; profiles: ModelProfile[] } {
  const custom = o.custom ?? [];
  const prefs = o.providerPrefs ?? DEFAULT_PROVIDER_PREFS;
  const profiles = effectiveProfiles(o.overrides, custom);
  const health = o.health ?? new HealthTracker();
  // 第 1 级 Jev：只有 Rust 侧确认已配置 Key 时启用；请求经代理，webview 只有占位 Key
  // 同一个客户端也作为完成校验的裁判（目标模式 checkDoneWithEvidence 在规则拿不准时问它）
  const jevClient = o.jev?.configured ? new JevClient({ apiKey: PROXY_PLACEHOLDER_KEY, fetch: proxiedFetch(o.backend, "jev"), browserProxy: true }) : null;
  const cloud = jevClient ? new CloudJevBackend(jevClient) : new CloudJevBackend(null, "没有配置 Jev Key（在设置页配置）");
  // 第 2 级本地决策模型与路由共用适配器缓存
  const providerFor = providerFactory(o.backend, custom, prefs.regions, o.timeoutMs);
  const local = localJevBackend(prefs.localJev, profiles, custom, providerFor);
  const chain = new FallbackChain([cloud, local, new RuleBasedBackend()]);
  const tools = new ToolRegistry(o.tools ?? []);
  const decision = new DecisionLayer({
    chain,
    availability: statusAvailability(o.statuses, custom, health, prefs),
    tools: tools.defs(),
    profiles,
    health,
    permission: o.permission,
    judge: jevClient,
  });
  const make = (r: RouteDecision) => routedLlm(r, providerFor, health);
  const deps: AgentDeps = {
    decision,
    tools,
    memories: o.memories,
    instructions: o.instructions,
    ...(o.budget ? { budget: o.budget } : {}),
    skills: o.skills,
    llm: (route) => withOverride(route, make, profiles, o.override ?? (() => null), o.consumeNext ?? (() => {})),
    confirm: o.confirm,
    approvePlan: o.approvePlan,
    onEvent: o.onEvent,
    onboarding: o.onboarding,
    ...(o.fault ? { faultHooks: { onPoint: async ({ point }: { point: RuntimeFaultPoint }) => { if (point === o.fault!.point) await o.fault!.trigger(point); } } } : {}),
    ...(o.backend.getToolInvocation && o.backend.saveToolInvocation ? {
      ledger: {
        get: (key) => o.backend.getToolInvocation!(key),
        put: (record) => o.backend.saveToolInvocation!(record),
        ...(o.backend.claimToolInvocation ? { claim: (key, owner, now, ttlMs) => o.backend.claimToolInvocation!(key, owner, now, ttlMs) } : {}),
        ...(o.backend.renewToolInvocation ? { renew: (key, owner, now, ttlMs) => o.backend.renewToolInvocation!(key, owner, now, ttlMs) } : {}),
        ...(o.backend.releaseToolInvocation ? { release: (key, owner) => o.backend.releaseToolInvocation!(key, owner) } : {}),
      },
    } : {}),
  };
  // 单 Agent 和多 Agent 协同共用同一套决策层、工具、模型调用和确认渠道
  return { runtime: new AgentRuntime(deps), coordinator: new Coordinator(deps), decision, profiles };
}

// 路由规则引擎：按能力矩阵做多因子评分，输出主模型、降级链和选择原因。
// 降级链：主模型 → 备选 1 → 备选 2 → 规则兜底。
import { PROVIDER_ERROR_TEXT, ProviderError, type ProviderErrorCode } from "../core/llm/errors";
import { HealthTracker, type HealthStatus } from "./health";
import { ADAPTER_READY, MODEL_PROFILES, providerReadiness } from "./profiles";
import { classifyTask } from "./rules";
import { CAP_LABEL, HARD_CAPS, SOFT_CAPS, TYPE_LABEL, type Classification, type ModelProfile, type TaskInput, type TaskType } from "./types";

export type Preference = "economy" | "balanced" | "best";
export type LatencyPref = "fast" | "normal" | "patient";
export type Availability = (p: ModelProfile) => HealthStatus;

export interface RouteRequest extends TaskInput {
  /** 省钱 / 平衡 / 最强，默认 balanced */
  preference?: Preference;
  latency?: LatencyPref;
  /** 成本上限（cost_tier 1–5），硬性约束，降级时也不突破 */
  maxCostTier?: number;
  /** 本次已经试过、要排除的模型 */
  exclude?: readonly string[];
  /** 已有分类结果时直接使用（例如来自 Jev） */
  classification?: Classification;
  /** 用户在输入框手动锁定的模型（profile id）：跳过评分和降级，只用它；不可用时如实报错，不悄悄换模型 */
  lock?: string;
}

export interface Weights {
  capability: number;
  quality: number;
  cost: number;
  latency: number;
}

export interface ScoreBreakdown extends Weights {
  availability: number;
  total: number;
}

export type ChainStage = "primary" | "fallback" | "rule_fallback";

export interface ChainEntry {
  profileId: string;
  provider: string;
  stage: ChainStage;
  score: number;
  breakdown: ScoreBreakdown;
  reason: string;
}

export interface RouteDecision {
  classification: Classification;
  primary: ChainEntry | null;
  chain: ChainEntry[];
  weights: Weights;
  reasons: string[];
  excluded: { profileId: string; reason: string }[];
}

/** 各偏好的基础权重（能力匹配、质量、成本、延迟）；可用性作为乘数单独计算 */
export const PREFERENCE_WEIGHTS: Readonly<Record<Preference, Weights>> = {
  economy: { capability: 0.25, quality: 0.2, cost: 0.4, latency: 0.15 },
  balanced: { capability: 0.3, quality: 0.35, cost: 0.2, latency: 0.15 },
  best: { capability: 0.3, quality: 0.55, cost: 0.05, latency: 0.1 },
};
export const LATENCY_FACTOR: Readonly<Record<LatencyPref, number>> = { fast: 2, normal: 1, patient: 0.4 };
/** 任务对质量的需求系数：简单问答不必上旗舰，代码和推理更看重质量 */
export const QUALITY_NEED: Readonly<Record<TaskType, number>> = {
  qa: 0.6,
  code: 1.2,
  reasoning: 1.3,
  vision: 1,
  long_context: 1,
  tool_use: 1,
};
/** 过滤上下文窗口时给输出预留的 token */
export const OUTPUT_RESERVE_TOKENS = 8192;

const PREF_LABEL: Record<Preference, string> = { economy: "省钱", balanced: "平衡", best: "最强" };
const LAT_LABEL: Record<LatencyPref, string> = { fast: "要快", normal: "正常", patient: "不赶时间" };

export function weightsFor(pref: Preference, latency: LatencyPref, type: TaskType): Weights {
  const b = PREFERENCE_WEIGHTS[pref];
  const raw = {
    capability: b.capability,
    quality: b.quality * QUALITY_NEED[type],
    cost: b.cost,
    latency: b.latency * LATENCY_FACTOR[latency],
  };
  const sum = raw.capability + raw.quality + raw.cost + raw.latency;
  return {
    capability: raw.capability / sum,
    quality: raw.quality / sum,
    cost: raw.cost / sum,
    latency: raw.latency / sum,
  };
}

/** 默认可用性：有适配器、Key 已配置、未熔断 */
export function defaultAvailability(
  env: Record<string, string | undefined>,
  health: HealthTracker = new HealthTracker(),
  adapters: ReadonlySet<string> = ADAPTER_READY,
): Availability {
  return (p) => {
    const r = providerReadiness(p.provider, env, adapters);
    return r.ok ? health.status(p.id, p.provider) : r;
  };
}

function exclusion(p: ModelProfile, cls: Classification, req: RouteRequest, avail: Availability): string | null {
  if (!p.enabled) return "已停用";
  if (req.exclude?.includes(p.id)) return "本次已尝试";
  for (const cap of ["vision", "tool_use"] as const) {
    if (cls.capabilities.includes(cap) && !p.capabilities.includes(cap)) return `不支持${CAP_LABEL[cap]}`;
  }
  if (cls.estTokens + OUTPUT_RESERVE_TOKENS > p.context_window) {
    return `上下文窗口不足（需约 ${cls.estTokens} token，窗口 ${p.context_window}）`;
  }
  if (req.maxCostTier !== undefined && p.cost_tier > req.maxCostTier) return `超出成本上限（${p.cost_tier} 档 > ${req.maxCostTier} 档）`;
  const a = avail(p);
  return a.ok ? null : a.reason;
}

function score(p: ModelProfile, cls: Classification, w: Weights, health: number): ScoreBreakdown {
  const soft = cls.capabilities.filter((c) => SOFT_CAPS.includes(c));
  const capability = soft.length ? soft.filter((c) => p.capabilities.includes(c)).length / soft.length : 1;
  const quality = (p.quality_tier - 1) / 4;
  const cost = (5 - p.cost_tier) / 4;
  const latency = (5 - p.latency_tier) / 4;
  const base = w.capability * capability + w.quality * quality + w.cost * cost + w.latency * latency;
  // 健康度 1 → ×1，0.5（半开）→ ×0.75
  const total = base * (0.5 + 0.5 * health);
  return { capability, quality, cost, latency, availability: health, total };
}

const f2 = (x: number) => x.toFixed(2);
const describe = (b: ScoreBreakdown) =>
  `总分 ${f2(b.total)}（能力 ${f2(b.capability)} · 质量 ${f2(b.quality)} · 成本 ${f2(b.cost)} · 延迟 ${f2(b.latency)} · 可用性 ${f2(b.availability)}）`;

const ZERO_BREAKDOWN: ScoreBreakdown = { capability: 0, quality: 0, cost: 0, latency: 0, availability: 0, total: 0 };

/** 手动锁定：链上只有这一个模型。成本上限不适用（用户明确选了它），能力不匹配只提示不拦截 */
function lockedRoute(req: RouteRequest & { lock: string }, profiles: readonly ModelProfile[], cls: Classification, w: Weights, avail: Availability): RouteDecision {
  const reasons = [
    `任务类型：${TYPE_LABEL[cls.type]}（${cls.signals.join("；") || "没有特殊信号"}）`,
    `手动锁定：${req.lock}，跳过路由决策`,
  ];
  const fail = (why: string): RouteDecision => {
    reasons.push(why);
    return { classification: cls, primary: null, chain: [], weights: w, reasons, excluded: [{ profileId: req.lock, reason: why }] };
  };
  const p = profiles.find((x) => x.id === req.lock);
  if (!p) return fail(`锁定的模型不存在：${req.lock}（在输入框改回「自动路由」或换一个模型）`);
  if (!p.enabled) return fail(`锁定的模型已停用：${req.lock}（在能力矩阵里启用，或改回「自动路由」）`);
  const a = avail(p);
  if (!a.ok) return fail(`锁定的模型不可用：${a.reason}（改回「自动路由」可以自动换模型）`);
  const missing = cls.capabilities.filter((c) => HARD_CAPS.includes(c) && !p.capabilities.includes(c));
  if (missing.length) reasons.push(`提示：能力矩阵里 ${p.id} 没有标注${missing.map((c) => CAP_LABEL[c]).join("、")}，按你的选择照常使用`);
  const entry: ChainEntry = { profileId: p.id, provider: p.provider, stage: "primary", score: 0, breakdown: { ...ZERO_BREAKDOWN, availability: a.health }, reason: "手动锁定" };
  return { classification: cls, primary: entry, chain: [entry], weights: w, reasons, excluded: [] };
}

export function route(
  req: RouteRequest,
  opts: { profiles?: readonly ModelProfile[]; availability: Availability },
): RouteDecision {
  const profiles = opts.profiles ?? MODEL_PROFILES;
  const cls = req.classification ?? classifyTask(req);
  const pref = req.preference ?? "balanced";
  const lat = req.latency ?? "normal";
  const w = weightsFor(pref, lat, cls.type);
  if (req.lock) return lockedRoute({ ...req, lock: req.lock }, profiles, cls, w, opts.availability);

  const excluded: RouteDecision["excluded"] = [];
  const scored: { p: ModelProfile; b: ScoreBreakdown }[] = [];
  for (const p of profiles) {
    const why = exclusion(p, cls, req, opts.availability);
    if (why) {
      excluded.push({ profileId: p.id, reason: why });
      continue;
    }
    const a = opts.availability(p);
    scored.push({ p, b: score(p, cls, w, a.ok ? a.health : 0) });
  }
  scored.sort(
    (x, y) =>
      y.b.total - x.b.total || y.p.quality_tier - x.p.quality_tier || x.p.cost_tier - y.p.cost_tier || x.p.id.localeCompare(y.p.id),
  );

  const chain: ChainEntry[] = [];
  const entry = (s: (typeof scored)[number], stage: ChainStage, reason: string): ChainEntry => ({
    profileId: s.p.id,
    provider: s.p.provider,
    stage,
    score: s.b.total,
    breakdown: s.b,
    reason,
  });
  if (scored[0]) chain.push(entry(scored[0], "primary", "评分最高"));
  // 备选优先换一家 Provider，避免同源故障（限流、宕机、Key 失效）连带失败
  for (let k = 0; k < 2; k++) {
    const used = new Set(chain.map((c) => c.provider));
    const inChain = (s: (typeof scored)[number]) => chain.some((c) => c.profileId === s.p.id);
    const diverse = scored.find((s) => !inChain(s) && !used.has(s.p.provider));
    const next = diverse ?? scored.find((s) => !inChain(s));
    if (!next) break;
    chain.push(entry(next, "fallback", diverse ? "换一家 Provider，避免同源故障" : "同一 Provider 的次优模型（没有其他可选 Provider）"));
  }
  // 规则兜底：不看评分，优先本地模型，其次成本、延迟最低
  const rest = scored.filter((s) => !chain.some((c) => c.profileId === s.p.id));
  rest.sort(
    (x, y) =>
      Number(y.p.provider === "ollama") - Number(x.p.provider === "ollama") ||
      x.p.cost_tier - y.p.cost_tier ||
      x.p.latency_tier - y.p.latency_tier ||
      x.p.id.localeCompare(y.p.id),
  );
  if (rest[0]) chain.push(entry(rest[0], "rule_fallback", "规则兜底：优先本地模型，其次成本、延迟最低"));

  const hard = cls.capabilities.filter((c) => HARD_CAPS.includes(c));
  const reasons = [
    `任务类型：${TYPE_LABEL[cls.type]}（${cls.signals.join("；") || "没有特殊信号"}）`,
    `硬性要求：${hard.map((c) => CAP_LABEL[c]).join("、") || "无"}；估算输入约 ${cls.estTokens} token`,
    `偏好：${PREF_LABEL[pref]}，延迟：${LAT_LABEL[lat]}${req.maxCostTier !== undefined ? `，成本上限 ${req.maxCostTier} 档` : ""}；权重 能力 ${f2(w.capability)} · 质量 ${f2(w.quality)} · 成本 ${f2(w.cost)} · 延迟 ${f2(w.latency)}`,
  ];
  for (const c of chain) {
    reasons.push(`${c.stage === "primary" ? "主模型" : c.stage === "fallback" ? "备选" : "兜底"} ${c.profileId}：${describe(c.breakdown)}；${c.reason}`);
  }
  if (excluded.length) {
    const groups = new Map<string, number>();
    for (const e of excluded) {
      const key = e.reason.split("（")[0];
      groups.set(key, (groups.get(key) ?? 0) + 1);
    }
    reasons.push(`排除 ${excluded.length} 个：${[...groups].map(([k, n]) => `${k} ${n}`).join("、")}`);
  }
  if (!chain.length) reasons.push("没有可用模型：请配置 OPENAI_API_KEY 或 ANTHROPIC_API_KEY，或放宽成本上限");

  return { classification: cls, primary: chain[0] ?? null, chain, weights: w, reasons, excluded };
}

// ---------- 执行降级链 ----------

/** retry：超时后等一会儿对同一个模型再试一次（这一条记录不算换模型） */
export type AttemptAction = "done" | "next" | "skip_provider" | "skipped" | "stop" | "retry";

export interface Attempt {
  profileId: string;
  stage: ChainStage;
  ok: boolean;
  errorCode?: string;
  latencyMs: number;
  action: AttemptAction;
  /** 因健康记录跳过时的原因（熔断中、Provider 已停用） */
  reason?: string;
  /** 服务端返回的 HTTP 状态码（有的话），给路由详情展示 */
  status?: number;
  /** 这个模型超时后已经重试过一次 */
  retried?: boolean;
}

/** 超时后重试前的等待；同一个模型只重试一次，再失败才换下一个 */
export const TIMEOUT_RETRY_DELAY_MS = 2000;

const isProviderCode = (c: string): c is ProviderErrorCode => Object.prototype.hasOwnProperty.call(PROVIDER_ERROR_TEXT, c);

/** 一次失败或跳过给用户看的原因：错误码换成中文说明，不直接显示 server、auth 之类的代码 */
export function attemptText(a: Attempt): string {
  if (a.reason) return a.reason;
  const c = a.errorCode;
  if (!c) return a.action;
  const base = isProviderCode(c) ? PROVIDER_ERROR_TEXT[c] : c === "provider_down" ? "同一 Provider 刚才鉴权或配置失败，已跳过" : "未知错误";
  if (a.action === "retry") return `${base}，${TIMEOUT_RETRY_DELAY_MS / 1000} 秒后重试`;
  return a.retried ? `${base}（已重试 1 次）` : base;
}

/** 可取消的等待：取消时抛出 aborted，和适配器的取消错误一致 */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new ProviderError("aborted", "router"));
    if (signal?.aborted) return abort();
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      abort();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class RouteExhaustedError extends Error {
  readonly code = "route_exhausted";
  constructor(
    readonly attempts: Attempt[],
    readonly lastError: unknown,
  ) {
    // 逐个写明试过哪个模型、为什么失败：卡片、时间线和 CLI 直接显示这段文字。超时重试的中间记录不单列，体现在「已重试 1 次」里
    const final = attempts.filter((a) => a.action !== "retry");
    super(`降级链上的 ${final.length} 个模型都没有成功：${final.map((a) => `${a.profileId}（${attemptText(a)}）`).join("、")}`);
    this.name = "RouteExhaustedError";
  }
  toAppError() {
    const summary = this.attempts.map((a) => `${a.profileId}:${a.errorCode ?? a.action}${a.action === "retry" ? "(retry)" : ""}`).join(", ");
    return { code: this.code, message: this.message, detail: summary };
  }
}

export interface FallbackOptions {
  health?: HealthTracker;
  now?: () => number;
  /** 用户取消时中断重试前的等待 */
  signal?: AbortSignal;
  /** 测试注入，默认真实等待 */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/**
 * 按降级链依次调用。触发规则：
 * - aborted：用户取消，立即停止并抛出
 * - timeout：等 2 秒对同一个模型重试一次（中转站偶发的慢请求很常见），再失败才记一次失败、换下一个
 * - auth / config：整个 Provider 下线，跳过它在链上的其他模型
 * - bad_request：换下一个；连续两个模型都报请求错误，说明请求本身有问题，停止
 * - rate_limit / network / server / not_found / 其他：记一次失败（参与熔断），换下一个
 * - 调用前先看健康记录：同一任务前几次调用已让它熔断或停用，直接跳过，不再等它失败；链上最后一个照试
 */
export async function executeWithFallback<T>(
  chain: readonly ChainEntry[],
  invoke: (entry: ChainEntry) => Promise<T>,
  opts: FallbackOptions = {},
): Promise<{ result: T; entry: ChainEntry; attempts: Attempt[] }> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? abortableSleep;
  const attempts: Attempt[] = [];
  const downProviders = new Set<string>();
  let badRequests = 0;
  let last: unknown = null;

  for (const e of chain) {
    const base = { profileId: e.profileId, stage: e.stage };
    if (downProviders.has(e.provider)) {
      attempts.push({ ...base, ok: false, latencyMs: 0, action: "skipped", errorCode: "provider_down" });
      continue;
    }
    // 路由在任务开始时算好，之后的每次调用都走同一条链；最后一个不跳过，免得一个都不试
    const h = e === chain[chain.length - 1] ? undefined : opts.health?.status(e.profileId, e.provider);
    if (h && !h.ok) {
      attempts.push({ ...base, ok: false, latencyMs: 0, action: "skipped", errorCode: "unhealthy", reason: h.reason });
      continue;
    }
    for (let retried = false; ; retried = true) {
      const t0 = now();
      const flag = retried ? { retried } : {};
      try {
        const result = await invoke(e);
        opts.health?.recordSuccess(e.profileId);
        attempts.push({ ...base, ok: true, latencyMs: now() - t0, action: "done", ...flag });
        return { result, entry: e, attempts };
      } catch (err) {
        last = err;
        const code = err instanceof ProviderError ? err.code : "unknown";
        const status = err instanceof ProviderError && err.status !== null ? { status: err.status } : {};
        const rec = { ...base, ok: false, latencyMs: now() - t0, errorCode: code, ...status, ...flag };
        if (code === "aborted") {
          attempts.push({ ...rec, action: "stop" });
          throw err;
        }
        if (code === "timeout" && !retried) {
          attempts.push({ ...rec, action: "retry" });
          await sleep(TIMEOUT_RETRY_DELAY_MS, opts.signal);
          continue;
        }
        if (code === "auth" || code === "config") {
          opts.health?.markProviderDown(e.provider, code === "auth" ? "鉴权失败" : "配置有误");
          downProviders.add(e.provider);
          attempts.push({ ...rec, action: "skip_provider" });
        } else if (code === "bad_request") {
          badRequests++;
          attempts.push({ ...rec, action: badRequests >= 2 ? "stop" : "next" });
          if (badRequests >= 2) throw new RouteExhaustedError(attempts, err);
        } else {
          opts.health?.recordFailure(e.profileId);
          attempts.push({ ...rec, action: "next" });
        }
        break;
      }
    }
  }
  throw new RouteExhaustedError(attempts, last);
}

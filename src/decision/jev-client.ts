// Jev 决策模型客户端（TypeSafe System One），封装 choice / score / noul 三种问题。
// - Key 只从环境变量 TYPESAFE_API_KEY 读取。桌面端（M5）改为由 Rust 侧读钥匙串并代理请求，Key 不进 webview。
// - 不打印 Key：关闭 SDK 日志（它在 debug 级会打印请求体）；错误细节先逐字抹掉 Key，再按规则脱敏。
// - 超时：单次尝试 2.5s（官方称 70–500ms 返回），整体时限 6s。429 / 529 / 5xx / 网络错误由 SDK 退避重试 1 次。
// - 只接受 https 端点。发送前对 state 脱敏并截断到 2 万字符（Jev 单次 64k token，state + 最长问题 32k）。
import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  APIUserAbortError,
  TypeSafeClient,
  TypeSafeError,
  choice as tsChoice,
  noul as tsNoul,
  score as tsScore,
  type EntryType,
  type Fetch,
  type Questions,
  type SystemOneResult,
} from "@typesafe-ai/sdk";
import { validateBaseUrl } from "../core/llm/registry";
import { redact } from "../core/redact";

export const JEV_KEY_ENV = "TYPESAFE_API_KEY";
export const JEV_BASE_URL = "https://api.typesafe.ai";
export const JEV_DEFAULT_MODEL = "jev-latest";
export const MAX_STATE_CHARS = 20_000;

export type JevErrorCode =
  | "no_key"
  | "auth"
  | "rate_limit"
  | "overloaded"
  | "server"
  | "timeout"
  | "network"
  | "bad_request"
  | "invalid_response"
  | "aborted"
  | "config"
  | "internal";

const RETRYABLE: ReadonlySet<JevErrorCode> = new Set(["rate_limit", "overloaded", "server", "timeout", "network"]);
const MESSAGES: Record<JevErrorCode, string> = {
  no_key: "没有配置 TYPESAFE_API_KEY",
  auth: "Jev 鉴权失败，请检查 TYPESAFE_API_KEY",
  rate_limit: "Jev 请求过于频繁",
  overloaded: "Jev 服务繁忙",
  server: "Jev 服务端错误",
  timeout: "Jev 请求超时",
  network: "无法连接 Jev 服务",
  bad_request: "Jev 请求参数有误",
  invalid_response: "Jev 返回的结果无法解析",
  aborted: "Jev 请求已取消",
  config: "Jev 配置有误",
  internal: "Jev 客户端内部错误",
};

export class JevError extends Error {
  readonly code: JevErrorCode;
  readonly status: number | null;
  readonly detail: string | null;
  constructor(code: JevErrorCode, opts: { status?: number; detail?: string; message?: string } = {}) {
    super(opts.message ?? MESSAGES[code]);
    this.name = "JevError";
    this.code = code;
    this.status = opts.status ?? null;
    this.detail = opts.detail ? redact(opts.detail).slice(0, 300) : null;
  }
  get retryable(): boolean {
    return RETRYABLE.has(this.code);
  }
  toAppError() {
    return { code: `jev_${this.code}`, message: this.message, detail: this.detail };
  }
}

export interface JevClientOptions {
  apiKey: string;
  baseURL?: string;
  model?: string;
  /** 单次尝试超时，默认 2500ms */
  timeoutMs?: number;
  /** 一次调用（含重试）的总时限，默认 6000ms */
  deadlineMs?: number;
  /** 失败后重试次数，默认 1 */
  maxRetries?: number;
  /** 首次退避时长，默认 300ms */
  backoffInitialMs?: number;
  fetch?: Fetch;
  /**
   * 桌面 webview 专用：请求经 Rust 的 provider_request 代理，apiKey 只是占位符，真实 Key 由 Rust 注入。
   * 只有同时提供 fetch（代理）时才生效；SDK 的浏览器保护依然拦截「浏览器里持有真实 Key」的用法。
   */
  browserProxy?: boolean;
}

const cap = (s: string) => (s.length > MAX_STATE_CHARS ? `${s.slice(0, MAX_STATE_CHARS)}…[已截断]` : s);

/** 发送前脱敏、截断 */
function prepareState(s: EntryType): EntryType {
  if (typeof s === "string") return cap(redact(s));
  if (s === null) return s;
  const json = redact(JSON.stringify(s));
  if (json.length > MAX_STATE_CHARS) return cap(json);
  try {
    return JSON.parse(json) as EntryType;
  } catch {
    return cap(json);
  }
}

function validate(res: any, questions: Questions): void {
  for (const [k, q] of Object.entries(questions) as [string, any][]) {
    const a = res?.answers?.[k];
    const bad = (why: string) => new JevError("invalid_response", { detail: `${k}：${why}` });
    if (!a || a.type !== q.type) throw bad("缺少回答或类型不符");
    if (a.type === "noul" && !(a.noul >= 0 && a.noul <= 1)) throw bad("noul 不在 0–1");
    if (a.type === "choice" && !Object.prototype.hasOwnProperty.call(q.criteria, a.choice)) throw bad("选项不在候选集中");
    if (a.type === "score" && !Number.isFinite(a.score)) throw bad("score 不是数字");
    if (a.type !== "noul" && !(a.confidence >= 0 && a.confidence <= 1)) throw bad("confidence 不在 0–1");
  }
}

export class JevClient {
  readonly model: string;
  readonly #client: TypeSafeClient;
  readonly #secret: string;
  readonly #deadlineMs: number;

  constructor(o: JevClientOptions) {
    if (!o.apiKey?.trim()) throw new JevError("no_key");
    let baseURL = JEV_BASE_URL;
    if (o.baseURL) {
      try {
        baseURL = validateBaseUrl(o.baseURL, "jev");
      } catch (e) {
        throw new JevError("config", { message: (e as Error).message });
      }
    }
    this.#secret = o.apiKey.trim();
    this.model = o.model ?? JEV_DEFAULT_MODEL;
    this.#deadlineMs = o.deadlineMs ?? 6000;
    try {
      this.#client = new TypeSafeClient({
        apiKey: this.#secret,
        baseURL,
        defaultModel: this.model,
        logLevel: "off",
        timeout: o.timeoutMs ?? 2500,
        retry: { maxRetries: o.maxRetries ?? 1, backoffInitialMs: o.backoffInitialMs ?? 300, backoffMaxMs: 2000, maxRetryAfterMs: 3000 },
        dangerouslyAllowBrowser: o.browserProxy === true && o.fetch !== undefined,
        fetch: o.fetch,
      });
    } catch (e) {
      throw new JevError("config", { detail: this.#scrub(String((e as Error).message ?? e)) });
    }
  }

  /** 没有配置 Key 时返回 null，调用方直接跳过第 1 级 */
  static fromEnv(env: Record<string, string | undefined>, opts: Omit<JevClientOptions, "apiKey"> = {}): JevClient | null {
    const apiKey = env[JEV_KEY_ENV]?.trim();
    if (!apiKey) return null;
    return new JevClient({
      ...opts,
      apiKey,
      baseURL: env.TYPESAFE_BASE_URL?.trim() || opts.baseURL,
      model: env.TYPESAFE_DEFAULT_MODEL?.trim() || opts.model,
    });
  }

  #scrub(s: string): string {
    return redact(s.split(this.#secret).join("[REDACTED]"));
  }

  #map(e: unknown, deadlineHit: boolean): JevError {
    if (e instanceof JevError) return e;
    if (e instanceof APIUserAbortError) {
      return deadlineHit ? new JevError("timeout", { detail: `超过总时限 ${this.#deadlineMs}ms` }) : new JevError("aborted");
    }
    if (e instanceof APITimeoutError) return new JevError("timeout", { detail: `单次超时 ${e.timeoutMs}ms` });
    if (e instanceof APIConnectionError) return new JevError("network", { detail: this.#scrub(e.message) });
    if (e instanceof APIError) {
      const s = e.status;
      const code: JevErrorCode = s === 401 || s === 403 ? "auth" : s === 429 ? "rate_limit" : s === 529 ? "overloaded" : s >= 500 ? "server" : "bad_request";
      // 不带响应体：服务端可能回显请求内容
      return new JevError(code, { status: s, detail: `HTTP ${s}${e.requestId ? ` · request ${e.requestId}` : ""}` });
    }
    if (e instanceof TypeSafeError) return new JevError("bad_request", { detail: this.#scrub(e.message) });
    return new JevError("internal", { detail: this.#scrub(String(e)).slice(0, 200) });
  }

  /** 一次请求里问多个问题（Jev 并行评估，比分开调用快且便宜） */
  async ask<const Q extends Questions>(state: EntryType, questions: Q, signal?: AbortSignal): Promise<SystemOneResult<Q>> {
    const ctrl = new AbortController();
    let deadlineHit = false;
    const timer = setTimeout(() => {
      deadlineHit = true;
      ctrl.abort();
    }, this.#deadlineMs);
    const onAbort = () => ctrl.abort();
    if (signal?.aborted) ctrl.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const res = await this.#client.systemOne({ state: prepareState(state), questions }, { signal: ctrl.signal });
      validate(res, questions);
      return res;
    } catch (e) {
      throw this.#map(e, deadlineHit);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  async choice<const T extends Record<string, string | null>>(state: EntryType, instructions: string, options: T, signal?: AbortSignal) {
    const r = await this.ask(state, { q: tsChoice(instructions, options) }, signal);
    const a = r.answers.q;
    return { choice: a.choice as keyof T & string, confidence: a.confidence, probabilities: a.probabilities as Record<string, number>, model: r.model };
  }

  async score(state: EntryType, instructions: string, levels: readonly [string, string, ...string[]], signal?: AbortSignal) {
    const r = await this.ask(state, { q: tsScore(instructions, levels) }, signal);
    return { score: r.answers.q.score, confidence: r.answers.q.confidence, model: r.model };
  }

  /** noul 没有单独的 confidence，这里用 |2p − 1| 表示确定程度 */
  async noul(state: EntryType, instructions: string, signal?: AbortSignal) {
    const r = await this.ask(state, { q: tsNoul(instructions) }, signal);
    const p = r.answers.q.noul;
    return { noul: p, confidence: Math.abs(2 * p - 1), model: r.model };
  }
}

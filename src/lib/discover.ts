// 从自定义 Provider 的 /models 读取模型列表（经 Rust 代理，用已保存的地址和 Key）。
// OpenAI 与 Anthropic 的列表格式都是 { data: [{ id }] }；少数中转站直接返回数组，也接受。
import { toAppError } from "@/lib/ipc";
import { isValidModelName, type Backend, type CustomProvider } from "@/platform";

/** 列表过长时只取前面这些，避免下拉框卡顿 */
export const MAX_DISCOVERED = 500;

export type DiscoverResult = { ok: true; models: string[] } | { ok: false; message: string };

function parseIds(body: string): string[] | null {
  let v: unknown;
  try {
    v = JSON.parse(body);
  } catch {
    return null;
  }
  const list = Array.isArray(v) ? v : (v as { data?: unknown } | null)?.data;
  if (!Array.isArray(list)) return null;
  return list.map((x) => (x as { id?: unknown } | null)?.id).filter((id): id is string => typeof id === "string");
}

/** 去重、过滤非法模型名并限长；格式认不出时返回空数组 */
export function parseModels(body: string): string[] {
  return [...new Set((parseIds(body) ?? []).map((s) => s.trim()).filter(isValidModelName))].slice(0, MAX_DISCOVERED);
}

// ---- 轻量探测：/models 列出来的不一定调得通（中转站常把没开通渠道的型号也列出来） ----

/** 单个探测的等待上限，覆盖响应头和完整正文；超时停止批次，不隐藏 */
export const PROBE_TIMEOUT_MS = 20_000;
/** 一次显式检查的总等待预算 */
export const PROBE_BATCH_TIMEOUT_MS = 60_000;
/** 同时探测的个数：别把中转站打出限流 */
export const PROBE_CONCURRENCY = 4;
/** 一次最多探测这么多个；更多的不探测，照常展示 */
export const MAX_PROBED = 100;

/** ok：调得通；missing：服务明确说没有这个模型（HTTP 404 或 model_not_found）；unknown：其他情况，照常展示 */
export type ProbeState = "ok" | "missing" | "unknown";
export type ProbeStopReason = "cancelled" | "timeout" | "budget";

export interface ProbeOptions {
  timeoutMs?: number;
  concurrency?: number;
  max?: number;
  signal?: AbortSignal;
  batchTimeoutMs?: number;
}

export interface ProbeResult {
  /** 确认不存在的模型：下拉里不展示 */
  unavailable: string[];
  /** 实际发起了多少次 transport 调用，不代表每次都已发出 HTTP */
  probed: number;
  /** 所有探测都是 404：多半是地址问题，这次结果不作数，不隐藏任何模型 */
  suspicious: boolean;
  total: number;
  /** 完整读取后 HTTP 2xx，只表示连接检查成功，不证明完整推理可用 */
  ok: number;
  missing: number;
  /** 已发起但错误、超时或取消，不能当成成功 */
  unknown: number;
  /** 未发起，包含超过模型数上限以及批次停止后的剩余模型 */
  notProbed: number;
  stopReason: ProbeStopReason | null;
}

const errorCode = (body: string): string => {
  try {
    const v = JSON.parse(body) as { error?: { code?: unknown; type?: unknown } | null; code?: unknown };
    return String(v.error?.code ?? v.error?.type ?? v.code ?? "");
  } catch {
    return "";
  }
};

function boundedOption(value: number | undefined, fallback: number, ceiling: number, zeroAllowed = false): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < (zeroAllowed ? 0 : 1)) throw new RangeError("probe_options_invalid");
  return Math.min(resolved, ceiling);
}

async function runProbe(
  backend: Backend,
  c: Pick<CustomProvider, "id" | "base_url" | "protocol">,
  model: string,
  timeoutMs: number,
  signal: AbortSignal,
  onTimeout: () => void,
): Promise<ProbeState> {
  if (signal.aborted) return "unknown";
  const anthropic = c.protocol === "anthropic";
  const req = {
    target: c.id,
    method: "POST" as const,
    url: `${c.base_url}${anthropic ? "/messages" : "/chat/completions"}`,
    body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: () => void = () => {};
  const interrupted = new Promise<null>((resolve) => {
    onAbort = () => resolve(null);
    signal.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => { onTimeout(); resolve(null); }, timeoutMs);
  });
  try {
    const response = (async () => {
      // The native raw-response channel can carry ordinary JSON. Do not add
      // stream:true to the probe payload. Its AbortSignal wakes native I/O.
      if (backend.providerStream) {
        const stream = await backend.providerStream(req, signal);
        return { status: stream.status, body: await stream.text() };
      }
      // Legacy buffered transports cannot be aborted. A timeout still stops
      // this batch, so it never launches replacements for abandoned waits.
      return backend.providerRequest(req);
    })();
    const r = await Promise.race([response, interrupted]);
    if (!r || signal.aborted) return "unknown";
    if (r.status >= 200 && r.status < 300) return "ok";
    if (r.status === 404 || errorCode(r.body) === "model_not_found") return "missing";
    return "unknown";
  } catch {
    return "unknown";
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}

/** 最小连接检查；超时会取消支持 raw-response stream 的 native 请求 */
export async function probeModel(
  backend: Backend,
  c: Pick<CustomProvider, "id" | "base_url" | "protocol">,
  model: string,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<ProbeState> {
  const controller = new AbortController();
  return runProbe(backend, c, model, boundedOption(timeoutMs, PROBE_TIMEOUT_MS, PROBE_TIMEOUT_MS), controller.signal, () => controller.abort());
}

/** 并发受限地探测一组模型，返回确认不存在的那些 */
export async function probeModels(
  backend: Backend,
  c: Pick<CustomProvider, "id" | "base_url" | "protocol">,
  models: readonly string[],
  o: ProbeOptions = {},
): Promise<ProbeResult> {
  const timeoutMs = boundedOption(o.timeoutMs, PROBE_TIMEOUT_MS, PROBE_TIMEOUT_MS);
  const batchTimeoutMs = boundedOption(o.batchTimeoutMs, PROBE_BATCH_TIMEOUT_MS, PROBE_BATCH_TIMEOUT_MS);
  const concurrency = boundedOption(o.concurrency, PROBE_CONCURRENCY, PROBE_CONCURRENCY);
  const list = models.slice(0, boundedOption(o.max, MAX_PROBED, MAX_PROBED, true));
  const states: (ProbeState | undefined)[] = new Array(list.length);
  let next = 0;
  let stopReason: ProbeStopReason | null = null;
  const controller = new AbortController();
  const stop = (reason: ProbeStopReason) => {
    if (stopReason !== null) return;
    stopReason = reason;
    controller.abort();
  };
  const onExternalAbort = () => stop("cancelled");
  o.signal?.addEventListener("abort", onExternalAbort, { once: true });
  if (o.signal?.aborted) stop("cancelled");
  const budget = list.length > 0 && stopReason === null ? setTimeout(() => stop("budget"), batchTimeoutMs) : undefined;
  const worker = async () => {
    while (stopReason === null && next < list.length) {
      const i = next++;
      states[i] = "unknown";
      states[i] = await runProbe(backend, c, list[i], timeoutMs, controller.signal, () => stop("timeout"));
    }
  };
  try { await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, worker)); }
  finally {
    clearTimeout(budget);
    o.signal?.removeEventListener("abort", onExternalAbort);
  }
  const probed = states.filter((state) => state !== undefined).length;
  const ok = states.filter((state) => state === "ok").length;
  const unknown = states.filter((state) => state === "unknown").length;
  const missing = list.filter((_, i) => states[i] === "missing");
  // 全部 404（且不止一个）：更像是对话地址不对，而不是每个模型都不存在
  const suspicious = stopReason === null && probed > 1 && missing.length === probed;
  return { unavailable: suspicious ? [] : missing, probed, suspicious, total: models.length,
    ok, missing: missing.length, unknown, notProbed: models.length - probed, stopReason };
}

export async function discoverModels(backend: Backend, c: Pick<CustomProvider, "id" | "base_url">): Promise<DiscoverResult> {
  let r;
  try {
    r = await backend.providerRequest({ target: c.id, method: "GET", url: `${c.base_url}/models` });
  } catch (e) {
    return { ok: false, message: toAppError(e).message };
  }
  if (r.status === 401 || r.status === 403) return { ok: false, message: `认证失败（HTTP ${r.status}），请检查 Key` };
  if (r.status === 404) return { ok: false, message: "该服务不提供模型列表（/models 返回 404），请手动填写模型名" };
  if (r.status < 200 || r.status >= 300) return { ok: false, message: `服务返回 HTTP ${r.status}` };
  if (!parseIds(r.body)) return { ok: false, message: "模型列表格式无法识别，请手动填写模型名" };
  const models = parseModels(r.body);
  if (!models.length) return { ok: false, message: "服务没有返回任何模型" };
  return { ok: true, models };
}

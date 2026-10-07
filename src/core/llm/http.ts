import { recordTerminalModelFailure } from "../goal-model-call";
import { ProviderError, codeFromStatus } from "./errors";
import type { FetchLike } from "./types";

/** 适配器单次请求的默认超时。应用里由设置页的「请求超时」覆盖（默认同为 90 秒） */
export const DEFAULT_LLM_TIMEOUT_MS = 90_000;

export interface HttpOptions {
  providerId: string;
  fetch: FetchLike;
  timeoutMs: number;
  /** 出错时从细节中抹掉的值（当前请求的 API Key） */
  secrets: readonly string[];
}

interface ResponseControl {
  cleanup: () => void;
  timedOut: () => boolean;
  callerAborted: () => boolean;
  timeoutMs: number;
  secrets: readonly string[];
}

// Headers 到达后 body 可能仍在流式读取。把取消状态绑定到 Response，直到
// readJson/readSse 的 finally 才清理，避免正文阶段失去调用方的 abort 监听。
const RESPONSE_CONTROLS = new WeakMap<Response, ResponseControl>();

function cleanupResponse(res: Response): void {
  RESPONSE_CONTROLS.get(res)?.cleanup();
  RESPONSE_CONTROLS.delete(res);
}

// Rust IPC rejects with a structured AppError. Preserve fixed transport codes
// without trusting response-derived message/detail fields. The router stops
// response_too_large and any failure after partial output; invalid_response
// before output can use the existing fallback policy with recorded attempts.
function nativeTransportFailure(providerId: string, error: unknown): ProviderError | null {
  if (error === null || typeof error !== "object" || !("code" in error)) return null;
  switch (error.code) {
    case "invalid_response":
      return new ProviderError("invalid_response", providerId, { detail: "Provider 响应不是完整的 UTF-8 文本" });
    case "response_too_large":
      return new ProviderError("response_too_large", providerId);
    case "timeout":
      return new ProviderError("timeout", providerId);
    case "aborted":
      return new ProviderError("aborted", providerId);
    default:
      return null;
  }
}

function streamReadFailure(res: Response, providerId: string, error: unknown): ProviderError {
  const control = RESPONSE_CONTROLS.get(res);
  if (control?.callerAborted()) return new ProviderError("aborted", providerId);
  if (control?.timedOut()) return new ProviderError("timeout", providerId, { detail: `${control.timeoutMs}ms` });
  const native = nativeTransportFailure(providerId, error);
  if (native) return native;
  return new ProviderError("network", providerId, { detail: scrub(String(error), control?.secrets ?? []) });
}

/** 发请求：统一超时、取消和错误映射。成功时返回 Response（调用方决定读 JSON 还是 SSE）。 */
export async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  opts: HttpOptions,
  signal?: AbortSignal,
): Promise<Response> {
  const ctrl = new AbortController();
  let timedOut = false;
  let callerAborted = signal?.aborted === true;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, opts.timeoutMs);
  const onAbort = () => {
    callerAborted = true;
    ctrl.abort();
  };
  if (callerAborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });

  let res: Response;
  try {
    res = await opts.fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    if (timedOut) throw new ProviderError("timeout", opts.providerId, { detail: `${opts.timeoutMs}ms` });
    if (callerAborted) throw new ProviderError("aborted", opts.providerId);
    const native = nativeTransportFailure(opts.providerId, e);
    if (native) throw native;
    throw new ProviderError("network", opts.providerId, { detail: scrub(String(e), opts.secrets) });
  }

  if (!res.ok) {
    let completed = false;
    const text = await res.text().then(body => { completed = true; return body; }, () => "");
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    const failure = new ProviderError(codeFromStatus(res.status), opts.providerId, {
      status: res.status,
      detail: scrub(`HTTP ${res.status}: ${text}`, opts.secrets),
    });
    throw completed && !timedOut && !callerAborted ? recordTerminalModelFailure(failure) : failure;
  }
  RESPONSE_CONTROLS.set(res, {
    cleanup: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
    timedOut: () => timedOut,
    callerAborted: () => callerAborted,
    timeoutMs: opts.timeoutMs,
    secrets: opts.secrets,
  });
  return res;
}

function scrub(s: string, secrets: readonly string[]): string {
  let out = s;
  for (const k of secrets) if (k) out = out.split(k).join("[REDACTED]");
  return out;
}

export async function readJson<T>(res: Response, providerId: string): Promise<T> {
  try {
    return (await res.json()) as T;
  } catch (error) {
    const control = RESPONSE_CONTROLS.get(res);
    if (control?.callerAborted() || control?.timedOut()) throw streamReadFailure(res, providerId, error);
    const native = nativeTransportFailure(providerId, error);
    if (native) throw native;
    throw new ProviderError("invalid_response", providerId, { detail: "响应不是合法 JSON" });
  } finally {
    cleanupResponse(res);
  }
}

/** 解析 SSE：按空行切分事件，容忍跨 chunk 的半行和 \r\n。 */
export async function* readSse(res: Response, providerId: string): AsyncGenerator<{ event: string | null; data: string }> {
  if (!res.body) {
    cleanupResponse(res);
    throw new ProviderError("invalid_response", providerId, { detail: "流式响应没有 body" });
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (value) buf += decoder.decode(value, { stream: true });
      if (done) buf += decoder.decode();
      buf = buf.replace(/\r\n/g, "\n");
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const ev = parseEvent(raw);
        if (ev) yield ev;
      }
      if (done) {
        const ev = parseEvent(buf);
        if (ev) yield ev;
        return;
      }
    }
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw streamReadFailure(res, providerId, error);
  } finally {
    // Protocol terminals such as [DONE] can precede HTTP EOF. Closing this
    // generator must also cancel the unread body, otherwise Rust keeps reading
    // an idle connection after the task has already completed. Do not wait on
    // an arbitrary fetch implementation's cancellation promise.
    void reader.cancel().catch(() => {});
    reader.releaseLock();
    cleanupResponse(res);
  }
}

function parseEvent(raw: string): { event: string | null; data: string } | null {
  let event: string | null = null;
  const data: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith(":")) continue;
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
  }
  return data.length ? { event, data: data.join("\n") } : null;
}

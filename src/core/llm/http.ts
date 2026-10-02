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
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, opts.timeoutMs);
  const onAbort = () => ctrl.abort();
  signal?.addEventListener("abort", onAbort, { once: true });

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
    if (signal?.aborted) throw new ProviderError("aborted", opts.providerId);
    throw new ProviderError("network", opts.providerId, { detail: scrub(String(e), opts.secrets) });
  }
  clearTimeout(timer);
  signal?.removeEventListener("abort", onAbort);

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ProviderError(codeFromStatus(res.status), opts.providerId, {
      status: res.status,
      detail: scrub(`HTTP ${res.status}: ${text}`, opts.secrets),
    });
  }
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
  } catch {
    throw new ProviderError("invalid_response", providerId, { detail: "响应不是合法 JSON" });
  }
}

/** 解析 SSE：按空行切分事件，容忍跨 chunk 的半行和 \r\n。 */
export async function* readSse(res: Response, providerId: string): AsyncGenerator<{ event: string | null; data: string }> {
  if (!res.body) throw new ProviderError("invalid_response", providerId, { detail: "流式响应没有 body" });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
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

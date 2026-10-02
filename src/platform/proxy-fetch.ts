// fetch 形状的适配层：模型适配器（OpenAI/Anthropic）和 Jev SDK 照常「发请求」，实际交给后端的 provider_request。
// - 前端传入的请求头全部丢弃，认证由 Rust 侧从钥匙串注入；webview 里只有占位 Key。
// - 后端错误转成 TypeError（与 fetch 的网络错误一致），由调用方按网络错误处理。
// - 取消：只停止等待，Rust 侧已发出的请求会自然结束（最长 180s 超时）。
import { toAppError, type AppError } from "@/lib/ipc";
import type { Backend } from "./types";

/** webview 里给适配器用的占位 Key，真实 Key 只在 Rust 进程内 */
export const PROXY_PLACEHOLDER_KEY = "proxied-by-rust";

export class ProxyError extends TypeError {
  constructor(readonly appError: AppError) {
    super(`${appError.message}（${appError.code}）`);
    this.name = "ProxyError";
  }
}

const NULL_BODY = new Set([204, 205, 304]);

function contentType(body: string): string {
  const s = body.trimStart();
  if (s.startsWith("{") || s.startsWith("[")) return "application/json";
  if (s.startsWith("data:") || s.startsWith("event:")) return "text/event-stream";
  return "text/plain; charset=utf-8";
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

function raceAbort<T>(p: Promise<T>, signal?: AbortSignal | null): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

export function proxiedFetch(backend: Backend, target: string) {
  return async (input: string, init: RequestInit = {}): Promise<Response> => {
    const method = (init.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "POST") throw new ProxyError({ code: "proxy_method", message: "只允许 GET 和 POST" });
    if (init.body != null && typeof init.body !== "string") {
      throw new ProxyError({ code: "proxy_body", message: "请求体必须是字符串" });
    }
    let res;
    try {
      res = await raceAbort(backend.providerRequest({ target, method, url: String(input), body: init.body ?? null }), init.signal);
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") throw e;
      throw new ProxyError(toAppError(e, "proxy_failed"));
    }
    const status = res.status >= 200 && res.status <= 599 ? res.status : 502;
    if (NULL_BODY.has(status)) return new Response(null, { status });
    return new Response(res.body, { status, headers: { "content-type": contentType(res.body) } });
  };
}

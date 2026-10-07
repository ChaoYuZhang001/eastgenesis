// fetch 形状的适配层：模型适配器（OpenAI/Anthropic）和 Jev SDK 照常「发请求」，实际交给后端的 provider_request。
// - 前端传入的请求头全部丢弃，认证由 Rust 侧从钥匙串注入；webview 里只有占位 Key。
// - 后端错误保留固定机器码，适配器区分超时、格式/大小失败与网络错误。
// - 取消：流式桌面请求立即结束前端等待并唤醒 Rust 异步读取，释放响应连接。
import { toAppError, type AppError } from "@/lib/ipc";
import type { Backend } from "./types";

/** webview 里给适配器用的占位 Key，真实 Key 只在 Rust 进程内 */
export const PROXY_PLACEHOLDER_KEY = "proxied-by-rust";

export class ProxyError extends TypeError {
  readonly code: string;
  constructor(readonly appError: AppError) {
    super(`${appError.message}（${appError.code}）`);
    this.name = "ProxyError";
    this.code = appError.code;
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
    // Desktop Tauri can carry an SSE body over an IPC Channel. Keep the
    // browser/mock path on the existing buffered proxy so tests and web mode
    // remain deterministic; only opt in when the request explicitly asks for
    // `stream: true`.
    let wantsStream = false;
    if (method === "POST" && typeof init.body === "string") {
      try {
        wantsStream = (JSON.parse(init.body) as { stream?: unknown }).stream === true;
      } catch {
        // The Provider adapter will report the normal invalid-request error.
      }
    }
    if (wantsStream && backend.providerStream) {
      return backend.providerStream({ target, method: method as "POST", url: String(input), body: init.body ?? null }, init.signal ?? undefined);
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

// JSON-RPC 2.0 连接（MCP 的消息层）。传输层可替换：stdio（CLI）、内存（测试）、Tauri IPC（M5）。
export type JsonRpcId = number | string;
export interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface Transport {
  send(m: JsonRpcMessage): void;
  onMessage(cb: (m: unknown) => void): void;
  onClose(cb: (reason?: string) => void): void;
  close(): Promise<void>;
}

export type McpErrorCode = "timeout" | "closed" | "rpc" | "protocol" | "unsupported_protocol" | "aborted" | "mcp_server_not_allowed";

export class McpError extends Error {
  constructor(
    readonly code: McpErrorCode,
    message: string,
    readonly rpcCode?: number,
  ) {
    super(message);
    this.name = "McpError";
  }
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

export class JsonRpcConnection {
  #next = 1;
  #closed: string | null = null;
  readonly #pending = new Map<JsonRpcId, Pending>();

  constructor(
    private readonly t: Transport,
    private readonly timeoutMs = 30_000,
  ) {
    t.onMessage((m) => this.#handle(m));
    t.onClose((reason) => this.#fail(reason ?? "连接已关闭"));
  }

  request<T>(method: string, params?: unknown, signal?: AbortSignal): Promise<T> {
    if (this.#closed) return Promise.reject(new McpError("closed", this.#closed));
    if (signal?.aborted) return Promise.reject(new McpError("aborted", `${method} 已取消`));
    const id = this.#next++;
    return new Promise<T>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.#pending.delete(id);
        signal?.removeEventListener("abort", onAbort);
      };
      const cancel = (e: McpError) => {
        cleanup();
        this.notify("notifications/cancelled", { requestId: id, reason: e.message });
        reject(e);
      };
      const timer = setTimeout(() => cancel(new McpError("timeout", `${method} 超时（${this.timeoutMs}ms）`)), this.timeoutMs);
      const onAbort = () => cancel(new McpError("aborted", `${method} 已取消`));
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#pending.set(id, {
        resolve: (v) => {
          cleanup();
          resolve(v as T);
        },
        reject: (e) => {
          cleanup();
          reject(e);
        },
      });
      try {
        this.t.send({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) });
      } catch (e) {
        cleanup();
        reject(new McpError("closed", e instanceof Error ? e.message : String(e)));
      }
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.#closed) return;
    try {
      this.t.send({ jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) });
    } catch {
      // 通知发送失败不影响调用方
    }
  }

  #handle(raw: unknown): void {
    if (typeof raw !== "object" || raw === null) return;
    const m = raw as JsonRpcMessage;
    if (typeof m.method === "string") {
      // 服务器发来的请求：只响应 ping；不支持 sampling、roots、elicitation 等，一律返回 method not found
      if (m.id !== undefined) {
        this.t.send(
          m.method === "ping"
            ? { jsonrpc: "2.0", id: m.id, result: {} }
            : { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `不支持的方法：${m.method.slice(0, 60)}` } },
        );
      }
      return;
    }
    if (m.id === undefined) return;
    const p = this.#pending.get(m.id);
    if (!p) return;
    if (m.error) p.reject(new McpError("rpc", String(m.error.message ?? "RPC 错误").slice(0, 300), m.error.code));
    else p.resolve(m.result);
  }

  #fail(reason: string): void {
    if (this.#closed) return;
    this.#closed = reason;
    for (const p of [...this.#pending.values()]) p.reject(new McpError("closed", reason));
  }

  async close(): Promise<void> {
    this.#fail("连接已关闭");
    await this.t.close();
  }
}

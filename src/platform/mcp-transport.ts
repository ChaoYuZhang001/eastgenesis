// 桌面端的 MCP Transport：进程由 Rust 侧 McpService 按 mcp.json 登记表启动，这里只按行收发 JSON-RPC 消息。
// 协议仍由 src/agent/mcp/client.ts 处理；CLI 继续用 Node 的 StdioTransport。
import { McpClient } from "@/agent/mcp/client";
import type { JsonRpcMessage, Transport } from "@/agent/mcp/jsonrpc";
import { toAppError } from "@/lib/ipc";
import type { Backend, McpServerView } from "./types";

/** 停止后最多等这么久的退出事件 */
const EXIT_WAIT_MS = 2_000;

export class BackendTransport implements Transport {
  readonly #msg: ((m: unknown) => void)[] = [];
  readonly #close: ((reason?: string) => void)[] = [];
  #ended: string | null = null;
  #off: (() => void) | null = null;
  /** Rust 侧启动时生效的配置（白名单、信任标注）；运行期间改 mcp.json 不影响它 */
  config: McpServerView | null = null;

  private constructor(
    private readonly backend: Backend,
    readonly server: string,
  ) {}

  /** 先注册监听，再按 ID 启动登记过的服务器，保证不丢最早的输出 */
  static async start(backend: Backend, server: string): Promise<BackendTransport> {
    const t = new BackendTransport(backend, server);
    t.#off = await backend.onMcp(server, { onLine: (l) => t.#onLine(l), onExit: (r) => t.#end(`MCP 服务器已退出（${r}）`) });
    try {
      t.config = await backend.mcpStart(server);
    } catch (e) {
      t.#off();
      throw toAppError(e, "mcp_spawn_failed");
    }
    return t;
  }

  #onLine(line: string): void {
    let m: unknown;
    try {
      m = JSON.parse(line);
    } catch {
      return; // 忽略非 JSON 行
    }
    for (const cb of this.#msg) cb(m);
  }

  #end(reason: string): void {
    if (this.#ended) return;
    this.#ended = reason;
    this.#off?.();
    for (const cb of this.#close) cb(reason);
  }

  send(m: JsonRpcMessage): void {
    if (this.#ended) throw new Error(this.#ended);
    this.backend.mcpSend(this.server, JSON.stringify(m)).catch((e) => this.#end(`无法写入 MCP 服务器：${toAppError(e).message}`));
  }

  onMessage(cb: (m: unknown) => void): void {
    this.#msg.push(cb);
  }

  onClose(cb: (reason?: string) => void): void {
    this.#close.push(cb);
  }

  /** 等退出事件到达再结束：否则它可能落到紧接着重新启动的新连接上 */
  async close(): Promise<void> {
    if (this.#ended) return;
    const exited = new Promise<void>((r) => this.#close.push(() => r()));
    const stopped = await this.backend.mcpStop(this.server).catch(() => false);
    if (stopped) await Promise.race([exited, new Promise((r) => setTimeout(r, EXIT_WAIT_MS))]);
    this.#end("已关闭");
  }
}

export async function connectBackendServer(backend: Backend, server: string, timeoutMs?: number) {
  const transport = await BackendTransport.start(backend, server);
  const client = new McpClient(transport, { timeoutMs });
  try {
    await client.initialize();
  } catch (e) {
    await transport.close();
    throw e;
  }
  return { client, transport };
}

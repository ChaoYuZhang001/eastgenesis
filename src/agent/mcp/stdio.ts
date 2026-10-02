// MCP stdio 传输（仅 Node / CLI）。桌面端在 M5 由 Rust 侧管理 MCP 进程，经 Tauri IPC 传输。
// - 不经过 shell（shell: false），参数不会被解释，避免命令注入。
// - 子进程只继承最小环境变量加配置里显式给出的变量：我们自己的 API Key 不会泄露给 MCP 服务器。
import { spawn, type ChildProcess } from "node:child_process";
import { redact } from "../../core/redact";
import { McpClient } from "./client";
import type { JsonRpcMessage, Transport } from "./jsonrpc";

export interface StdioServerConfig {
  command: string;
  args?: string[];
  /** 显式传给服务器的环境变量（例如它自己需要的 Token） */
  env?: Record<string, string>;
  cwd?: string;
}

const PASS_ENV = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TMPDIR", "TEMP", "TMP", "SystemRoot", "ComSpec", "APPDATA", "LOCALAPPDATA", "USERPROFILE"];
const MAX_LINE = 10_000_000;

export function childEnv(parent: Record<string, string | undefined>, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of PASS_ENV) {
    const v = parent[k];
    if (v !== undefined) env[k] = v;
  }
  return { ...env, ...extra };
}

export class StdioTransport implements Transport {
  readonly #proc: ChildProcess;
  readonly #msg: ((m: unknown) => void)[] = [];
  readonly #close: ((reason?: string) => void)[] = [];
  #buf = "";
  #stderr = "";
  #ended: string | null = null;

  constructor(cfg: StdioServerConfig, parentEnv: Record<string, string | undefined> = process.env) {
    this.#proc = spawn(cfg.command, cfg.args ?? [], {
      cwd: cfg.cwd,
      env: childEnv(parentEnv, cfg.env),
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
    });
    this.#proc.stdout?.setEncoding("utf8");
    this.#proc.stdout?.on("data", (chunk: string) => this.#onData(chunk));
    this.#proc.stderr?.setEncoding("utf8");
    this.#proc.stderr?.on("data", (c: string) => {
      this.#stderr = (this.#stderr + c).slice(-2000);
    });
    // 服务器没起来或提前退出时写 stdin 会报 EPIPE：转为连接关闭，而不是未处理的异常
    this.#proc.stdin?.on("error", (e) => this.#end(`MCP 服务器输入流错误：${e.message}`));
    this.#proc.on("error", (e) => this.#end(`无法启动 MCP 服务器：${e.message}`));
    this.#proc.on("exit", (code, sig) => this.#end(`MCP 服务器已退出（${sig ?? code}）`));
  }

  #onData(chunk: string): void {
    this.#buf += chunk;
    let i: number;
    while ((i = this.#buf.indexOf("\n")) >= 0) {
      const line = this.#buf.slice(0, i).trim();
      this.#buf = this.#buf.slice(i + 1);
      if (!line) continue;
      let m: unknown;
      try {
        m = JSON.parse(line);
      } catch {
        continue; // 忽略非 JSON 行
      }
      for (const cb of this.#msg) cb(m);
    }
    if (this.#buf.length > MAX_LINE) this.#buf = "";
  }

  #end(reason: string): void {
    if (this.#ended) return;
    this.#ended = reason;
    for (const cb of this.#close) cb(reason);
  }

  /** 服务器 stderr 的最后 2000 字符（已脱敏），用于诊断 */
  get stderrTail(): string {
    return redact(this.#stderr);
  }

  send(m: JsonRpcMessage): void {
    if (this.#ended) throw new Error(this.#ended);
    this.#proc.stdin?.write(`${JSON.stringify(m)}\n`);
  }

  onMessage(cb: (m: unknown) => void): void {
    this.#msg.push(cb);
  }

  onClose(cb: (reason?: string) => void): void {
    this.#close.push(cb);
  }

  async close(): Promise<void> {
    if (this.#proc.exitCode !== null || this.#proc.signalCode !== null) return;
    this.#proc.stdin?.end();
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        this.#proc.kill("SIGKILL");
        resolve();
      }, 2000);
      this.#proc.once("exit", () => {
        clearTimeout(t);
        resolve();
      });
    });
  }
}

export async function connectStdioServer(
  cfg: StdioServerConfig,
  opts: { parentEnv?: Record<string, string | undefined>; timeoutMs?: number } = {},
): Promise<{ client: McpClient; transport: StdioTransport }> {
  const transport = new StdioTransport(cfg, opts.parentEnv);
  const client = new McpClient(transport, { timeoutMs: opts.timeoutMs });
  await client.initialize();
  return { client, transport };
}

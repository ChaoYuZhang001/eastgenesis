// 最小 MCP 客户端：initialize、tools/list（分页）、tools/call，以及把 MCP 工具转换为运行时工具。
// 安全策略：
// - 工具必须在服务器策略的 allowTools 中才会注册（工具调用白名单）。
// - 服务器自报的标注不可信：更谨慎的标注（destructiveHint）总是采纳，放宽的标注（readOnlyHint）只在 trustAnnotations 时采纳。
// - 未信任的工具默认视为访问外部服务，执行前需要用户确认。
import type { SideEffect } from "../../decision/decision-layer";
import { TOOL_NAME } from "../tools";
import type { Tool } from "../types";
import { JsonRpcConnection, McpError, type Transport } from "./jsonrpc";

/** 优先使用列表中的第一个版本；服务器回应其他版本时，只接受列表内的 */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = ["2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_TOOLS = 500;

export interface McpToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}
export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: McpToolAnnotations;
}
export interface McpCallResult {
  ok: boolean;
  content: string;
  data?: unknown;
}

const isObj = (x: unknown): x is Record<string, any> => typeof x === "object" && x !== null && !Array.isArray(x);

export class McpClient {
  readonly #rpc: JsonRpcConnection;
  protocolVersion: string | null = null;
  serverInfo: { name?: string; version?: string } | null = null;

  constructor(transport: Transport, opts: { timeoutMs?: number } = {}) {
    this.#rpc = new JsonRpcConnection(transport, opts.timeoutMs);
  }

  async initialize(signal?: AbortSignal): Promise<{ protocolVersion: string; serverInfo: McpClient["serverInfo"] }> {
    const r = await this.#rpc.request<any>(
      "initialize",
      { protocolVersion: SUPPORTED_PROTOCOL_VERSIONS[0], capabilities: {}, clientInfo: { name: "EastGenesis Desktop", version: "0.1.0" } },
      signal,
    );
    const v = isObj(r) ? r.protocolVersion : undefined;
    if (typeof v !== "string" || !SUPPORTED_PROTOCOL_VERSIONS.includes(v)) {
      await this.close();
      throw new McpError("unsupported_protocol", `不支持的 MCP 协议版本：${String(v).slice(0, 40)}`);
    }
    this.protocolVersion = v;
    this.serverInfo = isObj(r.serverInfo) ? { name: String(r.serverInfo.name ?? ""), version: String(r.serverInfo.version ?? "") } : null;
    this.#rpc.notify("notifications/initialized");
    return { protocolVersion: v, serverInfo: this.serverInfo };
  }

  async listTools(signal?: AbortSignal): Promise<McpToolInfo[]> {
    const out: McpToolInfo[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20 && out.length < MAX_TOOLS; page++) {
      const r = await this.#rpc.request<any>("tools/list", cursor ? { cursor } : {}, signal);
      if (!isObj(r) || !Array.isArray(r.tools)) throw new McpError("protocol", "tools/list 返回格式无效");
      for (const t of r.tools) {
        if (!isObj(t) || typeof t.name !== "string" || !t.name) continue;
        out.push({
          name: t.name,
          ...(typeof t.description === "string" ? { description: t.description } : {}),
          ...(isObj(t.inputSchema) ? { inputSchema: t.inputSchema } : {}),
          ...(isObj(t.annotations) ? { annotations: t.annotations as McpToolAnnotations } : {}),
        });
      }
      if (typeof r.nextCursor !== "string" || !r.nextCursor) break;
      cursor = r.nextCursor;
    }
    return out.slice(0, MAX_TOOLS);
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallResult> {
    const r = await this.#rpc.request<any>("tools/call", { name, arguments: args }, signal);
    const parts: unknown[] = isObj(r) && Array.isArray(r.content) ? r.content : [];
    const content = parts
      .map((c) => {
        if (!isObj(c)) return "";
        if (c.type === "text") return String(c.text ?? "");
        if (c.type === "image") return "[图片]";
        if (c.type === "audio") return "[音频]";
        if (c.type === "resource" || c.type === "resource_link") return `[资源 ${String(c.resource?.uri ?? c.uri ?? "").slice(0, 200)}]`;
        return `[${String(c.type ?? "未知内容").slice(0, 30)}]`;
      })
      .join("\n");
    return { ok: !(isObj(r) && r.isError === true), content, ...(isObj(r) && r.structuredContent !== undefined ? { data: r.structuredContent } : {}) };
  }

  close(): Promise<void> {
    return this.#rpc.close();
  }
}

export interface McpServerPolicy {
  /** 服务器 ID，用于工具命名空间：/^[a-z0-9][a-z0-9_]{0,31}$/ */
  server: string;
  /** 允许注册的工具（服务器上的原始名称）；"*" 表示全部，需要显式写出 */
  allowTools: readonly string[] | "*";
  /** 是否信任服务器的只读等放宽类标注，默认 false */
  trustAnnotations?: boolean;
  timeoutMs?: number;
}

const SERVER_ID = /^[a-z0-9][a-z0-9_]{0,31}$/;
/** 删除类工具：执行前确认两次 */
const CONFIRM_TWICE = /^(delete|remove|unlink|rm)(_|$)/i;

/** MCP 服务器白名单：不在登记表里的服务器拒绝注册（CLI 和脚本用；桌面端由 Rust 侧按 mcp.json 拦截） */
export function assertServerAllowed(server: string, registered: readonly string[]): void {
  if (!registered.includes(server)) throw new McpError("mcp_server_not_allowed", `MCP 服务器 ${server.slice(0, 40)} 不在白名单，拒绝注册`);
}

export function sideEffectFor(a: McpToolAnnotations | undefined, trusted: boolean): SideEffect {
  if (a?.destructiveHint === true) return "destructive";
  if (trusted && a?.readOnlyHint === true) return "none";
  if (trusted && a?.destructiveHint === false) return a.openWorldHint ? "external" : "local_write";
  return "external";
}

export function mcpTools(
  client: Pick<McpClient, "callTool">,
  infos: readonly McpToolInfo[],
  policy: McpServerPolicy,
): { tools: Tool[]; skipped: { name: string; reason: string }[] } {
  if (!SERVER_ID.test(policy.server)) throw new Error(`MCP 服务器 ID 无效：${policy.server}`);
  const prefix = `mcp__${policy.server}__`;
  const tools: Tool[] = [];
  const skipped: { name: string; reason: string }[] = [];
  const seen = new Set<string>();
  for (const info of infos) {
    if (policy.allowTools !== "*" && !policy.allowTools.includes(info.name)) {
      skipped.push({ name: info.name, reason: "不在白名单" });
      continue;
    }
    const local = info.name.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 64 - prefix.length);
    const name = `${prefix}${local}`;
    if (!local || !TOOL_NAME.test(name) || seen.has(name)) {
      skipped.push({ name: info.name, reason: "名称无效或冲突" });
      continue;
    }
    seen.add(name);
    const desc = (info.description ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
    const sideEffect = sideEffectFor(info.annotations, policy.trustAnnotations === true);
    tools.push({
      name,
      description: `[MCP:${policy.server}] ${desc || info.name}`,
      sideEffect,
      ...(sideEffect === "destructive" && CONFIRM_TWICE.test(info.name) ? { confirmTwice: true } : {}),
      ...(info.inputSchema ? { inputSchema: info.inputSchema } : {}),
      ...(policy.timeoutMs ? { timeoutMs: policy.timeoutMs } : {}),
      run: (args, ctx) => client.callTool(info.name, args, ctx.signal),
    });
  }
  return { tools, skipped };
}

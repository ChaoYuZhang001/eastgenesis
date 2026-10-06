// 最小 MCP 客户端：initialize、tools/list（分页）、tools/call，以及把 MCP 工具转换为运行时工具。
// 安全策略：
// - 工具必须在服务器策略的 allowTools 中才会注册（工具调用白名单）。
// - 服务器自报的标注不可信：更谨慎的标注（destructiveHint）总是采纳，放宽的标注（readOnlyHint）只在 trustAnnotations 时采纳。
// - 未信任的工具默认视为访问外部服务，执行前需要用户确认。
import type { SideEffect } from "../../decision/decision-layer";
import { TOOL_NAME } from "../tools";
import type { Tool } from "../types";
import type { ArtifactRef, ToolProbeResult } from "../tool-contract";
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
  /** 只缓存当前进程内已成功或正在进行的幂等调用；失败、超时和断线都会移除。 */
  readonly #idempotent = new Map<string, Promise<McpCallResult>>();
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

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal, idempotencyKey?: string): Promise<McpCallResult> {
    const cached = idempotencyKey ? this.#idempotent.get(idempotencyKey) : undefined;
    if (cached) return cached;
    const request = (async (): Promise<McpCallResult> => {
      const r = await this.#rpc.request<any>(
        "tools/call",
        { name, arguments: args, ...(idempotencyKey ? { _meta: { "com.eastgenesis/idempotencyKey": idempotencyKey } } : {}) },
        signal,
      );
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
    })();
    if (!idempotencyKey) return request;
    const tracked = request.then(
      (result) => {
        if (!result.ok) this.#idempotent.delete(idempotencyKey);
        return result;
      },
      (error) => {
        this.#idempotent.delete(idempotencyKey);
        throw error;
      },
    );
    this.#idempotent.set(idempotencyKey, tracked);
    return tracked;
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
  const allowedRaw = new Set(infos.filter((info) => policy.allowTools === "*" || policy.allowTools.includes(info.name)).map((info) => info.name));
  const hasRaw = (name: string) => allowedRaw.has(name);
  const probeKey = (ctx: Parameters<NonNullable<Tool["probe"]>>[1], suffix: string) => ctx.invocation ? `${ctx.invocation.idempotencyKey}:probe:${suffix}` : undefined;
  const missing = (result: McpCallResult) => !result.ok && /not_found|路径不存在|不存在/.test(result.content);
  const objectData = (result: McpCallResult): Record<string, unknown> | null => isObj(result.data) ? result.data : null;
  const fileArtifact = (action: ArtifactRef["action"], path: string, ok: boolean, to?: string): ArtifactRef => ({ kind: "file", action, path, ...(to ? { to } : {}), ok });
  const filesProbe = (raw: string): Tool["probe"] | undefined => {
    if (policy.server !== "files") return undefined;
    const info = async (path: string, ctx: Parameters<NonNullable<Tool["probe"]>>[1], suffix: string) => {
      if (!hasRaw("get_file_info")) return null;
      const result = await client.callTool("get_file_info", { path }, ctx.signal, probeKey(ctx, `${raw}:${suffix}`));
      if (result.ok) return { data: objectData(result), missing: false, result };
      return { data: null, missing: missing(result), result };
    };
    if (raw === "write_file" && hasRaw("read_file")) {
      return async (args, ctx): Promise<ToolProbeResult> => {
        const path = typeof args.path === "string" ? args.path : "";
        const content = typeof args.content === "string" ? args.content : null;
        if (!path || content === null) return { state: "unknown", detail: "缺少可验证的 path 或 content" };
        const result = await client.callTool("read_file", { path }, ctx.signal, probeKey(ctx, "write_file"));
        if (!result.ok) return missing(result) ? { state: "not_applied", detail: "目标文件不存在，写入尚未落地", artifacts: [fileArtifact("modify", path, false)] } : { state: "unknown", detail: `无法读取目标文件：${result.content}` };
        const data = objectData(result);
        if (!data || data.truncated === true || typeof data.content !== "string") return { state: "unknown", detail: "目标文件内容被截断，无法安全比对" };
        if (data.content === content) return { state: "applied", detail: "目标文件内容与本次写入一致", artifacts: [fileArtifact("modify", path, true)] };
        return { state: "conflict", detail: "目标文件已存在，但内容与本次写入不一致；不会自动覆盖", artifacts: [fileArtifact("modify", path, false)] };
      };
    }
    if ((raw === "create_directory" || raw === "delete_file") && hasRaw("get_file_info")) {
      return async (args, ctx): Promise<ToolProbeResult> => {
        const path = typeof args.path === "string" ? args.path : "";
        if (!path) return { state: "unknown", detail: "缺少可验证的 path" };
        const observed = await info(path, ctx, "path");
        if (!observed) return { state: "unknown", detail: "没有可用的文件状态查询" };
        if (raw === "create_directory") {
          if (!observed.data && observed.missing) return { state: "not_applied", detail: "目录不存在，创建尚未落地", artifacts: [fileArtifact("create", path, false)] };
          if (!observed.data) return { state: "unknown", detail: "无法读取目标目录状态" };
          if (observed.data.type === "directory") return { state: "applied", detail: "目录已经存在，创建已落地", artifacts: [fileArtifact("create", path, true)] };
          return { state: "conflict", detail: "目标路径已被非目录条目占用", artifacts: [fileArtifact("create", path, false)] };
        }
        if (!observed.data && observed.missing) return { state: "applied", detail: "目标文件已不存在，删除已落地", artifacts: [fileArtifact("delete", path, true)] };
        if (!observed.data) return { state: "unknown", detail: "无法读取目标文件状态" };
        if (observed.data.type === "directory") return { state: "conflict", detail: "目标仍是目录，删除操作不会处理目录", artifacts: [fileArtifact("delete", path, false)] };
        return { state: "not_applied", detail: "目标文件仍存在，删除尚未落地", artifacts: [fileArtifact("delete", path, false)] };
      };
    }
    if (raw === "move_file" && hasRaw("get_file_info")) {
      return async (args, ctx): Promise<ToolProbeResult> => {
        const src = typeof args.src === "string" ? args.src : "";
        const dst = typeof args.dst === "string" ? args.dst : "";
        if (!src || !dst) return { state: "unknown", detail: "缺少可验证的 src 或 dst" };
        const destination = await info(dst, ctx, "dst");
        if (!destination || (!destination.data && !destination.missing)) return { state: "unknown", detail: "无法读取目标路径状态" };
        const destinationData = destination?.data;
        const base = src.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "";
        const expected = destinationData?.type === "directory" ? `${dst.replace(/[\\/]+$/, "")}/${base}` : dst;
        const [source, target] = await Promise.all([info(src, ctx, "src"), info(expected, ctx, "expected")]);
        if (!source || !target) return { state: "unknown", detail: "没有可用的文件状态查询" };
        if ((!source.data && !source.missing) || (!target.data && !target.missing)) return { state: "unknown", detail: "无法读取源或目标路径状态" };
        if (!source.data && target.data) return { state: "applied", detail: `目标已位于 ${expected}`, artifacts: [fileArtifact("move", src, true, expected)] };
        if (source.data && !target.data) return { state: "not_applied", detail: "源文件仍存在，移动尚未落地", artifacts: [fileArtifact("move", src, false, expected)] };
        if (!source.data && !target.data) return { state: "unknown", detail: "源和目标都不存在，无法判断移动结果" };
        return { state: "conflict", detail: "源和目标同时存在，无法安全判断是否应继续移动", artifacts: [fileArtifact("move", src, false, expected)] };
      };
    }
    return undefined;
  };
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
    const probe = filesProbe(info.name);
    tools.push({
      name,
      description: `[MCP:${policy.server}] ${desc || info.name}`,
      sideEffect,
      ...(sideEffect === "destructive" && CONFIRM_TWICE.test(info.name) ? { confirmTwice: true } : {}),
      ...(info.inputSchema ? { inputSchema: info.inputSchema } : {}),
      ...(policy.timeoutMs ? { timeoutMs: policy.timeoutMs } : {}),
      ...(info.annotations?.idempotentHint !== undefined ? { capability: { idempotent: info.annotations.idempotentHint } } : {}),
      ...(probe ? { probe } : {}),
      run: (args, ctx) => client.callTool(info.name, args, ctx.signal, ctx.invocation?.idempotencyKey),
    });
  }
  return { tools, skipped };
}

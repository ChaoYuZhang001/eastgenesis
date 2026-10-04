// 浏览器模式的 MCP：内存里的登记表和回显服务器，行为对齐 eg-core 的 McpService：
// 只能按 ID 启动登记过的服务器；发出的消息按启动时的 allowTools 再查一遍；密钥只记「已保存」，不保存值。
import { err } from "./mock-rules";
import type { Backend, FileRoot, McpHandlers, McpRegistry, McpServerView } from "./types";

/** 与 eg-core file_roots::validate_root 同一套规则（浏览器模式没有 Rust 侧校验，这里必须自己挡住） */
export const MAX_ROOTS = 24;
export function validateRoot(raw: string): string {
  const s = raw.trim();
  if (!s) throw err("invalid_root", "路径不能为空");
  if (s.length > 1024) throw err("invalid_root", "路径太长");
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(s)) throw err("invalid_root", "路径里有不可见的控制字符");
  const path = s.replace(/([\\/])[\\/]+/g, "$1").replace(/(.+)[\\/]$/, "$1");
  if (path === "/" || path === "//") throw err("invalid_root", "不能把整个磁盘加入允许列表");
  if (path === "~" || /^(\/Users|\/home)\/[^/]+$/.test(path)) throw err("invalid_root", "不能把整个家目录加入允许列表；请选择具体的子目录");
  if (!(path.startsWith("~/") || path.startsWith("/"))) throw err("invalid_root", "请写绝对路径或以 ~/ 开头的路径");
  if (path.split(/[\\/]/).includes("..")) throw err("invalid_root", "路径里不能有 ..");
  return path;
}

type McpBackend = Pick<
  Backend,
  "fileRootsList" | "fileRootsAdd" | "fileRootsRemove" | "mcpList" | "onMcp" | "mcpStart" | "mcpSend" | "mcpStop" | "setMcpSecret" | "deleteMcpSecret"
>;

const base = { args: [], env: {}, cwd: null, running: false, stderr_tail: null };

/** 演示用登记表：echo 只放行一个工具；notes 放行全部但不信任标注，并且要先在钥匙串保存密钥 */
const REGISTRY: Omit<McpServerView, "refs" | "running" | "stderr_tail">[] = [
  { ...base, id: "echo", command: "/usr/local/bin/mcp-echo", allow_tools: ["echo"], trust_annotations: true },
  { ...base, id: "notes", command: "/usr/local/bin/mcp-notes", env: { NOTES_TOKEN: "${keychain:NOTES_TOKEN}" }, allow_tools: "*", trust_annotations: false },
];
const ERRORS = [{ id: "remote", message: "只支持本机 stdio 服务器（command + args），暂不支持 url / sse / http" }];

const TOOLS: Record<string, { name: string; description: string; annotations?: Record<string, boolean> }[]> = {
  echo: [
    { name: "echo", description: "原样返回输入（模拟）", annotations: { readOnlyHint: true } },
    { name: "shout", description: "转成大写（模拟，未列入白名单）", annotations: { readOnlyHint: true } },
  ],
  notes: [
    { name: "list_notes", description: "列出笔记（模拟）", annotations: { readOnlyHint: true } },
    { name: "wipe_notes", description: "清空笔记（模拟）", annotations: { destructiveHint: true } },
  ],
};
const SCHEMA = { type: "object", properties: { text: { type: "string" } } };

type Msg = { id?: unknown; method?: unknown; params?: { name?: unknown; arguments?: { text?: unknown } }; result?: unknown; error?: unknown };

/** 与 eg-core mcp_guard 相同的规则 */
export function checkOutgoing(line: string, allow: string[] | "*"): Msg {
  let m: unknown;
  try {
    m = JSON.parse(line);
  } catch {
    throw err("invalid_message", "消息不是 JSON");
  }
  if (typeof m !== "object" || m === null || Array.isArray(m)) throw err("invalid_message", "只接受单条 JSON-RPC 消息");
  const msg = m as Msg;
  if (!("method" in msg)) {
    if (!("id" in msg) || !("result" in msg || "error" in msg)) throw err("invalid_message", "不是有效的 JSON-RPC 消息");
    return msg;
  }
  if (typeof msg.method !== "string") throw err("invalid_message", "method 应是字符串");
  const req = "id" in msg;
  if (!req && msg.method.startsWith("notifications/")) return msg;
  if (req && ["initialize", "ping", "tools/list"].includes(msg.method)) return msg;
  if (req && msg.method === "tools/call") {
    const name = typeof msg.params?.name === "string" ? msg.params.name : "";
    if (!name || (allow !== "*" && !allow.includes(name))) throw err("mcp_tool_not_allowed", `工具 ${name.slice(0, 64)} 不在这个服务器的 allowTools 白名单内`);
    return msg;
  }
  throw err("mcp_method_not_allowed", `不允许向 MCP 服务器发送 ${msg.method.slice(0, 40)}`);
}

function reply(server: string, msg: Msg): Record<string, unknown> {
  switch (msg.method) {
    case "initialize":
      return { result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: `mock-${server}`, version: "0.0.0" } } };
    case "tools/list":
      return { result: { tools: TOOLS[server].map((t) => ({ ...t, inputSchema: SCHEMA })) } };
    case "tools/call": {
      const text = String(msg.params?.arguments?.text ?? "");
      const out = msg.params?.name === "shout" ? text.toUpperCase() : msg.params?.name === "wipe_notes" ? "（模拟）已清空" : text;
      return { result: { content: [{ type: "text", text: out }] } };
    }
    case "ping":
      return { result: {} };
    default:
      return { error: { code: -32601, message: "Method not found" } };
  }
}

export function createMockMcp(): McpBackend {
  const handlers = new Map<string, McpHandlers>();
  const running = new Map<string, string[] | "*">();
  const secrets = new Set<string>();

  const view = (e: (typeof REGISTRY)[number]): McpServerView => ({
    ...e,
    refs: Object.values(e.env).flatMap((v) => [...v.matchAll(/\$\{keychain:(\w+)\}/g)].map((m) => ({ source: "keychain" as const, name: m[1], configured: secrets.has(`${e.id}/${m[1]}`) }))),
    running: running.has(e.id),
    stderr_tail: null,
  });
  const entry = (id: string) => {
    const e = REGISTRY.find((x) => x.id === id);
    if (!e) throw err("mcp_not_registered", "mcp.json 里没有登记这个 MCP 服务器");
    return view(e);
  };

  // 允许访问的目录：默认 ~/Downloads，其余由用户添加（浏览器模式只在这次运行里有效）
  let roots: FileRoot[] = [{ path: "~/Downloads", fixed: true }];

  return {
    fileRootsList: async (): Promise<FileRoot[]> => roots.map((r) => ({ ...r })),
    async fileRootsAdd(path: string) {
      const p = validateRoot(path);
      if (!roots.some((r) => r.path === p)) {
        if (roots.length >= MAX_ROOTS) throw err("invalid_root", `最多 ${MAX_ROOTS} 个目录，请先移除一些`);
        roots = [...roots, { path: p, fixed: false }];
      }
      return roots.map((r) => ({ ...r }));
    },
    async fileRootsRemove(path: string) {
      const p = validateRoot(path);
      if (roots.find((r) => r.path === p)?.fixed) throw err("invalid_root", "~/Downloads 是默认目录，不能移除");
      const had = roots.some((r) => r.path === p);
      if (!had) throw err("root_not_found", "这个目录不在允许列表里");
      roots = roots.filter((r) => r.path !== p);
      return roots.map((r) => ({ ...r }));
    },
    mcpList: async (): Promise<McpRegistry> => ({ path_hint: "~/Library/Application Support/com.eastgenesis.desktop/mcp.json", servers: REGISTRY.map(view), errors: ERRORS }),
    async onMcp(server, h) {
      handlers.set(server, h);
      return () => void (handlers.get(server) === h && handlers.delete(server));
    },
    async mcpStart(server) {
      const v = entry(server);
      const missing = v.refs.find((r) => !r.configured);
      if (missing) throw err("mcp_secret_missing", `钥匙串里还没有 ${missing.name}，请先在设置页保存`);
      if (running.has(server)) throw err("mcp_already_running", "这个 MCP 服务器已在运行");
      running.set(server, v.allow_tools);
      return { ...v, running: true };
    },
    async mcpSend(server, line) {
      if (/[\r\n]/.test(line)) throw err("invalid_message", "消息不能包含换行");
      const allow = running.get(server);
      if (!allow) throw err("mcp_not_running", "这个 MCP 服务器没有运行");
      const msg = checkOutgoing(line, allow);
      if (msg.id === undefined || typeof msg.method !== "string") return; // 通知和应答不用回
      const body = reply(server, msg);
      setTimeout(() => handlers.get(server)?.onLine(JSON.stringify({ jsonrpc: "2.0", id: msg.id, ...body })), 0);
    },
    async mcpStop(server) {
      const was = running.delete(server);
      if (was) setTimeout(() => handlers.get(server)?.onExit("stopped"), 0);
      return was;
    },
    async setMcpSecret(server, name, value) {
      if (!entry(server).refs.some((r) => r.name === name)) throw err("mcp_secret_not_referenced", "mcp.json 里这个服务器没有引用这个钥匙串条目");
      const v = value.trim();
      if (!v || v.length > 8192 || /[\u0000-\u001f\u007f-\u009f]/.test(v)) throw err("invalid_mcp_secret_value", "密钥格式无效（1–8192 个字符，不能包含换行或控制字符）");
      secrets.add(`${server}/${name}`); // 只记「已保存」，值丢弃
    },
    async deleteMcpSecret(server, name) {
      if (!/^[a-z0-9][a-z0-9_]{0,31}$/.test(server) || !/^[A-Za-z_]\w{0,63}$/.test(name)) throw err("invalid_mcp_secret", "MCP 服务器 ID 或密钥名无效");
      secrets.delete(`${server}/${name}`);
    },
  };
}

// MCP 连接：登记表（mcp.json，只读）+ 本次会话里已连接的服务器及其工具。
// 工具只按 Rust 侧启动时生效的 allowTools / trustAnnotations 注册；任务开始时取当时已连接服务器的工具。
import { create } from "zustand";
import { mcpTools, type McpToolInfo, type Tool } from "@/agent";
import { toAppError } from "@/lib/ipc";
import { connectBackendServer, getBackend, type BackendTransport, type McpRegistry, type McpServerView } from "@/platform";

export type McpConnStatus = "starting" | "running" | "failed";

export interface McpConn {
  status: McpConnStatus;
  /** 启动时生效的配置；运行期间改 mcp.json 要重启才生效 */
  config: McpServerView | null;
  infos: McpToolInfo[];
  tools: Tool[];
  skipped: { name: string; reason: string }[];
  serverInfo: string | null;
  error: string | null;
}

interface McpState {
  registry: McpRegistry | null;
  loadError: string | null;
  conns: Record<string, McpConn>;
  refresh(): Promise<void>;
  start(id: string): Promise<void>;
  /** 连接所有内置服务器（应用启动时调用一次；已在连接的跳过） */
  startBuiltins(): Promise<void>;
  stop(id: string): Promise<void>;
  setSecret(server: string, name: string, value: string): Promise<string | null>;
  deleteSecret(server: string, name: string): Promise<string | null>;
}

/** 首次通过 npx 等启动时可能要先下载，握手给足时间 */
const START_TIMEOUT_MS = 60_000;
const EXIT_WAIT_MS = 2_000;
const transports = new Map<string, BackendTransport>();
const EMPTY: McpConn = { status: "starting", config: null, infos: [], tools: [], skipped: [], serverInfo: null, error: null };

/** 界面重新加载后，Rust 侧可能还留着上次启动的进程：先停掉它并等它的退出事件过去，再重新连接 */
async function stopDetached(id: string): Promise<void> {
  const b = getBackend();
  let done = () => {};
  const exited = new Promise<void>((r) => (done = r));
  const off = await b.onMcp(id, { onLine: () => {}, onExit: () => done() });
  try {
    if (await b.mcpStop(id)) await Promise.race([exited, new Promise((r) => setTimeout(r, EXIT_WAIT_MS))]);
  } finally {
    off();
  }
}

async function connect(id: string) {
  try {
    return await connectBackendServer(getBackend(), id, START_TIMEOUT_MS);
  } catch (e) {
    if (toAppError(e).code !== "mcp_already_running") throw e;
    await stopDetached(id);
    return connectBackendServer(getBackend(), id, START_TIMEOUT_MS);
  }
}

export const useMcp = create<McpState>((set, get) => {
  const patch = (id: string, p: Partial<McpConn>) => set((s) => ({ conns: { ...s.conns, [id]: { ...(s.conns[id] ?? EMPTY), ...p } } }));
  const drop = (id: string) =>
    set((s) => {
      const conns = { ...s.conns };
      delete conns[id];
      return { conns };
    });
  const attempt = async (f: () => Promise<unknown>): Promise<string | null> => {
    try {
      await f();
      await get().refresh();
      return null;
    } catch (e) {
      return toAppError(e).message;
    }
  };

  return {
    registry: null,
    loadError: null,
    conns: {},
    async refresh() {
      try {
        set({ registry: await getBackend().mcpList(), loadError: null });
      } catch (e) {
        set({ loadError: toAppError(e).message });
      }
    },
    async start(id) {
      const cur = get().conns[id]?.status;
      if (cur === "starting" || cur === "running") return;
      patch(id, { ...EMPTY });
      try {
        const { client, transport } = await connect(id);
        transports.set(id, transport);
        transport.onClose((reason) => {
          // 主动停止时已先从 transports 移除；走到这里说明服务器意外退出或连接出错。
          // 不在这里停进程：Rust 侧保留它的 stderr，界面据此显示退出原因
          if (transports.get(id) !== transport) return;
          transports.delete(id);
          patch(id, { status: "failed", tools: [], error: reason ?? "连接已关闭" });
          void get().refresh();
        });
        const config = transport.config!;
        const infos = await client.listTools();
        const { tools, skipped } = mcpTools(client, infos, { server: id, allowTools: config.allow_tools, trustAnnotations: config.trust_annotations });
        const info = client.serverInfo;
        await get().refresh();
        patch(id, { status: "running", config, infos, tools, skipped, serverInfo: info?.name ? `${info.name} ${info.version ?? ""}`.trim() : null, error: null });
      } catch (e) {
        const t = transports.get(id);
        transports.delete(id);
        await t?.close();
        await get().refresh();
        patch(id, { status: "failed", tools: [], error: toAppError(e).message });
      }
    },
    async startBuiltins() {
      await get().refresh();
      const ids = (get().registry?.servers ?? []).filter((s) => s.builtin).map((s) => s.id);
      await Promise.all(ids.map((id) => get().start(id)));
    },
    // 先刷新登记表再移除连接：中间不会闪出「运行中（未连接）」
    async stop(id) {
      const t = transports.get(id);
      transports.delete(id);
      if (t) await t.close();
      else await getBackend().mcpStop(id).catch(() => false);
      await get().refresh();
      drop(id);
    },
    setSecret: (server, name, value) => attempt(() => getBackend().setMcpSecret(server, name, value)),
    deleteSecret: (server, name) => attempt(() => getBackend().deleteMcpSecret(server, name)),
  };
});

/** 当前已连接服务器的工具（任务开始时取一次） */
/**
 * 右侧面板预览文件：只走内置文件服务器已注册的只读工具（read_file / read_pdf），受它的沙箱目录限制；
 * 服务器没连上或路径不在允许目录里时返回原因，不另开读取通道。
 */
export async function previewFile(path: string, signal?: AbortSignal): Promise<{ ok: boolean; text: string }> {
  const conn = useMcp.getState().conns["files"];
  if (conn?.status !== "running") return { ok: false, text: "内置文件服务器没有运行，无法预览。" };
  const name = /\.pdf$/i.test(path) ? "mcp__files__read_pdf" : "mcp__files__read_file";
  const tool = conn.tools.find((t) => t.name === name && t.sideEffect === "none");
  if (!tool) return { ok: false, text: "内置文件服务器没有注册只读的读取工具，无法预览。" };
  const r = await tool.run({ path }, { signal: signal ?? new AbortController().signal });
  return { ok: r.ok, text: r.content };
}

/** 已连接服务器的工具；servers 给了就只要这些服务器的（输入框「+」› 插件里勾选的） */
export function activeMcpTools(servers: readonly string[] | null = null): Tool[] {
  return Object.entries(useMcp.getState().conns).flatMap(([id, c]) => (c.status === "running" && (!servers || servers.includes(id)) ? c.tools : []));
}

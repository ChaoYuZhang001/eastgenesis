// 桌面端：所有能力都走 Rust 侧的 Tauri 命令。命令名与 src-tauri/src/lib.rs 一一对应。
// 顶层参数用 camelCase（Tauri 自动转成 Rust 的 snake_case），嵌套结构体保持 snake_case 字段名。
import { call, type AppInfo } from "@/lib/ipc";
import { assertSupportedSchemaVersion, database, getSetting, readSchemaVersion, setSetting } from "@/lib/db";
import { recordQaStartup } from "@/lib/qa-startup";
import { listGoals, saveGoal, updateGoal } from "@/lib/db-goal";
import { deleteMemory, listMemories, saveMemory, touchMemories } from "@/lib/db-memory";
import { archiveProject, deleteProject, listProjects, projectUsage, saveProject, unarchiveProject } from "@/lib/db-project";
import { deleteSession, listSessions, listUsage, recordUsage, saveSession } from "@/lib/db-session";
import { claimToolInvocation, getToolInvocation, releaseToolInvocation, renewToolInvocation, saveToolInvocation } from "@/lib/db-invocation";
import { deleteSkill, listSkills, saveSkill, touchSkills } from "@/lib/db-skill";
import type { RuntimeFaultPoint } from "@/agent/tool-contract";
import type { Backend, FileRoot, CustomProvider, KeyStatus, McpHandlers, McpRegistry, McpServerView, ProxyRequest, ProxyResponse, ProxyStreamEvent, SavedProvider } from "./types";

interface McpLinePayload {
  server: string;
  line: string;
  connection_id?: string | null;
}
interface McpExitPayload {
  server: string;
  reason: string;
  connection_id?: string | null;
}

async function onMcp(server: string, h: McpHandlers): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  const offLine = await listen<McpLinePayload>("mcp-message", (e) => {
    if (e.payload.server === server && (h.connectionId === undefined || e.payload.connection_id === h.connectionId)) h.onLine(e.payload.line);
  });
  const offExit = await listen<McpExitPayload>("mcp-exit", (e) => {
    if (e.payload.server === server && (h.connectionId === undefined || e.payload.connection_id === h.connectionId)) h.onExit(e.payload.reason);
  });
  return () => {
    offLine();
    offExit();
  };
}

export function createTauriBackend(): Backend {
  async function providerStream(req: ProxyRequest, signal?: AbortSignal): Promise<Response> {
    const { Channel, invoke } = await import("@tauri-apps/api/core");
    if (signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
    const streamId = `provider-stream-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
    let resolveHeaders!: (status: number) => void;
    let rejectHeaders!: (error: unknown) => void;
    let headersReady = false;
    const ready = new Promise<number>((resolve, reject) => {
      resolveHeaders = resolve;
      rejectHeaders = reject;
    });
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    const queuedChunks: Uint8Array[] = [];
    let streamDone = false;
    let streamError: unknown = null;
    let invokeDone = false;
    let aborted = false;
    let settled = false;
    const pump = () => {
      const c = controller;
      if (!c || aborted || settled) return;
      if (queuedChunks.length && (c.desiredSize == null || c.desiredSize > 0)) {
        c.enqueue(queuedChunks.shift()!);
        return;
      }
      // An IPC terminal can arrive after `pull` is already waiting. Wake that
      // read here, but only once both queues have drained: controller.error()
      // would otherwise discard a previously enqueued partial chunk.
      if (queuedChunks.length === 0 && c.desiredSize !== null && c.desiredSize > 0 && (streamError !== null || streamDone)) {
        settled = true;
        signal?.removeEventListener("abort", cancel);
        if (streamError !== null) c.error(streamError);
        else c.close();
      }
    };
    const channel = new Channel<ProxyStreamEvent>((event) => {
      if (aborted || settled) return;
      if (event.type === "headers") {
        headersReady = true;
        resolveHeaders(event.status);
        return;
      }
      if (event.type === "chunk") {
        queuedChunks.push(new Uint8Array(event.data));
        pump();
      } else if (event.type === "done") {
        streamDone = true;
        pump();
      } else {
        const error = event.error;
        if (!headersReady) rejectHeaders(error);
        streamError = error;
        pump();
      }
    });
    const cancel = () => {
      if (aborted || settled) return;
      aborted = true;
      signal?.removeEventListener("abort", cancel);
      void invoke("provider_stream_cancel", { streamId });
      const error = new DOMException("The operation was aborted.", "AbortError");
      if (!headersReady) rejectHeaders(error);
      queuedChunks.length = 0;
      controller?.error(error);
    };
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
        pump();
        signal?.addEventListener("abort", cancel, { once: true });
      },
      pull: pump,
      cancel,
    });
    void invoke("provider_stream", { req: { ...req, body: req.body ?? null }, streamId, channel })
      .catch((error) => {
        invokeDone = true;
        if (aborted) return;
        if (!headersReady) rejectHeaders(error);
        streamError = error;
        pump();
      })
      .finally(() => { invokeDone = true; });
    const status = await ready;
    // `invokeDone` is intentionally only diagnostic: the channel owns the
    // response lifetime and may still deliver ordered chunks after headers.
    void invokeDone;
    return new Response(stream, { status, headers: { "content-type": "text/event-stream" } });
  }

  return {
    kind: "tauri",
    async init() {
      recordQaStartup("backend_init_started");
      recordQaStartup("app_info_started");
      const infoReady = call<AppInfo>("get_app_info").then((info) => {
        recordQaStartup("app_info_resolved");
        return info;
      }, (error: unknown) => {
        recordQaStartup("app_info_failed");
        throw error;
      });
      try {
        const [info, db] = await Promise.all([infoReady, database()]);
        recordQaStartup("schema_read_started");
        let schemaVersion: number | null;
        try {
          schemaVersion = await readSchemaVersion(db);
          recordQaStartup("schema_read_resolved");
        } catch (error) {
          recordQaStartup("schema_read_failed");
          throw error;
        }
        assertSupportedSchemaVersion(schemaVersion);
        // Vite removes this literal branch and its lazy QA chunk from ordinary builds.
        if (import.meta.env.VITE_QA_GOAL_OBSERVER === "1") {
          void import("@/lib/qa-goal-snapshot").then(({ installQaGoalObserver }) =>
            installQaGoalObserver({ select: db.select.bind(db) }, (command, args) => call(command, args)),
          ).catch(() => {});
        }
        recordQaStartup("backend_init_resolved");
        return { info, storage: "sqlite", schemaVersion };
      } catch (error) {
        recordQaStartup("backend_init_failed");
        throw error;
      }
    },

    qaFaultPoint: () => call<RuntimeFaultPoint | null>("qa_fault_point"),
    qaLedgerLeaseMs: () => call<number | null>("qa_ledger_lease_ms"),
    qaFaultExit: (point) => call<void>("qa_fault_exit", { point }),

    providerStatus: () => call<KeyStatus[]>("get_provider_status"),
    setProviderKey: (provider, key) => call<KeyStatus>("set_provider_key", { provider, key }),
    deleteProviderKey: (provider) => call<KeyStatus>("delete_provider_key", { provider }),

    jevStatus: () => call<KeyStatus>("get_jev_status"),
    setJevKey: (key) => call<KeyStatus>("set_jev_key", { key }),
    deleteJevKey: () => call<KeyStatus>("delete_jev_key"),

    listCustomProviders: () => call<CustomProvider[]>("list_custom_providers"),
    saveCustomProvider: (provider, apiKey) =>
      call<SavedProvider>("save_custom_provider", { provider, apiKey: apiKey?.trim() ? apiKey : null }),
    deleteCustomProvider: (id) => call<void>("delete_custom_provider", { id }),

    providerRequest: (req: ProxyRequest) => call<ProxyResponse>("provider_request", { req: { ...req, body: req.body ?? null } }),
    providerStream,

    fileRootsList: () => call<FileRoot[]>("file_roots_list"),
    fileRootsAdd: (path) => call<FileRoot[]>("file_roots_add", { path }),
    fileRootsRemove: (path) => call<FileRoot[]>("file_roots_remove", { path }),
    pickDirectory: (defaultPath) => call<string | null>("pick_directory", { defaultPath: defaultPath ?? null }),

    mcpList: () => call<McpRegistry>("mcp_list"),
    onMcp,
    mcpStart: (server, connectionId) => call<McpServerView>("mcp_start", { server, ...(connectionId === undefined ? {} : { connectionId }) }),
    mcpSend: (server, line, connectionId) => call<void>("mcp_send", { server, line, ...(connectionId === undefined ? {} : { connectionId }) }),
    mcpStop: (server, connectionId) => call<boolean>("mcp_stop", { server, ...(connectionId === undefined ? {} : { connectionId }) }),
    setMcpSecret: (server, name, value) => call<void>("set_mcp_secret", { server, name, value }),
    deleteMcpSecret: (server, name) => call<void>("delete_mcp_secret", { server, name }),

    listMemories,
    saveMemory: (m) => saveMemory(m),
    deleteMemory,
    touchMemories: (ids) => touchMemories(ids),
    listSkills,
    saveSkill: (s) => saveSkill(s),
    deleteSkill,
    touchSkills: (ids) => touchSkills(ids),
    // 只传声明过的参数：这些函数的第二个参数是测试用的 now
    listProjects,
    saveProject: (p) => saveProject(p),
    archiveProject: (id) => archiveProject(id),
    unarchiveProject: (id) => unarchiveProject(id),
    projectUsage,
    deleteProject: (id) => deleteProject(id),
    listGoals: (projectId) => listGoals(projectId),
    saveGoal: (g) => saveGoal(g),
    updateGoal: (id, change) => updateGoal(id, change),
    listSessions,
    saveSession: (s) => saveSession(s),
    deleteSession: (id) => deleteSession(id),
    recordUsage,
    listUsage,
    getToolInvocation,
    saveToolInvocation,
    claimToolInvocation,
    renewToolInvocation,
    releaseToolInvocation,

    loadSetting: getSetting,
    saveSetting: setSetting,
  };
}

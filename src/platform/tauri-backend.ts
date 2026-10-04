// 桌面端：所有能力都走 Rust 侧的 Tauri 命令。命令名与 src-tauri/src/lib.rs 一一对应。
// 顶层参数用 camelCase（Tauri 自动转成 Rust 的 snake_case），嵌套结构体保持 snake_case 字段名。
import { call, type AppInfo } from "@/lib/ipc";
import { database, getSetting, readSchemaVersion, setSetting } from "@/lib/db";
import { listGoals, saveGoal, updateGoal } from "@/lib/db-goal";
import { deleteMemory, listMemories, saveMemory, touchMemories } from "@/lib/db-memory";
import { archiveProject, deleteProject, listProjects, projectUsage, saveProject, unarchiveProject } from "@/lib/db-project";
import { deleteSession, listSessions, listUsage, recordUsage, saveSession } from "@/lib/db-session";
import { deleteSkill, listSkills, saveSkill, touchSkills } from "@/lib/db-skill";
import type { Backend, CustomProvider, KeyStatus, McpHandlers, McpRegistry, McpServerView, ProxyRequest, ProxyResponse, SavedProvider } from "./types";

interface McpLinePayload {
  server: string;
  line: string;
}
interface McpExitPayload {
  server: string;
  reason: string;
}

async function onMcp(server: string, h: McpHandlers): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  const offLine = await listen<McpLinePayload>("mcp-message", (e) => {
    if (e.payload.server === server) h.onLine(e.payload.line);
  });
  const offExit = await listen<McpExitPayload>("mcp-exit", (e) => {
    if (e.payload.server === server) h.onExit(e.payload.reason);
  });
  return () => {
    offLine();
    offExit();
  };
}

export function createTauriBackend(): Backend {
  return {
    kind: "tauri",
    async init() {
      const [info, db] = await Promise.all([call<AppInfo>("get_app_info"), database()]);
      return { info, storage: "sqlite", schemaVersion: await readSchemaVersion(db) };
    },

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

    mcpList: () => call<McpRegistry>("mcp_list"),
    onMcp,
    mcpStart: (server) => call<McpServerView>("mcp_start", { server }),
    mcpSend: (server, line) => call<void>("mcp_send", { server, line }),
    mcpStop: (server) => call<boolean>("mcp_stop", { server }),
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

    loadSetting: getSetting,
    saveSetting: setSetting,
  };
}

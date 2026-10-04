// 会话：内容栏「最近」「历史」里的每一项。一次会话由若干轮任务组成（见 stores/tasks.ts）。
// 迁移 5 起会话持久化：每轮结束后写回数据库，启动时读回（stores/history.ts）。
import { create } from "zustand";
import type { PermissionMode, Preference } from "@/decision";
import type { AttachedFile } from "@/lib/attachments";
import { MAX_FILES } from "@/lib/attachments";
import { newSessionId } from "@/decision/session";
import { useTasks, type TaskCard, type TaskMode } from "./tasks";
import { useSettings } from "./settings";
import { useMemory } from "./memory";

/** 会话标题：取第一句话，太长就截断 */
export const MAX_TITLE = 30;
/** 带进下一轮的历史对话最多多少字符 */
export const MAX_HISTORY_CHARS = 6000;

export interface Session {
  id: string;
  title: string;
  /** 新建时所在的当前项目；null 表示不属于任何项目 */
  projectId: string | null;
  createdAt: number;
  updatedAt: number;
}

interface ChatState {
  sessions: Session[];
  /** 当前会话；null 表示停在空白首屏 */
  activeId: string | null;
  /** 输入框里还没发出去的文本 */
  draft: string;
  /** 输入框附带的文件 */
  files: AttachedFile[];
  /** 输入框锁定的模型（profile id）；null 表示自动路由 */
  lock: string | null;
  permission: PermissionMode;
  multi: boolean;
  /** 输入框的路由模式：null 是「自动」，按 目标 > 项目 > 全局 取值；economy / best 是这个任务覆盖 */
  preference: Preference | null;
  /** 「+」菜单里的模式：快速（默认）、计划模式、目标 */
  mode: TaskMode;
  /** 这次任务的工作目录（告诉模型文件放在哪）；null 表示没指定 */
  workdir: string | null;
  /** 这次任务能用哪些 MCP 服务器的工具；null 表示所有已连接的 */
  servers: string[] | null;
  /** 会话列表的搜索词 */
  query: string;
  newSession(): void;
  select(id: string): void;
  setDraft(v: string): void;
  addFiles(files: readonly AttachedFile[]): void;
  removeFile(name: string): void;
  setLock(v: string | null): void;
  setPermission(v: PermissionMode): void;
  setMulti(v: boolean): void;
  setPreference(v: Preference | null): void;
  setMode(v: TaskMode): void;
  setWorkdir(v: string | null): void;
  setServers(v: string[] | null): void;
  setQuery(v: string): void;
  /** 发出当前草稿：新建会话（如果还没有）并提交任务；返回任务 id */
  send(opts?: SendOptions): string | null;
  /** 从会话列表里移除（项目删除时连带）；会话只在内存里 */
  removeSessions(ids: readonly string[]): void;
}

export interface SendOptions {
  /** 当前项目：新会话归入它，任务带上它的 id */
  projectId?: string | null;
  /** 任务层路由偏好：null 表示「自动」，按 目标 > 项目 > 全局 取值 */
  preference?: Preference | null;
  mode?: TaskMode;
  goalId?: string | null;
}

export const title = (goal: string) => {
  const line = goal.trim().split("\n")[0]!.trim();
  return line.length > MAX_TITLE ? `${line.slice(0, MAX_TITLE)}…` : line || "新会话";
};

/** 同一会话之前几轮：从新到旧填进预算，再按时间正序拼成对话 */
export function historyOf(tasks: readonly TaskCard[], sessionId: string, budget = MAX_HISTORY_CHARS): string {
  const done = tasks.filter((t) => t.sessionId === sessionId && t.summary).sort((a, b) => b.seq - a.seq);
  const turns: string[] = [];
  let left = budget;
  for (const t of done) {
    const turn = `用户：${t.goal}\n助手：${t.summary}`;
    if (turn.length > left) break;
    left -= turn.length;
    turns.push(turn);
  }
  return turns.reverse().join("\n\n");
}

/** 这一轮是不是第一次对话：还没引导过、也没有用户偏好，且没有别的任务正在问 */
export function shouldOnboard(tasks: readonly TaskCard[]): boolean {
  const s = useSettings.getState();
  if (!s.loaded || s.onboarded) return false;
  if (useMemory.getState().items.some((n) => n.kind === "preference")) return false;
  return !tasks.some((t) => t.onboarding && t.status === "running");
}

export const useChat = create<ChatState>((set, get) => ({
  sessions: [],
  activeId: null,
  draft: "",
  files: [],
  lock: null,
  permission: "confirm",
  multi: false,
  preference: null,
  mode: "quick",
  workdir: null,
  servers: null,
  query: "",

  // 回到空白首屏；锁定的模型和权限档位保留，它们是用户的偏好而不是会话数据
  newSession: () => set({ activeId: null, draft: "", files: [] }),
  select: (id) => set((s) => (s.sessions.some((x) => x.id === id) ? { activeId: id, draft: "", files: [] } : s)),
  setDraft: (draft) => set({ draft }),
  addFiles(files) {
    set((s) => {
      const merged = [...s.files];
      for (const f of files) {
        const i = merged.findIndex((x) => x.name === f.name);
        if (i >= 0) merged[i] = f;
        else if (merged.length < MAX_FILES) merged.push(f);
      }
      return { files: merged };
    });
  },
  removeFile: (name) => set((s) => ({ files: s.files.filter((f) => f.name !== name) })),
  // 锁定模型和「省钱 / 最强」互斥：锁定后跳过路由决策，偏好没有意义
  setLock: (lock) => set(lock ? { lock, preference: null } : { lock }),
  setPreference: (preference) => set({ preference, lock: null }),
  setMode: (mode) => set({ mode }),
  setWorkdir: (workdir) => set({ workdir }),
  setServers: (servers) => set({ servers }),
  setPermission: (permission) => set({ permission }),
  setMulti: (multi) => set({ multi }),
  setQuery: (query) => set({ query }),
  removeSessions: (ids) =>
    set((s) => ({ sessions: s.sessions.filter((x) => !ids.includes(x.id)), activeId: s.activeId && ids.includes(s.activeId) ? null : s.activeId })),

  send(opts = {}) {
    const { draft, files, lock, permission, multi, preference, workdir, servers } = get();
    const goal = draft.trim();
    if (!goal) return null;
    const now = Date.now();
    let sessionId = get().activeId;
    if (sessionId) {
      set((s) => ({ sessions: s.sessions.map((x) => (x.id === sessionId ? { ...x, updatedAt: now } : x)) }));
    } else {
      sessionId = newSessionId();
      const projectId = opts.projectId ?? null;
      set((s) => ({ sessions: [{ id: sessionId!, title: title(goal), projectId, createdAt: now, updatedAt: now }, ...s.sessions], activeId: sessionId }));
    }
    const tasks = useTasks.getState().tasks;
    const history = historyOf(tasks, sessionId);
    // 上一轮问过对齐问题：这一轮的回答整句作为待确认偏好
    const aligning = tasks.some((t) => t.sessionId === sessionId && t.onboarding && t.status === "completed") && !useSettings.getState().onboarded;
    const id = useTasks.getState().submit(goal, {
      sessionId,
      lock,
      permission,
      multi,
      projectId: get().sessions.find((x) => x.id === sessionId)?.projectId ?? null,
      ...((opts.preference ?? preference) && { preference: opts.preference ?? preference }),
      ...((opts.mode ?? get().mode) !== "quick" && { mode: opts.mode ?? get().mode }),
      ...(workdir && { workdir }),
      ...(servers && { servers }),
      ...(opts.goalId && { goalId: opts.goalId }),
      ...(history && { history }),
      ...(files.length && { files: files.map((f) => ({ name: f.name, text: f.text })) }),
      ...(aligning ? { aligning: true } : shouldOnboard(tasks) && { onboarding: true }),
    });
    // 计划模式只管这一次；路由模式、权限、工作目录是用户的选择，保留
    if (id) set({ draft: "", files: [], mode: "quick" });
    return id;
  },
}));

/** 会话列表：按搜索词过滤，最近更新的在前 */
export function visibleSessions(sessions: readonly Session[], query: string): Session[] {
  const q = query.trim().toLowerCase();
  const list = q ? sessions.filter((s) => s.title.toLowerCase().includes(q)) : [...sessions];
  return list.sort((a, b) => b.updatedAt - a.updatedAt);
}

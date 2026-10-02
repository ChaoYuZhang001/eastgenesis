// 会话：左侧列表的每一项。一次会话由若干轮任务组成（见 stores/tasks.ts）。
// 只放在内存里：重启后从空白首屏开始，历史任务不持久化。
import { create } from "zustand";
import type { PermissionMode } from "@/decision";
import type { AttachedFile } from "@/lib/attachments";
import { MAX_FILES } from "@/lib/attachments";
import { useTasks, type TaskCard } from "./tasks";
import { useSettings } from "./settings";
import { useMemory } from "./memory";

/** 会话标题：取第一句话，太长就截断 */
export const MAX_TITLE = 30;
/** 带进下一轮的历史对话最多多少字符 */
export const MAX_HISTORY_CHARS = 6000;

export interface Session {
  id: string;
  title: string;
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
  setQuery(v: string): void;
  /** 发出当前草稿：新建会话（如果还没有）并提交任务；返回任务 id */
  send(): string | null;
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

let seq = 0;

export const useChat = create<ChatState>((set, get) => ({
  sessions: [],
  activeId: null,
  draft: "",
  files: [],
  lock: null,
  permission: "confirm",
  multi: false,
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
  setLock: (lock) => set({ lock }),
  setPermission: (permission) => set({ permission }),
  setMulti: (multi) => set({ multi }),
  setQuery: (query) => set({ query }),

  send() {
    const { draft, files, lock, permission, multi } = get();
    const goal = draft.trim();
    if (!goal) return null;
    const now = Date.now();
    let sessionId = get().activeId;
    if (sessionId) {
      set((s) => ({ sessions: s.sessions.map((x) => (x.id === sessionId ? { ...x, updatedAt: now } : x)) }));
    } else {
      sessionId = `s-${++seq}`;
      set((s) => ({ sessions: [{ id: sessionId!, title: title(goal), createdAt: now, updatedAt: now }, ...s.sessions], activeId: sessionId }));
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
      ...(history && { history }),
      ...(files.length && { files: files.map((f) => ({ name: f.name, text: f.text })) }),
      ...(aligning ? { aligning: true } : shouldOnboard(tasks) && { onboarding: true }),
    });
    if (id) set({ draft: "", files: [] });
    return id;
  },
}));

/** 会话列表：按搜索词过滤，最近更新的在前 */
export function visibleSessions(sessions: readonly Session[], query: string): Session[] {
  const q = query.trim().toLowerCase();
  const list = q ? sessions.filter((s) => s.title.toLowerCase().includes(q)) : [...sessions];
  return list.sort((a, b) => b.updatedAt - a.updatedAt);
}

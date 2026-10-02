import { create } from "zustand";

// 主视图：对话是首屏；设置分成「模型与路由」「系统与工具」，智能体单独一页
export type View = "chat" | "agents" | "models" | "system";
export type SettingsView = Exclude<View, "chat">;

export const VIEW_LABEL: Record<View, string> = {
  chat: "对话",
  agents: "智能体",
  models: "模型与路由",
  system: "系统与工具",
};

export const SETTINGS_VIEWS: readonly SettingsView[] = ["models", "system", "agents"];

interface UiState {
  view: View;
  /** 专家模式：恢复任务画布 + 右侧执行时间线与路由面板，默认关闭 */
  expert: boolean;
  panelOpen: boolean;
  setView: (v: View) => void;
  toggleExpert: () => void;
  togglePanel: () => void;
}

export const useUi = create<UiState>((set) => ({
  view: "chat",
  expert: false,
  panelOpen: true,
  setView: (view) => set({ view }),
  toggleExpert: () => set((s) => ({ expert: !s.expert })),
  togglePanel: () => set((s) => ({ panelOpen: !s.panelOpen })),
}));

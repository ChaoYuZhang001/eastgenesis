import { create } from "zustand";
import { getBackend } from "@/platform";

// V3 布局（docs/UI_LAYOUT_V3.md）：图标栏选「工作台 / 项目 / 历史 / 设置」，内容栏随之换内容；
// 主区显示当前会话、目标详情、项目概览或设置子页。
export type Rail = "home" | "projects" | "history" | "settings";
export const RAIL_LABEL: Record<Rail, string> = { home: "工作台", projects: "项目", history: "历史", settings: "设置" };

/** 主区显示什么；chat 时显示当前会话（useChat.activeId），没有会话就是首屏 */
export type MainView = { kind: "chat" } | { kind: "goal"; id: string } | { kind: "project"; id: string };

/** 设置子页（第 8 节）：分类 › 子页 */
export type SettingsPageId =
  | "general" | "notifications" | "appearance" | "shortcuts" | "usage"
  | "providers" | "custom" | "routing" | "matrix"
  | "mcp" | "skills" | "memory" | "permissions"
  | "version" | "updates" | "licenses";
export const DEFAULT_SETTINGS_PAGE: SettingsPageId = "providers";

export type FontSize = "sm" | "md" | "lg";
export type PanelTab = "files" | "changes" | "terminal";

/** 存进设置的界面偏好（内容栏收起、分组展开、字号、减少动态效果、专家模式） */
export interface UiPrefs {
  collapsed: boolean;
  groups: { projects: boolean; recent: boolean; archived: boolean };
  fontSize: FontSize;
  reduceMotion: boolean;
  /** 专家模式：回答下方浮层里多显示内部评分、权重和成本档（V3 7.3），不再切换布局 */
  expert: boolean;
}
export const DEFAULT_UI_PREFS: UiPrefs = {
  collapsed: false,
  groups: { projects: true, recent: true, archived: false },
  fontSize: "md",
  reduceMotion: false,
  expert: false,
};
export const UI_PREFS_KEY = "ui_prefs";

export function parseUiPrefs(raw: string | null): UiPrefs {
  try {
    const v = JSON.parse(raw ?? "null") as Partial<UiPrefs> | null;
    if (!v || typeof v !== "object") return DEFAULT_UI_PREFS;
    const g = (v.groups ?? {}) as Partial<UiPrefs["groups"]>;
    const bool = (x: unknown, d: boolean) => (typeof x === "boolean" ? x : d);
    return {
      collapsed: bool(v.collapsed, false),
      groups: { projects: bool(g.projects, true), recent: bool(g.recent, true), archived: bool(g.archived, false) },
      fontSize: v.fontSize === "sm" || v.fontSize === "lg" ? v.fontSize : "md",
      reduceMotion: bool(v.reduceMotion, false),
      expert: bool(v.expert, false),
    };
  } catch {
    return DEFAULT_UI_PREFS;
  }
}

interface UiState {
  rail: Rail;
  main: MainView;
  settingsPage: SettingsPageId;
  prefs: UiPrefs;
  /** 窗口窄于 1180 时，打开右侧面板会先收起内容栏；关面板时恢复（V3 1.3） */
  autoCollapsed: boolean;
  panel: { open: boolean; tab: PanelTab; path: string | null };
  /** 当前项目：新任务、新目标归入它；输入框占位文字随之变化（V3 1.3） */
  currentProjectId: string | null;
  /** 工作台里展开的项目行 */
  expanded: string[];
  /** 内容栏搜索 */
  search: { open: boolean; query: string };
  setRail(r: Rail): void;
  /** 点图标栏：点的是已选中的项就收起 / 展开内容栏 */
  clickRail(r: Rail): void;
  open(v: MainView): void;
  openSettings(page?: SettingsPageId): void;
  toggleCollapsed(): void;
  toggleGroup(g: keyof UiPrefs["groups"]): void;
  setPrefs(p: Partial<UiPrefs>): void;
  loadPrefs(): Promise<void>;
  setCurrentProject(id: string | null): void;
  toggleExpanded(id: string): void;
  setSearch(s: Partial<UiState["search"]>): void;
  openPanel(tab: PanelTab, path?: string | null, narrow?: boolean): void;
  closePanel(): void;
}

export const useUi = create<UiState>((set, get) => {
  const persist = (prefs: UiPrefs) => void getBackend().saveSetting(UI_PREFS_KEY, JSON.stringify(prefs)).catch(() => {});
  const putPrefs = (p: Partial<UiPrefs>) => {
    const prefs = { ...get().prefs, ...p };
    set({ prefs });
    persist(prefs);
  };
  return {
    rail: "home",
    main: { kind: "chat" },
    settingsPage: DEFAULT_SETTINGS_PAGE,
    prefs: DEFAULT_UI_PREFS,
    autoCollapsed: false,
    panel: { open: false, tab: "files", path: null },
    currentProjectId: null,
    expanded: [],
    search: { open: false, query: "" },
    setRail: (rail) => set({ rail, search: { open: false, query: "" } }),
    clickRail(r) {
      if (get().rail === r) get().toggleCollapsed();
      else get().setRail(r);
    },
    open: (main) => set({ main, ...(get().rail === "settings" ? { rail: "home" as Rail } : {}) }),
    openSettings: (page) => set({ rail: "settings", settingsPage: page ?? get().settingsPage, search: { open: false, query: "" } }),
    toggleCollapsed: () => {
      set({ autoCollapsed: false });
      putPrefs({ collapsed: !get().prefs.collapsed });
    },
    toggleGroup: (g) => putPrefs({ groups: { ...get().prefs.groups, [g]: !get().prefs.groups[g] } }),
    setPrefs: putPrefs,
    async loadPrefs() {
      try {
        set({ prefs: parseUiPrefs(await getBackend().loadSetting(UI_PREFS_KEY)) });
      } catch {
        // 读不到就用默认值，不影响使用
      }
    },
    setCurrentProject: (currentProjectId) => set({ currentProjectId }),
    toggleExpanded: (id) => set((s) => ({ expanded: s.expanded.includes(id) ? s.expanded.filter((x) => x !== id) : [...s.expanded, id] })),
    setSearch: (p) => set((s) => ({ search: { ...s.search, ...p } })),
    openPanel(tab, path = null, narrow = false) {
      // 窄窗口：先收起内容栏，保证主区不小于 560；只收起原本展开的，关面板时恢复
      const collapse = narrow && !get().prefs.collapsed;
      set({ panel: { open: true, tab, path }, autoCollapsed: collapse || get().autoCollapsed });
    },
    closePanel: () => set((s) => ({ panel: { ...s.panel, open: false }, autoCollapsed: false })),
  };
});

/** 内容栏此刻是否收起：用户收起的，或因窄窗口打开面板临时收起的 */
export const contentCollapsed = (s: Pick<UiState, "prefs" | "autoCollapsed">) => s.prefs.collapsed || s.autoCollapsed;

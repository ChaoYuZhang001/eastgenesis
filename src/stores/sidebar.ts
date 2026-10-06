import { create } from "zustand";
import type { Project } from "@/decision/project";

interface SidebarState {
  // 当前选中的导航项
  activeView: "home" | "projects" | "history" | "settings";
  setActiveView: (view: SidebarState["activeView"]) => void;

  // 内容栏是否收起
  collapsed: boolean;
  setCollapsed: (collapsed: boolean) => void;

  // 当前项目（点击项目行后设为当前，影响输入框占位文字和新任务归属）
  currentProject: Project | null;
  setCurrentProject: (project: Project | null) => void;

  // 分组展开状态
  projectsExpanded: boolean;
  recentExpanded: boolean;
  setProjectsExpanded: (expanded: boolean) => void;
  setRecentExpanded: (expanded: boolean) => void;

  // 展开的项目 ID（显示项目下的目标和任务）
  expandedProjects: Set<string>;
  toggleProject: (id: string) => void;
}

export const useSidebar = create<SidebarState>((set) => ({
  activeView: "home",
  setActiveView: (view) => set({ activeView: view }),

  collapsed: false,
  setCollapsed: (collapsed) => set({ collapsed }),

  currentProject: null,
  setCurrentProject: (project) => set({ currentProject: project }),

  projectsExpanded: true,
  recentExpanded: true,
  setProjectsExpanded: (expanded) => set({ projectsExpanded: expanded }),
  setRecentExpanded: (expanded) => set({ recentExpanded: expanded }),

  expandedProjects: new Set(),
  toggleProject: (id) =>
    set((s) => {
      const next = new Set(s.expandedProjects);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { expandedProjects: next };
    }),
}));

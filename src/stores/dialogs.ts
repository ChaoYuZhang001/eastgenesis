import { create } from "zustand";

// 需要确认或填表的对话框：新建 / 编辑项目、放弃 / 删除目标。删除项目的二次确认用 useProjects.pendingDelete。
// 在 App 层渲染（components/layout/Dialogs.tsx），内容栏收起时也能弹出。
export type Ask = { kind: "new-project" } | { kind: "edit-project"; id: string } | { kind: "abandon-goal"; id: string } | { kind: "delete-goal"; id: string };

export const useDialogs = create<{ current: Ask | null; ask(a: Ask): void; done(): void }>((set) => ({
  current: null,
  ask: (current) => set({ current }),
  done: () => set({ current: null }),
}));

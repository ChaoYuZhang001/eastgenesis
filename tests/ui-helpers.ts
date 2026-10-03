// UI 测试共用：每个用例用新的 mock 后端，并把全局 store 恢复到初始状态
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { DEFAULT_PROVIDER_PREFS, DEFAULT_REQUEST_TIMEOUT_S } from "@/lib/engine";
import { createMockBackend, setBackend, type Backend } from "@/platform";
import { useAppStore } from "@/stores/app";
import { useChat } from "@/stores/chat";
import { health } from "@/stores/health";
import { useMcp } from "@/stores/mcp";
import { useMemory } from "@/stores/memory";
import { useSkills } from "@/stores/skills";
import { DEFAULT_ROUTING, useSettings } from "@/stores/settings";
import { useGoals } from "@/stores/goals";
import { useProjects } from "@/stores/projects";
import { useTasks } from "@/stores/tasks";
import { DEFAULT_SETTINGS_PAGE, DEFAULT_UI_PREFS, useUi, type SettingsPageId } from "@/stores/ui";

export const LONG = { timeout: 5000 };

export function resetStores(backend: Backend = createMockBackend()): Backend {
  // 上一个用例留下的运行先停掉，避免等待中的确认永远不结束
  for (const t of useTasks.getState().tasks) useTasks.getState().cancel(t.id);
  setBackend(backend);
  // 健康记录全应用共用：上一个用例打开的熔断不能影响下一个
  health.reset();
  useAppStore.setState({ phase: "booting", init: null, backendKind: null, error: null });
  useSettings.setState({
    loaded: false,
    statuses: [],
    jev: null,
    custom: [],
    routing: DEFAULT_ROUTING,
    overrides: {},
    providerPrefs: DEFAULT_PROVIDER_PREFS,
    timeoutS: DEFAULT_REQUEST_TIMEOUT_S,
    modelCache: {},
    probingIds: [],
    onboarded: true,
    showReasoning: false,
    defaultPermission: "confirm",
    error: null,
  });
  useTasks.setState({ tasks: [], activeId: null });
  useChat.setState({ sessions: [], activeId: null, draft: "", files: [], lock: null, permission: "confirm", multi: false, preference: null, mode: "quick", workdir: null, servers: null, query: "" });
  useMcp.setState({ registry: null, loadError: null, conns: {} });
  useMemory.setState({ loaded: false, items: [], error: null });
  useSkills.setState({ loaded: false, items: [], error: null });
  useProjects.setState({ loaded: false, items: [], error: null, pendingDelete: null });
  useGoals.setState({ loaded: false, items: [], error: null });
  useUi.setState({
    rail: "home",
    main: { kind: "chat" },
    settingsPage: DEFAULT_SETTINGS_PAGE,
    prefs: DEFAULT_UI_PREFS,
    autoCollapsed: false,
    panel: { open: false, tab: "files", path: null },
    currentProjectId: null,
    expanded: [],
    search: { open: false, query: "" },
  });
  return backend;
}

export function submit(goal: string) {
  fireEvent.change(screen.getByLabelText("任务描述"), { target: { value: goal } });
  fireEvent.click(screen.getByRole("button", { name: "提交任务" }));
}

/** 打开输入框里的「+」菜单（附件、模式、多 Agent 协同、插件在里面） */
export function openMore() {
  fireEvent.click(screen.getByRole("button", { name: "添加" }));
  return screen.getByRole("menu", { name: "添加" });
}

/** 点图标栏「设置」，再在内容栏的设置分类里点某个子页 */
export function openSettings(page?: string) {
  if (!screen.queryByRole("navigation", { name: "设置分类" })) fireEvent.click(within(screen.getByRole("navigation", { name: "主导航" })).getByRole("button", { name: "设置" }));
  if (page) fireEvent.click(within(screen.getByRole("navigation", { name: "设置分类" })).getByRole("button", { name: page }));
}

/** 回到工作台（对话） */
export const backToChat = () => fireEvent.click(within(screen.getByRole("navigation", { name: "主导航" })).getByRole("button", { name: "工作台" }));

/** 直接把设置主区切到某个子页（单测设置页组件时用） */
export const settingsPage = (page: SettingsPageId) => useUi.setState({ rail: "settings", settingsPage: page });

/** 点开回答下方的折叠路由行，返回浮层 */
export function openRoute(el: HTMLElement) {
  fireEvent.click(within(el).getByRole("button", { name: /查看路由决策/ }));
  return within(el).getByRole("dialog", { name: "路由决策" });
}

/** 浮层里切到「执行过程」 */
export function runTab(overlay: HTMLElement) {
  fireEvent.click(within(overlay).getByRole("tab", { name: "执行过程" }));
}

export const card = (goal: string) => screen.getByRole("article", { name: `任务：${goal}` });

/** 逐个处理权限确认，直到任务结束；reject 指定的工具点「拒绝」，其余批准。返回每次确认的文字 */
export async function drive(el: HTMLElement, reject?: string): Promise<string[]> {
  const seen: string[] = [];
  for (let i = 0; i < 10; i++) {
    const next = await waitFor(() => {
      const g = within(el).queryByRole("group");
      const running = within(el).queryByRole("button", { name: "停止任务" });
      if (!g && running) throw new Error("等待中");
      return g;
    }, LONG);
    if (!next) return seen;
    seen.push(next.textContent ?? "");
    const deny = reject !== undefined && next.textContent?.includes(reject);
    fireEvent.click(within(next).getByRole("button", { name: deny ? "拒绝" : "批准" }));
    await waitFor(() => expect(next.isConnected).toBe(false), LONG);
  }
  throw new Error("确认次数超出预期");
}

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
import { useTasks } from "@/stores/tasks";
import { useUi } from "@/stores/ui";

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
    error: null,
  });
  useTasks.setState({ tasks: [], activeId: null });
  useChat.setState({ sessions: [], activeId: null, draft: "", files: [], lock: null, permission: "confirm", multi: false, query: "" });
  useMcp.setState({ registry: null, loadError: null, conns: {} });
  useMemory.setState({ loaded: false, items: [], error: null });
  useSkills.setState({ loaded: false, items: [], error: null });
  useUi.setState({ view: "chat", expert: false, panelOpen: true });
  return backend;
}

export function submit(goal: string) {
  fireEvent.change(screen.getByLabelText("任务描述"), { target: { value: goal } });
  fireEvent.click(screen.getByRole("button", { name: "提交任务" }));
}

/** 打开输入框里的「+」菜单（附件和多 Agent 协同开关在里面） */
export function openMore() {
  fireEvent.click(screen.getByRole("button", { name: "更多选项" }));
}

/** 进设置页某个分区 */
export function openSettings(label?: string) {
  fireEvent.click(screen.getByRole("button", { name: "设置" }));
  if (label) fireEvent.click(within(screen.getByRole("navigation", { name: "设置分区" })).getByRole("button", { name: label }));
}

export const backToChat = () => fireEvent.click(screen.getByRole("button", { name: "返回对话" }));

/** 打开专家模式（任务画布 + 右侧执行面板） */
export const openExpert = () => fireEvent.click(screen.getByRole("button", { name: "专家模式" }));

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

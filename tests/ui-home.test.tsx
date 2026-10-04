// 首屏（docs/UI_LAYOUT_V3.md 第 2、3、5、9 节）：控件数 ≤ 16 并按区域核对；快捷建议只填入输入框；
// 权限三档语义不变；路由下拉（自动 / 省钱 / 最强 / 手动锁定）；锁定后跳过路由决策；会话列表
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import App from "@/App";
import { placePopup } from "@/components/ui/menu";
import { useChat } from "@/stores/chat";
import { useSettings } from "@/stores/settings";
import { useTasks } from "@/stores/tasks";
import { LONG, card, drive, openRoute, resetStores, submit } from "./ui-helpers";

beforeEach(() => resetStores());

async function boot() {
  render(<App />);
  await waitFor(() => expect(screen.getByLabelText("任务描述")).toBeEnabled(), LONG);
}

/** 可交互元素：按钮、下拉、输入框、链接；不算正文输入框（textarea）、tabIndex=-1 的和隐藏的 */
function interactive(root: ParentNode = document): HTMLElement[] {
  const all = Array.from(root.querySelectorAll<HTMLElement>("button, select, input, a[href]"));
  return all.filter((el) => el.tabIndex !== -1 && !el.closest("[hidden]") && !(el instanceof HTMLInputElement && el.type === "hidden"));
}
const names = (els: HTMLElement[]) => els.map((el) => el.getAttribute("aria-label") ?? el.textContent?.trim() ?? "");

/** 停掉还在跑的任务并等它们收尾，用例结束后不再有状态更新 */
async function stopAll() {
  act(() => {
    for (const t of useTasks.getState().tasks) useTasks.getState().cancel(t.id);
  });
  await waitFor(() => expect(useTasks.getState().tasks.every((t) => t.status !== "running")).toBe(true), LONG);
}

describe("首屏", () => {
  it("控件数 16：图标栏 5 + 内容栏 4 + 输入框 4 + 快捷建议 3；没有常驻右侧面板和内部评分", async () => {
    await boot();
    expect(interactive()).toHaveLength(16);
    expect(names(interactive(screen.getByRole("navigation", { name: "主导航" })))).toEqual(["工作台", "新任务", "项目", "历史", "设置"]);
    expect(names(interactive(screen.getByRole("complementary", { name: "内容栏" })))).toEqual(["搜索", "新任务", "项目", "最近"]);
    const form = screen.getByLabelText("任务描述").closest("form")!;
    expect(names(interactive(form))).toEqual(["添加", "权限", "路由", "提交任务"]);
    expect(names(interactive(screen.getByRole("list", { name: "快捷任务" })))).toEqual(["整理这个文件夹的文件", "读一下这份文档，总结要点", "帮我查一下这段代码为什么报错"]);
    expect(screen.queryByRole("complementary", { name: "右侧面板" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "打开面板" })).not.toBeInTheDocument();
    expect(screen.queryByRole("log")).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/评分|成本档位/);
  });

  it("快捷建议只填进输入框并聚焦，不直接提交", async () => {
    await boot();
    const quick = screen.getByRole("list", { name: "快捷任务" });
    fireEvent.click(within(quick).getAllByRole("button")[0]!);
    expect(screen.getByLabelText("任务描述")).toHaveValue("整理这个文件夹的文件");
    expect(screen.getByLabelText("任务描述")).toHaveFocus();
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
  });

  it("Enter 换行，⌘↩ 或 Ctrl+Enter 发送", async () => {
    await boot();
    const box = screen.getByLabelText("任务描述");
    fireEvent.change(box, { target: { value: "解释一下量子纠缠" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(useTasks.getState().tasks).toHaveLength(0);
    fireEvent.keyDown(box, { key: "Enter", ctrlKey: true });
    expect(useTasks.getState().tasks).toHaveLength(1);
    fireEvent.change(screen.getByLabelText("任务描述"), { target: { value: "再解释一遍" } });
    fireEvent.keyDown(screen.getByLabelText("任务描述"), { key: "Enter", metaKey: true });
    expect(useTasks.getState().tasks).toHaveLength(2);
    await stopAll();
  });

  it("权限开关三级：完全访问 / 变更前确认 / 只读，默认变更前确认，提示随之变化", async () => {
    await boot();
    const perm = screen.getByLabelText("权限");
    expect(Array.from((perm as HTMLSelectElement).options).map((o) => o.text)).toEqual(["完全访问", "变更前确认", "只读"]);
    expect(perm).toHaveValue("confirm");
    fireEvent.change(perm, { target: { value: "readonly" } });
    expect(useChat.getState().permission).toBe("readonly");
    // 提示放在权限下拉的 title 里，输入框下方不再常驻小字
    expect(perm.getAttribute("title")).toMatch(/只执行只读工具/);
    expect(document.body.textContent).not.toMatch(/有副作用的操作/);
  });

  it("路由下拉：自动（推荐）默认；省钱 / 最强写进这个任务的偏好；手动锁定按 Provider 分组，中转站来自 /models 缓存", async () => {
    await boot();
    let pill = screen.getByRole("button", { name: "路由" });
    expect(pill).toHaveTextContent("自动路由");
    fireEvent.click(pill);
    let menu = screen.getByRole("menu", { name: "路由" });
    const auto = within(menu).getByRole("menuitemradio", { name: /自动（推荐）/ });
    expect(auto).toHaveAttribute("aria-checked", "true");
    expect(auto).toHaveTextContent("当前按「平衡（来自全局设置）」");
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: /省钱模式/ }));
    expect(useChat.getState().preference).toBe("economy");
    expect(pill).toHaveTextContent("省钱模式");

    // 任务带上这一层的偏好
    submit("解释一下量子纠缠");
    expect(useTasks.getState().tasks[0]).toMatchObject({ preference: "economy", preferenceSource: "task" });
    await stopAll();

    // 保存一个本地中转站（无需 Key），保存后自动读取 /models 并缓存
    await act(async () => {
      await useSettings.getState().saveCustom({ id: "custom:relay", label: "中转站", base_url: "http://127.0.0.1:8080/v1", default_model: "only-registered", headers: {} });
    });
    await waitFor(() => expect(useSettings.getState().modelCache["custom:relay"]?.models).toEqual(["mock-model", "gpt-5.6-luna"]));
    // 提交后输入框落到会话底部，是另一个实例；任务层偏好保留
    pill = screen.getByRole("button", { name: "路由" });
    expect(pill).toHaveTextContent("省钱模式");
    fireEvent.click(pill);
    menu = screen.getByRole("menu", { name: "路由" });
    fireEvent.click(within(menu).getByRole("menuitem", { name: /手动锁定/ }));
    const sub = screen.getByRole("menu", { name: "手动锁定" });
    expect(sub).toHaveTextContent("锁定后整个任务都用它，不自动降级");
    const relay = within(sub).getByRole("group", { name: "中转站" });
    expect(within(relay).getAllByRole("menuitemradio").map((o) => o.textContent)).toEqual(["mock-model", "gpt-5.6-luna"]);
    fireEvent.click(within(relay).getByRole("menuitemradio", { name: "gpt-5.6-luna" }));
    expect(useChat.getState()).toMatchObject({ lock: "custom:relay/gpt-5.6-luna", preference: null });
    expect(pill).toHaveTextContent("锁定 · gpt-5.6-luna");
  });

  it("弹出位置：放不下就翻面（子菜单右 → 左，向上的菜单 → 向下），并夹在窗口内", () => {
    const rect = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, right: left + width, bottom: top + height }) as DOMRect;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // 子菜单：锚点靠右边，右边放不下 → 翻到左边
    const sub = placePopup(rect(vw - 300, 200, 288, 40), rect(0, 0, 288, 400), "right", "start");
    expect(sub.flipped).toBe(true);
    expect(sub.left + 288).toBeLessThanOrEqual(vw - 300);
    // 右边放得下 → 不翻
    expect(placePopup(rect(100, 200, 200, 40), rect(0, 0, 200, 300), "right", "start")).toMatchObject({ flipped: false, left: 304 });
    // 向上的菜单：锚点贴着顶，上面放不下 → 翻到下面
    const up = placePopup(rect(100, 20, 32, 32), rect(0, 0, 256, 300), "top", "start");
    expect(up).toMatchObject({ flipped: true, top: 56 });
    // 右对齐、离右边很近：夹在窗口内
    const end = placePopup(rect(vw - 40, vh - 60, 32, 32), rect(0, 0, 288, 200), "top", "end");
    expect(end.left + 288).toBeLessThanOrEqual(vw - 8);
    expect(end.top).toBeGreaterThanOrEqual(8);
  });

  it("菜单打开期间窗口尺寸变了就关掉（位置已经不准）", async () => {
    await boot();
    fireEvent.click(screen.getByRole("button", { name: "路由" }));
    expect(screen.getByRole("menu", { name: "路由" })).toBeInTheDocument();
    fireEvent(window, new Event("resize"));
    await waitFor(() => expect(screen.queryByRole("menu", { name: "路由" })).not.toBeInTheDocument());
  });

  it("路由菜单可以只用键盘操作：↓ 打开、↓↑ 移动、Esc 关闭并把焦点还给胶囊", async () => {
    await boot();
    const pill = screen.getByRole("button", { name: "路由" });
    pill.focus();
    fireEvent.keyDown(pill, { key: "ArrowDown" });
    const menu = screen.getByRole("menu", { name: "路由" });
    expect(within(menu).getByRole("menuitemradio", { name: /自动（推荐）/ })).toHaveFocus();
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(within(menu).getByRole("menuitemradio", { name: /省钱模式/ })).toHaveFocus();
    fireEvent.keyDown(menu, { key: "End" });
    // 最后一项是只读的「本月省了…」，点了跳到使用情况
    expect(within(menu).getByRole("menuitem", { name: /本月/ })).toHaveFocus();
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(within(menu).getByRole("menuitem", { name: /手动锁定/ })).toHaveFocus();
    fireEvent.keyDown(menu, { key: "Escape" });
    expect(screen.queryByRole("menu", { name: "路由" })).not.toBeInTheDocument();
    expect(pill).toHaveFocus();
  });

  it("锁定模型后跳过路由决策：路由行写明手动锁定；运行中只显示当前一步，完成后折叠成一行", async () => {
    await boot();
    fireEvent.click(screen.getByRole("button", { name: "路由" }));
    fireEvent.click(within(screen.getByRole("menu", { name: "路由" })).getByRole("menuitem", { name: /手动锁定/ }));
    const target = within(screen.getByRole("menu", { name: "手动锁定" })).getAllByRole("menuitemradio")[0]!;
    const label = target.textContent!;
    fireEvent.click(target);
    const lock = useChat.getState().lock!;
    expect(lock).toBeTruthy();

    const goal = "整理本周会议纪要并保存";
    submit(goal);
    const c = card(goal);
    // 运行中：只有一行当前状态，没有展开的步骤列表
    expect(within(c).getByRole("status")).toHaveTextContent(/正在|等你确认/);
    expect(within(c).queryByRole("list", { name: "执行步骤" })).not.toBeInTheDocument();

    await drive(c);
    const done = await within(c).findByRole("button", { name: /^已完成 · \d+ 步 · \d+\.\d+s$/ }, LONG);
    expect(done).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(done);
    expect(within(c).getByRole("list", { name: "执行步骤" })).toBeVisible();

    const line = within(c).getByRole("button", { name: /查看路由决策/ });
    expect(line).toHaveTextContent(new RegExp(`^手动锁定 ${lock.replace(/^custom:/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*· 查看详情$`));
    const route = within(openRoute(c)).getByRole("region", { name: "路由决策详情" });
    expect(route).toHaveTextContent(`你手动锁定了 ${lock.replace(/^custom:/, "")}，本次跳过路由决策，不会自动降级。`);
    expect(label.length).toBeGreaterThan(0);
    expect(route.textContent).not.toMatch(/评分|成本档位/);
  });

  it("会话：发送后出现在「最近」；新任务回到首屏；点会话回到那一轮", async () => {
    await boot();
    submit("第一个会话的问题");
    const list = screen.getByRole("navigation", { name: "会话列表" });
    const item = await within(list).findByRole("button", { name: /第一个会话的问题/ });
    expect(item).toHaveAttribute("aria-current", "page");

    fireEvent.click(within(screen.getByRole("navigation", { name: "主导航" })).getByRole("button", { name: "新任务" }));
    expect(screen.getByRole("heading", { level: 1, name: "你好，今天想创造什么？" })).toBeInTheDocument();
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
    expect(item).not.toHaveAttribute("aria-current");

    fireEvent.click(item);
    expect(card("第一个会话的问题")).toBeInTheDocument();
  });
});

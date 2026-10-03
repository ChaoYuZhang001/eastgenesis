// 主界面外壳（V3：docs/UI_LAYOUT_V3.md 第 1、7、8 节）
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import App from "@/App";
import { createMockBackend } from "@/platform";
import { useChat } from "@/stores/chat";
import { useUi } from "@/stores/ui";
import { LONG, backToChat, card, drive, openSettings, resetStores, submit } from "./ui-helpers";

beforeEach(() => resetStores());

const rail = () => screen.getByRole("navigation", { name: "主导航" });
const railItem = (name: string) => within(rail()).getByRole("button", { name });

describe("主界面外壳（浏览器模式）", () => {
  it("启动页只覆盖初始化，完成后显示图标栏 + 内容栏 + 主区；没有常驻右侧面板", async () => {
    render(<App />);
    expect(screen.getByTestId("splash")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId("splash")).not.toBeInTheDocument());

    // 图标栏：五项都显示名称，工作台默认选中；浏览器模式如实标明「模拟」
    expect(within(rail()).getAllByRole("button").map((b) => b.textContent)).toEqual(["工作台", "新任务", "项目", "历史", "设置"]);
    expect(railItem("工作台")).toHaveAttribute("aria-current", "page");
    expect(within(rail()).getByText("模拟")).toBeInTheDocument();

    // 内容栏：组合 Logo（深色底版本）+ 搜索 + 新任务 + 项目、最近两组
    const side = screen.getByRole("complementary", { name: "内容栏" });
    expect(within(side).getByAltText("EastGenesis Desktop").getAttribute("src")).toContain("logo-dark-transparent");
    expect(within(side).getByRole("navigation", { name: "会话列表" })).toHaveTextContent("还没有会话");
    expect(within(side).getByText("还没有项目")).toBeInTheDocument();

    expect(screen.getByRole("heading", { level: 1, name: "你好，今天想创造什么？" })).toBeInTheDocument();
    expect(screen.getByPlaceholderText("描述你的任务...")).toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "右侧面板" })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText("任务描述")).toBeEnabled());
  });

  it("初始化失败时启动页显示图标、文字和重试按钮", async () => {
    // 第一次初始化失败，重试时成功
    resetStores(createMockBackend({ failInit: 1 }));
    render(<App />);
    expect(await screen.findByRole("alert")).toHaveTextContent("启动失败：（模拟）无法打开数据库");
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByRole("navigation", { name: "会话列表" })).toBeInTheDocument();
  });

  it("再点一次已选中的导航项或按 ⌘B 收起内容栏；状态存进设置", async () => {
    render(<App />);
    await screen.findByRole("navigation", { name: "会话列表" });
    fireEvent.click(railItem("工作台"));
    expect(screen.queryByRole("complementary", { name: "内容栏" })).not.toBeInTheDocument();
    // 收起时选中项的高亮不变
    expect(railItem("工作台")).toHaveAttribute("aria-current", "page");
    fireEvent.keyDown(window, { key: "b", metaKey: true });
    expect(screen.getByRole("complementary", { name: "内容栏" })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "b", ctrlKey: true });
    expect(screen.queryByRole("complementary", { name: "内容栏" })).not.toBeInTheDocument();
    expect(useUi.getState().prefs.collapsed).toBe(true);
  });

  it("搜索：点搜索图标出现搜索框，过滤内容栏；Esc 收起并把焦点还给搜索按钮", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByLabelText("任务描述")).toBeEnabled(), LONG);
    submit("第一个会话的问题");
    const side = screen.getByRole("complementary", { name: "内容栏" });
    expect(within(side).queryByRole("searchbox")).not.toBeInTheDocument();
    const btn = within(side).getByRole("button", { name: "搜索" });
    fireEvent.click(btn);
    const box = within(side).getByRole("searchbox", { name: "搜索内容栏" });
    expect(box).toHaveFocus();
    fireEvent.change(box, { target: { value: "不存在" } });
    expect(within(side).getByText("没有匹配的会话")).toBeInTheDocument();
    fireEvent.keyDown(box, { key: "Escape" });
    expect(within(side).queryByRole("searchbox")).not.toBeInTheDocument();
    expect(btn).toHaveFocus();
    expect(within(side).getByRole("navigation", { name: "会话列表" })).toHaveTextContent("第一个会话的问题");
    await drive(card("第一个会话的问题"));
  });

  it("设置：内容栏列出 4 个分类，默认打开 Provider 管理；切换子页；回工作台", async () => {
    render(<App />);
    await screen.findByRole("navigation", { name: "会话列表" });
    openSettings();
    const nav = screen.getByRole("navigation", { name: "设置分类" });
    expect(within(nav).getAllByRole("heading").map((h) => h.textContent)).toEqual(["个人", "模型与路由", "Agent", "关于"]);
    const item = (name: string) => within(nav).getByRole("button", { name });
    expect(item("Provider 管理")).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("heading", { level: 1, name: "Provider 管理" })).toBeInTheDocument();
    expect(screen.getByLabelText("OpenAI API Key")).toBeInTheDocument();

    fireEvent.click(item("版本"));
    expect(screen.getByRole("heading", { level: 1, name: "版本" })).toBeInTheDocument();
    const info = screen.getByLabelText("版本信息");
    expect(info).toHaveTextContent("浏览器模拟");
    expect(info).toHaveTextContent("内存存储（不持久化）");

    fireEvent.click(item("检查更新"));
    expect(screen.getByText(/开发阶段，没有自动更新/)).toBeInTheDocument();
    fireEvent.click(item("许可证"));
    expect(screen.getByText("应用自身的许可证待定。")).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "打包的字体" })).getAllByText("SIL Open Font License 1.1")).toHaveLength(3);

    // ⌘, 打开设置；点工作台回到对话首屏
    backToChat();
    expect(screen.getByRole("heading", { level: 1, name: "你好，今天想创造什么？" })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: ",", metaKey: true });
    expect(screen.getByRole("navigation", { name: "设置分类" })).toBeInTheDocument();
  });

  it("专家模式在设置 › 个人 › 常规里：只影响浮层里显示多少细节，不切换布局", async () => {
    render(<App />);
    await screen.findByRole("navigation", { name: "会话列表" });
    openSettings("常规");
    const box = screen.getByLabelText("专家模式") as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    expect(useUi.getState().prefs.expert).toBe(true);
    backToChat();
    // 布局不变：没有任务画布，也没有常驻的执行面板
    expect(screen.getByRole("heading", { level: 1, name: "你好，今天想创造什么？" })).toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "执行面板" })).not.toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "右侧面板" })).not.toBeInTheDocument();
  });

  it("右侧面板：有改动时才出现入口，点了才打开；Esc 或关闭按钮关掉；窄窗口先收起内容栏", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByLabelText("任务描述")).toBeEnabled(), LONG);
    expect(screen.queryByRole("button", { name: "打开面板" })).not.toBeInTheDocument();
    submit("整理本周会议纪要并保存");
    const c = card("整理本周会议纪要并保存");
    await drive(c);
    await within(c).findByText(/^已完成 · /, {}, LONG);
    // Agent 写了文件也不自动弹出
    expect(screen.queryByRole("complementary", { name: "右侧面板" })).not.toBeInTheDocument();

    const innerWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1000 });
    fireEvent.click(screen.getByRole("button", { name: "打开面板" }));
    const panel = screen.getByRole("complementary", { name: "右侧面板" });
    // 1000 < 1180：先收起内容栏，保证主区不小于 560
    expect(screen.queryByRole("complementary", { name: "内容栏" })).not.toBeInTheDocument();
    expect(useUi.getState().prefs.collapsed).toBe(false);
    expect(within(panel).getByRole("tab", { name: "改动" })).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole("tab", { name: "改动" }));
    expect(within(panel).getByRole("list", { name: "改动" })).toHaveTextContent("~/EastGenesis/output.md");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("complementary", { name: "右侧面板" })).not.toBeInTheDocument();
    // 关面板后恢复内容栏
    expect(screen.getByRole("complementary", { name: "内容栏" })).toBeInTheDocument();
    Object.defineProperty(window, "innerWidth", { configurable: true, value: innerWidth });

    // 切换会话后入口跟着当前会话走
    act(() => useChat.getState().newSession());
    expect(screen.queryByRole("button", { name: "打开面板" })).not.toBeInTheDocument();
  });
});

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import App from "@/App";
import { createMockBackend } from "@/platform";
import { backToChat, openExpert, openSettings, resetStores } from "./ui-helpers";

beforeEach(() => resetStores());

describe("主界面外壳（浏览器模式）", () => {
  it("启动页只覆盖初始化，完成后淡出并显示两区布局：侧边栏 + 对话", async () => {
    render(<App />);
    expect(screen.getByTestId("splash")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId("splash")).not.toBeInTheDocument());

    const side = screen.getByRole("complementary", { name: "侧边栏" });
    expect(within(side).getByAltText("EastGenesis Desktop").getAttribute("src")).toContain("logo-dark-transparent");
    expect(within(side).getByRole("navigation", { name: "会话列表" })).toHaveTextContent("还没有会话");
    // 后端状态默认折叠，点开才看到存储细节
    const status = within(side).getByRole("button", { name: "模拟后端" });
    expect(status).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(status);
    expect(within(side).getByText("内存存储（不持久化）")).toBeInTheDocument();

    expect(screen.getByRole("heading", { level: 1, name: "你好，今天想创造什么？" })).toBeInTheDocument();
    expect(screen.getByPlaceholderText("描述你的任务，或选择一个智能体...")).toBeInTheDocument();
    // 首屏没有常驻的右侧面板
    expect(screen.queryByRole("complementary", { name: "执行面板" })).not.toBeInTheDocument();
    // 设置加载完成后才能提交
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

  it("设置入口在侧边栏底部；设置页分区可切换，标签可用方向键切换", async () => {
    render(<App />);
    await screen.findByRole("navigation", { name: "会话列表" });

    openSettings();
    const nav = screen.getByRole("navigation", { name: "设置分区" });
    const item = (name: string) => within(nav).getByRole("button", { name });
    expect(item("模型与路由")).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("heading", { level: 1, name: "模型与路由" })).toBeInTheDocument();

    const routing = screen.getByRole("tab", { name: "路由策略" });
    expect(routing).toHaveAttribute("aria-selected", "true");
    routing.focus();
    fireEvent.keyDown(routing, { key: "ArrowRight" });
    const matrix = screen.getByRole("tab", { name: "能力矩阵" });
    expect(matrix).toHaveAttribute("aria-selected", "true");
    expect(matrix).toHaveFocus();
    expect(screen.getByRole("tabpanel")).toHaveAccessibleName("能力矩阵");
    fireEvent.keyDown(matrix, { key: "End" });
    expect(screen.getByRole("tab", { name: "自定义 Provider" })).toHaveAttribute("aria-selected", "true");

    fireEvent.click(item("系统与工具"));
    expect(screen.getByRole("tab", { name: "API Key" })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(item("智能体"));
    expect(screen.getByRole("heading", { level: 1, name: "智能体" })).toBeInTheDocument();

    backToChat();
    expect(screen.getByRole("heading", { level: 1, name: "你好，今天想创造什么？" })).toBeInTheDocument();
  });

  it("专家模式才出现任务画布和右侧执行面板，面板可折叠", async () => {
    render(<App />);
    await screen.findByRole("navigation", { name: "会话列表" });
    expect(screen.getByRole("button", { name: "专家模式" })).toHaveAttribute("aria-pressed", "false");

    openExpert();
    expect(screen.getByRole("button", { name: "专家模式" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("heading", { level: 1, name: /你好，\s*今天想创造什么？/ })).toBeInTheDocument();

    const toggle = screen.getByRole("button", { name: "执行面板" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("heading", { name: "执行时间线" })).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("heading", { name: "执行时间线" })).not.toBeInTheDocument();
    fireEvent.click(toggle);
    expect(screen.getByRole("heading", { name: "路由决策" })).toBeInTheDocument();

    // 关掉专家模式回到对话首屏
    openExpert();
    expect(screen.queryByRole("complementary", { name: "执行面板" })).not.toBeInTheDocument();
  });
});

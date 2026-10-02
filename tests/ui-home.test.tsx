// 对话式首屏：验收「首屏只有输入框和会话列表」「模型下拉来自 /models」「三级权限」
// 「路由行可折叠且不出现内部评分」「运行中只显示当前一步，完成后折叠」「锁定模型跳过路由」
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import App from "@/App";
import { useChat } from "@/stores/chat";
import { useSettings } from "@/stores/settings";
import { LONG, card, drive, resetStores, submit } from "./ui-helpers";

beforeEach(() => resetStores());

async function boot() {
  render(<App />);
  await waitFor(() => expect(screen.getByLabelText("任务描述")).toBeEnabled(), LONG);
}

/** 首屏可交互元素：按钮、下拉、输入框、链接；不算正文输入框（textarea）和隐藏的文件选择 */
function interactive(): HTMLElement[] {
  const all = Array.from(document.querySelectorAll<HTMLElement>("button, select, input, a[href]"));
  return all.filter((el) => el.tabIndex !== -1 && !el.closest("[hidden]") && !(el instanceof HTMLInputElement && el.type === "hidden"));
}

describe("对话式首屏", () => {
  it("首屏只有会话列表和输入框：可交互元素 ≤ 12，没有常驻右侧面板和内部评分", async () => {
    await boot();
    const els = interactive();
    expect(els.length).toBeLessThanOrEqual(12);
    const names = els.map((el) => el.getAttribute("aria-label") ?? el.textContent?.trim() ?? "");
    for (const n of ["新任务", "搜索会话", "设置", "专家模式", "更多选项", "权限", "模型", "提交任务"]) expect(names).toContain(n);
    expect(screen.queryByRole("complementary", { name: "执行面板" })).not.toBeInTheDocument();
    expect(screen.queryByRole("log")).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/评分|成本档位/);
  });

  it("快捷任务只填进输入框，不直接提交", async () => {
    await boot();
    const quick = screen.getByRole("list", { name: "快捷任务" });
    fireEvent.click(within(quick).getAllByRole("button")[0]!);
    expect(screen.getByLabelText("任务描述")).toHaveValue("整理这个目录里的文件，按类型分好");
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
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

  it("模型下拉：第一项是自动路由；自定义 Provider（中转站）的选项来自 /models 缓存", async () => {
    await boot();
    const sel = () => screen.getByLabelText("模型") as HTMLSelectElement;
    expect(sel().value).toBe("");
    expect(sel().options[0]!.text).toBe("自动路由");
    // 默认配置了 openai、anthropic：官方分组来自能力矩阵
    const groups = () => Array.from(sel().querySelectorAll("optgroup")).map((g) => g.label);
    expect(groups().length).toBeGreaterThan(0);

    // 保存一个本地中转站（无需 Key），保存后自动读取 /models 并缓存
    await act(async () => {
      await useSettings.getState().saveCustom({ id: "custom:relay", label: "中转站", base_url: "http://127.0.0.1:8080/v1", default_model: "only-registered", headers: {} });
    });
    await waitFor(() => expect(useSettings.getState().modelCache["custom:relay"]?.models).toEqual(["mock-model", "gpt-5.6-luna"]));
    await waitFor(() => expect(groups()).toContain("中转站"));
    const relay = Array.from(sel().querySelectorAll("optgroup")).find((g) => g.label === "中转站")!;
    expect(Array.from(relay.querySelectorAll("option")).map((o) => o.textContent)).toEqual(["mock-model", "gpt-5.6-luna"]);
  });

  it("锁定模型后跳过路由决策：路由行写明手动锁定；运行中只显示当前一步，完成后折叠成一行", async () => {
    await boot();
    const sel = screen.getByLabelText("模型") as HTMLSelectElement;
    const target = Array.from(sel.querySelectorAll("optgroup option"))[0] as HTMLOptionElement;
    fireEvent.change(sel, { target: { value: target.value } });
    expect(useChat.getState().lock).toBe(target.value);

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
    expect(line).toHaveTextContent(/手动锁定/);
    fireEvent.click(line);
    const route = within(c).getByRole("region", { name: "路由决策详情" });
    expect(route).toHaveTextContent(`你手动锁定了 ${target.value.replace(/^custom:/, "")}，本次跳过路由决策。`);
    expect(route.textContent).not.toMatch(/评分|成本档位/);
  });

  it("会话：发送后出现在左侧列表；新任务回到首屏；点历史会话回到那一轮", async () => {
    await boot();
    submit("第一个会话的问题");
    const list = screen.getByRole("navigation", { name: "会话列表" });
    const item = await within(list).findByRole("button", { name: "第一个会话的问题" });
    expect(item).toHaveAttribute("aria-current", "page");

    fireEvent.click(screen.getByRole("button", { name: "新任务" }));
    expect(screen.getByRole("heading", { level: 1, name: "你好，今天想创造什么？" })).toBeInTheDocument();
    expect(screen.queryByRole("article")).not.toBeInTheDocument();

    fireEvent.click(item);
    expect(card("第一个会话的问题")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("搜索会话"), { target: { value: "不存在" } });
    expect(within(list).getByText("没有匹配的会话")).toBeInTheDocument();
  });
});

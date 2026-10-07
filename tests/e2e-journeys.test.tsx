// 端到端：渲染完整 App（浏览器模式 + 模拟后端），按用户的真实路径走完整流程。
// 贯穿检查：Key 不出现在页面、日志和设置里；没有控制台报错；失败如实显示，不伪装成成果。
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import App from "@/App";
import { createMockBackend, type Backend } from "@/platform";
import { useMemory } from "@/stores/memory";
import { useSettings } from "@/stores/settings";
import { useSkills } from "@/stores/skills";
import { LONG, backToChat, card, drive, openRoute, openSettings, resetStores, runTab, submit } from "./ui-helpers";

const KEY = ["sk", "e2e", "0123456789abcdefghij"].join("-");
let logs: string[] = [];

beforeEach(() => {
  logs = [];
  for (const m of ["error", "warn", "log"] as const) {
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logs.push(`${m}: ${a.map(String).join(" ")}`));
  }
});
afterEach(() => vi.restoreAllMocks());

/** 启动应用直到可以提交任务；backend 相同即模拟「重启后读回同一份数据」 */
async function boot(backend: Backend = createMockBackend()) {
  resetStores(backend);
  const view = render(<App />);
  await waitFor(() => expect(screen.getByLabelText("任务描述")).toBeEnabled(), LONG);
  return view;
}

describe("端到端：首次使用到拿到成果", () => {
  it("配置 Key → 提交任务 → 确认写入 → 看到成果、路由记录 → 专家模式看时间线 → 保存为技能", async () => {
    await boot();
    // 配置 Key：输入框提交后清空，页面只显示「已配置」
    openSettings("Provider 管理");
    const input = screen.getByLabelText("Google Gemini API Key");
    fireEvent.change(input, { target: { value: KEY } });
    fireEvent.click(within(input.closest("li")!).getByRole("button", { name: "保存" }));
    await within(input.closest("li")!).findByText("已配置（系统钥匙串）");
    expect(input).toHaveValue("");

    backToChat();
    const goal = "整理本周会议纪要并保存";
    submit(goal);
    const c = card(goal);
    const confirms = await drive(c);
    // 写入类工具必须先经用户确认
    expect(confirms.some((t) => t.includes("demo_write_file"))).toBe(true);
    await within(c).findByText(/^已完成 · /, {}, LONG);
    expect(within(c).getByRole("region", { name: "成果" })).toHaveTextContent(`（模拟）已完成：${goal}`);

    // 回答下面那行路由记录（V3 5.2）：折叠时是模型和「和最强模式比省了多少」+「为什么选它」；耗时、tokens 在浮层的执行过程里
    const line = within(c).getByRole("button", { name: /查看路由决策/ });
    expect(line).toHaveTextContent(/^使用 \S+ · (省|多花) (<\$0\.01|\$\d+\.\d{2})· 为什么选它$/);
    expect(line.textContent).not.toMatch(/评分|成本档位/);
    const overlay = openRoute(c);
    const route = within(overlay).getByRole("region", { name: "路由决策详情" });
    expect(within(route).getByText("首选")).toBeInTheDocument();
    expect(within(route).getByText("综合能力最强，匹配当前任务")).toBeInTheDocument();
    // 路由偏好写明来自哪一层；默认不是专家模式，不出现内部评分
    expect(route).toHaveTextContent("路由偏好平衡（来自全局设置）");
    // 价格对比：只用价目表里的官方标价；最强模式会选谁、各自单价写明
    const price = within(overlay).getByRole("region", { name: "价格对比" });
    expect(price).toHaveTextContent("最强模式会选");
    expect(price).toHaveTextContent(/每百万 tokens/);
    expect(route.textContent).not.toMatch(/评分|成本档位|判断来源|Jev|没有参与的模型|已停用|Provider|规则兜底|排第一/);

    // 完整时间线、耗时和 tokens 在浮层的「执行过程」里
    runTab(overlay);
    expect(overlay).toHaveTextContent(/耗时 \d+\.\d+s · 模型调用 \d+ 次 · [\d.]+k? tokens/);
    const log = within(overlay).getByRole("log", { name: "执行时间线" });
    for (const s of ["任务分析", "路由决策", "工具调用", "反思", "完成"]) expect(within(log).getAllByText(s).length).toBeGreaterThan(0);
    fireEvent.keyDown(overlay, { key: "Escape" });
    const c2 = card(goal);

    // 成果沉淀：保存为技能后在「记忆与技能库」里能看到
    fireEvent.click(within(c2).getByRole("button", { name: "保存为技能" }));
    fireEvent.click(within(within(c2).getByRole("form", { name: "保存为技能" })).getByRole("button", { name: "保存" }));
    await within(c2).findByText(`已保存到技能库：「${goal}」`);
    openSettings("技能库");
    expect(within(screen.getByRole("list", { name: "技能列表" })).getByRole("listitem", { name: goal })).toBeInTheDocument();

    // 贯穿检查
    expect(document.body.innerHTML).not.toContain(KEY);
    expect(JSON.stringify(useSettings.getState())).not.toContain(KEY);
    expect(logs).toEqual([]);
  });
});

describe("端到端：重启后恢复", () => {
  it("路由偏好、能力矩阵调整、本地决策模型、记忆和技能在重启后读回", async () => {
    const backend = createMockBackend();
    const first = await boot(backend);
    await act(async () => {
      const s = useSettings.getState();
      s.setRouting({ preference: "economy" });
      s.setOverride("openai/gpt-5.6-luna", { enabled: false });
      s.setLocalJev("ollama/qwen3:8b");
      expect(await useMemory.getState().save({ kind: "preference", text: "用简体中文回答" })).toMatchObject({ text: "用简体中文回答" });
      const skill = { name: "整理周报", description: "汇总本周进展，写成周报", steps: [{ goal: "汇总本周进展", tool: "demo_search" }, { goal: "按模板写成周报", tool: null }] };
      expect(await useSkills.getState().save(skill)).toMatchObject({ name: "整理周报" });
      await new Promise((r) => setTimeout(r, 0));
    });
    first.unmount();

    await boot(backend);
    expect(useSettings.getState()).toMatchObject({
      routing: { preference: "economy" },
      overrides: { "openai/gpt-5.6-luna": { enabled: false } },
      providerPrefs: { localJev: "ollama/qwen3:8b" },
    });
    openSettings("路由偏好");
    expect(screen.getByLabelText("决策模型")).toHaveValue("ollama/qwen3:8b");
    openSettings("记忆");
    expect(screen.getByText("用简体中文回答")).toBeInTheDocument();
    openSettings("技能库");
    expect(await within(screen.getByRole("list", { name: "技能列表" })).findByRole("listitem", { name: "整理周报" })).toBeInTheDocument();
    expect(logs).toEqual([]);
  });
});

describe("端到端：所有模型都不可用", () => {
  it("任务如实标为失败，逐个写明试过的模型和失败原因，不显示成果", async () => {
    await boot(createMockBackend({ failRequests: true }));
    const goal = "解释一下量子纠缠";
    submit(goal);
    const c = card(goal);
    await drive(c);
    expect(within(c).getByText(/^失败 · /)).toBeInTheDocument();
    expect(within(c).queryByRole("region", { name: "成果" })).not.toBeInTheDocument();

    // 折叠行描述本次实际尝试，点开后逐个写明试过谁、为什么失败。
    const line = within(c).getByRole("button", { name: /查看路由决策/ });
    expect(line).toHaveTextContent(/本次尝试的 \d+ 个模型均未成功/);
    const overlay = openRoute(c);
    const route = within(overlay).getByRole("region", { name: "路由决策详情" });
    const first = within(route).getByText("首选").nextElementSibling?.textContent ?? "";
    const model = first.match(/^[\w:.-]+\/[\w:.-]+/)?.[0];
    expect(model).toBeTruthy();
    // 服务返回 503：失败记录和时间线都写明是哪个模型、什么原因（服务端错误；前几次调用后熔断，直接跳过）
    const m = model!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const why = new RegExp(`${m}：(服务端错误|连续失败 \\d+ 次，熔断中)`);
    expect(within(route).getByRole("list", { name: "失败记录" })).toHaveTextContent(why);
    runTab(overlay);
    expect(within(overlay).getByRole("log", { name: "执行时间线" })).toHaveTextContent(/（(服务端错误|连续失败 \d+ 次，熔断中)/);
    expect(logs).toEqual([]);
  });
});

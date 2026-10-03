// 任务在会话里的完整表现（V3：卡片画布已下线，过程信息在回答下方的折叠路由行浮层里，docs/UI_LAYOUT_V3.md 2.2、5.2）
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ChatView } from "@/components/chat/ChatView";
import { effectiveProfiles } from "@/lib/engine";
import { useMemory } from "@/stores/memory";
import { useSettings } from "@/stores/settings";
import { useSkills } from "@/stores/skills";
import { useUi } from "@/stores/ui";
import { LONG, card, drive, openMore, openRoute, resetStores, runTab, submit } from "./ui-helpers";

beforeEach(async () => {
  resetStores();
  await useSettings.getState().load();
});

describe("会话里的任务", () => {
  it("提交后确认工具调用，产出成果；成果块列出改动的文件", async () => {
    render(<ChatView />);
    submit("整理本周会议纪要并保存");
    const c = card("整理本周会议纪要并保存");
    expect(screen.getByLabelText("任务描述")).toHaveValue("");

    const confirm = await within(c).findByRole("group", {}, LONG);
    expect(confirm).toHaveTextContent("前需要你的确认");
    expect(confirm).toHaveTextContent("风险");
    await drive(c);

    expect(within(c).getByText(/^已完成 · /)).toBeInTheDocument();
    const result = within(c).getByRole("region", { name: "成果" });
    expect(result).toHaveTextContent("（模拟）已完成：整理本周会议纪要并保存");
    // 写入类工具的目标文件取自工具调用记录；面板不会自动弹出，要点了才开
    expect(within(result).getByRole("list", { name: "改动的文件" })).toHaveTextContent("~/EastGenesis/output.md");
    expect(screen.queryByRole("complementary", { name: "右侧面板" })).not.toBeInTheDocument();
    expect(useUi.getState().panel.open).toBe(false);
    fireEvent.click(within(result).getByRole("button", { name: "查看改动（1 个文件）" }));
    expect(useUi.getState().panel).toMatchObject({ open: true, tab: "changes" });
  });

  it("拒绝写入类工具后任务停止，步骤标记为失败", async () => {
    render(<ChatView />);
    submit("整理周报并保存");
    const c = card("整理周报并保存");
    await drive(c, "demo_write_file");
    const line = within(c).getByRole("button", { name: /^已停止/ });
    fireEvent.click(line);
    expect(within(c).getByRole("list", { name: "执行步骤" })).toHaveTextContent("失败：");
  });
});

describe("记忆提议", () => {
  it("目标里说「记住」时回答里请用户确认，确认后才保存", async () => {
    render(<ChatView />);
    submit("记住：我的时区是 UTC+8");
    const c = card("记住：我的时区是 UTC+8");
    const prompt = within(c).getByRole("region", { name: "记忆提议" });
    expect(prompt).toHaveTextContent("我的时区是 UTC+8");
    expect(useMemory.getState().items).toEqual([]);
    fireEvent.click(within(prompt).getByRole("button", { name: "记住" }));
    await waitFor(() => expect(within(c).queryByRole("region", { name: "记忆提议" })).toBeNull());
    expect(useMemory.getState().items).toMatchObject([{ kind: "fact", text: "我的时区是 UTC+8", source: "task" }]);
    await within(c).findByText(/^已完成 · /, {}, LONG);
  });
});

describe("保存为技能", () => {
  it("完成的任务可以把实际做完的步骤保存为技能，保存前可以修改", async () => {
    render(<ChatView />);
    submit("调研量子纠缠的研究进展");
    const c = card("调研量子纠缠的研究进展");
    await within(c).findByText(/^已完成 · /, {}, LONG);
    fireEvent.click(within(c).getByRole("button", { name: "保存为技能" }));
    const form = within(c).getByRole("form", { name: "保存为技能" });
    expect(within(form).getByLabelText("名称")).toHaveValue("调研量子纠缠的研究进展");
    expect((within(form).getByLabelText("步骤") as HTMLTextAreaElement).value).toContain("| demo_search");
    fireEvent.click(within(form).getByRole("button", { name: "保存" }));
    await within(c).findByText("已保存到技能库：「调研量子纠缠的研究进展」");
    expect(useSkills.getState().items).toMatchObject([{ name: "调研量子纠缠的研究进展", source: "task" }]);
    expect(useSkills.getState().items[0].steps.some((s) => s.tool === "demo_search")).toBe(true);
  });
});

describe("多 Agent 协同", () => {
  it("在「添加」菜单里勾选后拆成子 Agent 并行执行，最后合并成果；执行过程里有拆分记录", async () => {
    render(<ChatView />);
    const menu = openMore();
    fireEvent.click(within(menu).getByRole("menuitemcheckbox", { name: /多 Agent 协同/ }));
    expect(within(screen.getByRole("list", { name: "这次任务的设置" })).getByText("多 Agent")).toBeInTheDocument();
    submit("调研国产大模型的现状");
    const c = card("调研国产大模型的现状");
    await drive(c);
    await within(c).findByText(/^已完成 · /, {}, LONG);
    fireEvent.click(within(c).getByRole("button", { name: /^已完成/ }));
    const steps = within(c).getByRole("list", { name: "执行步骤" });
    expect(steps).toHaveTextContent("调研员：调研并整理资料：调研国产大模型的现状");
    expect(steps).toHaveTextContent("撰写员：撰写成文：调研国产大模型的现状");
    expect(within(c).getByRole("region", { name: "成果" })).toHaveTextContent("已合并 2 个子 Agent 的成果");

    const overlay = openRoute(c);
    runTab(overlay);
    const agents = within(overlay).getByRole("list", { name: "子 Agent" });
    expect(within(agents).getAllByRole("listitem")).toHaveLength(2);
    expect(within(agents).getByRole("listitem", { name: "调研员" })).toHaveTextContent("已完成");
    expect(within(within(overlay).getByRole("log", { name: "执行时间线" })).getByText("拆分为 2 个子 Agent")).toBeInTheDocument();
  }, 15000);
});

describe("回答下方的路由浮层", () => {
  it("执行过程：各阶段、每一步的模型；成本档和内部评分只在专家模式出现", async () => {
    render(<ChatView />);
    submit("写一段 Python 快速排序");
    const c = card("写一段 Python 快速排序");
    await drive(c);

    let overlay = openRoute(c);
    expect(within(overlay).queryByRole("region", { name: "内部评分" })).not.toBeInTheDocument();
    runTab(overlay);
    let log = within(overlay).getByRole("log", { name: "执行时间线" });
    for (const s of ["任务分析", "路由决策", "模型输出", "反思", "完成"]) expect(within(log).getAllByText(s).length).toBeGreaterThan(0);
    expect(within(log).queryByText(/成本档位 \d\/5/)).not.toBeInTheDocument();
    fireEvent.keyDown(overlay, { key: "Escape" });
    expect(within(c).queryByRole("dialog", { name: "路由决策" })).not.toBeInTheDocument();

    act(() => useUi.getState().setPrefs({ expert: true }));
    overlay = openRoute(c);
    const route = within(overlay).getByRole("region", { name: "内部评分" });
    expect(within(route).getAllByText(/得分 \d\.\d{2}/).length).toBeGreaterThan(0);
    // 没有配置 Jev Key：决策降级到规则引擎，并说明原因
    expect(within(route).getByText(/规则引擎（第 \d 级/)).toBeInTheDocument();
    expect(within(route).getByText(/已降级：/)).toBeInTheDocument();
    expect(within(route).getByText(/权重：能力匹配/)).toBeInTheDocument();
    runTab(overlay);
    log = within(overlay).getByRole("log", { name: "执行时间线" });
    expect(within(log).getAllByText(/成本档位 \d\/5/).length).toBeGreaterThan(0);
  });

  it("选了本地决策模型：浮层注明它为什么没接手，时间线注明反思由它判断", async () => {
    useSettings.getState().setLocalJev("ollama/qwen3:8b");
    act(() => useUi.getState().setPrefs({ expert: true }));
    render(<ChatView />);
    submit("写一段 Python 快速排序");
    const c = card("写一段 Python 快速排序");
    await drive(c);
    const overlay = openRoute(c);
    expect(within(within(overlay).getByRole("region", { name: "内部评分" })).getByText(/已降级：.*本地 Jev（置信度 0\.00 低于阈值 0\.6）/)).toBeInTheDocument();
    runTab(overlay);
    expect(within(within(overlay).getByRole("log", { name: "执行时间线" })).getAllByText("评分 1.00 · 本地 Jev").length).toBeGreaterThan(0);
  });

  it("手动干预在任务进行中出现：锁定后，之后的模型调用都用它", async () => {
    const locked = effectiveProfiles().find((p) => p.provider === "anthropic")!.id;
    render(<ChatView />);
    submit("整理本周会议纪要并保存");
    const c = card("整理本周会议纪要并保存");
    // 写入前停下来等确认：任务还在进行中，路由决策已经做完
    await within(c).findByRole("group", {}, LONG);
    const overlay = openRoute(c);
    const panel = within(overlay).getByRole("region", { name: "手动干预" });
    fireEvent.change(within(panel).getByLabelText("模型"), { target: { value: locked } });
    fireEvent.click(within(panel).getByRole("button", { name: "锁定" }));
    expect(within(panel).getByText(new RegExp(`已锁定 ${locked}`))).toBeInTheDocument();
    fireEvent.keyDown(overlay, { key: "Escape" });

    await drive(c);
    const done = openRoute(c);
    expect(within(done).queryByRole("region", { name: "手动干预" })).not.toBeInTheDocument();
    runTab(done);
    const calls = within(within(done).getByRole("log", { name: "执行时间线" })).getAllByText(/^(规划|修改步骤|生成参数|回答|总结) · /);
    // 锁定之前的规划用的是自动选的模型；从第一次用上锁定模型起，之后每一次都是它
    const first = calls.findIndex((el) => el.textContent?.includes(locked));
    expect(first).toBeGreaterThanOrEqual(0);
    for (const el of calls.slice(first)) expect(el.textContent).toContain(locked);
  });
});

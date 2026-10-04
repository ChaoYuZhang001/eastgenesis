// 项目与目标的界面（docs/UI_LAYOUT_V3.md 1.2–1.4、2.3–2.5）：接在 M8 的 projects / goals store 上
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import App from "@/App";
import { useChat } from "@/stores/chat";
import { useGoals } from "@/stores/goals";
import { useProjects } from "@/stores/projects";
import { useSettings } from "@/stores/settings";
import { useTasks } from "@/stores/tasks";
import { useUi } from "@/stores/ui";
import { LONG, card, drive, openMore, resetStores, submit } from "./ui-helpers";

beforeEach(() => resetStores());

async function boot() {
  render(<App />);
  await waitFor(() => expect(screen.getByLabelText("任务描述")).toBeEnabled(), LONG);
  await waitFor(() => expect(useProjects.getState().loaded && useGoals.getState().loaded).toBe(true));
}
const rail = (name: string) => fireEvent.click(within(screen.getByRole("navigation", { name: "主导航" })).getByRole("button", { name }));
const side = () => screen.getByRole("complementary", { name: "内容栏" });

async function newProject(name: string, pref?: string) {
  rail("项目");
  fireEvent.click(within(side()).getByRole("button", { name: "新建项目" }));
  const form = screen.getByRole("form", { name: "新建项目" });
  fireEvent.change(within(form).getByLabelText("名称"), { target: { value: name } });
  if (pref) fireEvent.change(within(form).getByLabelText("路由偏好"), { target: { value: pref } });
  fireEvent.click(within(form).getByRole("button", { name: "保存" }));
  await waitFor(() => expect(screen.queryByRole("form", { name: "新建项目" })).not.toBeInTheDocument());
  return useProjects.getState().items.find((p) => p.name === name)!;
}

describe("项目", () => {
  it("新建：保存失败时显示 store 返回的原文；成功后出现在列表里，行的第二行是生效的路由偏好", async () => {
    await boot();
    rail("项目");
    fireEvent.click(within(side()).getByRole("button", { name: "新建项目" }));
    const form = screen.getByRole("form", { name: "新建项目" });
    fireEvent.change(within(form).getByLabelText("名称"), { target: { value: "合同" } });
    fireEvent.change(within(form).getByLabelText("项目指令"), { target: { value: "token 是 sk-abcdefghijklmnop1234" } });
    fireEvent.click(within(form).getByRole("button", { name: "保存" }));
    expect(await within(form).findByRole("alert")).toHaveTextContent("内容看起来包含密钥或令牌，不能保存");
    fireEvent.change(within(form).getByLabelText("项目指令"), { target: { value: "先给结论" } });
    fireEvent.change(within(form).getByLabelText("路由偏好"), { target: { value: "economy" } });
    fireEvent.click(within(form).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(screen.queryByRole("form", { name: "新建项目" })).not.toBeInTheDocument());

    const list = within(side()).getByRole("navigation", { name: "项目列表" });
    const row = within(list).getByRole("button", { name: /合同/ });
    expect(row).toHaveTextContent("省钱");
    expect(within(row).getByTitle("路由偏好：省钱（来自项目）")).toBeInTheDocument();

    // 点项目行打开概览：偏好写明来源
    fireEvent.click(row);
    const main = screen.getByRole("main", { name: "项目" });
    expect(within(main).getByRole("heading", { level: 1, name: "合同" })).toBeInTheDocument();
    expect(main).toHaveTextContent("省钱（来自项目）");
    expect(await within(main).findByText("0 条")).toBeInTheDocument();
  });

  it("工作台里点项目行：展开并设为当前项目；新任务归入它，占位文字和标签行随之变化", async () => {
    await boot();
    const p = await newProject("周报");
    rail("工作台");
    const row = within(side()).getByRole("button", { name: /周报/ });
    expect(row).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(row);
    expect(row).toHaveAttribute("aria-expanded", "true");
    expect(within(side()).getByText("还没有目标和任务")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("在「周报」里描述你的任务...")).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "这次任务的设置" })).getByText("周报")).toBeInTheDocument();

    submit("汇总本周进展");
    expect(useChat.getState().sessions[0]).toMatchObject({ projectId: p.id });
    expect(useTasks.getState().tasks[0]).toMatchObject({ projectId: p.id, preferenceSource: "global" });
    const group = within(side()).getByRole("group", { name: "周报 里的目标和任务" });
    expect(within(group).getByRole("button", { name: /汇总本周进展/ })).toBeInTheDocument();
    await drive(card("汇总本周进展"));

    // 点标签上的 × 取消当前项目
    fireEvent.click(screen.getByRole("button", { name: "移除项目 周报" }));
    expect(useUi.getState().currentProjectId).toBeNull();
    expect(screen.getByPlaceholderText("描述你的任务...")).toBeInTheDocument();
  });

  it("路由偏好继承：项目设成省钱，任务自动时用省钱（来自项目）；任务选最强时覆盖项目", async () => {
    await boot();
    await act(async () => {
      useSettings.getState().setRouting({ preference: "balanced" });
    });
    await newProject("调研", "economy");
    rail("工作台");
    fireEvent.click(within(side()).getByRole("button", { name: /调研/ }));
    submit("调研量子纠缠");
    expect(useTasks.getState().tasks[0]).toMatchObject({ preference: "economy", preferenceSource: "project" });
    await drive(card("调研量子纠缠"));

    fireEvent.click(screen.getByRole("button", { name: "路由" }));
    fireEvent.click(within(screen.getByRole("menu", { name: "路由" })).getByRole("menuitemradio", { name: /最强模式/ }));
    submit("再调研一次");
    expect(useTasks.getState().tasks[0]).toMatchObject({ preference: "best", preferenceSource: "task" });
    await drive(card("再调研一次"));
  });

  it("更多操作：归档、取消归档；删除项目要二次确认，写明连带数量，取消默认聚焦", async () => {
    await boot();
    const p = await newProject("旧项目");
    await act(async () => {
      await useGoals.getState().save({ description: "目标甲", project_id: p.id });
      await useGoals.getState().save({ description: "目标乙", project_id: p.id });
    });
    const list = within(side()).getByRole("navigation", { name: "项目列表" });
    const row = within(list).getByRole("button", { name: /旧项目/ });
    fireEvent.mouseEnter(row.parentElement!);
    fireEvent.click(within(list).getByRole("button", { name: "项目的更多操作" }));
    fireEvent.click(within(screen.getByRole("menu", { name: "项目的更多操作" })).getByRole("menuitem", { name: "归档" }));
    await waitFor(() => expect(useProjects.getState().items[0]?.archived).toBe(true));
    // 归档后在「已归档」组里（默认收起）
    const archived = within(side()).getByRole("button", { name: /已归档/ });
    expect(archived).toHaveAttribute("aria-expanded", "false");
    expect(archived).toHaveTextContent("1");
    fireEvent.click(archived);

    // 右键打开同一个菜单
    const again = within(side()).getByRole("button", { name: /^旧项目/ });
    fireEvent.contextMenu(again.parentElement!);
    await waitFor(() => expect(screen.getByRole("menu", { name: "项目的更多操作" })).toBeInTheDocument());
    fireEvent.click(within(screen.getByRole("menu", { name: "项目的更多操作" })).getByRole("menuitem", { name: "删除项目…" }));
    const dialog = await screen.findByRole("alertdialog", { name: "删除「旧项目」？" });
    expect(dialog).toHaveTextContent("会一并删除 2 个目标。");
    expect(within(dialog).getByRole("button", { name: "取消" })).toHaveFocus();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(useProjects.getState().items).toHaveLength(1);

    fireEvent.contextMenu(within(side()).getByRole("button", { name: /^旧项目/ }).parentElement!);
    await waitFor(() => expect(screen.getByRole("menu", { name: "项目的更多操作" })).toBeInTheDocument());
    fireEvent.click(within(screen.getByRole("menu", { name: "项目的更多操作" })).getByRole("menuitem", { name: "删除项目…" }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "删除" }));
    await waitFor(() => expect(useProjects.getState().items).toEqual([]));
    expect(useGoals.getState().items).toEqual([]);
  });
});

describe("目标", () => {
  it("「添加」菜单勾选「目标」后提交：新建目标并打开详情；开始后自动跑一轮，暂停 / 继续，状态行写明轮数和模型调用", async () => {
    await boot();
    const menu = openMore();
    fireEvent.click(within(menu).getByRole("menuitemcheckbox", { name: /目标/ }));
    expect(screen.getByPlaceholderText("描述要持续追求的目标...")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("任务描述"), { target: { value: "把下载文件夹里的合同都归档" } });
    fireEvent.click(screen.getByRole("button", { name: "提交任务" }));

    const main = await screen.findByRole("main", { name: "目标" });
    expect(within(main).getByRole("heading", { level: 1, name: "把下载文件夹里的合同都归档" })).toBeInTheDocument();
    expect(main).toHaveTextContent("未开始 · 模型调用 0 / 50");
    expect(useTasks.getState().tasks).toEqual([]);
    expect(useChat.getState().mode).toBe("quick");

    // 开始：执行器立刻开一轮（mock 模型不带实据，跑完停在「等你确认」，不自动收尾）
    fireEvent.click(within(main).getByRole("button", { name: "开始" }));
    const bar = await within(main).findByRole("region", { name: "等你确认" }, LONG);
    expect(bar).toHaveTextContent("AI 声称完成，但无实据");
    expect(main).toHaveTextContent(/第 1 轮/);
    expect(main).toHaveTextContent(/模型调用 [1-9]\d* \/ 50/);
    // 这一轮对应一张任务卡（工作台里能看到它的执行过程），目标下能看到这一步的步骤
    const rounds = within(main).getByRole("list", { name: "轮次" });
    expect(within(rounds).getByRole("button", { name: /第 1 轮/ })).toHaveAttribute("aria-expanded", "true");
    expect(main).toHaveTextContent("规则判定：拿不准");

    fireEvent.click(within(main).getByRole("button", { name: "暂停" }));
    await within(main).findByRole("button", { name: "继续" });
    expect(main).toHaveTextContent("已暂停");

    // 「最近」里出现这个目标，第二行是状态
    const recent = within(side()).getByRole("navigation", { name: "会话列表" });
    expect(within(recent).getByRole("button", { name: /把下载文件夹里的合同都归档/ })).toHaveTextContent("已暂停");
  });

  it("最后一轮拿不准：显示「AI 声称完成，但无实据」，不自动开下一轮也不自动收尾，等你选", async () => {
    await boot();
    let id = "";
    await act(async () => {
      const g = await useGoals.getState().save({ description: "写一份周报" });
      if (typeof g === "string") throw new Error(g);
      id = g.id;
      await useGoals.getState().start(id);
      await useGoals.getState().apply(id, { op: "start_round", plan: { title: "写初稿", items: ["汇总进展", "写成周报"] } });
      await useGoals.getState().apply(id, { op: "finish_round", result: { verdict: "uncertain", reason: "AI 声称完成，但无实据", by: "rules" }, evidence: { tool_calls: [], file_changes: [], command_outputs: [], claim: "已经写好了" } });
    });
    act(() => useUi.getState().open({ kind: "goal", id }));
    const main = screen.getByRole("main", { name: "目标" });
    const bar = within(main).getByRole("region", { name: "等你确认" });
    expect(bar).toHaveTextContent("AI 声称完成，但无实据");
    expect(main).toHaveTextContent("等你确认 · 第 1 轮");
    const rounds = within(main).getByRole("list", { name: "轮次" });
    expect(within(rounds).getByRole("button", { name: /第 1 轮 · 写初稿/ })).toHaveAttribute("aria-expanded", "true");
    expect(within(rounds).getByText("规则判定：拿不准")).toBeInTheDocument();
    // 什么都不点：不会自己进入下一轮
    await new Promise((r) => setTimeout(r, 30));
    expect(useGoals.getState().items[0]?.rounds).toHaveLength(1);
    expect(useGoals.getState().items[0]?.status).toBe("running");

    fireEvent.click(within(bar).getByRole("button", { name: "确认已完成" }));
    await waitFor(() => expect(useGoals.getState().items[0]?.status).toBe("completed"));
    expect(within(main).queryByRole("region", { name: "等你确认" })).not.toBeInTheDocument();
    expect(within(main).getByText("你确认：已完成")).toBeInTheDocument();
    expect(within(main).queryByRole("button", { name: "开始" })).not.toBeInTheDocument();
  });

  it("放弃、删除都要确认；菜单只给合法的转换；删除后详情页回到首屏", async () => {
    await boot();
    let id = "";
    await act(async () => {
      const g = await useGoals.getState().save({ description: "整理照片" });
      if (typeof g === "string") throw new Error(g);
      id = g.id;
    });
    act(() => useUi.getState().open({ kind: "goal", id }));
    const main = screen.getByRole("main", { name: "目标" });
    // 未开始的目标不能放弃（M8 状态机），菜单里就不给
    fireEvent.click(within(main).getByRole("button", { name: "目标的更多操作" }));
    expect(within(screen.getByRole("menu", { name: "目标的更多操作" })).queryByRole("menuitem", { name: "放弃目标…" })).not.toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("menu", { name: "目标的更多操作" }), { key: "Escape" });
    fireEvent.click(within(main).getByRole("button", { name: "开始" }));
    await within(main).findByRole("button", { name: "暂停" });
    fireEvent.click(within(main).getByRole("button", { name: "目标的更多操作" }));
    fireEvent.click(within(screen.getByRole("menu", { name: "目标的更多操作" })).getByRole("menuitem", { name: "放弃目标…" }));
    const dialog = await screen.findByRole("alertdialog", { name: "放弃这个目标？" });
    expect(dialog).toHaveTextContent("已完成的轮次会保留，之后不能再继续。");
    fireEvent.click(within(dialog).getByRole("button", { name: "放弃" }));
    await waitFor(() => expect(useGoals.getState().items[0]?.status).toBe("abandoned"));

    fireEvent.click(within(main).getByRole("button", { name: "目标的更多操作" }));
    const menu = screen.getByRole("menu", { name: "目标的更多操作" });
    expect(within(menu).queryByRole("menuitem", { name: "放弃目标…" })).not.toBeInTheDocument();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "删除目标…" }));
    fireEvent.click(within(await screen.findByRole("alertdialog", { name: "删除这个目标？" })).getByRole("button", { name: "删除" }));
    await waitFor(() => expect(useGoals.getState().items).toEqual([]));
    expect(screen.getByRole("heading", { level: 1, name: "你好，今天想创造什么？" })).toBeInTheDocument();
  });
});

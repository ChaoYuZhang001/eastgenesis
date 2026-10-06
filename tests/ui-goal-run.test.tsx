// 目标模式的界面接线（M10）：开始后自动跑一轮，轮次显示判定和折叠路由行；
// 暂停停掉正在跑的那一轮；「继续下一轮」在确认之后才开下一轮；删除项目先停掉这个项目里的目标。
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import App from "@/App";
import { emptyEvidence } from "@/decision/evidence";
import { useChat } from "@/stores/chat";
import { watchHistory } from "@/stores/history";
import { useGoals } from "@/stores/goals";
import { useProjects } from "@/stores/projects";
import { useTasks } from "@/stores/tasks";
import { useUi } from "@/stores/ui";
import { LONG, resetStores } from "./ui-helpers";

beforeEach(() => resetStores());

async function boot() {
  render(<App />);
  await waitFor(() => expect(screen.getByLabelText("任务描述")).toBeEnabled(), LONG);
}

/** 新建一个目标、打开详情页并开始（返回详情主区） */
async function startGoal(description: string) {
  let id = "";
  await act(async () => {
    const g = await useGoals.getState().save({ description });
    if (typeof g === "string") throw new Error(g);
    id = g.id;
  });
  act(() => useUi.getState().open({ kind: "goal", id }));
  const main = screen.getByRole("main", { name: "目标" });
  fireEvent.click(within(main).getByRole("button", { name: "开始" }));
  return { id, main };
}

describe("目标模式：多轮执行", () => {
  it("开始后自动跑一轮：轮次显示进行中的步骤、判定和折叠路由行，并记进目标的模型调用数", async () => {
    await boot();
    const { main } = await startGoal("把下载文件夹里的合同都归档");

    // mock 模型不带实据：这一轮判定「拿不准」，停下等你确认（不自动收尾，也不自动开下一轮）
    const bar = await within(main).findByRole("region", { name: "等你确认" }, LONG);
    expect(bar).toHaveTextContent("AI 声称完成，但无实据");
    expect(useGoals.getState().items[0]?.rounds).toHaveLength(1);
    expect(useGoals.getState().items[0]?.used_llm_calls).toBeGreaterThan(0);

    // 这一轮是一次真实的任务：执行器建了卡，事件都在
    const card = useTasks.getState().tasks[0];
    expect(card).toMatchObject({ goalId: useGoals.getState().items[0]?.id, mode: "goal", sessionId: null });
    expect(card.events.some((e) => e.type === "route")).toBe(true);

    // 轮次展开着：步骤、判定和折叠路由行都在
    const rounds = within(main).getByRole("list", { name: "轮次" });
    const round = within(rounds).getByRole("button", { name: /第 1 轮/ });
    expect(round).toHaveAttribute("aria-expanded", "true");
    expect(within(rounds).getByRole("list", { name: "第 1 轮的步骤" })).toBeInTheDocument();
    expect(within(rounds).getByText("规则判定：拿不准")).toBeInTheDocument();
    const route = within(rounds).getByRole("button", { name: /查看路由决策/ });
    expect(route).toHaveTextContent(/· 查看详情$|· 为什么选它$/);
    fireEvent.click(route);
    expect(within(rounds).getByRole("region", { name: "路由决策详情" })).toBeInTheDocument();
  });

  it("暂停停掉正在跑的那一轮：这一轮记为「被打断」，不再开下一轮", async () => {
    await boot();
    // 目标里带「保存」：mock 规划器会排一步需要确认的写入，这一轮因此真的停在半路
    const { id, main } = await startGoal("把下载文件夹里的合同归档并保存一份清单");
    // 目标轮次不进会话列表，所以确认提示出现在详情页的「正在执行的一轮」里
    const running = await within(main).findByRole("region", { name: "正在执行的一轮" }, LONG);
    expect(running).toHaveTextContent(/· Work 工作/);
    await within(running).findByRole("group", { name: /确认/ }, LONG);

    fireEvent.click(within(main).getByRole("button", { name: "暂停" }));
    await waitFor(() => expect(useGoals.getState().items.find((x) => x.id === id)?.status).toBe("paused"), LONG);
    // 被打断的一轮保留下来，没有判定，也不会自己往下跑
    await waitFor(() => {
      const g = useGoals.getState().items.find((x) => x.id === id)!;
      expect(g.rounds).toHaveLength(1);
      expect(g.rounds[0].status).toBe("interrupted");
      expect(g.rounds[0].verdict).toBeNull();
    }, LONG);
    // 那一轮的任务也停了，确认提示不再挂着
    await waitFor(() => expect(within(main).queryByRole("group", { name: /确认/ })).not.toBeInTheDocument(), LONG);
    expect(useTasks.getState().tasks.every((t) => t.status !== "running")).toBe(true);
    expect(main).toHaveTextContent("已暂停");
  });

  it("「继续下一轮」在确认之后才开下一轮；确认完成则收尾", async () => {
    await boot();
    const { id, main } = await startGoal("写一份周报");
    const bar = await within(main).findByRole("region", { name: "等你确认" }, LONG);

    fireEvent.click(within(bar).getByRole("button", { name: "继续下一轮" }));
    await waitFor(() => expect(useGoals.getState().items.find((g) => g.id === id)?.rounds).toHaveLength(2), LONG);
    const g = useGoals.getState().items.find((x) => x.id === id)!;
    expect(g.rounds[0].verdict?.by).toBe("user");
    expect(g.rounds[0].status).toBe("not_done");
    // 第二轮的标题取自上一轮判定（你说继续），并带上了第一轮的提示
    expect(g.rounds[1].title).toContain("你选择继续");

    // 第二轮同样停在「等你确认」；这次确认完成
    await waitFor(() => expect(within(main).getByRole("region", { name: "等你确认" })).toBeInTheDocument(), LONG);
    fireEvent.click(within(main).getByRole("button", { name: "确认已完成" }));
    await waitFor(() => expect(useGoals.getState().items.find((x) => x.id === id)?.status).toBe("completed"), LONG);
    expect(within(main).queryByRole("region", { name: "等你确认" })).not.toBeInTheDocument();
  });

  it("每轮的模型调用记进使用记录，但目标轮次不会写出一条会话", async () => {
    const stop = watchHistory();
    const backend = resetStores();
    await boot();
    await startGoal("把合同归档");
    await waitFor(() => expect(useGoals.getState().items[0]?.used_llm_calls).toBeGreaterThan(0), LONG);
    await waitFor(async () => {
      const calls = await backend.listUsage(0);
      expect(calls.length).toBeGreaterThan(0);
      expect(calls[0].goal_id).toBe(useGoals.getState().items[0]?.id);
      expect(calls[0].session_id).toBeNull();
    }, LONG);
    // 会话表里不该出现目标轮次（否则「最近」和历史里会多出一堆空会话）
    expect(await backend.listSessions()).toEqual([]);
    expect(useChat.getState().sessions).toEqual([]);
    stop();
  });

  it("同一时间有会话在跑时，目标轮次也不会被写进那个会话的回合里", async () => {
    const stop = watchHistory();
    const backend = resetStores();
    await boot();
    // 一个普通会话（一轮问答），同时一个目标在跑
    fireEvent.change(screen.getByLabelText("任务描述"), { target: { value: "解释一下量子纠缠" } });
    fireEvent.click(screen.getByRole("button", { name: "提交任务" }));
    const sessionId = useChat.getState().activeId!;
    await waitFor(() => expect(useTasks.getState().tasks[0]?.status).not.toBe("running"), LONG);
    await startGoal("把合同归档");

    await waitFor(async () => {
      const stored = await backend.listSessions();
      const s = stored.find((x) => x.id === sessionId);
      expect(s?.turns).toHaveLength(1);
      // 只有那一轮问答，目标轮次不在里面
      expect(s?.turns[0].goal).toBe("解释一下量子纠缠");
    }, LONG);
    expect(useGoals.getState().items[0]?.used_llm_calls).toBeGreaterThan(0);
    stop();
  });

  it("删除项目时先停掉这个项目下正在跑的目标（哪怕它正卡在确认提示上）", async () => {
    await boot();
    let pid = "";
    await act(async () => {
      const p = await useProjects.getState().save({ name: "归档项目" });
      if (typeof p === "string") throw new Error(p);
      pid = p.id;
      const g = await useGoals.getState().save({ description: "把合同归档到项目里并保存一份清单", project_id: pid });
      if (typeof g === "string") throw new Error(g);
      useUi.getState().open({ kind: "goal", id: g.id });
    });
    const main = screen.getByRole("main", { name: "目标" });
    fireEvent.click(within(main).getByRole("button", { name: "开始" }));
    // 停在权限确认上：循环在等这个回答，改写目标不会让它退出
    await within(main).findByRole("group", { name: /确认/ }, LONG);

    // 从内容栏删项目：确认后目标被连带删除，前面那一轮的任务被取消
    const panel = screen.getByRole("complementary", { name: "内容栏" });
    const row = within(panel).getByRole("button", { name: /归档项目/ });
    fireEvent.contextMenu(row);
    fireEvent.click(await screen.findByRole("menuitem", { name: "删除项目…" }));
    const dialog = await screen.findByRole("alertdialog", { name: /删除「归档项目」？/ });
    fireEvent.click(within(dialog).getByRole("button", { name: "删除" }));
    await waitFor(() => expect(useGoals.getState().items).toEqual([]), LONG);
    expect(useProjects.getState().items).toEqual([]);
    // 在跑的那一轮任务已经停掉（不再有 running 的任务）
    await waitFor(() => expect(useTasks.getState().tasks.every((t) => t.status !== "running")).toBe(true), LONG);
  });

  it("落库的轮次带上执行它的任务 id；读回后仍能把轮次和任务对上", async () => {
    await boot();
    const { id } = await startGoal("归档截图");
    await waitFor(() => expect(useGoals.getState().items[0]?.rounds).toHaveLength(1), LONG);
    const round = useGoals.getState().items[0]!.rounds[0];
    const taskId = useTasks.getState().tasks[0]!.id;
    expect(round.task_id).toBe(taskId);
    // 从数据库读回：task_id 保留（界面靠它找到那一轮的折叠路由行）
    await act(async () => {
      await useGoals.getState().load();
    });
    expect(useGoals.getState().items.find((g) => g.id === id)?.rounds[0].task_id).toBe(taskId);
    // 旧数据（没有 task_id 的轮次）读回后是 null，不出错
    expect(emptyEvidence()).toEqual({ tool_calls: [], file_changes: [], command_outputs: [] });
  });
});

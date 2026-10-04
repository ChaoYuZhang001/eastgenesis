// 会话持久化（迁移 5）：重启后会话、回合、本月节省都能读回；删除的会话不再出现；进行中的回合不写进数据库
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import App from "@/App";
import { createMockBackend, type Backend } from "@/platform";
import { useChat } from "@/stores/chat";
import { useTasks } from "@/stores/tasks";
import { useUsage } from "@/stores/usage";
import { LONG, card, drive, openRoute, resetStores, submit } from "./ui-helpers";

async function boot(backend: Backend) {
  resetStores(backend);
  useUsage.setState({ loaded: false, calls: [], error: null });
  const view = render(<App />);
  await waitFor(() => expect(screen.getByLabelText("任务描述")).toBeEnabled(), LONG);
  return view;
}
const recent = () => screen.getByRole("navigation", { name: "会话列表" });

describe("会话持久化", () => {
  it("回合结束后写回；重启读回：会话在「最近」里，点开是同样的回答和路由记录，本月节省跨重启累计", async () => {
    const backend = createMockBackend();
    const first = await boot(backend);
    submit("整理本周会议纪要并保存");
    const c = card("整理本周会议纪要并保存");
    await drive(c);
    await within(c).findByText(/^已完成 · /, {}, LONG);
    await waitFor(async () => expect((await backend.listSessions())[0]?.turns).toHaveLength(1));
    await waitFor(async () => expect((await backend.listUsage(0)).length).toBeGreaterThan(0));
    const calls = (await backend.listUsage(0)).length;
    first.unmount();

    await boot(backend);
    const item = await within(recent()).findByRole("button", { name: /整理本周会议纪要并保存/ }, LONG);
    fireEvent.click(item);
    const again = card("整理本周会议纪要并保存");
    expect(within(again).getByRole("region", { name: "成果" })).toHaveTextContent("（模拟）已完成：整理本周会议纪要并保存");
    expect(within(openRoute(again)).getByRole("region", { name: "路由决策详情" })).toHaveTextContent("首选");
    // 读回的回合只读：没有停止按钮、没有待确认
    expect(within(again).queryByRole("button", { name: "停止任务" })).not.toBeInTheDocument();
    await waitFor(() => expect(useUsage.getState().calls).toHaveLength(calls));

    // 新的一轮接在读回的回合后面，同一个会话
    submit("再补一份待办清单");
    const next = card("再补一份待办清单");
    await drive(next);
    await within(next).findByText(/^已完成 · /, {}, LONG);
    const turns = useTasks.getState().tasks.filter((t) => t.sessionId === useChat.getState().activeId).sort((a, b) => a.seq - b.seq);
    expect(turns.map((t) => t.goal)).toEqual(["整理本周会议纪要并保存", "再补一份待办清单"]);
    await waitFor(async () => expect((await backend.listSessions())[0]?.turns).toHaveLength(2));
  });

  it("删除会话：二次确认，删除后重启也不再出现", async () => {
    const backend = createMockBackend();
    const first = await boot(backend);
    submit("解释一下量子纠缠");
    await drive(card("解释一下量子纠缠"));
    await waitFor(async () => expect(await backend.listSessions()).toHaveLength(1));

    const row = within(recent()).getByRole("button", { name: /解释一下量子纠缠/ });
    fireEvent.contextMenu(row.parentElement!);
    await waitFor(() => expect(screen.getByRole("menu", { name: "会话的更多操作" })).toBeInTheDocument());
    fireEvent.click(within(screen.getByRole("menu", { name: "会话的更多操作" })).getByRole("menuitem", { name: "删除会话…" }));
    const dialog = await screen.findByRole("alertdialog", { name: "删除这个会话？" });
    expect(within(dialog).getByRole("button", { name: "取消" })).toHaveFocus();
    fireEvent.click(within(dialog).getByRole("button", { name: "删除" }));
    await waitFor(() => expect(useChat.getState().sessions).toEqual([]));
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
    expect(await backend.listSessions()).toEqual([]);
    first.unmount();

    await boot(backend);
    expect(within(recent()).getByText("还没有会话")).toBeInTheDocument();
  });

  it("进行中的回合不写进数据库：同一会话里前一轮结束写回时，还在等确认的那一轮不在里面", async () => {
    const backend = createMockBackend();
    const first = await boot(backend);
    // 第一轮停在写入确认上，第二轮是简单问答、很快结束并触发写回
    submit("整理周报并保存");
    await within(card("整理周报并保存")).findByRole("group", {}, LONG);
    submit("你好");
    await waitFor(() => expect(useTasks.getState().tasks.find((t) => t.goal === "你好")?.status).toBe("completed"), LONG);
    await waitFor(async () => expect((await backend.listSessions())[0]?.turns.map((t) => t.goal)).toEqual(["你好"]));
    expect(useTasks.getState().tasks.find((t) => t.goal === "整理周报并保存")?.status).toBe("running");
    // 停掉以后才写回，状态如实是「已停止」
    act(() => {
      for (const t of useTasks.getState().tasks) useTasks.getState().cancel(t.id);
    });
    await waitFor(async () => expect((await backend.listSessions())[0]?.turns.map((t) => [t.goal, t.status])).toEqual([["整理周报并保存", "aborted"], ["你好", "completed"]]));
    first.unmount();
  });
});

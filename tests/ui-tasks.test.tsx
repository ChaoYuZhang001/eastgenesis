import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { RightPanel } from "@/components/panel/RightPanel";
import { TaskCanvas } from "@/components/task/TaskCanvas";
import { effectiveProfiles } from "@/lib/engine";
import { useMemory } from "@/stores/memory";
import { useSettings } from "@/stores/settings";
import { useSkills } from "@/stores/skills";
import { LONG, card, drive, openMore, resetStores, submit } from "./ui-helpers";

// 专家模式的工作台：任务画布 + 右侧执行面板
function Workbench() {
  return (
    <div className="flex">
      <TaskCanvas />
      <RightPanel />
    </div>
  );
}

beforeEach(async () => {
  resetStores();
  await useSettings.getState().load();
});

const order = () => screen.getAllByRole("article").map((a) => a.getAttribute("aria-label"));

describe("任务画布", () => {
  it("提交任务生成卡片，确认工具调用后产出成果", async () => {
    render(<Workbench />);
    submit("整理本周会议纪要并保存");
    const c = card("整理本周会议纪要并保存");
    expect(screen.getByLabelText("任务描述")).toHaveValue("");
    expect(c).toHaveAttribute("aria-current", "true");

    const confirm = await within(c).findByRole("group", {}, LONG);
    expect(confirm).toHaveTextContent("前需要你的确认");
    expect(confirm).toHaveTextContent("风险");
    await drive(c);

    expect(within(c).getByText("已完成")).toBeInTheDocument();
    expect(within(c).getByRole("region", { name: "成果" })).toHaveTextContent("（模拟）已完成：整理本周会议纪要并保存");
    expect(within(c).getByRole("list", { name: "执行步骤" })).toHaveTextContent("已完成：");
    expect(within(c).getByText(/模型调用 \d+ 次/)).toBeInTheDocument();
  });

  it("拒绝写入类工具后任务停止，步骤标记为失败", async () => {
    render(<Workbench />);
    submit("整理周报并保存");
    const c = card("整理周报并保存");
    await drive(c, "demo_write_file");
    expect(within(c).getByText("已停止")).toBeInTheDocument();
    expect(within(c).getByRole("list", { name: "执行步骤" })).toHaveTextContent("失败：");
  });

  it("多卡片：拖拽排序、上移下移、折叠、关闭", async () => {
    render(<Workbench />);
    for (const g of ["甲", "乙", "丙"]) submit(g);
    expect(order()).toEqual(["任务：丙", "任务：乙", "任务：甲"]);

    // 把「甲」拖到「丙」上：放到第 1 位
    const grip = card("甲").querySelector("[draggable]")!;
    fireEvent.dragStart(grip);
    fireEvent.dragOver(card("丙"));
    expect(card("丙").className).toContain("border-dashed");
    fireEvent.drop(card("丙"));
    expect(order()).toEqual(["任务：甲", "任务：丙", "任务：乙"]);
    expect(screen.getByText("已移到第 1 位，共 3 个任务")).toBeInTheDocument();

    fireEvent.click(within(card("甲")).getByRole("button", { name: "下移" }));
    expect(order()).toEqual(["任务：丙", "任务：甲", "任务：乙"]);
    expect(within(card("丙")).getByRole("button", { name: "上移" })).toBeDisabled();
    expect(within(card("乙")).getByRole("button", { name: "下移" })).toBeDisabled();

    const toggle = within(card("乙")).getByRole("button", { name: "乙" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(document.getElementById(toggle.getAttribute("aria-controls")!)).not.toBeVisible();

    fireEvent.click(within(card("丙")).getByRole("button", { name: "关闭任务" }));
    expect(order()).toEqual(["任务：甲", "任务：乙"]);

    // 停掉剩下的任务并等它们收尾，测试结束后不再有状态更新
    for (const a of screen.getAllByRole("article")) {
      const stop = within(a).queryByRole("button", { name: "停止任务" });
      if (stop) fireEvent.click(stop);
    }
    await waitFor(() => expect(screen.queryAllByRole("button", { name: "停止任务" })).toHaveLength(0), LONG);
    expect(within(card("甲")).getByText("已停止")).toBeInTheDocument();
  });
});

describe("记忆提议", () => {
  it("目标里说「记住」时卡片上请用户确认，确认后才保存", async () => {
    render(<Workbench />);
    submit("记住：我的时区是 UTC+8");
    const c = card("记住：我的时区是 UTC+8");
    const prompt = within(c).getByRole("region", { name: "记忆提议" });
    expect(prompt).toHaveTextContent("我的时区是 UTC+8");
    expect(useMemory.getState().items).toEqual([]);
    fireEvent.click(within(prompt).getByRole("button", { name: "记住" }));
    await waitFor(() => expect(within(c).queryByRole("region", { name: "记忆提议" })).toBeNull());
    expect(useMemory.getState().items).toMatchObject([{ kind: "fact", text: "我的时区是 UTC+8", source: "task" }]);
    await within(c).findByText("已完成", {}, LONG);
  });
});

describe("保存为技能", () => {
  it("完成的任务可以把实际做完的步骤保存为技能，保存前可以修改", async () => {
    render(<Workbench />);
    submit("调研量子纠缠的研究进展");
    const c = card("调研量子纠缠的研究进展");
    await within(c).findByText("已完成", {}, LONG);
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
  it("勾选后拆成子 Agent 并行执行，卡片和执行面板显示每个子 Agent 的进度，最后合并成果", async () => {
    render(<Workbench />);
    // 多 Agent 协同开关在输入框的「+」菜单里
    openMore();
    fireEvent.click(screen.getByRole("checkbox", { name: /多 Agent 协同/ }));
    submit("调研国产大模型的现状");
    const c = card("调研国产大模型的现状");
    expect(within(c).getByText("多 Agent")).toBeInTheDocument();
    await drive(c);
    expect(within(c).getByText("已完成")).toBeInTheDocument();
    const steps = within(c).getByRole("list", { name: "执行步骤" });
    expect(steps).toHaveTextContent("调研员：调研并整理资料：调研国产大模型的现状");
    expect(steps).toHaveTextContent("撰写员：撰写成文：调研国产大模型的现状");
    expect(within(c).getByRole("region", { name: "成果" })).toHaveTextContent("已合并 2 个子 Agent 的成果");
    const agents = screen.getByRole("list", { name: "子 Agent" });
    expect(within(agents).getAllByRole("listitem")).toHaveLength(2);
    expect(within(agents).getByRole("listitem", { name: "调研员" })).toHaveTextContent("已完成");
    expect(within(screen.getByRole("log", { name: "执行时间线" })).getByText("拆分为 2 个子 Agent")).toBeInTheDocument();
  }, 15000);
});

describe("执行时间线与路由面板", () => {
  it("实时展示各阶段，以及每一步用的模型、原因和成本", async () => {
    render(<Workbench />);
    expect(screen.getByText("提交任务后，这里实时显示每一步的决策。")).toBeInTheDocument();
    submit("写一段 Python 快速排序");
    await drive(card("写一段 Python 快速排序"));

    const log = screen.getByRole("log", { name: "执行时间线" });
    for (const s of ["任务分析", "路由决策", "模型输出", "反思", "完成"]) expect(within(log).getAllByText(s).length).toBeGreaterThan(0);
    expect(within(log).getAllByText(/成本档位 \d\/5/).length).toBeGreaterThan(0);

    const route = screen.getByRole("region", { name: "路由决策" });
    expect(within(route).getByText("首选")).toBeInTheDocument();
    expect(within(route).getAllByText(/得分 \d\.\d{2}/).length).toBeGreaterThan(0);
    // 没有配置 Jev Key：决策降级到规则引擎，并说明原因
    expect(within(route).getByText(/规则引擎（第 \d 级/)).toBeInTheDocument();
    expect(within(route).getByText(/已降级：/)).toBeInTheDocument();
    expect(within(route).getByText(/权重：能力匹配/)).toBeInTheDocument();
  });

  it("选了本地决策模型：路由面板注明它为什么没接手，时间线注明反思由它判断", async () => {
    useSettings.getState().setLocalJev("ollama/qwen3:8b");
    render(<Workbench />);
    submit("写一段 Python 快速排序");
    await drive(card("写一段 Python 快速排序"));

    const route = screen.getByRole("region", { name: "路由决策" });
    expect(within(route).getByText(/已降级：.*本地 Jev（置信度 0\.00 低于阈值 0\.6）/)).toBeInTheDocument();
    const log = screen.getByRole("log", { name: "执行时间线" });
    expect(within(log).getAllByText("评分 1.00 · 本地 Jev").length).toBeGreaterThan(0);
  });

  it("手动干预：锁定模型后，之后的模型调用都用它", async () => {
    const locked = effectiveProfiles().find((p) => p.provider === "anthropic")!.id;
    render(<Workbench />);
    const panel = screen.getByRole("region", { name: "手动干预" });
    expect(within(panel).getByRole("button", { name: "锁定" })).toBeDisabled();
    expect(within(panel).getByText("选择一个进行中的任务后可以手动干预。")).toBeInTheDocument();

    submit("解释一下量子纠缠");
    fireEvent.change(within(panel).getByLabelText("模型"), { target: { value: locked } });
    fireEvent.click(within(panel).getByRole("button", { name: "锁定" }));
    expect(within(panel).getByText(new RegExp(`已锁定 ${locked}`))).toBeInTheDocument();
    const c = card("解释一下量子纠缠");
    expect(within(c).getByTitle("手动干预")).toHaveTextContent(`已锁定 ${locked}`);

    await drive(c);
    const calls = within(screen.getByRole("log", { name: "执行时间线" })).getAllByText(/^(规划|修改步骤|生成参数|回答|总结) · /);
    expect(calls.length).toBeGreaterThan(0);
    for (const el of calls) expect(el.textContent).toContain(locked);
  });
});

// 回答区：思考过程默认不显示，设置里打开后折叠成一行、展开只有摘要；中转站超时引起的降级在路由记录里写明「因超时」。
// 设置页：请求超时默认 90 秒；/models 探测出 404 的模型写明已隐藏。
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { AgentEvent } from "@/agent";
import { AssistantTurn } from "@/components/chat/AssistantTurn";
import { SettingsPage } from "@/components/settings/SettingsPage";
import { createMockBackend } from "@/platform";
import { useSettings } from "@/stores/settings";
import type { TaskCard } from "@/stores/tasks";
import { resetStores } from "./ui-helpers";

beforeEach(() => resetStores());

const route: AgentEvent = {
  type: "route",
  profileId: "custom:relay/a",
  reasons: [],
  decision: {
    classification: { type: "reasoning", capabilities: ["reasoning"] },
    primary: null,
    chain: [],
    weights: { capability: 0.3, quality: 0.35, cost: 0.2, latency: 0.15 },
    reasons: [],
    excluded: [],
  },
  meta: { backend: "rules", level: 3, degraded: false, confidence: 1, skipped: [], latencyMs: 0 },
} as unknown as AgentEvent;

const turn = (events: AgentEvent[]): TaskCard =>
  ({
    id: "t1",
    seq: 1,
    sessionId: "s1",
    goal: "算一道题",
    status: "completed",
    collapsed: false,
    events,
    summary: "答案是 42",
    pendingConfirm: null,
    override: null,
    lock: null,
    permission: "confirm",
    onboarding: false,
    files: [],
    multi: false,
    startedAt: 0,
    endedAt: 1000,
    proposal: null,
    projectId: null,
    goalId: null,
    mode: "quick",
  }) as TaskCard;

describe("回答区", () => {
  it("默认不显示思考过程；设置里打开后折叠成「思考过程 · N 字」，展开只有摘要，不泄露系统提示", () => {
    const leaky = ["你是 EastGenesis 的智能体，按步骤完成用户目标。", "Output JSON only, then reflect on the plan.", "先拆成两步"].join("\n");
    const card = turn([route, { type: "llm", purpose: "answer", profileId: "custom:relay/deepseek-reasoner", latencyMs: 1, usage: null, reasoning: leaky }]);
    const off = render(<AssistantTurn card={card} />);
    expect(screen.queryByRole("button", { name: /思考过程/ })).not.toBeInTheDocument();
    off.unmount();

    act(() => useSettings.getState().setShowReasoning(true));
    const on = render(<AssistantTurn card={card} />);
    const b = screen.getByRole("button", { name: /思考过程/ });
    expect(b).toHaveTextContent("思考过程 · 5 字");
    fireEvent.click(b);
    const region = screen.getByRole("region", { name: "思考过程" });
    expect(region).toHaveTextContent("先拆成两步");
    expect(region.textContent).not.toMatch(/你是 EastGenesis|JSON|Output|reflect/);
    on.unmount();
  });

  it("思考过程默认折叠，点开才显示；没有思考过程时不出现", () => {
    act(() => useSettings.getState().setShowReasoning(true));
    const { unmount } = render(
      <AssistantTurn
        card={turn([route, { type: "llm", purpose: "answer", profileId: "custom:relay/deepseek-reasoner", latencyMs: 1, usage: null, reasoning: "先拆成两步" }])}
      />,
    );
    const btn = screen.getByRole("button", { name: /思考过程/ });
    expect(btn).toHaveAttribute("aria-expanded", "false");
    // 折叠时内容不可见（隐藏元素的无障碍名称不计算，按 aria-controls 取）
    expect(document.getElementById(btn.getAttribute("aria-controls")!)).not.toBeVisible();
    expect(screen.queryByRole("region", { name: "思考过程" })).not.toBeInTheDocument();
    fireEvent.click(btn);
    expect(btn).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("region", { name: "思考过程" })).toHaveTextContent("先拆成两步");
    // 成果区只放正文
    expect(screen.getByRole("region", { name: "成果" })).not.toHaveTextContent("先拆成两步");
    unmount();

    render(<AssistantTurn card={turn([route, { type: "llm", purpose: "answer", profileId: "openai/a", latencyMs: 1, usage: null }])} />);
    expect(screen.queryByRole("button", { name: /思考过程/ })).not.toBeInTheDocument();
  });

  it("超时引起的降级：折叠行和降级记录都写明「因超时」", () => {
    render(
      <AssistantTurn
        card={turn([
          route,
          {
            type: "llm",
            purpose: "answer",
            profileId: "custom:relay/b",
            latencyMs: 1,
            usage: null,
            fallbacks: [{ profileId: "custom:relay/a", reason: "请求超时（已重试 1 次）", code: "timeout" }],
            retries: 1,
          },
        ])}
      />,
    );
    const line = screen.getByRole("button", { name: /查看路由决策/ });
    expect(line).toHaveTextContent("因超时降级 1 次");
    fireEvent.click(line);
    const list = within(screen.getByRole("region", { name: "路由决策详情" })).getByRole("list", { name: "降级记录" });
    expect(list).toHaveTextContent("因超时降级到 relay/b（relay/a 请求超时（已重试 1 次））");
  });
});

describe("设置页", () => {
  it("请求超时默认 90 秒，可以改；改动写进设置", () => {
    render(<SettingsPage section="models" />);
    const sel = screen.getByLabelText("请求超时") as HTMLSelectElement;
    expect(sel.value).toBe("90");
    expect(sel.selectedOptions[0]!.text).toBe("90 秒（默认）");
    fireEvent.change(sel, { target: { value: "120" } });
    expect(useSettings.getState().timeoutS).toBe(120);
    expect(sel.value).toBe("120");
  });

  it("「显示模型思考过程」开关默认关闭，打开后写进设置", async () => {
    const b = createMockBackend();
    resetStores(b);
    render(<SettingsPage section="models" />);
    const box = screen.getByLabelText("显示模型思考过程") as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    expect(useSettings.getState().showReasoning).toBe(true);
    await waitFor(async () => expect(await b.loadSetting("show_reasoning")).toBe("true"));
  });

  it("自定义 Provider：探测结果写明几个模型返回 404、已从下拉隐藏", async () => {
    resetStores(createMockBackend({ listModels: ["gpt-x", "ghost"], missingModels: ["ghost"] }));
    await act(async () => {
      await useSettings.getState().load();
      await useSettings.getState().saveCustom({ id: "custom:relay", label: "中转站", base_url: "http://127.0.0.1:8080/v1", default_model: "gpt-x", headers: {} });
    });
    await waitFor(() => expect(useSettings.getState().modelCache["custom:relay"]?.probedAt).toBeDefined());
    render(<SettingsPage section="models" />);
    fireEvent.click(screen.getByRole("tab", { name: "自定义 Provider" }));
    expect(await screen.findByText("探测完成：1 个模型返回 404，已从输入框的模型下拉隐藏")).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "不可用的模型（404）" })).toHaveTextContent("ghost");
  });
});

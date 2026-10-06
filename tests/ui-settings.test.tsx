import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { SettingsContent } from "@/components/settings/SettingsView";
import { CAP_LABEL } from "@/decision";
import { effectiveProfiles } from "@/lib/engine";
import type { Backend } from "@/platform";
import { useMemory } from "@/stores/memory";
import { useSettings } from "@/stores/settings";
import { useSkills } from "@/stores/skills";
import { resetStores } from "./ui-helpers";

const KEY = "sk-test-0123456789abcdef";
let backend: Backend;

beforeEach(async () => {
  backend = resetStores();
  await useSettings.getState().load();
});

const row = (label: string) => screen.getByText(label, { selector: "p" }).closest("li")!;

describe("设置页 · 模型与路由", () => {
  it("路由策略：切换偏好后权重表随之变化，并持久化", async () => {
    render(<SettingsContent page="routing" />);
    const table = screen.getByRole("table", { name: "当前设置下的打分权重（按任务类型）" });
    const before = table.textContent;
    fireEvent.click(screen.getByRole("radio", { name: /^最强/ }));
    expect(screen.getByRole("radio", { name: /^最强/ })).toBeChecked();
    expect(table.textContent).not.toBe(before);
    fireEvent.change(screen.getByLabelText("成本上限"), { target: { value: "3" } });
    expect(useSettings.getState().routing).toMatchObject({ preference: "best", maxCostTier: 3 });
    await waitFor(async () => expect(JSON.parse((await backend.loadSetting("routing")) ?? "{}")).toMatchObject({ preference: "best", maxCostTier: 3 }));
  });

  it("能力矩阵：只保存和内置值不同的字段，可恢复默认", () => {
    const p = effectiveProfiles()[0];
    const cap = p.capabilities[0];
    render(<SettingsContent page="matrix" />);

    const btn = within(screen.getByRole("group", { name: `${p.id} 的能力` })).getByRole("button", { name: CAP_LABEL[cap] });
    expect(btn).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(btn);
    expect(btn).toHaveAttribute("aria-pressed", "false");
    expect(useSettings.getState().overrides[p.id]?.capabilities).not.toContain(cap);
    fireEvent.click(btn);
    expect(useSettings.getState().overrides[p.id]).toBeUndefined();

    const next = p.cost_tier === 1 ? 2 : 1;
    fireEvent.change(screen.getByLabelText(`${p.id} 成本档位`), { target: { value: String(next) } });
    fireEvent.click(screen.getByRole("checkbox", { name: `启用 ${p.id}` }));
    expect(useSettings.getState().overrides[p.id]).toEqual({ cost_tier: next, enabled: false });
    fireEvent.click(screen.getByRole("button", { name: `恢复默认：${p.id}` }));
    expect(useSettings.getState().overrides).toEqual({});
  });

  it("自定义 Provider：添加、测试连接、改地址清除 Key、两步删除", async () => {
    render(<SettingsContent page="custom" />);
    fireEvent.click(screen.getByRole("button", { name: "添加自定义 Provider" }));
    const form = screen.getByRole("form", { name: "添加自定义 Provider" });
    expect(within(form).getByLabelText("名称")).toHaveFocus();
    fireEvent.change(within(form).getByLabelText("名称"), { target: { value: "My Relay" } });
    expect(within(form).getByLabelText("ID")).toHaveValue("my-relay");
    fireEvent.change(within(form).getByLabelText("Base URL"), { target: { value: "https://relay.example.com/v1" } });
    fireEvent.change(within(form).getByLabelText("默认模型"), { target: { value: "gpt-4o-mini" } });
    fireEvent.change(within(form).getByLabelText("API Key"), { target: { value: KEY } });
    fireEvent.click(within(form).getByRole("button", { name: "保存" }));

    const item = await screen.findByRole("listitem", { name: "My Relay" });
    expect(item).toHaveTextContent("custom:my-relay/gpt-4o-mini");
    expect(within(item).getByText("Key 已配置")).toBeInTheDocument();
    fireEvent.click(within(item).getByRole("button", { name: "测试连接" }));
    expect(await within(item).findByText(/^连接正常（HTTP 200），可用模型 2 个/)).toBeInTheDocument();
    expect(within(item).getByText(/· 实测 \d+ ms/)).toBeInTheDocument();
    expect(within(item).getByText("模型列表（2）")).toBeInTheDocument();
    expect(within(item).getByText(/^服务端模型列表：2 个/)).toBeInTheDocument();
    expect(within(item).getByRole("button", { name: "刷新模型列表" })).toBeEnabled();

    fireEvent.click(within(item).getByRole("button", { name: "编辑" }));
    const edit = screen.getByRole("form", { name: "编辑 My Relay" });
    expect(within(edit).getByLabelText("ID")).toBeDisabled();
    fireEvent.change(within(edit).getByLabelText("Base URL"), { target: { value: "https://relay2.example.com/v1" } });
    expect(within(edit).getByText(/保存时会清除原 Key/)).toBeInTheDocument();
    fireEvent.click(within(edit).getByRole("button", { name: "保存" }));
    const updated = await screen.findByRole("listitem", { name: "My Relay" });
    expect(within(updated).getByText(/原 Key 已清除/)).toBeInTheDocument();
    expect(within(updated).getByText("未配置 Key")).toBeInTheDocument();
    await waitFor(() => expect(within(updated).getByRole("button", { name: "编辑" })).toHaveFocus());

    fireEvent.click(within(updated).getByRole("button", { name: "删除" }));
    fireEvent.click(within(updated).getByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(screen.queryByRole("listitem", { name: "My Relay" })).not.toBeInTheDocument());
    expect(screen.getByText("已删除 My Relay")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "添加自定义 Provider" })).toHaveFocus();
    expect(document.body.innerHTML).not.toContain(KEY);
  });

  it("自定义 Provider：选择协议、登记多个模型、读取模型列表，列表里标出能力参照", async () => {
    render(<SettingsContent page="custom" />);
    fireEvent.click(screen.getByRole("button", { name: "添加自定义 Provider" }));
    const form = screen.getByRole("form", { name: "添加自定义 Provider" });
    fireEvent.change(within(form).getByLabelText("名称"), { target: { value: "Claude Relay" } });
    fireEvent.change(within(form).getByLabelText("Base URL"), { target: { value: "https://relay.example.com/v1" } });
    fireEvent.change(within(form).getByLabelText("协议"), { target: { value: "anthropic" } });
    expect(within(form).getByText(/x-api-key/)).toBeInTheDocument();
    fireEvent.change(within(form).getByLabelText("默认模型"), { target: { value: "claude-x" } });
    expect(within(form).getByText("保存后可以从服务读取模型列表。")).toBeInTheDocument();
    const add = within(form).getByLabelText("添加模型");
    fireEvent.change(add, { target: { value: "gpt-5.6-luna" } });
    fireEvent.keyDown(add, { key: "Enter" });
    fireEvent.change(add, { target: { value: "extra" } });
    fireEvent.click(within(form).getByRole("button", { name: "添加" }));
    fireEvent.click(within(form).getByRole("button", { name: "移除模型 extra" }));
    fireEvent.change(within(form).getByLabelText("API Key"), { target: { value: KEY } });
    fireEvent.click(within(form).getByRole("button", { name: "保存" }));

    const item = await screen.findByRole("listitem", { name: "Claude Relay" });
    expect(within(item).getByText("Anthropic 兼容（Messages）")).toBeInTheDocument();
    expect(within(item).getByText("自动路由：可恢复")).toBeInTheDocument();
    expect(within(item).getByText(/协议：Anthropic Messages · 流结束：message_stop/)).toBeInTheDocument();
    const routes = within(item).getByRole("list", { name: "Claude Relay 参与路由的模型" });
    expect(within(routes).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "custom:claude-relay/claude-x",
      "custom:claude-relay/gpt-5.6-luna · 能力参照 openai/gpt-5.6-luna",
    ]);
    expect(useSettings.getState().custom[0]).toMatchObject({ protocol: "anthropic", models: ["claude-x", "gpt-5.6-luna"] });

    fireEvent.click(within(item).getByRole("button", { name: "编辑" }));
    const edit = screen.getByRole("form", { name: "编辑 Claude Relay" });
    expect(within(edit).getByLabelText("协议")).toHaveValue("anthropic");
    fireEvent.click(within(edit).getByRole("button", { name: "获取模型列表" }));
    expect(await within(edit).findByText(/读取到 2 个模型/)).toBeInTheDocument();
    expect([...document.querySelectorAll("datalist option")].map((o) => o.getAttribute("value"))).toEqual(["mock-model", "gpt-5.6-luna"]);
    fireEvent.change(within(edit).getByLabelText("协议"), { target: { value: "openai" } });
    expect(within(edit).queryByRole("button", { name: "获取模型列表" })).not.toBeInTheDocument();
    expect(within(edit).getByText("地址或协议改过，保存后再读取模型列表。")).toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain(KEY);
  });
});

describe("设置页 · Provider、决策层与 Agent", () => {
  it("API Key：经后端保存、提交后清空输入；Jev Key 单独管理（在「路由偏好 › 决策层」，和 Provider 的 Key 分开）", async () => {
    render(<SettingsContent page="providers" />);
    const google = row("Google Gemini");
    expect(within(google).queryByText(/适配器未实现/)).not.toBeInTheDocument();
    expect(within(google).getByText("自动路由：可恢复")).toBeInTheDocument();
    expect(within(google).getByText(/协议：OpenAI 兼容 · 流结束：SSE \[DONE\]/)).toBeInTheDocument();
    expect(within(google).getByText(/端点连通性仍需“测试连接”/)).toBeInTheDocument();
    const input = within(google).getByLabelText("Google Gemini API Key");
    fireEvent.change(input, { target: { value: KEY } });
    fireEvent.click(within(google).getByRole("button", { name: "保存" }));
    expect(input).toHaveValue("");
    expect(await within(google).findByText("已配置（系统钥匙串）")).toBeInTheDocument();
    expect(within(google).getByText("已记录为已配置（浏览器模式不保存 Key）")).toBeInTheDocument();
    fireEvent.click(within(google).getByRole("button", { name: "测试连接" }));
    expect(await within(google).findByText(/^连接正常（HTTP 200），可用模型 \d+ 个/)).toBeInTheDocument();

    expect(screen.queryByText("Jev 决策层", { selector: "p" })).not.toBeInTheDocument();
    const providers = render(<SettingsContent page="routing" />);
    const jev = within(providers.container).getByText("Jev 决策层", { selector: "p" }).closest("li")!;
    expect(within(jev).getByText("未配置")).toBeInTheDocument();
    fireEvent.change(within(jev).getByLabelText("Jev 决策层 API Key"), { target: { value: KEY } });
    fireEvent.click(within(jev).getByRole("button", { name: "保存" }));
    expect(await within(jev).findByText("已配置（系统钥匙串）")).toBeInTheDocument();
    expect(useSettings.getState().jev?.configured).toBe(true);

    providers.unmount();
    const openai = row("OpenAI");
    fireEvent.click(within(openai).getByRole("button", { name: "删除 OpenAI 的 Key" }));
    expect(await within(openai).findByText("未配置")).toBeInTheDocument();

    const ollama = row("Ollama（本机）");
    expect(within(ollama).getByText("本机服务，不需要 Key")).toBeInTheDocument();
    expect(within(ollama).queryByLabelText(/API Key/)).not.toBeInTheDocument();

    expect(document.body.innerHTML).not.toContain(KEY);
    expect(JSON.stringify(useSettings.getState())).not.toContain(KEY);
  });

  it("地域与本机 Ollama：只有多地域的 Provider 显示地域选择；Ollama 默认不参与路由", () => {
    render(<SettingsContent page="providers" />);
    expect(within(row("OpenAI")).queryByLabelText("地域")).not.toBeInTheDocument();
    const qwen = within(row("通义千问 Qwen")).getByLabelText("地域");
    expect(qwen).toHaveValue("cn");
    fireEvent.change(qwen, { target: { value: "intl" } });
    expect(useSettings.getState().providerPrefs.regions).toEqual({ qwen: "intl" });
    expect(within(row("Kimi（Moonshot）")).getByLabelText("地域")).toHaveValue("cn");

    const toggle = within(row("Ollama（本机）")).getByLabelText("让路由使用本机 Ollama");
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);
    expect(toggle).toBeChecked();
    expect(useSettings.getState().providerPrefs.ollama).toBe(true);
  });

  it("本地决策模型：只列本机服务的模型，默认不使用；选择后持久化，已不可用的选择如实标出", async () => {
    render(<SettingsContent page="routing" />);
    const select = screen.getByLabelText("决策模型");
    expect(select).toHaveValue("");
    expect(select).toHaveAccessibleDescription(/超时、出错或把握不够都交给规则引擎/);
    const values = within(select).getAllByRole("option").map((o) => (o as HTMLOptionElement).value);
    expect(values).toContain("ollama/qwen3:8b");
    expect(values.every((v) => v === "" || v.startsWith("ollama/"))).toBe(true);

    fireEvent.change(select, { target: { value: "ollama/qwen3:8b" } });
    expect(useSettings.getState().providerPrefs).toMatchObject({ localJev: "ollama/qwen3:8b", ollama: false });
    await waitFor(async () => expect(JSON.parse((await backend.loadSetting("provider_prefs")) ?? "{}")).toMatchObject({ localJev: "ollama/qwen3:8b" }));
    fireEvent.change(select, { target: { value: "" } });
    expect(useSettings.getState().providerPrefs.localJev).toBeNull();

    act(() => useSettings.getState().setLocalJev("ollama/gone:1b"));
    expect(select).toHaveValue("ollama/gone:1b");
    expect(within(select).getByRole("option", { name: "ollama/gone:1b（已不可用）" })).toBeInTheDocument();
  });

  it("MCP：登记表只读展示；启动后列出注册与未注册的工具；密钥只进不出", async () => {
    render(<SettingsContent page="mcp" />);
    const echo = await screen.findByRole("listitem", { name: "echo" });
    expect(within(echo).getByText("未启动")).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "没能登记的条目" })).getByText("remote")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /添加/ })).toBeNull();

    fireEvent.click(within(echo).getByRole("button", { name: "启动" }));
    const tools = await within(echo).findByRole("list", { name: "echo 已注册的工具" });
    expect(within(tools).getByText("mcp__echo__echo")).toBeInTheDocument();
    expect(within(within(echo).getByRole("list", { name: "echo 未注册的工具" })).getByText("不在白名单")).toBeInTheDocument();
    expect(within(echo).getByText("运行中")).toBeInTheDocument();

    const notes = screen.getByRole("listitem", { name: "notes" });
    expect(within(notes).getByRole("button", { name: "启动" })).toBeDisabled();
    fireEvent.change(within(notes).getByLabelText("notes 的 NOTES_TOKEN"), { target: { value: "value-1" } });
    fireEvent.click(within(notes).getByRole("button", { name: "保存" }));
    await within(notes).findByText("已记录为已保存（浏览器模式不保存值）");
    expect(within(notes).getByText("已保存（系统钥匙串）")).toBeInTheDocument();
    expect(within(notes).getByLabelText("notes 的 NOTES_TOKEN")).toHaveValue("");
    expect(within(notes).getByRole("button", { name: "启动" })).toBeEnabled();
    expect(document.body.textContent).not.toContain("value-1");

    fireEvent.click(within(echo).getByRole("button", { name: "停止" }));
    await within(echo).findByText("未启动");
  });

  it("记忆：添加、编辑、两步删除；技能库先留结构", async () => {
    render(<SettingsContent page="memory" />);
    expect(await screen.findByText(/暂无记忆/)).toBeInTheDocument();
    // 技能库是单独的子页（V3 第 8 节「Agent › 技能库」）
    expect(screen.queryByRole("heading", { name: "技能库" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "添加记忆" }));
    const form = screen.getByRole("form", { name: "添加记忆" });
    fireEvent.click(within(form).getByRole("radio", { name: /^事实/ }));
    fireEvent.change(within(form).getByLabelText("内容"), { target: { value: "我的时区是 UTC+8" } });
    fireEvent.click(within(form).getByRole("button", { name: "保存" }));
    await screen.findByText("已保存");
    const item = screen.getByRole("listitem", { name: "我的时区是 UTC+8" });
    expect(within(item).getByText("事实")).toBeInTheDocument();
    expect(within(item).getByText(/手动添加/)).toBeInTheDocument();

    fireEvent.click(within(item).getByRole("button", { name: "编辑" }));
    const edit = screen.getByRole("form", { name: "编辑记忆" });
    fireEvent.change(within(edit).getByLabelText("内容"), { target: { value: "我的时区是 UTC+9" } });
    fireEvent.click(within(edit).getByRole("button", { name: "保存" }));
    const edited = await screen.findByRole("listitem", { name: "我的时区是 UTC+9" });
    expect(useMemory.getState().items).toMatchObject([{ kind: "fact", text: "我的时区是 UTC+9", source: "manual" }]);

    fireEvent.click(within(edited).getByRole("button", { name: "删除" }));
    fireEvent.click(within(edited).getByRole("button", { name: "确认删除" }));
    await screen.findByText("已删除这条记忆");
    expect(screen.getByText(/暂无记忆/)).toBeInTheDocument();
    expect(useMemory.getState().items).toEqual([]);
  });

  it("技能库：添加、编辑、两步删除", async () => {
    render(<SettingsContent page="skills" />);
    expect(screen.getByRole("heading", { name: "技能库" })).toBeInTheDocument();
    expect(await screen.findByText(/暂无技能/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "添加技能" }));
    const form = screen.getByRole("form", { name: "添加技能" });
    fireEvent.change(within(form).getByLabelText("名称"), { target: { value: "整理周报" } });
    fireEvent.change(within(form).getByLabelText("步骤"), { target: { value: "汇总本周进展 | demo_search\n按模板写成周报" } });
    fireEvent.click(within(form).getByRole("button", { name: "保存" }));
    await screen.findByText("已保存技能「整理周报」");
    const item = screen.getByRole("listitem", { name: "整理周报" });
    const steps = within(item).getByRole("list", { name: "整理周报 的步骤" });
    expect(within(steps).getAllByRole("listitem")).toHaveLength(2);
    expect(within(steps).getByText("demo_search")).toBeInTheDocument();
    expect(within(item).getByText("2 步")).toBeInTheDocument();

    fireEvent.click(within(item).getByRole("button", { name: "编辑" }));
    const edit = screen.getByRole("form", { name: "编辑技能" });
    expect(within(edit).getByLabelText("步骤")).toHaveValue("汇总本周进展 | demo_search\n按模板写成周报");
    fireEvent.change(within(edit).getByLabelText("名称"), { target: { value: "整理月报" } });
    fireEvent.click(within(edit).getByRole("button", { name: "保存" }));
    const renamed = await screen.findByRole("listitem", { name: "整理月报" });
    expect(useSkills.getState().items).toMatchObject([{ name: "整理月报", source: "manual" }]);

    fireEvent.click(within(renamed).getByRole("button", { name: "删除" }));
    fireEvent.click(within(renamed).getByRole("button", { name: "确认删除" }));
    await screen.findByText("已删除这个技能");
    expect(screen.getByText(/暂无技能/)).toBeInTheDocument();
    expect(useSkills.getState().items).toEqual([]);
  });
});

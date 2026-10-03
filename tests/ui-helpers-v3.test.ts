// V3 界面用到的纯函数：内容栏的路由摘要、历史分组、改动的文件、界面偏好解析
import type { AgentEvent } from "@/agent";
import type { Goal } from "@/decision/goal";
import type { Project } from "@/decision/project";
import { artifactsOf, changesOf } from "@/lib/artifacts";
import { goalSummary, historyBucket, modelsOf, projectSummary, recentItems, sessionSummary } from "@/lib/sidebar-rows";
import { parsePermission } from "@/stores/settings";
import type { TaskCard } from "@/stores/tasks";
import { DEFAULT_UI_PREFS, parseUiPrefs } from "@/stores/ui";

const llm = (profileId: string): AgentEvent => ({ type: "llm", purpose: "answer", profileId, latencyMs: 1, usage: null });
const tool = (name: string, args: Record<string, unknown>, ok = true): AgentEvent =>
  ({ type: "tool_result", step: { id: "s", goal: "g", tool: name, args }, ok, content: "x", latencyMs: 1 }) as AgentEvent;
const project = (p: Partial<Project>): Project => ({ id: "prj-a", name: "甲", description: "", instructions: "", context_folders: [], routing_preference: null, archived: false, created_at: 1, updated_at: 1, ...p });
const goal = (g: Partial<Goal>): Goal =>
  ({ id: "goal-a", project_id: null, description: "目标", instructions: "", routing_preference: null, status: "idle", rounds: [], max_llm_calls: 50, used_llm_calls: 0, created_at: 1, updated_at: 1, ...g }) as Goal;

describe("内容栏的路由摘要", () => {
  it("项目：生效的偏好，来源写在悬停提示里", () => {
    expect(projectSummary(project({}), "balanced")).toEqual({ text: "平衡", title: "路由偏好：平衡（来自全局设置）" });
    expect(projectSummary(project({ routing_preference: "economy" }), "best")).toEqual({ text: "省钱", title: "路由偏好：省钱（来自项目）" });
  });

  it("会话：一个模型写模型名（去掉 custom: 前缀），几个模型写个数，进行中加前缀；子 Agent 的调用也算", () => {
    const t = (events: AgentEvent[], status: TaskCard["status"] = "completed") => ({ events, status }) as TaskCard;
    expect(sessionSummary([t([llm("kimi/kimi-k3"), llm("kimi/kimi-k3")])])).toBe("kimi/kimi-k3");
    expect(sessionSummary([t([llm("custom:relay/m1")])])).toBe("relay/m1");
    expect(sessionSummary([t([llm("a/x")]), t([{ type: "subagent", agent: "r", event: llm("b/y") } as AgentEvent])])).toBe("2 个模型");
    expect(sessionSummary([t([llm("a/x")], "running")])).toBe("进行中 · a/x");
    expect(sessionSummary([t([], "running")])).toBe("进行中");
    expect(sessionSummary([t([])])).toBe("没有调用模型");
    expect(modelsOf([llm("a/x"), llm("b/y"), llm("a/x")])).toEqual(["a/x", "b/y"]);
  });

  it("目标：状态 + 轮数；最后一轮拿不准时是「等你确认」", () => {
    expect(goalSummary(goal({}))).toBe("未开始");
    const round = (status: string) => ({ index: 1, title: "", items: [], status, evidence: { tool_calls: [], file_changes: [], command_outputs: [] }, verdict: null, started_at: 1, finished_at: 2 });
    expect(goalSummary(goal({ status: "running", rounds: [round("not_done")] as Goal["rounds"] }))).toBe("进行中 · 第 1 轮");
    expect(goalSummary(goal({ status: "running", rounds: [round("uncertain")] as Goal["rounds"] }))).toBe("等你确认");
  });

  it("「最近」：会话和目标混排，按最近更新，最多 n 条", () => {
    const s = (id: string, at: number) => ({ id, title: id, projectId: null, createdAt: at, updatedAt: at });
    const items = recentItems([s("s1", 5), s("s2", 1)], [goal({ id: "goal-x", updated_at: 3 })], 2);
    expect(items.map((i) => (i.kind === "goal" ? i.goal.id : i.session.id))).toEqual(["s1", "goal-x"]);
  });

  it("历史分组按本地日期：今天 / 昨天 / 7 天内 / 更早", () => {
    const now = new Date(2026, 9, 3, 15, 0).getTime();
    expect(historyBucket(new Date(2026, 9, 3, 0, 1).getTime(), now)).toBe("today");
    expect(historyBucket(new Date(2026, 9, 2, 23, 59).getTime(), now)).toBe("yesterday");
    expect(historyBucket(new Date(2026, 8, 27, 12).getTime(), now)).toBe("week");
    expect(historyBucket(new Date(2026, 8, 20).getTime(), now)).toBe("older");
  });
});

describe("回答里的改动列表（取自工具调用记录）", () => {
  it("区分新建、写入、删除、移动、读取；同一个文件同一种操作只留一条；失败的不算改动", () => {
    const { files, commands } = artifactsOf([
      tool("mcp__files__read_file", { path: "~/Downloads/a.txt" }),
      tool("mcp__files__write_file", { path: "~/Downloads/b.md", content: "x" }),
      tool("mcp__files__write_file", { path: "~/Downloads/b.md", content: "y" }),
      tool("mcp__files__move_file", { source: "~/Downloads/c.pdf", destination: "~/Downloads/合同/c.pdf" }),
      tool("mcp__files__delete_file", { path: "~/Downloads/d.tmp" }, false),
      tool("mcp__files__create_directory", { path: "~/Downloads/合同" }),
      tool("demo_write_file", { path: "~/EastGenesis/output.md" }),
      tool("mcp__shell__run_command", { command: "ls" }),
    ]);
    expect(files.map((f) => [f.action, f.path])).toEqual([
      ["read", "~/Downloads/a.txt"],
      ["modified", "~/Downloads/b.md"],
      ["moved", "~/Downloads/c.pdf"],
      ["deleted", "~/Downloads/d.tmp"],
      ["created", "~/Downloads/合同"],
      ["modified", "~/EastGenesis/output.md"],
    ]);
    expect(files.find((f) => f.action === "moved")?.to).toBe("~/Downloads/合同/c.pdf");
    expect(changesOf(files).map((f) => f.path)).toEqual(["~/Downloads/b.md", "~/Downloads/c.pdf", "~/Downloads/合同", "~/EastGenesis/output.md"]);
    expect(commands).toEqual([{ command: "ls", ok: true, output: "x" }]);
  });

  it("没有路径参数的调用不当作改动，也不臆测路径", () => {
    expect(artifactsOf([tool("mcp__files__write_file", { content: "x" })]).files).toEqual([]);
  });
});

describe("存进设置的界面偏好", () => {
  it("缺字段、类型不对、坏 JSON 都回到默认值", () => {
    expect(parseUiPrefs(null)).toEqual(DEFAULT_UI_PREFS);
    expect(parseUiPrefs("{坏")).toEqual(DEFAULT_UI_PREFS);
    expect(parseUiPrefs(JSON.stringify({ collapsed: true, groups: { recent: false }, fontSize: "huge", expert: "yes" }))).toEqual({
      ...DEFAULT_UI_PREFS,
      collapsed: true,
      groups: { ...DEFAULT_UI_PREFS.groups, recent: false },
    });
  });

  it("默认权限只认三档之一，其余当作「变更前确认」", () => {
    expect(parsePermission(JSON.stringify("readonly"))).toBe("readonly");
    expect(parsePermission(JSON.stringify("root"))).toBe("confirm");
    expect(parsePermission(null)).toBe("confirm");
    expect(parsePermission("不是 JSON")).toBe("confirm");
  });
});

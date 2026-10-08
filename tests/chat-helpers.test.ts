// 对话式界面用到的纯函数：会话标题与历史、进度文字、路由行文字、模型下拉分组
import { PERSONA } from "@/agent/runtime";
import { effectiveProfiles } from "@/lib/engine";
import { modelGroups, hasOption, lockLabel } from "@/lib/model-options";
import { doneText, progressOf, toolText } from "@/lib/progress";
import type { AgentEvent } from "@/agent";
import { DIGEST_MAX, digestReasoning, reasoningParts } from "@/lib/reasoning";
import { toTimeline } from "@/lib/timeline";
import { fallbackVerb, formatDuration, formatTokens, latestSurface, routeLineText, routeSummary, surfaceJourney, surfaceJourneyFromEvents, surfaceJourneyText, surfaceJourneyTextFromEvents, type RouteSummary } from "@/lib/route-summary";
import { historyOf, MAX_TITLE, title, visibleSessions } from "@/stores/chat";
import type { TaskCard } from "@/stores/tasks";

const turn = (seq: number, goal: string, summary: string | null, sessionId = "s1") => ({ seq, goal, summary, sessionId }) as unknown as TaskCard;

describe("会话", () => {
  it("标题取第一行并截断；空白退回「新会话」", () => {
    expect(title("  整理文件\n第二行")).toBe("整理文件");
    expect(title("长".repeat(MAX_TITLE + 5))).toBe(`${"长".repeat(MAX_TITLE)}…`);
    expect(title("   ")).toBe("新会话");
  });

  it("历史：只取本会话已有结果的轮次，按时间正序；超出预算时丢最旧的", () => {
    const tasks = [turn(1, "甲", "一"), turn(2, "乙", null), turn(3, "丙", "三"), turn(4, "丁", "四", "s2")];
    expect(historyOf(tasks, "s1")).toBe("用户：甲\n助手：一\n\n用户：丙\n助手：三");
    expect(historyOf(tasks, "s1", 12)).toBe("用户：丙\n助手：三");
    expect(historyOf(tasks, "s3")).toBe("");
  });

  it("会话列表按最近更新排序，搜索不分大小写", () => {
    const ss = [
      { id: "a", title: "Alpha", projectId: null, createdAt: 1, updatedAt: 1 },
      { id: "b", title: "beta", projectId: null, createdAt: 2, updatedAt: 5 },
    ];
    expect(visibleSessions(ss, "").map((s) => s.id)).toEqual(["b", "a"]);
    expect(visibleSessions(ss, "ALP").map((s) => s.id)).toEqual(["a"]);
  });

  it("人设原文进系统提示", () => {
    expect(PERSONA).toBe("我是 EastGenesis，跑在你电脑上的多模型 Agent。我会根据任务自动选择最合适的模型，你不需要关心背后是哪个厂商。");
  });
});

describe("渐进式执行文字", () => {
  it("工具名翻成人话", () => {
    expect(toolText("fs.read_file")).toBe("正在读取");
    expect(toolText("demo_write_file")).toBe("正在写入");
    expect(toolText("shell_exec")).toBe("正在执行命令");
    expect(toolText("weird")).toBe("正在调用 weird");
  });

  it("没有事件时是「正在分析任务…」；完成与失败的折叠文字", () => {
    const p = progressOf([]);
    expect(p).toMatchObject({ text: "正在分析任务…", done: 0, total: 0, waiting: false });
    expect(doneText("completed", { ...p, total: 5, done: 5 }, "12.4s")).toBe("已完成 · 5 步 · 12.4s");
    expect(doneText("failed", { ...p, total: 5, done: 2 }, "3.0s")).toBe("失败 · 2/5 步 · 3.0s");
    expect(doneText("aborted", p, "1.0s")).toBe("已停止 · 1.0s");
  });

  it("时长和 token 的写法", () => {
    expect(formatDuration(12_400)).toBe("12.4s");
    expect(formatDuration(90_000)).toBe("1 分 30 秒");
    expect(formatTokens(0)).toBe("token 数未知");
    expect(formatTokens(1234)).toBe("1.2k tokens");
  });
});

describe("路由行", () => {
  const base: RouteSummary = {
    used: "custom:relay/claude-x",
    models: ["openai/a", "custom:relay/claude-x"],
    calls: 2,
    tokens: 1500,
    locked: false,
    candidates: [],
    fallbacks: [{ from: "openai/a", to: "custom:relay/claude-x", reason: "HTTP 503", times: 2, timeout: false }],
    retries: 1,
    failures: [],
    taskType: "对话",
    needs: [],
    noModel: null,
  };

  it("折叠文字（V3 5.2）：具体模型、节省、降级次数；耗时和 tokens 不在这一行；不含内部评分", () => {
    const t = routeLineText(base, "省 $0.12");
    expect(t).toBe("使用 relay/claude-x（共 2 个模型） · 省 $0.12 · 降级 2 次");
    expect(t).not.toMatch(/评分|成本档位|本模型|tokens|\ds$/);
    expect(routeLineText(base)).toBe("使用 relay/claude-x（共 2 个模型） · 降级 2 次");
    expect(routeLineText({ ...base, locked: true, fallbacks: [] })).toBe("手动锁定 relay/claude-x");
    expect(routeLineText({ ...base, used: null, failures: [{ profileId: "x", reason: "r" }] })).toBe("本次尝试的 1 个模型均未成功 · 降级 2 次");
  });

  it("兜底的原因按实际选到的模型写：本机模型才说「最省钱」，云端模型只说是最后兜底", () => {
    const route = (provider: string, profileId: string) =>
      ({
        decision: {
          classification: { type: "qa", capabilities: [], confidence: 1, signals: [], estTokens: 10 },
          primary: null,
          chain: [{ profileId, provider, stage: "rule_fallback", score: 0, breakdown: {}, reason: "规则兜底：优先本地模型，其次成本、延迟最低" }],
          weights: { capability: 0, quality: 0, cost: 0, latency: 0 },
          reasons: [],
          excluded: [],
        },
        meta: { backend: "rules", level: 3, degraded: false, confidence: 1, skipped: [], latencyMs: 0 },
      }) as unknown as Parameters<typeof routeSummary>[0];
    expect(routeSummary(route("ollama", "ollama/qwen3:8b"), [])!.candidates[0]!.why).toBe("本地模型优先，最省钱");
    expect(routeSummary(route("anthropic", "anthropic/claude-fable-5-1"), [])!.candidates[0]!.why).toBe("前面都失败时的最后兜底");
  });

  it("因超时降级在折叠行里直接写明", () => {
    const slow = { from: "openai/b", to: "custom:relay/claude-x", reason: "请求超时（已重试 1 次）", times: 1, timeout: true };
    expect(routeLineText({ ...base, fallbacks: [slow] })).toMatch(/因超时降级 1 次$/);
    expect(routeLineText({ ...base, fallbacks: [...base.fallbacks, slow] })).toMatch(/降级 3 次（1 次因超时）$/);
    expect(fallbackVerb(slow)).toBe("因超时降级到");
    expect(fallbackVerb(base.fallbacks[0]!)).toBe("降级到");
  });

  it("跨能力面时在折叠行显示同一任务链，单能力面保持简洁", () => {
    const journey = { workSurface: "work" as const, stepRoutes: [
      { stepId: "read", goal: "读取资料", surface: "work" as const, surfaceLabel: "Work 工作", profileId: "openai/a", reason: "文件能力" },
      { stepId: "test", goal: "运行测试", surface: "codex" as const, surfaceLabel: "Codex 开发", profileId: "openai/a", reason: "代码能力" },
      { stepId: "answer", goal: "总结结果", surface: "chat" as const, surfaceLabel: "Chat 对话", profileId: "openai/a", reason: "对话能力" },
    ] };
    expect(surfaceJourney(journey)).toEqual(["work", "codex", "chat"]);
    expect(surfaceJourneyText(journey)).toBe("能力链 Work → Codex → Chat");
    expect(routeLineText({ ...base, ...journey })).toContain("能力链 Work → Codex → Chat");
    expect(surfaceJourney({ workSurface: "work", stepRoutes: [{ ...journey.stepRoutes[2]!, surface: "chat" }] })).toEqual(["chat"]);
    expect(surfaceJourneyText({ workSurface: "chat", stepRoutes: [] })).toBeNull();
    expect(routeLineText({ ...base, workSurface: "chat", stepRoutes: [] })).not.toContain("能力链");
  });
});

describe("路由摘要：降级原因", () => {
  it("超时的尝试标成 timeout，其余不标", () => {
    const events: AgentEvent[] = [
      {
        type: "llm",
        purpose: "answer",
        profileId: "custom:relay/claude-x",
        latencyMs: 10,
        usage: null,
        fallbacks: [
          { profileId: "openai/a", reason: "请求超时（已重试 1 次）", code: "timeout" },
          { profileId: "openai/b", reason: "服务端错误", code: "server" },
        ],
        retries: 1,
      },
    ];
    const route = {
      decision: {
        classification: { type: "qa", capabilities: [] },
        primary: null,
        chain: [],
        weights: { capability: 0.3, quality: 0.35, cost: 0.2, latency: 0.15 },
        reasons: [],
        excluded: [],
      },
      meta: { backend: "rules", level: 3, degraded: false, confidence: 1, skipped: [], latencyMs: 0 },
    } as unknown as NonNullable<Parameters<typeof routeSummary>[0]>;
    const s = routeSummary(route, events)!;
    expect(s.fallbacks.map((f) => [f.from, f.to, f.timeout])).toEqual([
      ["openai/a", "openai/b", true],
      ["openai/b", "custom:relay/claude-x", false],
    ]);
  });

  it("汇总步骤级路由，回答浮层能看见同一任务跨能力面切换", () => {
    const route = {
      decision: {
        classification: { type: "tool_use", capabilities: ["tool_use"] },
        primary: null,
        chain: [],
        weights: { capability: 0.3, quality: 0.35, cost: 0.2, latency: 0.15 },
        reasons: [],
        excluded: [],
      },
      meta: { backend: "rules", level: 3, degraded: false, confidence: 1, skipped: [], latencyMs: 0 },
    } as unknown as NonNullable<Parameters<typeof routeSummary>[0]>;
    const stepDecision = { ...route.decision, primary: { profileId: "openai/a", reason: "匹配工具能力" }, chain: [{ profileId: "openai/a", provider: "openai", stage: "primary", reason: "匹配工具能力" }] } as never;
    const s = routeSummary(route, [{
      type: "step_route",
      step: { id: "s1", goal: "读取报告", tool: "read_file" },
      surface: "work",
      surfaceReason: "需要研究、本地文件或交付物能力",
      profileId: "openai/a",
      reasons: [],
      decision: stepDecision,
      meta: route.meta,
    }]);
    expect(s?.stepRoutes).toEqual([{ stepId: "s1", goal: "读取报告", surface: "work", surfaceLabel: "Work 工作", profileId: "openai/a", reason: "匹配工具能力" }]);
  });
});

describe("运行中的能力面", () => {
  const step = (surface: "chat" | "work" | "codex"): AgentEvent => ({
    type: "step_start",
    step: { id: `step-${surface}`, goal: "执行任务", tool: null },
    attempt: 1,
    surface,
  });

  it("取最近一步，并递归读取子 Agent 的路由事件", () => {
    expect(latestSurface([step("work"), step("codex")])).toBe("codex");
    expect(latestSurface([{ type: "subagent", agent: "research", event: step("work") }])).toBe("work");
    expect(latestSurface([{ type: "llm", purpose: "answer", profileId: "openai/a", latencyMs: 1, usage: null }])).toBeNull();
  });

  it("按执行顺序去重能力链，并在跨面后生成运行中摘要", () => {
    const events: AgentEvent[] = [step("work"), step("work"), { type: "subagent", agent: "coder", event: step("codex") }];
    expect(surfaceJourneyFromEvents(events)).toEqual(["work", "codex"]);
    expect(surfaceJourneyTextFromEvents(events)).toBe("能力链 Work → Codex");
    expect(surfaceJourneyTextFromEvents([step("chat")])).toBeNull();
  });
});

describe("思考过程", () => {
  it("只取回答和总结的思考，规划、生成参数等内部步骤不展示", () => {
    const events: AgentEvent[] = [
      { type: "llm", purpose: "plan", profileId: "openai/a", latencyMs: 1, usage: null, reasoning: "拆成三步：先列目录" },
      { type: "llm", purpose: "args", profileId: "openai/a", latencyMs: 1, usage: null, reasoning: "参数要填路径" },
      { type: "llm", purpose: "answer", profileId: "custom:relay/deepseek-reasoner", latencyMs: 1, usage: null, reasoning: "  先想一想  " },
      { type: "llm", purpose: "summary", profileId: "openai/a", latencyMs: 1, usage: null, reasoning: "   " },
    ];
    expect(reasoningParts(events)).toEqual([{ label: "回答", text: "先想一想" }]);
  });

  it("摘要去掉系统提示原文、内部指令和英文推理", () => {
    const raw = [
      "你是 EastGenesis 的智能体，按步骤完成用户目标。",
      'The user wants a short intro. I should output JSON {"steps": []}.',
      "只输出 JSON，不要解释。",
      "<tool_output source=\"files\" untrusted=\"true\">secret</tool_output>",
      "步骤 1：调用 list_directory",
      "用户想要一段简短的自我介绍，先说清楚我能做什么。",
      "再补一句：可以帮忙整理文件。",
    ].join("\n");
    expect(digestReasoning(raw)).toBe("用户想要一段简短的自我介绍，先说清楚我能做什么。\n再补一句：可以帮忙整理文件。");
    expect(digestReasoning("Let me think about the plan step by step.")).toBe("");
    expect(digestReasoning("想".repeat(DIGEST_MAX + 50))).toHaveLength(DIGEST_MAX + 1);
  });

  it("整理后没有可读内容时不展示", () => {
    const events: AgentEvent[] = [
      { type: "llm", purpose: "answer", profileId: "openai/a", latencyMs: 1, usage: null, reasoning: "I need to answer briefly in Chinese." },
    ];
    expect(reasoningParts(events)).toEqual([]);
  });
});

describe("专家时间线：降级原因", () => {
  it("超时引起的降级写「因超时降级」", () => {
    const e = (code: string, reason: string): AgentEvent => ({
      type: "llm",
      purpose: "answer",
      profileId: "custom:relay/b",
      latencyMs: 1,
      usage: null,
      fallbacks: [{ profileId: "custom:relay/a", reason, code }],
    });
    const [slow] = toTimeline([e("timeout", "请求超时（已重试 1 次）")], []).filter((i) => i.stage === "model");
    expect(slow).toMatchObject({ tone: "warn", detail: "因超时降级：先试 custom:relay/a（请求超时（已重试 1 次）），降级到 custom:relay/b" });
    const [bad] = toTimeline([e("server", "服务端错误")], []).filter((i) => i.stage === "model");
    expect(bad.detail).toMatch(/^已降级：/);
  });
});

describe("模型下拉分组", () => {
  const relay = { id: "custom:relay", label: "中转站", base_url: "https://relay.example.com/v1", default_model: "reg", headers: {} };
  const ok = () => ({ ok: true as const, health: 1 });

  it("自定义 Provider 优先用 /models 缓存，没有缓存时用已登记模型；不可用的分组不出现", () => {
    const profiles = effectiveProfiles({}, [relay]);
    const g = modelGroups(profiles, [relay], ok, { "custom:relay": { models: ["m1", "m2"], fetchedAt: 1 } });
    const r = g.find((x) => x.provider === "custom:relay")!;
    expect(r.options.map((o) => o.label)).toEqual(["m1", "m2"]);
    expect(modelGroups(profiles, [relay], ok).find((x) => x.provider === "custom:relay")!.options.map((o) => o.label)).toEqual(["reg"]);
    expect(modelGroups(profiles, [relay], () => ({ ok: false as const, reason: "没有 Key" }))).toEqual([]);

    const id = r.options[0]!.id;
    expect(hasOption(g, id)).toBe(true);
    expect(lockLabel(g, id)).toBe("m1");
    expect(lockLabel(g, null)).toBe("自动路由");
    expect(hasOption(g, "gone/model")).toBe(false);
  });

  it("探测返回 404 的模型不出现在下拉里", () => {
    const profiles = effectiveProfiles({}, [relay]);
    const g = modelGroups(profiles, [relay], ok, { "custom:relay": { models: ["m1", "m2", "m3"], fetchedAt: 1, probedAt: 2, unavailable: ["m2"] } });
    expect(g.find((x) => x.provider === "custom:relay")!.options.map((o) => o.label)).toEqual(["m1", "m3"]);
    // 全部不可用：这个分组不出现
    expect(modelGroups(profiles, [relay], ok, { "custom:relay": { models: ["m2"], fetchedAt: 1, unavailable: ["m2"] } }).find((x) => x.provider === "custom:relay")).toBeUndefined();
  });
});

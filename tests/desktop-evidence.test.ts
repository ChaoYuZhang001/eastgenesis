// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@/agent";
import { route, type ModelProfile } from "@/decision";
import { desktopEvidenceOf } from "@/lib/desktop-evidence";
import type { TaskCard } from "@/stores/tasks";

const profiles: ModelProfile[] = [
  {
    id: "openai/fast",
    provider: "openai",
    capabilities: ["code", "reasoning", "tool_use", "long_context"],
    cost_tier: 2,
    quality_tier: 3,
    latency_tier: 1,
    context_window: 128_000,
    enabled: true,
    is_custom: false,
  },
  {
    id: "anthropic/backup",
    provider: "anthropic",
    capabilities: ["code", "reasoning", "tool_use", "long_context"],
    cost_tier: 3,
    quality_tier: 4,
    latency_tier: 2,
    context_window: 200_000,
    enabled: true,
    is_custom: false,
  },
];

const decision = route(
  { text: "这段正文不会进入验收证据", preference: "balanced", latency: "normal", surfaceHint: "work" },
  { profiles, availability: () => ({ ok: true, health: 1 }) },
);
const meta = {
  backend: "rules" as const,
  level: 3 as const,
  degraded: true,
  confidence: 0.7,
  skipped: [{ backend: "cloud-jev" as const, reason: "没有 Key" }],
  latencyMs: 4,
};

function card(events: AgentEvent[]): TaskCard {
  return {
    id: "task-evidence-1",
    seq: 1,
    sessionId: "session-1",
    goal: "这是一段不应落盘的任务正文",
    status: "failed",
    collapsed: false,
    events,
    summary: "私密结果正文不应该被导出",
    pendingConfirm: null,
    pendingPlan: null,
    override: null,
    lock: null,
    permission: "confirm",
    onboarding: false,
    files: ["/Users/alice/secret.pdf"],
    multi: false,
    startedAt: 1_000,
    endedAt: 2_250,
    proposal: null,
    projectId: null,
    goalId: null,
    mode: "quick",
    preference: "balanced",
    preferenceSource: "global",
    surfaceHint: "work",
    streamingText: "已经收到的私密片段",
    streamingInterrupted: true,
  };
}

describe("desktopEvidenceOf", () => {
  it("只导出可复盘字段，不导出任务正文、工具参数、路径、输出和推理", () => {
    const step = { id: "s1", goal: "写入秘密文件", tool: "write_file", args: { path: "/Users/alice/secret.txt", content: "token=sk-123456789012345" } };
    const events: AgentEvent[] = [
      { type: "run_start", runId: "run-1", goal: "不应被导出的原始目标", recordedAt: 1_000 },
      { type: "route", profileId: decision.primary?.profileId ?? null, reasons: ["原始路由原因"], decision, meta, recordedAt: 1_020 },
      { type: "step_route", step, surface: "work", surfaceReason: "需要写入文件", profileId: decision.primary?.profileId ?? null, reasons: [], decision, meta, recordedAt: 1_030 },
      { type: "llm", purpose: "answer", profileId: "openai/fast", latencyMs: 120, usage: { inputTokens: 12, outputTokens: 30 }, fallbacks: [{ profileId: "anthropic/backup", reason: "Bearer sk-123456789012345", code: "timeout" }], retries: 1, reasoning: "不应导出推理", recordedAt: 1_100 },
      { type: "tool_result", step, ok: true, content: "命中了私密文件内容", latencyMs: 10, invocationId: "inv-1", idempotencyKey: "idem-1", artifacts: [{ kind: "file", action: "modify", path: "/Users/alice/secret.txt", ok: true }], executionState: "applied", recordedAt: 1_200 },
      { type: "recover", step, strategy: "ask_user", error: "需要用户处理私密错误", backend: "rules", recordedAt: 1_300 },
      { type: "run_end", status: "failed", summary: "原始失败正文", recordedAt: 2_250 },
    ];

    const evidence = desktopEvidenceOf(card(events), 9_000);
    const serialized = JSON.stringify(evidence);
    expect(evidence).toMatchObject({
      schemaVersion: 1,
      capturedAt: 9_000,
      task: { id: "task-evidence-1", status: "failed", durationMs: 1_250, filesCount: 1 },
      surfaceJourney: ["work"],
      models: { calls: 1, firstCallAt: 1_100, lastCallAt: 1_100, fallbackCount: 1, retries: 1, successful: ["openai/fast"], providers: ["openai", "anthropic"] },
      stream: { partialOutput: true, firstChunkAt: null, lastChunkAt: null, partialOutputChars: 9 },
      tools: { calls: 1, firstCallAt: 1_200, lastCallAt: 1_200, succeeded: 1, failed: 0, artifacts: 1, ledgerStates: { applied: 1 } },
      events: { total: 7, firstRecordedAt: 1_000, lastRecordedAt: 2_250, recoveries: 1, runEndStatus: "failed" },
    });
    expect(evidence.routes).toHaveLength(2);
    expect(evidence.routes[0]).toMatchObject({ kind: "task", stepId: null, surface: null, recordedAt: 1_020, profileId: "openai/fast", provider: "openai", policyVersion: "m22.4", snapshot: { profiles: 2 } });
    expect(evidence.routes[1]).toMatchObject({ kind: "step", stepId: "s1", surface: "work", recordedAt: 1_030 });
    expect(serialized).not.toContain("不应被导出的原始目标");
    expect(serialized).not.toContain("原始目标");
    expect(serialized).not.toContain("secret.txt");
    expect(serialized).not.toContain("secret.pdf");
    expect(serialized).not.toContain("私密文件内容");
    expect(serialized).not.toContain("sk-123456789012345");
    expect(serialized).not.toContain("不应导出推理");
    expect(evidence.privacy.omitted).toContain("raw_event_text");
  });

  it("兼容没有路由快照的旧记录，并区分未记录的账本状态", () => {
    const oldDecision = { ...decision, trace: undefined };
    const event: AgentEvent = {
      type: "tool_result",
      step: { id: "s1", goal: "读取", tool: "read_file", args: { path: "~/Downloads/x.txt" } },
      ok: false,
      content: "失败",
      latencyMs: 2,
    };
    const evidence = desktopEvidenceOf(card([{ type: "route", profileId: null, reasons: [], decision: oldDecision, meta }, event]), 10);
    expect(evidence.routes[0]).toMatchObject({ policyVersion: null, snapshot: null });
    expect(evidence.tools.ledgerStates).toEqual({ not_recorded: 1 });
    expect(evidence.tools.failed).toBe(1);
  });

  it("按步骤顺序记录跨 Chat、Work、Codex 的能力链", () => {
    const events: AgentEvent[] = [
      { type: "route", profileId: "openai/fast", reasons: [], decision, meta },
      { type: "step_start", step: { id: "w", goal: "研究", tool: "read_file" }, attempt: 1, surface: "work" },
      { type: "subagent", agent: "coder", event: { type: "step_route", step: { id: "c", goal: "修改", tool: "run_command" }, surface: "codex", profileId: "openai/fast", reasons: [], decision, meta } },
      { type: "step_start", step: { id: "a", goal: "总结", tool: null }, attempt: 1, surface: "chat" },
    ];
    expect(desktopEvidenceOf(card(events), 20).surfaceJourney).toEqual(["work", "codex", "chat"]);
  });
});

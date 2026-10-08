// Agent 运行时共享类型。纯 TS，桌面端与 CLI 共用（MCP 的 stdio 传输除外）。
import type { ChatMessage, Usage } from "../core/llm/types";
import type { SideEffect } from "../decision/decision-layer";
import type { BackendName, DecisionMeta, ReplanStrategy, Risk } from "../decision/fallback";
import type { RouteDecision, RouteRequest } from "../decision/router";
import type { WorkSurface } from "../decision/types";
import type { MemoryNote } from "./memory";
import type { ArtifactRef, ToolCapabilityOverride, ToolExecutionState, ToolInvocation, ToolProbeResult } from "./tool-contract";

/** 路由偏好：由设置页和任务输入传入，原样交给 routeTask；lock 是输入框里手动锁定的模型 */
export type RouteOptions = Pick<RouteRequest, "preference" | "latency" | "maxCostTier" | "attachments" | "lock" | "surfaceHint">;

export interface ToolContext {
  signal: AbortSignal;
  /** 本次调用的稳定关联信息；工具适配器可以用 idempotencyKey 做去重。 */
  invocation?: ToolInvocation;
}
export interface ToolOutput {
  ok: boolean;
  content: string;
  data?: unknown;
  artifacts?: readonly ArtifactRef[];
}
export interface Tool {
  /** /^[a-z][a-z0-9_]{0,63}$/；MCP 工具为 mcp__<服务器>__<工具> */
  name: string;
  description: string;
  sideEffect: SideEffect;
  /** JSON Schema，给规划器看 */
  inputSchema?: Record<string, unknown>;
  timeoutMs?: number;
  /** 删除等不可恢复的操作：执行前要用户确认两次 */
  confirmTwice?: boolean;
  /** 工具能力声明；未声明的字段由 ToolRegistry 按名称、描述和副作用推断。 */
  capability?: ToolCapabilityOverride;
  /** 从失败任务恢复前，查询副作用是否已经落地；没有探测能力的工具沿用确认闸门。 */
  probe?(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolProbeResult>;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput>;
}

export interface PlanStep {
  id: string;
  goal: string;
  /** null 表示不用工具，由模型直接完成（回答、总结） */
  tool: string | null;
  args?: Record<string, unknown>;
}
export interface Plan {
  steps: PlanStep[];
  /** direct：简单问答，跳过规划直接回答；skill：「再…一次」按保存的技能直接执行开头的只读步骤 */
  source: "llm" | "fallback" | "direct" | "skill";
  note?: string;
  /** 这批步骤做完后，要根据结果继续规划（先列目录、再逐个处理这类任务） */
  more?: boolean;
}
export type StepStatus = "done" | "failed" | "denied";
export interface StepRecord {
  step: PlanStep;
  status: StepStatus;
  attempts: number;
  output?: string;
  error?: string;
  score?: number;
  invocationId?: string;
  idempotencyKey?: string;
  artifacts?: ArtifactRef[];
  executionState?: ToolExecutionState;
}

/** 从持久化事件继续执行：保留已完成步骤，下一次从 nextStepIndex 开始。 */
export interface ResumeState {
  plan: Plan;
  records: StepRecord[];
  nextStepIndex: number;
}

export type LlmPurpose = "plan" | "revise" | "args" | "answer" | "summary" | "split" | "merge";
export interface LlmRequest {
  purpose: LlmPurpose;
  messages: ChatMessage[];
  maxTokens?: number;
  /** 仅 answer / summary 使用：模型流式输出的增量及实际模型。 */
  onDelta?: (delta: { text: string; profileId: string }) => void;
}
/** 降级链上排在前面、这次没用上的模型和原因（已换成中文说明，不含密钥） */
export interface LlmFallback {
  profileId: string;
  reason: string;
  /** 失败的错误码（timeout、rate_limit 等）；界面据此标出「因超时降级」，不靠匹配文字 */
  code?: string;
}
export interface LlmReply {
  text: string;
  profileId: string;
  latencyMs: number;
  usage: Usage | null;
  /** 推理模型的思考过程；没有时不带 */
  reasoning?: string;
  /** 没有降级时不带这个字段 */
  fallbacks?: LlmFallback[];
  /** 超时后对同一个模型重试的次数；没有重试时不带 */
  retries?: number;
}
export type LlmCall = (req: LlmRequest, signal?: AbortSignal) => Promise<LlmReply>;

export interface ConfirmRequest {
  runId: string;
  step: PlanStep;
  tool: string;
  /** 已脱敏 */
  args: Record<string, unknown>;
  risk: Risk;
  reasons: string[];
  /** 多 Agent 协同时发起确认的子 Agent（角色名） */
  agent?: string;
  /** 不可恢复的操作（删除）的第二次确认 */
  second?: boolean;
}

/** 协调器拆出的子任务 */
export interface SubAgentSpec {
  id: string;
  role: string;
  goal: string;
}

export type RunStatus = "completed" | "failed" | "aborted" | "needs_user" | "budget_exceeded";

/** 执行时间线事件。事件里的参数、工具输出都已脱敏 */
export type AgentEvent = (
  | { type: "run_start"; runId: string; goal: string }
  /** 这次任务参考的记忆（用户确认过的条目） */
  | { type: "memory"; items: Pick<MemoryNote, "id" | "kind" | "text">[] }
  /** 这次规划参考的技能 */
  | { type: "skill"; items: { id: string; name: string }[] }
  /** 多 Agent 协同：协调器把目标拆成的子任务 */
  | { type: "split"; agents: SubAgentSpec[]; note?: string }
  /** 子 Agent 的事件，原样包一层 */
  | { type: "subagent"; agent: string; event: AgentEvent }
  /** decision 是完整路由结果（候选链、评分、排除原因），meta 说明分类由哪一级决策做出，供路由面板展示 */
  | { type: "route"; profileId: string | null; reasons: string[]; decision: RouteDecision; meta: DecisionMeta }
  /** 每个执行步骤的能力路由；任务级 route 仍保留，步骤路由用于跨 Chat/Work/Codex 切换 */
  | { type: "step_route"; step: PlanStep; surface?: WorkSurface; surfaceReason?: string; profileId: string | null; reasons: string[]; decision: RouteDecision; meta: DecisionMeta }
  /** continuation：根据前面结果追加步骤的第几轮；plan 是追加后的完整计划 */
  | { type: "plan"; plan: Plan; revision: number; continuation?: number }
  /** 计划模式：用户对计划的决定（批准后才执行第一步） */
  | { type: "plan_review"; approved: boolean }
  | { type: "step_start"; step: PlanStep; attempt: number; surface?: WorkSurface; surfaceReason?: string; invocationId?: string; idempotencyKey?: string }
  | { type: "probe"; step: PlanStep; state: ToolProbeResult["state"]; detail: string; invocationId?: string; idempotencyKey?: string; artifacts?: ArtifactRef[] }
  | { type: "gate"; step: PlanStep; verdict: "allow" | "confirm" | "deny"; risk: Risk; reasons: string[]; backend: BackendName; invocationId?: string; idempotencyKey?: string; recovery?: boolean }
  | { type: "confirm"; step: PlanStep; approved: boolean; executionState?: ToolExecutionState }
  | { type: "tool_result"; step: PlanStep; ok: boolean; content: string; latencyMs: number; invocationId?: string; idempotencyKey?: string; artifacts?: ArtifactRef[]; executionState?: ToolExecutionState }
  /** accepted：运行时对子步骤的实际接受判定，与 done 评分判断不同；旧 checkpoint 可以没有。
   * output：已接受的非工具子步骤的脱敏结果快照，受会话字符串预算限制。 */
  | { type: "reflect"; step: PlanStep | null; done: boolean; score: number; backend: BackendName; accepted?: boolean; output?: string }
  | { type: "recover"; step: PlanStep; strategy: ReplanStrategy; error: string; backend: BackendName }
  /** fallbacks：这次调用先试过、失败或跳过的模型，时间线据此写明换了模型 */
  /** reasoning：推理模型的思考过程，只用于界面折叠展示，不进上下文 */
  | { type: "llm"; purpose: LlmPurpose; profileId: string; latencyMs: number; usage: Usage | null; fallbacks?: LlmFallback[]; retries?: number; reasoning?: string }
  /** 降级链上所有模型都失败：逐个记下试过谁、为什么失败，路由记录据此展示完整降级路径 */
  | { type: "llm_failed"; purpose: LlmPurpose; attempts: LlmFallback[]; retries?: number; partialOutput?: boolean }
  /** 流式回答的增量；只用于当前任务的运行态展示，不参与历史路由统计。 */
  | { type: "llm_delta"; purpose: LlmPurpose; profileId: string; text: string }
  | { type: "run_end"; status: RunStatus; summary: string }
) & {
  /** 任务卡写入历史时补上的本地时间；运行时直接构造的测试事件可以没有。 */
  recordedAt?: number;
};

export interface Budget {
  /** 每批计划最多几步；每续写一轮，执行步数预算再加这么多（总数不超过 maxTotalSteps） */
  maxSteps: number;
  /** 续写规划最多几轮（先列目录、再逐个处理这类任务） */
  maxContinuations: number;
  maxTotalSteps: number;
  maxAttemptsPerStep: number;
  maxReplans: number;
  maxLlmCalls: number;
}

export interface RunResult {
  /** Fixed authority control result; quota_denied is opaque, not known exhaustion. */
  quotaControl?: { code: import("../core/goal-quota").GoalQuotaErrorCode };
  runId: string;
  status: RunStatus;
  summary: string;
  plan: Plan;
  steps: StepRecord[];
  replans: number;
  events: AgentEvent[];
}

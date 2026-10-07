// 从已脱敏的 Agent 事件中恢复可继续执行的 checkpoint。
// 这里只保存步骤目标和状态，不复用事件里的参数；恢复时重新生成参数，避免把脱敏后的
// 占位符当成真实参数，也避免把旧的副作用调用无条件重放。
import type { AgentEvent, ArtifactRef, Plan, PlanStep, ResumeState, RunStatus, StepRecord, ToolExecutionState } from "@/agent";
import { redact } from "@/core/redact";
import { MAX_FIELD } from "@/decision/session";

export interface RecoveryCheckpoint extends ResumeState {
  status: Exclude<RunStatus, "completed" | "running">;
  failedStep: PlanStep | null;
  reason: string;
  /** 上次调用可能已经产生副作用，但没有可验证的成功结果。 */
  uncertainSteps: PlanStep[];
}

/**
 * 恢复原因是用户需要的操作依据，但来源可能是 Provider 或工具错误。
 * 运行时通常已经脱敏，这里在 UI 边界再做一次密钥遮罩并限制长度，避免
 * 合成事件、旧历史或第三方工具把原始凭据带进恢复提示。
 */
export function safeRecoveryReason(reason: string): string {
  const value = redact(reason.trim());
  if (!value) return "从未完成步骤继续";
  return value.length > 240 ? `${value.slice(0, 237)}…` : value;
}

type StepState = "pending" | "running" | "done" | "failed" | "denied";
interface SeenStep {
  step: PlanStep;
  state: StepState;
  attempts: number;
  output?: string;
  invocationId?: string;
  idempotencyKey?: string;
  artifacts?: ArtifactRef[];
  executionState?: ToolExecutionState;
  error?: string;
  score?: number;
}

const RESUMABLE = new Set<RunStatus>(["failed", "needs_user", "budget_exceeded", "aborted"]);

const withoutArgs = (step: PlanStep): PlanStep => {
  const { args: _args, ...rest } = step;
  return rest;
};

/**
 * 找到最近一次未完成的计划。返回 null 表示没有可安全恢复的任务：例如任务已经完成、
 * 还没生成计划就失败，或者事件不是一个可继续的终态。
 */
export function recoveryCheckpoint(events: readonly AgentEvent[]): RecoveryCheckpoint | null {
  let plan: Plan | null = null;
  let status: RunStatus | null = null;
  let runSummary = "";
  const seen = new Map<string, SeenStep>();

  for (const e of events) {
    if (e.type === "plan") {
      plan = e.plan;
      for (const step of e.plan.steps) {
        const old = seen.get(step.id);
        if (!old) seen.set(step.id, { step, state: "pending", attempts: 0 });
        else old.step = step;
      }
    } else if (e.type === "step_start") {
      const old = seen.get(e.step.id) ?? { step: e.step, state: "pending", attempts: 0 };
      old.step = e.step;
      old.state = "running";
      old.attempts++;
      old.invocationId = e.invocationId ?? old.invocationId;
      old.idempotencyKey = e.idempotencyKey ?? old.idempotencyKey;
      seen.set(e.step.id, old);
    } else if (e.type === "tool_result") {
      const old = seen.get(e.step.id) ?? { step: e.step, state: "pending", attempts: 0 };
      old.step = e.step;
      old.state = e.ok ? "done" : "failed";
      if (e.ok) old.output = e.content;
      else old.error = e.content || "工具执行失败";
      old.invocationId = e.invocationId ?? old.invocationId;
      old.idempotencyKey = e.idempotencyKey ?? old.idempotencyKey;
      old.artifacts = e.artifacts;
      old.executionState = e.executionState ?? (e.ok ? "applied" : "unknown");
      seen.set(e.step.id, old);
    } else if (e.type === "probe") {
      const old = seen.get(e.step.id) ?? { step: e.step, state: "pending", attempts: 0 };
      old.step = e.step;
      old.invocationId = e.invocationId ?? old.invocationId;
      old.idempotencyKey = e.idempotencyKey ?? old.idempotencyKey;
      old.artifacts = e.artifacts;
      old.executionState = e.state === "conflict" ? "unknown" : e.state;
      if (e.state === "applied") {
        old.state = "done";
        old.output = e.detail;
      } else {
        old.state = "failed";
        old.error = e.detail;
      }
      seen.set(e.step.id, old);
    } else if (e.type === "gate") {
      const old = seen.get(e.step.id) ?? { step: e.step, state: "pending", attempts: 0 };
      old.step = e.step;
      // The gate is the last durable identity before started/tool-result.
      // Keep its digest-bearing key even though arguments are regenerated.
      old.invocationId = e.invocationId ?? old.invocationId;
      old.idempotencyKey = e.idempotencyKey ?? old.idempotencyKey;
      if (e.verdict === "deny") {
        old.state = "denied";
        old.error = e.reasons.join("；") || "操作被权限规则拒绝";
        old.executionState = "not_applied";
      }
      seen.set(e.step.id, old);
    } else if (e.type === "confirm" && !e.approved) {
      const old = seen.get(e.step.id) ?? { step: e.step, state: "pending", attempts: 0 };
      old.step = e.step;
      old.state = "failed";
      old.error = "用户没有批准这一步";
      old.executionState = e.executionState ?? "not_applied";
      seen.set(e.step.id, old);
    } else if (e.type === "reflect" && e.step) {
      const old = seen.get(e.step.id) ?? { step: e.step, state: "pending", attempts: 0 };
      old.step = e.step;
      // Persist the runtime's decision before its asynchronous replan window.
      // Legacy events lack this decision; retain their original state semantics
      // rather than inferring acceptance from done/score or tool output.
      if (e.accepted === false) {
        old.state = "failed";
        old.error = "上一次子步骤结果未被运行时接受，请从这一步继续";
        if (e.step.tool === null) {
          old.executionState = "not_applied";
          delete old.output;
        }
      } else if (e.accepted === true || old.state === "running" || old.state === "pending") old.state = "done";
      if (old.state === "done" && e.step.tool === null && typeof e.output === "string") {
        old.output = redact(e.output).slice(0, MAX_FIELD).replace(/[\uD800-\uDBFF]$/, "");
      }
      old.score = e.score;
      seen.set(e.step.id, old);
    } else if (e.type === "recover") {
      const old = seen.get(e.step.id) ?? { step: e.step, state: "pending", attempts: 0 };
      old.step = e.step;
      old.state = "failed";
      old.error = e.error;
      old.executionState ??= e.step.tool ? "unknown" : "not_applied";
      seen.set(e.step.id, old);
    } else if (e.type === "run_end") {
      status = e.status;
      runSummary = e.summary;
      if (e.status !== "completed") {
        // 没有 tool_result / reflect 的中断步骤仍然必须可恢复。
        for (const value of seen.values()) if (value.state === "running") {
          value.state = "failed";
          value.error ??= e.summary || "上一次执行没有完成";
          value.executionState ??= value.step.tool ? "unknown" : "not_applied";
        }
      }
    }
  }

  if (!plan || !status || !RESUMABLE.has(status)) return null;
  const resumeStatus = status as Exclude<RunStatus, "completed" | "running">;
  const steps = plan.steps;
  const nextStepIndex = steps.findIndex((step) => seen.get(step.id)?.state !== "done");
  const next = nextStepIndex < 0 ? steps.length : nextStepIndex;
  const failedStep = steps[next] ? withoutArgs(steps[next]) : null;
  const records: StepRecord[] = steps.flatMap((step) => {
    const value = seen.get(step.id);
    if (!value || value.state === "pending") return [];
    return [{
      step: withoutArgs(step),
      status: value.state === "denied" ? "denied" : value.state === "done" ? "done" : "failed",
      attempts: Math.max(1, value.attempts),
      ...(value.error ? { error: value.error } : {}),
      ...(value.output ? { output: value.output } : {}),
      ...(value.invocationId ? { invocationId: value.invocationId } : {}),
      ...(value.idempotencyKey ? { idempotencyKey: value.idempotencyKey } : {}),
      ...(value.artifacts ? { artifacts: value.artifacts } : {}),
      ...(value.executionState ? { executionState: value.executionState } : {}),
      ...(value.score !== undefined ? { score: value.score } : {}),
    } satisfies StepRecord];
  });

  const why = failedStep ? (seen.get(steps[next]?.id ?? "")?.error ?? runSummary) : "";
  const uncertainSteps = steps.filter((step) => seen.get(step.id)?.executionState === "unknown").map(withoutArgs);
  return {
    plan: { ...plan, steps: steps.map(withoutArgs) },
    records,
    nextStepIndex: next,
    status: resumeStatus,
    failedStep,
    reason: failedStep ? (why || "从未完成步骤继续") : "计划中的步骤均已记录，继续规划后续工作",
    uncertainSteps,
  };
}

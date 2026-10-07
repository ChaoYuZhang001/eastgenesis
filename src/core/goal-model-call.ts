import { GoalQuotaControlError, type GoalMeterScope, type GoalQuotaErrorCode, type GoalQuotaKind, type GoalQuotaPurpose } from "./goal-quota";

/** The caller must establish scope and createEngine inside its controlled try/finally. */
export interface GoalModelExecution {
  readonly goalId: string;
  readonly enrollmentId: string;
  readonly taskId: string;
  readonly executionId: string;
}

/** Scope identifiers are captured once; taskId alone remains ordinary Chat metadata. */
export function resolveGoalMeter(execution?: GoalModelExecution, meter?: GoalMeterScope): GoalMeterScope | undefined {
  if (execution === undefined && meter === undefined) return undefined;
  if (!execution || !meter || typeof meter.invoke !== "function") throw new GoalQuotaControlError("quota_invalid_request");
  for (const key of ["goalId", "enrollmentId", "taskId", "executionId"] as const) {
    if (typeof execution[key] !== "string" || !execution[key] || execution[key] !== meter[key]) throw new GoalQuotaControlError("quota_invalid_request");
  }
  const captured = Object.freeze({ ...execution });
  return Object.freeze({
    goalId: captured.goalId, enrollmentId: captured.enrollmentId,
    taskId: captured.taskId, executionId: captured.executionId,
    ownerId: meter.ownerId, fence: meter.fence,
    invoke: meter.invoke.bind(meter),
  });
}

// Adapter provenance is not a status-code classifier. Only completed HTTP response
// paths may record an error; constructors and transport/timeout errors cannot do so.
const TERMINAL_FAILURES = new WeakSet<object>();
/** @internal Called only at positively observed terminal adapter/aggregate paths. */
export function recordTerminalModelFailure<T extends object>(error: T): T { TERMINAL_FAILURES.add(error); return error; }
export function isTerminalModelFailure(error: unknown): boolean {
  return typeof error === "object" && error !== null && TERMINAL_FAILURES.has(error);
}

export async function invokeGoalModel<T>(meter: GoalMeterScope | undefined, kind: GoalQuotaKind, purpose: GoalQuotaPurpose, callback: () => Promise<T>): Promise<T> {
  if (!meter) return callback();
  if (typeof globalThis.crypto?.randomUUID !== "function") throw new GoalQuotaControlError("quota_invalid_request");
  return meter.invoke({ permitId: `permit-${globalThis.crypto.randomUUID()}`, kind, purpose }, callback, {
    classifyFailure: error => isTerminalModelFailure(error) ? "failed" : "unknown",
  });
}

/** Opaque admission rejection never asserts known exhaustion or Provider failure. */
export function goalQuotaSummary(code: GoalQuotaErrorCode): string {
  switch (code) {
    case "quota_denied": return "目标模型调用未获持久额度许可，请检查目标运行状态后继续";
    case "quota_outcome_unknown": return "模型调用结果未知，已暂停后续模型调用，请检查已有结果";
    case "quota_storage_unknown": return "目标额度存储状态未知，已暂停后续模型调用";
    default: return "目标模型调用权限无效，已停止运行";
  }
}

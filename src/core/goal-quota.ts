/** Logical Goal admissions, not HTTP, tokens, fees or remote exactly-once. */
export const GOAL_QUOTA_PROTOCOL = "inclusive-goal-quota-v1" as const;
export const GOAL_QUOTA_MAX_LIMIT = 500;
export const GOAL_QUOTA_MAX_FENCE = 1_000_000_000;
export const GOAL_QUOTA_KINDS = ["main", "cloud_decision", "local_decision", "goal_verifier"] as const;
export const GOAL_QUOTA_PURPOSES = ["plan", "revise", "answer", "args", "summary", "split", "merge", "decision", "route", "choose_tool", "gate", "replan", "check_done", "evaluate_result"] as const;
export type GoalQuotaKind = typeof GOAL_QUOTA_KINDS[number];
export type GoalQuotaPurpose = typeof GOAL_QUOTA_PURPOSES[number];
export type GoalQuotaErrorCode = "quota_invalid_request" | "quota_denied" | "quota_storage_unknown" | "quota_outcome_unknown" | "quota_protocol_invalid";
export class GoalQuotaControlError extends Error {
  readonly code: GoalQuotaErrorCode;
  constructor(code: GoalQuotaErrorCode) { super(code); this.name = "GoalQuotaControlError"; this.code = code; }
}
export function isGoalQuotaControlError(value: unknown): value is GoalQuotaControlError { return value instanceof GoalQuotaControlError; }
export interface GoalQuotaIdentity { readonly goalId: string; readonly enrollmentId: string }
export interface GoalQuotaClaim extends GoalQuotaIdentity { readonly ownerId: string; readonly fence: number }
export interface GoalQuotaExecution { readonly taskId: string; readonly executionId: string }
export interface GoalQuotaCall { readonly permitId: string; readonly kind: GoalQuotaKind; readonly purpose: GoalQuotaPurpose }
export interface GoalQuotaFailurePolicy { /** Only a trusted adapter with positive terminal evidence may return failed. */ classifyFailure(error: unknown): "failed" | "unknown" }
export interface GoalMeterScope extends GoalQuotaClaim, GoalQuotaExecution {
  invoke<T>(call: GoalQuotaCall, callback: () => Promise<T>, policy?: GoalQuotaFailurePolicy): Promise<T>;
}
export interface GoalQuotaPermit {
  id: string; task_id: string; execution_id: string; owner: string; fence: number;
  kind: GoalQuotaKind; purpose: GoalQuotaPurpose; state: "pending" | "succeeded" | "failed" | "unknown";
  admitted_at: number; finished_at: number | null;
}
export interface GoalQuotaRecord {
  protocol: typeof GOAL_QUOTA_PROTOCOL; goal_id: string; enrollment_id: string; state: "prepared" | "enrolled";
  limit: number; consumed: number; owner: string | null; fence: number; active: boolean; lease_until: number; permits: GoalQuotaPermit[];
}

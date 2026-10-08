import { GoalQuotaControlError, type GoalQuotaErrorCode } from "@/core/goal-quota";

/** withDb serializes Error identity. Restore only exact fixed control codes
 * at execution/recovery boundaries; never interpret arbitrary provider text. */
export function rethrowGoalControl(error: unknown): never {
  if (error instanceof GoalQuotaControlError) throw error;
  if (error && typeof error === "object") {
    const { code, message } = error as { code?: unknown; message?: unknown };
    if (typeof code === "string" && message === code && ["quota_invalid_request", "quota_denied", "quota_storage_unknown", "quota_outcome_unknown", "quota_protocol_invalid"].includes(code)) {
      throw new GoalQuotaControlError(code as GoalQuotaErrorCode);
    }
  }
  throw error;
}

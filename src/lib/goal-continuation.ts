import type { AgentEvent } from "@/agent";
import type { Goal } from "@/decision/goal";
import { normalizeRecoveryAccounting, type StoredTurn } from "@/decision/session";
import { withDb } from "./db";
import { getGoalForQuota } from "./db-goal";
import { quotaProjection } from "./goal-quota-storage";
import { readCanonicalGoalSnapshot } from "./goal-snapshot";
import { rethrowGoalControl } from "./goal-quota-error";
import { recoveryCheckpoint, type RecoveryCheckpoint } from "./recovery";

/** A DB-derived capability to resume the same interrupted Task, never a billing receipt.
 * Its private preimages are consumed by the conditional fresh claim and bind. */
export interface GoalContinuation {
  readonly goalId: string;
  readonly enrollmentId: string;
  readonly taskId: string;
  readonly round: number;
  readonly revision: number;
  readonly authorityFence: number;
  readonly sourceExecutionId: string;
  readonly sourceOwnerId: string;
  readonly sourceFence: number;
  readonly limit: number;
  readonly consumed: number;
}
interface Source {
  rounds: string;
  record: string;
  task: StoredTurn;
  checkpoint: RecoveryCheckpoint;
}
const sources = new WeakMap<GoalContinuation, Source>();
// All capability state derives from persisted compact JSON. Keep copying
// independent of optional WebView builtins while retaining the private seed.
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function sameData(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => sameData(v, b[i]));
  if (!a || !b || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) || Array.isArray(b)) return false;
  const x = a as Record<string, unknown>, y = b as Record<string, unknown>, keys = Object.keys(x);
  return keys.length === Object.keys(y).length && keys.every(k => Object.prototype.hasOwnProperty.call(y, k) && sameData(x[k], y[k]));
}

function eligible(g: Goal, taskId: string, now: number): boolean {
  const q = g.quota, e = q?.execution, r = g.rounds.at(-1), t = r?.task_checkpoint;
  return Boolean(q && e && g.status === "running" && r?.status === "interrupted"
    && r.task_id === taskId && e.taskId === taskId && t?.id === taskId
    && t.goalId === g.id && t.mode === "goal" && !t.multi
    && q.pending === 0 && q.unknown === 0 && q.consumed < q.limit
    && (!q.active || q.leaseUntil <= now));
}

export async function prepareGoalContinuation(goalId: string, taskId: string, clock: () => number = Date.now): Promise<GoalContinuation | null> {
  return withDb(async db => {
    const discovered = await getGoalForQuota(db, goalId);
    if (!discovered.quota) return null;
    // Capture the exact preimages from the strict reader's single coherent
    // SELECT. Evidence alone never authorizes continuation: the later claim
    // and bind must still compare both original JSON values atomically.
    let raw: { rounds: string; authority: string } | undefined;
    const snapshot = await readCanonicalGoalSnapshot({ select: async <T>(sql: string, args?: unknown[]): Promise<T> => {
      const rows = await db.select<T>(sql, args);
      if (Array.isArray(rows) && rows.length === 1) raw = rows[0];
      return rows;
    } }, goalId);
    const envelope = snapshot.envelope, record = snapshot.authority;
    if (!raw || envelope.enrollment_id !== discovered.quota.enrollmentId) return null;
    const g: Goal = { ...discovered, status: snapshot.status, rounds: envelope.rounds,
      quota: quotaProjection(envelope, record), max_llm_calls: record.limit, used_llm_calls: record.consumed };
    const now = clock();
    if (!Number.isSafeInteger(now) || now < 0 || record.state !== "enrolled" || !eligible(g, taskId, now)) return null;
    const execution = g.quota!.execution!;
    if (execution.fence > record.fence || record.active && (record.owner !== execution.ownerId || record.fence !== execution.fence)) return null;
    // parseRounds intentionally repairs some legacy fields. Recovery authority
    // must additionally match the actual raw last checkpoint's identities.
    const lastRaw = JSON.parse(raw.rounds).rounds.at(-1);
    if (lastRaw?.task_id !== taskId || lastRaw?.task_checkpoint?.id !== taskId
      || lastRaw.task_checkpoint.goalId !== goalId || lastRaw.task_checkpoint.mode !== "goal"
      || lastRaw.task_checkpoint.multi !== false) return null;
    const r = g.rounds.at(-1)!, task = r.task_checkpoint!;
    if (!sameData(lastRaw, r)) return null;
    const a = normalizeRecoveryAccounting(task.recovery_accounting, taskId);
    if (!a) return null;
    const events = task.events as AgentEvent[];
    let latestStart = -1;
    for (let i = events.length - 1; i >= 0; i--) if (events[i]?.type === "run_start") { latestStart = i; break; }
    if (latestStart < 0 || (events[latestStart] as Extract<AgentEvent, { type: "run_start" }>).runId !== a.run_id) return null;
    let terminal: Extract<AgentEvent, { type: "run_end" }> | undefined;
    for (let i = events.length - 1; i > latestStart; i--) if (events[i]?.type === "run_end") { terminal = events[i] as typeof terminal; break; }
    if (terminal?.status === "completed") return null;
    if (a.final) {
      // Only a persisted, positively failed run can use its final receipt as
      // old accounting evidence. A synthetic restart marker is never final.
      if (task.status !== "failed" || terminal?.status !== "failed"
        || snapshot.mainReceipt.state !== "final" || !snapshot.mainReceipt.terminalEvidence
        || !sameData(snapshot.mainReceipt.accounting, a) || r.llm_settlements === undefined) return null;
      const settled = r.llm_settlements.find(receipt => receipt.run_id === a.run_id);
      if (settled && settled.llm_calls !== a.llm_calls) return null;
    }
    if (!terminal && task.status !== "running") return null;
    // A temporary aborted view closes only recovery interpretation. Do not
    // persist it, settle the incomplete accounting, or infer a tool outcome.
    const view: AgentEvent[] = terminal ? clone(events) : [...clone(events), {
      type: "run_end", status: "aborted", summary: "应用在任务完成前退出，继续原任务前核验执行记录",
    }];
    const checkpoint = recoveryCheckpoint(view);
    if (!checkpoint) return null;
    const q = g.quota!, e = q.execution!;
    const proof: GoalContinuation = Object.freeze({ goalId, enrollmentId: q.enrollmentId, taskId,
      round: r.index, revision: q.revision, authorityFence: q.fence, sourceExecutionId: e.executionId,
      sourceOwnerId: e.ownerId, sourceFence: e.fence, limit: q.limit, consumed: q.consumed });
    sources.set(proof, { rounds: raw.rounds, record: raw.authority, task: clone(task), checkpoint: clone(checkpoint) });
    return proof;
  }).catch(rethrowGoalControl);
}

export function isGoalContinuation(proof: GoalContinuation | undefined, g: Goal, now = Date.now()): proof is GoalContinuation {
  if (!proof || !sources.has(proof) || !eligible(g, proof.taskId, now)) return false;
  const q = g.quota!, e = q.execution!;
  return proof.goalId === g.id && proof.enrollmentId === q.enrollmentId
    && proof.round === g.rounds.at(-1)?.index && proof.revision === q.revision
    && proof.authorityFence === q.fence && proof.sourceExecutionId === e.executionId
    && proof.sourceOwnerId === e.ownerId && proof.sourceFence === e.fence
    && proof.limit === q.limit && proof.consumed === q.consumed;
}

export function goalContinuationGuard(proof: GoalContinuation, g: Goal, now = Date.now()): Pick<Source, "rounds" | "record"> | null {
  if (!isGoalContinuation(proof, g, now)) return null;
  const source = sources.get(proof)!;
  return { rounds: source.rounds, record: source.record };
}

export function goalContinuationSeed(proof: GoalContinuation, g: Goal): Pick<Source, "task" | "checkpoint"> | null {
  if (!isGoalContinuation(proof, g)) return null;
  const source = sources.get(proof)!;
  return { task: clone(source.task), checkpoint: clone(source.checkpoint) };
}

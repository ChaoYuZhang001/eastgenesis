// @vitest-environment node
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/lib/db";
import { asDb, loadSqlite, migratedDb, type RawDb, type SqliteModule } from "./sqlite-helper";
const state = vi.hoisted(() => ({ db: null as Db | null }));
vi.mock("@/lib/db", () => ({ withDb: async (f: (db: Db) => Promise<unknown>) => f(state.db!) }));
import { saveGoal, updateGoal, listGoals } from "@/lib/db-goal";
import { createMockBackend, setBackend } from "@/platform";
import { useGoals } from "@/stores/goals";
import { taskToStoredTurn, useTasks } from "@/stores/tasks";
import { hydrateGoalCheckpoints } from "@/stores/history";
import { goalRunner } from "@/lib/goal-run";
import type { AgentEvent } from "@/agent";
import type { RecoveryPreparation } from "@/lib/goal-runner";
import { prepareGoalContinuation, goalContinuationSeed, isGoalContinuation, type GoalContinuation } from "@/lib/goal-continuation";
import { acquireGoalExecution } from "@/lib/goal-execution";
import { createGoalQuotaAuthority, GOAL_QUOTA_SQL } from "@/lib/db-goal-quota";
import { GOAL_PUBLICATION_SQL } from "@/lib/db-goal-publication";
import * as engine from "@/lib/engine";
import type { GoalMeterScope } from "@/core/goal-quota";

let sqlite: SqliteModule;
let raw: RawDb;
beforeAll(async () => { sqlite = (await loadSqlite())!; expect(sqlite).not.toBeNull(); });
beforeEach(() => {
  raw = migratedDb(sqlite); state.db = asDb(() => raw);
  setBackend({ ...createMockBackend(), kind: "tauri", saveGoal, updateGoal, listGoals });
  useGoals.setState({ items: [], loaded: true, error: null });
  useTasks.setState({ tasks: [], activeId: null });
});
afterEach(() => {
  for (const goal of useGoals.getState().items) goalRunner.stop(goal.id);
  vi.restoreAllMocks(); setBackend(null);
  (raw as RawDb & { close(): void }).close();
});

/** The production APIs prepare, claim, meter and persist this partial Task.
 * This is a synthetic post-crash state, not a process-abort/WebView proof.
 * No completed run_end, final receipt, tool effect or provider HTTP is seeded. */
async function interruptedKnownMain(outcome: "known" | "failed" | "unknown" = "known", cap = 4) {
  const saved = await useGoals.getState().save({ description: "synthetic canonical continuation", max_llm_calls: cap });
  if (typeof saved === "string") throw Error(saved);
  expect(await useGoals.getState().start(saved.id)).toBeNull();
  const handle = useTasks.getState().runGoalRound("synthetic continuation", { mode: "goal", goalId: saved.id });
  const session = (await handle.prepare!())!;
  expect(session).not.toBeNull();
  expect(typeof await useGoals.getState().apply(saved.id, { op: "start_round", plan: { task_id: handle.taskId }, quota_publication: session.publication })).not.toBe("string");
  const request = session.meter.invoke({ permitId: "permit-partial-main", kind: "main", purpose: "plan" }, async () => {
    if (outcome !== "known") throw Error("synthetic remote outcome");
    return "synthetic known planner output";
  }, { classifyFailure: () => outcome === "failed" ? "failed" : "unknown" });
  if (outcome === "known") await request;
  else if (outcome === "failed") await expect(request).rejects.toThrow("synthetic remote outcome");
  else await expect(request).rejects.toMatchObject({ code: "quota_outcome_unknown" });
  const events: AgentEvent[] = [
    { type: "run_start", runId: "run-partial-main", goal: "synthetic continuation" },
    { type: "plan", plan: { source: "llm", steps: [{ id: "step-1", goal: "inspect a synthetic fixture", tool: null }] }, revision: 1 },
    { type: "llm", purpose: "plan", profileId: "synthetic/fixture", latencyMs: 1, usage: null },
  ];
  useTasks.setState(s => ({ tasks: s.tasks.map(t => t.id === handle.taskId ? { ...t, status: "running", events, recovery_accounting: { version: 1, task_id: handle.taskId, run_id: "run-partial-main", llm_calls: 1, final: false } } : t) }));
  const card = useTasks.getState().tasks.find(t => t.id === handle.taskId)!;
  expect(typeof await useGoals.getState().apply(saved.id, { op: "checkpoint_round", task: taskToStoredTurn(card), quota_publication: session.publication })).not.toBe("string");
  expect(await useGoals.getState().pause(saved.id)).toBeNull();
  await session.release();
  useTasks.setState({ tasks: [] });
  await useGoals.getState().load(); hydrateGoalCheckpoints();
  const reloaded = (await listGoals())[0];
  expect(reloaded.rounds[0].task_checkpoint?.recovery_accounting?.final).toBe(false);
  expect(reloaded.rounds[0].llm_settlements).toEqual([]);
  if (outcome !== "unknown") expect(await useGoals.getState().start(saved.id)).toBeNull();
  return { id: saved.id, taskId: handle.taskId, oldExecutionId: session.context.executionId };
}

async function rewriteEnvelope(id: string, mutate: (e: { revision: number; rounds: Array<{ task_checkpoint: { goal: string; events: AgentEvent[]; mode: string; recovery_accounting: unknown } }> }) => void, db = state.db!) {
  const [row] = await db.select<{ rounds: string }[]>("SELECT rounds FROM goals WHERE id=$1", [id]);
  const e = JSON.parse(row.rounds); mutate(e);
  await db.execute("UPDATE goals SET rounds=$1 WHERE id=$2", [JSON.stringify(e), id]);
}

async function proofFor(f: { id: string; taskId: string }) {
  const proof = await prepareGoalContinuation(f.id, f.taskId);
  expect(proof).not.toBeNull(); return proof!;
}

describe("canonical occupied calls distinguish an unfinished run from an unknown request", () => {
  test("positive terminal permits can authorize same-task continuation without a fabricated final receipt", async () => {
    const f = await interruptedKnownMain();
    const before = (await listGoals())[0];
    expect(before.quota).toMatchObject({ consumed: 1, pending: 0, unknown: 0, active: false });
    const result = await useTasks.getState().prepareGoalRecovery(f.taskId, f.id) as RecoveryPreparation & { continuation?: unknown };
    expect(result.accounting).toBeNull(); expect(result.completed).toBeNull();
    expect(result.continuation).toBeDefined();
    const after = (await listGoals())[0];
    expect(after.quota?.consumed).toBe(1);
    expect(after.rounds[0].task_id).toBe(f.taskId);
    expect(after.rounds[0].task_checkpoint?.recovery_accounting?.final).toBe(false);
    expect(after.rounds[0].llm_settlements).toEqual([]);
  });

  test("remote unknown stays occupied and cannot authorize continuation", async () => {
    const f = await interruptedKnownMain("unknown");
    expect(await useGoals.getState().start(f.id)).toBe("quota_outcome_unknown");
    const result = await useTasks.getState().prepareGoalRecovery(f.taskId, f.id) as RecoveryPreparation & { continuation?: unknown };
    expect(result.continuation).toBeUndefined();
    expect((await listGoals())[0].quota).toMatchObject({ consumed: 1, unknown: 1, active: false });
  });

  test("positively failed permits also stay occupied and allow the unfinished same-task path", async () => {
    const f = await interruptedKnownMain("failed");
    expect(await proofFor(f)).toMatchObject({ consumed: 1, taskId: f.taskId });
    const record = await createGoalQuotaAuthority(state.db!).snapshot({ goalId: f.id, enrollmentId: (await listGoals())[0].quota!.enrollmentId });
    expect(record.permits[0].state).toBe("failed");
    expect((await listGoals())[0].rounds[0].llm_settlements).toEqual([]);
  });

  test("actual Runner and lazy Tasks resume the same task with a fresh execution; old charge is never settled as a receipt", async () => {
    const f = await interruptedKnownMain();
    const dispatched: string[] = [];
    let newMeter: GoalMeterScope | undefined;
    vi.spyOn(engine, "createEngine").mockImplementation(options => {
      const meter = options.goalMeter!; newMeter = meter;
      const run = async (_goal: string, opts: { taskId?: string; resume?: { plan: { steps: Array<{ goal: string }> } } }) => {
        expect(opts.taskId).toBe(f.taskId);
        expect(opts.resume?.plan.steps[0].goal).toBe("inspect a synthetic fixture");
        expect(meter.executionId).not.toBe(f.oldExecutionId);
        options.onEvent!({ type: "run_start", runId: "run-resumed-main", goal: _goal });
        await meter.invoke({ permitId: "permit-resumed-main", kind: "main", purpose: "answer" }, async () => { dispatched.push("main"); return "synthetic answer"; });
        options.onEvent!({ type: "llm", purpose: "answer", profileId: "synthetic/fixture", latencyMs: 1, usage: null });
        options.onEvent!({ type: "run_end", status: "completed", summary: "synthetic complete" });
        return { status: "completed" as const, summary: "synthetic complete", events: [] };
      };
      return { runtime: { run }, coordinator: { run }, decision: { checkDoneWithEvidence: async () => {
        await meter.invoke({ permitId: "permit-resumed-verifier", kind: "goal_verifier", purpose: "check_done" }, async () => { dispatched.push("goal_verifier"); return "synthetic verdict"; });
        return { verdict: "done", by: "jev", reason: "synthetic verification" };
      } }, profiles: [] } as unknown as ReturnType<typeof engine.createEngine>;
    });
    await goalRunner.run(f.id);
    const g = (await listGoals())[0];
    expect(g.status).toBe("completed"); expect(g.rounds).toHaveLength(1);
    expect(g.rounds[0].task_id).toBe(f.taskId);
    expect(g.rounds[0].llm_settlements).toEqual([{ run_id: "run-resumed-main", llm_calls: 1 }]);
    expect(dispatched).toEqual(["main", "goal_verifier"]);
    expect(g.quota).toMatchObject({ consumed: 3, pending: 0, unknown: 0, active: false });
    const record = await createGoalQuotaAuthority(state.db!).snapshot({ goalId: f.id, enrollmentId: g.quota!.enrollmentId });
    expect(record.permits[0]).toMatchObject({ id: "permit-partial-main", state: "succeeded", execution_id: f.oldExecutionId });
    expect(record.permits.slice(1).every(p => p.task_id === f.taskId && p.execution_id === newMeter!.executionId)).toBe(true);
  });

  test("a forged or cloned capability cannot resume or claim", async () => {
    const f = await interruptedKnownMain(), proof = await proofFor(f), g = (await listGoals())[0];
    const cloned = { ...proof } as GoalContinuation;
    expect(isGoalContinuation(cloned, g)).toBe(false);
    expect(goalContinuationSeed(cloned, g)).toBeNull();
    await expect(acquireGoalExecution(f.id, f.taskId, Date.now, cloned)).rejects.toMatchObject({ code: "quota_denied" });
    expect((await listGoals())[0].quota?.active).toBe(false);
  });

  test("missing capability cannot be bypassed by a stale memory-only final flag", async () => {
    const f = await interruptedKnownMain();
    await expect(acquireGoalExecution(f.id, f.taskId)).rejects.toMatchObject({ code: "quota_denied" });
    useTasks.setState(s => ({ tasks: s.tasks.map(t => t.id !== f.taskId ? t : { ...t, recovery_accounting: { ...t.recovery_accounting!, final: true } }) }));
    const handle = useTasks.getState().resumeGoalRound("synthetic", { mode: "goal", goalId: f.id, taskId: f.taskId });
    expect(handle).not.toBeNull();
    await expect(handle!.prepare!()).rejects.toMatchObject({ code: "quota_denied" });
    expect((await listGoals())[0].quota).toMatchObject({ active: false, consumed: 1 });
  });

  test("private checkpoint copies cannot redirect a later recovery seed", async () => {
    const f = await interruptedKnownMain(), proof = await proofFor(f), g = (await listGoals())[0];
    const first = goalContinuationSeed(proof, g)!;
    first.checkpoint.plan.steps[0].goal = "synthetic redirected step";
    expect(goalContinuationSeed(proof, g)!.checkpoint.plan.steps[0].goal).toBe("inspect a synthetic fixture");
    expect(Object.isFrozen(proof)).toBe(true);
  });

  test("JSON checkpoint recovery does not require structuredClone from the desktop WebView", async () => {
    const f = await interruptedKnownMain();
    vi.stubGlobal("structuredClone", undefined);
    try {
      const proof = await proofFor(f), g = (await listGoals())[0];
      expect(goalContinuationSeed(proof, g)?.checkpoint.plan.steps[0].goal).toBe("inspect a synthetic fixture");
    } finally { vi.unstubAllGlobals(); }
  });

  test("a same-ID stale card plan is rejected before prepare or engine", async () => {
    const f = await interruptedKnownMain(), proof = await proofFor(f);
    useTasks.setState(s => ({ tasks: s.tasks.map(t => t.id !== f.taskId ? t : { ...t, events: t.events.map(e => e.type !== "plan" ? e : { ...e, plan: { ...e.plan, steps: [{ ...e.plan.steps[0], goal: "synthetic stale plan" }] } }) }) }));
    const sp = vi.spyOn(engine, "createEngine");
    expect(useTasks.getState().resumeGoalRound("synthetic", { mode: "goal", goalId: f.id, taskId: f.taskId }, proof)).toBeNull();
    expect(sp).not.toHaveBeenCalled(); expect((await listGoals())[0].quota?.consumed).toBe(1);
  });

  test("incomplete canonical recovery cannot bypass the capability through the legacy entry", async () => {
    const f = await interruptedKnownMain();
    expect(useTasks.getState().resumeGoalRound("synthetic", { mode: "goal", goalId: f.id, taskId: f.taskId })).toBeNull();
    expect((await listGoals())[0].quota?.active).toBe(false);
  });

  test("cross-await checkpoint mutation is atomically rejected at claim even with the same revision", async () => {
    const f = await interruptedKnownMain(), proof = await proofFor(f), db = state.db!;
    const handle = useTasks.getState().resumeGoalRound("synthetic", { mode: "goal", goalId: f.id, taskId: f.taskId }, proof)!;
    let mutated = false;
    state.db = { select: db.select, execute: async (sql, args) => {
      if (!mutated && sql.startsWith(GOAL_QUOTA_SQL.claim) && sql.includes("AND value=$8")) {
        mutated = true; await rewriteEnvelope(f.id, e => { e.rounds[0].task_checkpoint.goal = "synthetic changed checkpoint"; }, db);
      }
      return db.execute(sql, args);
    } };
    await expect(handle.prepare!()).rejects.toMatchObject({ code: "quota_denied" });
    state.db = db; expect(mutated).toBe(true);
    expect((await listGoals())[0].quota).toMatchObject({ consumed: 1, active: false });
  });

  test("checkpoint mutation after successful claim rejects bind and never publishes the new execution", async () => {
    const f = await interruptedKnownMain(), proof = await proofFor(f), db = state.db!;
    const handle = useTasks.getState().resumeGoalRound("synthetic", { mode: "goal", goalId: f.id, taskId: f.taskId }, proof)!;
    let mutated = false;
    state.db = { select: db.select, execute: async (sql, args) => {
      if (!mutated && sql.startsWith(GOAL_PUBLICATION_SQL.bind) && sql.includes("AND rounds=$19")) {
        mutated = true; await rewriteEnvelope(f.id, e => { e.rounds[0].task_checkpoint.goal = "synthetic changed after claim"; }, db);
      }
      return db.execute(sql, args);
    } };
    await expect(handle.prepare!()).rejects.toMatchObject({ code: "quota_denied" });
    state.db = db; expect(mutated).toBe(true);
    const g = (await listGoals())[0];
    expect(g.quota).toMatchObject({ consumed: 1, active: false });
    expect(g.quota?.execution?.executionId).toBe(f.oldExecutionId);
    expect(g.rounds[0].llm_settlements).toEqual([]);
  });

  test("a live competing owner acquired during recovery discovery is not implicitly paused", async () => {
    const f = await interruptedKnownMain();
    const original = useTasks.getState().prepareGoalRecovery;
    const foreign = { current: null as Awaited<ReturnType<typeof acquireGoalExecution>> };
    vi.spyOn(useTasks.getState(), "prepareGoalRecovery").mockImplementation(async (...args) => {
      const pending = await original(...args); foreign.current = await acquireGoalExecution(f.id, f.taskId, Date.now, pending.continuation); return pending;
    });
    const sp = vi.spyOn(engine, "createEngine");
    try {
      await goalRunner.run(f.id);
      const g = (await listGoals())[0];
      expect(g.status).toBe("running"); expect(g.quota?.active).toBe(true);
      expect(g.quota?.ownerId).toBe(foreign.current!.publication.ownerId);
      expect(sp).not.toHaveBeenCalled();
    } finally { await foreign.current?.release(); }
  });

  test("automatic exhaustion from a stale refreshed Goal cannot fail or revoke a new owner", async () => {
    const saved = await useGoals.getState().save({ description: "synthetic stale exhaustion", max_llm_calls: 1 });
    if (typeof saved === "string") throw Error(saved);
    expect(await useGoals.getState().start(saved.id)).toBeNull();
    const handle = useTasks.getState().runGoalRound("synthetic", { mode: "goal", goalId: saved.id });
    const first = (await handle.prepare!())!;
    await first.meter.invoke({ permitId: "permit-before-round", kind: "main", purpose: "plan" }, async () => "synthetic known output");
    await first.release(); await useGoals.getState().refresh(saved.id);
    const refresh = useGoals.getState().refresh, foreign = { current: null as Awaited<ReturnType<typeof acquireGoalExecution>> };
    vi.spyOn(useGoals.getState(), "refresh").mockImplementation(async id => {
      const stale = await refresh(id); foreign.current = await acquireGoalExecution(id, handle.taskId); return stale;
    });
    const sp = vi.spyOn(engine, "createEngine");
    try {
      await goalRunner.run(saved.id);
      const g = (await listGoals())[0];
      expect(g.status).toBe("running"); expect(g.quota?.active).toBe(true);
      expect(g.quota?.ownerId).toBe(foreign.current!.publication.ownerId);
      expect(g.quota?.consumed).toBe(1); expect(sp).not.toHaveBeenCalled();
    } finally { await foreign.current?.release(); }
  });

  test("an older completed terminal never replaces the latest unfinished run anchor", async () => {
    const f = await interruptedKnownMain();
    await rewriteEnvelope(f.id, e => {
      e.rounds[0].task_checkpoint.events.unshift(
        { type: "run_start", runId: "run-older-completed", goal: "synthetic older invocation" },
        { type: "run_end", status: "completed", summary: "synthetic older terminal" },
      ); e.revision++;
    });
    const proof = await proofFor(f), g = (await listGoals())[0];
    expect(goalContinuationSeed(proof, g)?.checkpoint.status).toBe("aborted");
    expect(g.rounds[0].task_checkpoint?.events.at(-1)).toMatchObject({ type: "llm" });
    expect(g.rounds[0].task_checkpoint?.recovery_accounting?.final).toBe(false);
  });

  test("known model permits preserve uncertain tool identity and regenerate arguments instead of declaring the effect safe", async () => {
    const f = await interruptedKnownMain();
    await rewriteEnvelope(f.id, e => {
      const step = { id: "step-1", goal: "synthetic effect awaiting probe", tool: "synthetic.write", args: { target: "synthetic.fixture", content: "synthetic content" } };
      e.rounds[0].task_checkpoint.events = e.rounds[0].task_checkpoint.events.map(x => x.type !== "plan" ? x : { ...x, plan: { ...x.plan, steps: [step] } });
      e.rounds[0].task_checkpoint.events.push({ type: "step_start", step, attempt: 1, invocationId: "inv-synthetic-effect", idempotencyKey: "synthetic-digest-key" });
      e.revision++;
    });
    const proof = await proofFor(f), seed = goalContinuationSeed(proof, (await listGoals())[0])!;
    expect(seed.checkpoint.uncertainSteps).toHaveLength(1);
    expect(seed.checkpoint.plan.steps[0].args).toBeUndefined();
    expect(seed.checkpoint.records[0]).toMatchObject({ invocationId: "inv-synthetic-effect", idempotencyKey: "synthetic-digest-key", executionState: "unknown" });
    expect((await listGoals())[0].rounds[0].llm_settlements).toEqual([]);
  });

  test.each(["main", "local_decision", "cloud_decision", "goal_verifier"] as const)("unknown %s anywhere in the canonical authority blocks continuation", async kind => {
    const f = await interruptedKnownMain(), session = (await acquireGoalExecution(f.id, f.taskId, Date.now, await proofFor(f)))!;
    const purpose = kind === "main" ? "answer" : kind === "goal_verifier" ? "check_done" : "decision";
    await expect(session.meter.invoke({ permitId: "permit-unknown-role", kind, purpose }, async () => { throw Error("synthetic unknown"); })).rejects.toMatchObject({ code: "quota_outcome_unknown" });
    expect(await prepareGoalContinuation(f.id, f.taskId)).toBeNull();
    expect((await listGoals())[0].quota).toMatchObject({ consumed: 2, unknown: 1, active: false });
    await session.release();
  });

  test("a pending canonical request blocks proof before the synthetic transport settles", async () => {
    const f = await interruptedKnownMain(), session = (await acquireGoalExecution(f.id, f.taskId, Date.now, await proofFor(f)))!;
    let release!: () => void;
    const invoked = session.meter.invoke({ permitId: "permit-still-pending", kind: "main", purpose: "answer" }, () => new Promise<string>(resolve => { release = () => resolve("synthetic terminal"); }));
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    try {
      expect(await prepareGoalContinuation(f.id, f.taskId)).toBeNull();
      expect((await listGoals())[0].quota?.pending).toBe(1);
    } finally { release(); await invoked; await session.release(); }
  });

  test("zero remaining canonical budget cannot create a continuation capability", async () => {
    const f = await interruptedKnownMain("known", 1);
    expect(await prepareGoalContinuation(f.id, f.taskId)).toBeNull();
    expect((await listGoals())[0].quota?.consumed).toBe(1);
  });

  test("missing plan, wrong raw checkpoint mode, and legacy rounds never grant the V1 continuation path", async () => {
    const f = await interruptedKnownMain();
    await rewriteEnvelope(f.id, e => { e.rounds[0].task_checkpoint.events = e.rounds[0].task_checkpoint.events.filter(x => x.type !== "plan"); e.revision++; });
    expect(await prepareGoalContinuation(f.id, f.taskId)).toBeNull();
    await rewriteEnvelope(f.id, e => { e.rounds[0].task_checkpoint.mode = "quick"; e.revision++; });
    expect(await prepareGoalContinuation(f.id, f.taskId)).toBeNull();
    await state.db!.execute("UPDATE goals SET rounds=$1 WHERE id=$2", ["[]", f.id]);
    expect(await prepareGoalContinuation(f.id, f.taskId)).toBeNull();
  });
});

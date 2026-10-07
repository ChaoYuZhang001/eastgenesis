// 独立进程故障窗口夹具：模拟真实运行时在副作用已落地、最终账本提交前被 SIGKILL。
// 仅供 tests/invocation-crash-process.test.ts 调用，不是产品启动入口。
import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { DecisionLayer } from "@/decision/decision-layer";
import { applyGoalChange, newGoal, normalizeGoal, parseRounds, type Goal } from "@/decision/goal";
import { recoveryCheckpoint } from "@/lib/recovery";
import type { StoredTurn } from "@/decision/session";
import { AgentRuntime } from "@/agent/runtime";
import { makeToolInvocation } from "@/agent";
import type { AgentEvent, InvocationLedger, InvocationLedgerRecord, InvocationLeaseResult, PlanStep, Tool } from "@/agent";
import { ToolRegistry } from "@/agent/tools";
import { INVOCATION_SQL } from "@/lib/db-invocation";
import { readMigrations } from "./sqlite-helper";

type Row = Record<string, unknown>;
type Db = { exec(sql: string): void; prepare(sql: string): { get(params: Record<string, unknown>): Row | undefined; run(params: Record<string, unknown>): { changes: number | bigint } }; close(): void };

const [, , mode, dbPath, artifactPath] = process.argv;
if (!mode || !dbPath || !artifactPath || !["crash", "recover", "crash-stale", "recover-stale", "recover-read-error"].includes(mode)) throw new Error("故障 worker 参数无效");
const isCrash = mode === "crash" || mode === "crash-stale";
const readErrorRecovery = mode === "recover-read-error";
const staleCheckpoint = mode === "crash-stale" || mode === "recover-stale" || readErrorRecovery;

const db = new DatabaseSync(dbPath) as unknown as Db;
db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
try {
  db.prepare("SELECT value FROM app_meta WHERE key = 'schema_version'").get({});
} catch {
  for (const migration of readMigrations()) db.exec(migration.sql);
}

const rowToRecord = (row: Row | undefined): InvocationLedgerRecord | null => {
  if (!row) return null;
  let artifacts: InvocationLedgerRecord["artifacts"] = [];
  try { artifacts = JSON.parse(String(row.artifacts ?? "[]")) as InvocationLedgerRecord["artifacts"]; } catch { /* malformed evidence is treated as empty */ }
  return {
    taskId: String(row.task_id), stepId: String(row.step_id), invocationId: String(row.invocation_id), idempotencyKey: String(row.idempotency_key),
    tool: String(row.tool), argsDigest: String(row.args_digest), attempt: Number(row.attempt), state: row.state as InvocationLedgerRecord["state"], artifacts,
    ...(row.detail ? { detail: String(row.detail) } : {}), ...(row.lease_owner ? { leaseOwner: String(row.lease_owner) } : {}),
    ...(row.lease_expires_at !== null && row.lease_expires_at !== undefined ? { leaseExpiresAt: Number(row.lease_expires_at) } : {}),
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
  };
};
const bind = (values: unknown[]) => Object.fromEntries(values.map((value, index) => [`$${index + 1}`, value === undefined ? null : value]));

const GOAL_ID = "goal-process-crash";
const TASK_ID = "task-process-crash-window";
const TASK_ROW_SQL = "SELECT state, lease_owner, lease_expires_at FROM tool_invocations WHERE task_id = $1 AND step_id = $2";
const GOAL_SELECT = "SELECT id, project_id, description, instructions, routing_preference, status, rounds, max_llm_calls, used_llm_calls, created_at, updated_at FROM goals WHERE id = $1";
const GOAL_UPSERT = "INSERT INTO goals (id, project_id, description, instructions, routing_preference, status, rounds, max_llm_calls, used_llm_calls, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT(id) DO UPDATE SET description=excluded.description, instructions=excluded.instructions, routing_preference=excluded.routing_preference, status=excluded.status, rounds=excluded.rounds, max_llm_calls=excluded.max_llm_calls, used_llm_calls=excluded.used_llm_calls, updated_at=excluded.updated_at";
const saveGoal = (g: Goal) => db.prepare(GOAL_UPSERT).run(bind([g.id, g.project_id, g.description, g.instructions, g.routing_preference, g.status, JSON.stringify(g.rounds), g.max_llm_calls, g.used_llm_calls, g.created_at, g.updated_at]));
const readGoal = (): Goal => {
  const row = db.prepare(GOAL_SELECT).get(bind([GOAL_ID]));
  if (!row) throw new Error("目标 checkpoint 不存在");
  const rounds = parseRounds(String(row.rounds));
  if (!rounds) throw new Error("目标 checkpoint 损坏");
  return {
    id: String(row.id), project_id: row.project_id === null ? null : String(row.project_id), description: String(row.description),
    instructions: String(row.instructions ?? ""), routing_preference: row.routing_preference === null ? null : row.routing_preference as Goal["routing_preference"],
    status: row.status as Goal["status"], rounds, max_llm_calls: Number(row.max_llm_calls), used_llm_calls: Number(row.used_llm_calls),
    created_at: Number(row.created_at), updated_at: Number(row.updated_at),
  };
};
const initialCheckpoint = (task: PlanStep, idempotencyKey = "pending"): StoredTurn => ({
  id: TASK_ID, seq: 1, goal: "写入故障夹具 marker", status: "running", summary: null,
  events: [
    { type: "run_start", runId: "run-process-crash", goal: "写入故障夹具 marker" },
    { type: "plan", plan: { source: "llm", steps: [task] }, revision: 1 },
    ...(!staleCheckpoint ? [{ type: "step_start", step: task, attempt: 1, invocationId: `${TASK_ID}:s1:1`, idempotencyKey }] : []),
  ],
  lock: null, permission: "confirm", files: [], multi: false, startedAt: 100, endedAt: null, goalId: GOAL_ID,
  mode: "goal", preference: "balanced", preferenceSource: "global", surfaceHint: null,
});
let sqliteReadFaultObserved = false;
let readFaultAttempted = false;
const ledger: InvocationLedger = {
  get: async (key) => {
    if (readErrorRecovery && !readFaultAttempted) {
      readFaultAttempted = true;
      // A connection-local fixture shadows only this SELECT. The main durable
      // row is untouched, and later writes/claims could succeed after cleanup.
      db.exec("CREATE TEMP TABLE tool_invocations(fixture_only INTEGER)");
      try { return rowToRecord(db.prepare(INVOCATION_SQL.get).get(bind([key]))); }
      catch (error) { sqliteReadFaultObserved = true; throw error; }
      finally { db.exec("DROP TABLE temp.tool_invocations"); }
    }
    return rowToRecord(db.prepare(INVOCATION_SQL.get).get(bind([key])));
  },
  put: async (record) => {
    db.prepare(INVOCATION_SQL.put).run(bind([
      record.idempotencyKey, record.taskId, record.stepId, record.invocationId, record.tool, record.argsDigest, record.attempt, record.state,
      JSON.stringify(record.artifacts), record.detail ?? "", record.leaseOwner ?? null, record.leaseExpiresAt ?? null, record.createdAt, record.updatedAt,
    ]));
  },
  claim: async (key, owner, now, ttlMs): Promise<InvocationLeaseResult> => {
    const result = db.prepare(INVOCATION_SQL.claim).run(bind([key, owner, now + ttlMs, now]));
    if (Number(result.changes) > 0) return "acquired";
    const current = await ledger.get(key);
    if (!current) return "missing";
    if (current.state === "applied" || current.state === "conflict") return "terminal";
    return "busy";
  },
  renew: async (key, owner, now, ttlMs) => Number(db.prepare(INVOCATION_SQL.renew).run(bind([key, owner, now + ttlMs])).changes) > 0,
  release: async (key, owner) => { db.prepare(INVOCATION_SQL.release).run(bind([key, owner])); },
};

const ENV = { OPENAI_API_KEY: "synthetic" };
const planStep: PlanStep = { id: "s1", goal: "写入故障夹具 marker", tool: "write_marker", args: { path: artifactPath, content: "applied" } };
let runCalls = 0;
let probeCalls = 0;
let confirmCalls = 0;
const tool: Tool = {
  name: "write_marker", description: "写入故障夹具 marker", sideEffect: "local_write",
  run: async () => {
    runCalls++;
    writeFileSync(artifactPath, "applied\n", "utf8");
    return { ok: true, content: "marker 已写入" };
  },
  probe: async () => {
    probeCalls++;
    try {
      return readFileSync(artifactPath, "utf8").trim() === "applied"
        ? { state: "applied" as const, detail: "恢复探测确认 marker 已落地" }
        : { state: "not_applied" as const, detail: "marker 尚未落地" };
    } catch {
      return { state: "not_applied" as const, detail: "marker 尚未落地" };
    }
  },
};
const registry = new ToolRegistry([tool]);
const decision = DecisionLayer.fromEnv(ENV, { tools: registry.defs() });
const runtime = new AgentRuntime({
  decision,
  tools: registry,
  llm: () => async (request) => {
    if (request.purpose === "plan") return { text: JSON.stringify({ steps: [planStep] }), profileId: "synthetic/planner", latencyMs: 0, usage: null };
    return { text: "恢复完成", profileId: "synthetic/summary", latencyMs: 0, usage: null };
  },
  confirm: async () => { confirmCalls++; return true; },
  ledger,
  now: () => (isCrash ? 100 : 111),
  ledgerLeaseMs: 10,
  ...(isCrash ? { faultHooks: { onPoint: ({ point }: { point: string }) => { if (point === "after_tool_before_ledger_commit") process.kill(process.pid, "SIGKILL"); } } } : {}),
});

let goal: Goal;
if (isCrash) {
  goal = newGoal(normalizeGoal({ description: "写入故障夹具 marker" }), 100, GOAL_ID);
  goal = applyGoalChange(goal, { op: "transition", to: "running" }, 101);
  goal = applyGoalChange(goal, { op: "start_round", plan: { title: "写入 marker", items: [planStep.goal], task_id: TASK_ID } }, 102);
  const invocation = makeToolInvocation({ taskId: TASK_ID, stepId: planStep.id, attempt: 1, tool, args: planStep.args ?? {} });
  goal = applyGoalChange(goal, { op: "checkpoint_round", task: initialCheckpoint(planStep, invocation.idempotencyKey) }, 103);
  saveGoal(goal);
} else {
  goal = readGoal();
  goal = applyGoalChange(goal, { op: "recover_after_restart" }, 111);
  const checkpoint = goal.rounds.at(-1)?.task_checkpoint;
  if (!checkpoint || checkpoint.id !== TASK_ID) throw new Error("恢复时没有找到原任务 checkpoint");
  // persisted checkpoint is from just before the tool call; synthesize the process-exit edge
  // so recoveryCheckpoint marks the step unknown and AgentRuntime asks the ledger to probe it.
  const events = [...(checkpoint.events as AgentEvent[]), { type: "run_end", status: "aborted", summary: "进程在工具账本提交前退出" } satisfies AgentEvent];
  const resume = recoveryCheckpoint(events);
  if (!resume) throw new Error("无法从目标 checkpoint 生成恢复状态");
  if (staleCheckpoint && resume.records.length !== 0) throw new Error("落后 checkpoint 夹具应仅有计划");
  // 生产恢复不会复用事件中的参数：由恢复规划阶段重新生成本次夹具的安全参数。
  // 这里用固定 planStep 代替规划模型，确保恢复仍然使用与第一次相同的幂等键。
  resume.plan = { ...resume.plan, steps: [planStep] };
  resume.failedStep = planStep;
  resume.records = resume.records.map((record) => ({ ...record, step: planStep }));
  goal = applyGoalChange(goal, { op: "transition", to: "running" }, 112);
  goal = applyGoalChange(goal, { op: "resume_round" }, 113);
  saveGoal(goal);
  const result = await runtime.run("写入故障夹具 marker", { taskId: TASK_ID, resume });
  if (staleCheckpoint) {
    // This synthetic older-shape checkpoint predates the durable side effect.
    // The real ledger survived SIGKILL; regenerated arguments alone must not
    // supply the missing original identity or permit another tool invocation.
    if (result.status !== "needs_user") throw new Error("落后 checkpoint 未停止自动恢复");
    const missingOriginalIdentity = result.summary.includes("缺少可验证的原始身份") && result.events.some((event) =>
      event.type === "probe" && event.state === "unknown" && event.detail.includes("缺少可验证的原始身份"));
    const failedReadStopped = sqliteReadFaultObserved && result.summary === "无法读取工具调用账本，已停止执行；请检查本地存储后再试"
      && result.events.every((event) => event.type !== "gate" && event.type !== "tool_result");
    if (!(readErrorRecovery ? failedReadStopped : missingOriginalIdentity)) throw new Error("落后 checkpoint 的实际恢复原因不匹配");
    goal = applyGoalChange(goal, { op: "transition", to: "paused" }, 114);
    saveGoal(goal);
    const ledgerRow = db.prepare(TASK_ROW_SQL).get({ $1: TASK_ID, $2: "s1" });
    process.stdout.write(JSON.stringify({ status: result.status, runCalls, probeCalls, confirmCalls, goalStatus: goal.status,
      taskId: goal.rounds.at(-1)?.task_id, roundCount: goal.rounds.length, ledgerState: ledgerRow?.state,
      checkpointRecords: resume.records.length, reasonCategory: readErrorRecovery ? "ledger_read_failed" : "missing_original_identity",
      ...(readErrorRecovery ? { sqliteReadFaultObserved } : {}) }) + "\n");
    db.close();
    process.exit(0);
  }
  if (result.status !== "completed") throw new Error(`恢复任务未完成：${result.status} ${result.summary}`);
  goal = applyGoalChange(goal, { op: "set_round_items", items: [{ text: planStep.goal, status: "done" }] }, 114);
  goal = applyGoalChange(goal, { op: "finish_round", result: { verdict: "done", reason: "恢复后 ledger probe 确认副作用已落地", by: "rules" } }, 115);
  saveGoal(goal);
  const ledgerRow = db.prepare(TASK_ROW_SQL).get({ $1: TASK_ID, $2: "s1" });
  writeFileSync(`${dbPath}.${mode}.result.json`, JSON.stringify({ status: result.status, runCalls, goalStatus: goal.status, taskId: goal.rounds.at(-1)?.task_id, ledgerState: ledgerRow?.state }), "utf8");
  if (existsSync(`${dbPath}.${mode}.result.json`)) process.stdout.write(JSON.stringify({ status: result.status, runCalls, goalStatus: goal.status, taskId: goal.rounds.at(-1)?.task_id, ledgerState: ledgerRow?.state }) + "\n");
  db.close();
  process.exit(0);
}

const result = await runtime.run("写入故障夹具 marker", { taskId: TASK_ID });
writeFileSync(`${dbPath}.${mode}.result.json`, JSON.stringify({ status: result.status, runCalls, summary: result.summary }), "utf8");
if (existsSync(`${dbPath}.${mode}.result.json`)) process.stdout.write(JSON.stringify({ status: result.status, runCalls }) + "\n");
db.close();

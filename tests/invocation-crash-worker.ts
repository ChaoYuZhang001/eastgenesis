// 独立进程故障窗口夹具：模拟真实运行时在副作用已落地、最终账本提交前被 SIGKILL。
// 仅供 tests/invocation-crash-process.test.ts 调用，不是产品启动入口。
import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { DecisionLayer } from "@/decision/decision-layer";
import { AgentRuntime } from "@/agent/runtime";
import type { InvocationLedger, InvocationLedgerRecord, InvocationLeaseResult, PlanStep, Tool } from "@/agent";
import { ToolRegistry } from "@/agent/tools";
import { INVOCATION_SQL } from "@/lib/db-invocation";
import { readMigrations } from "./sqlite-helper";

type Row = Record<string, unknown>;
type Db = { exec(sql: string): void; prepare(sql: string): { get(params: Record<string, unknown>): Row | undefined; run(params: Record<string, unknown>): { changes: number | bigint } }; close(): void };

const [, , mode, dbPath, artifactPath] = process.argv;
if (!mode || !dbPath || !artifactPath || (mode !== "crash" && mode !== "recover")) throw new Error("故障 worker 参数应为 crash|recover <db> <artifact>");

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
const ledger: InvocationLedger = {
  get: async (key) => rowToRecord(db.prepare(INVOCATION_SQL.get).get(bind([key]))),
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
const tool: Tool = {
  name: "write_marker", description: "写入故障夹具 marker", sideEffect: "local_write",
  run: async () => {
    runCalls++;
    writeFileSync(artifactPath, "applied\n", "utf8");
    return { ok: true, content: "marker 已写入" };
  },
  probe: async () => {
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
  confirm: async () => true,
  ledger,
  now: () => (mode === "crash" ? 100 : 111),
  ledgerLeaseMs: 10,
  ...(mode === "crash" ? { faultHooks: { onPoint: ({ point }: { point: string }) => { if (point === "after_tool_before_ledger_commit") process.kill(process.pid, "SIGKILL"); } } } : {}),
});

const result = mode === "crash"
  ? await runtime.run("写入故障夹具 marker", { taskId: "process-crash-window" })
  : await runtime.run("写入故障夹具 marker", {
      taskId: "process-crash-window",
      resume: { plan: { steps: [planStep], source: "llm" }, records: [{ step: planStep, status: "failed", attempts: 1, executionState: "unknown" }], nextStepIndex: 0 },
    });
writeFileSync(`${dbPath}.${mode}.result.json`, JSON.stringify({ status: result.status, runCalls, summary: result.summary }), "utf8");
if (existsSync(`${dbPath}.${mode}.result.json`)) process.stdout.write(JSON.stringify({ status: result.status, runCalls }) + "\n");
db.close();

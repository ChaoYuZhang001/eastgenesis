// 跨重启工具调用账本（迁移 6/7）：不保存工具正文，只保存幂等键、参数摘要、状态、租约和产物引用。
// 账本是恢复证据，不是权限边界；真正执行仍要经过 DecisionLayer 和 MCP/Rust 沙箱。
import type { ArtifactRef, InvocationLedgerRecord, InvocationLedgerState, InvocationLeaseResult } from "@/agent";
import { withDb } from "./db";

const STATES = new Set<InvocationLedgerState>(["planned", "started", "applied", "not_applied", "unknown", "conflict"]);
const KINDS = new Set<ArtifactRef["kind"]>(["file", "command", "external"]);
const ACTIONS = new Set<ArtifactRef["action"]>(["read", "create", "modify", "move", "delete", "execute", "request"]);

export const INVOCATION_SQL = {
  get: "SELECT idempotency_key, task_id, step_id, invocation_id, tool, args_digest, attempt, state, artifacts, detail, lease_owner, lease_expires_at, created_at, updated_at FROM tool_invocations WHERE idempotency_key = $1",
  put:
    "INSERT INTO tool_invocations (idempotency_key, task_id, step_id, invocation_id, tool, args_digest, attempt, state, artifacts, detail, lease_owner, lease_expires_at, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) ON CONFLICT(idempotency_key) DO UPDATE SET task_id = excluded.task_id, step_id = excluded.step_id, invocation_id = excluded.invocation_id, tool = excluded.tool, args_digest = excluded.args_digest, attempt = excluded.attempt, state = CASE WHEN tool_invocations.state IN ('applied', 'conflict') THEN tool_invocations.state WHEN tool_invocations.lease_owner IS NOT NULL AND excluded.lease_owner IS NULL THEN tool_invocations.state WHEN tool_invocations.lease_owner IS NOT NULL AND excluded.lease_owner IS NOT NULL AND tool_invocations.lease_owner <> excluded.lease_owner THEN tool_invocations.state ELSE excluded.state END, artifacts = CASE WHEN tool_invocations.state IN ('applied', 'conflict') THEN tool_invocations.artifacts WHEN tool_invocations.lease_owner IS NOT NULL AND excluded.lease_owner IS NULL THEN tool_invocations.artifacts WHEN tool_invocations.lease_owner IS NOT NULL AND excluded.lease_owner IS NOT NULL AND tool_invocations.lease_owner <> excluded.lease_owner THEN tool_invocations.artifacts ELSE excluded.artifacts END, detail = CASE WHEN tool_invocations.state IN ('applied', 'conflict') THEN tool_invocations.detail WHEN tool_invocations.lease_owner IS NOT NULL AND excluded.lease_owner IS NULL THEN tool_invocations.detail WHEN tool_invocations.lease_owner IS NOT NULL AND excluded.lease_owner IS NOT NULL AND tool_invocations.lease_owner <> excluded.lease_owner THEN tool_invocations.detail ELSE excluded.detail END, lease_owner = CASE WHEN excluded.state IN ('applied', 'conflict') THEN NULL WHEN tool_invocations.state IN ('applied', 'conflict') THEN NULL WHEN tool_invocations.lease_owner IS NOT NULL AND excluded.lease_owner IS NULL THEN tool_invocations.lease_owner WHEN tool_invocations.lease_owner IS NOT NULL AND excluded.lease_owner IS NOT NULL AND tool_invocations.lease_owner <> excluded.lease_owner THEN tool_invocations.lease_owner ELSE excluded.lease_owner END, lease_expires_at = CASE WHEN excluded.state IN ('applied', 'conflict') THEN NULL WHEN tool_invocations.state IN ('applied', 'conflict') THEN NULL WHEN tool_invocations.lease_owner IS NOT NULL AND excluded.lease_owner IS NULL THEN tool_invocations.lease_expires_at WHEN tool_invocations.lease_owner IS NOT NULL AND excluded.lease_owner IS NOT NULL AND tool_invocations.lease_owner <> excluded.lease_owner THEN tool_invocations.lease_expires_at ELSE excluded.lease_expires_at END, created_at = tool_invocations.created_at, updated_at = excluded.updated_at",
  claim: "UPDATE tool_invocations SET lease_owner = $2, lease_expires_at = $3 WHERE idempotency_key = $1 AND state NOT IN ('applied', 'conflict') AND (lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= $4 OR lease_owner = $2)",
  renew: "UPDATE tool_invocations SET lease_expires_at = $3 WHERE idempotency_key = $1 AND lease_owner = $2 AND state NOT IN ('applied', 'conflict')",
  release: "UPDATE tool_invocations SET lease_owner = NULL, lease_expires_at = NULL WHERE idempotency_key = $1 AND lease_owner = $2",
} as const;

type Row = {
  idempotency_key: string;
  task_id: string;
  step_id: string;
  invocation_id: string;
  tool: string;
  args_digest: string;
  attempt: number;
  state: string;
  artifacts: string;
  detail: string;
  lease_owner: string | null;
  lease_expires_at: number | null;
  created_at: number;
  updated_at: number;
};

function refs(raw: string): ArtifactRef[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item): ArtifactRef[] => {
      if (!item || typeof item !== "object") return [];
      const x = item as Record<string, unknown>;
      if (!KINDS.has(x.kind as ArtifactRef["kind"]) || !ACTIONS.has(x.action as ArtifactRef["action"]) || typeof x.ok !== "boolean") return [];
      return [{
        kind: x.kind as ArtifactRef["kind"],
        action: x.action as ArtifactRef["action"],
        ...(typeof x.path === "string" ? { path: x.path.slice(0, 2000) } : {}),
        ...(typeof x.to === "string" ? { to: x.to.slice(0, 2000) } : {}),
        ...(typeof x.command === "string" ? { command: x.command.slice(0, 2000) } : {}),
        ok: x.ok,
      }];
    });
  } catch {
    return [];
  }
}

function fromRow(row: Row): InvocationLedgerRecord | null {
  if (!row || !STATES.has(row.state as InvocationLedgerState) || !Number.isInteger(Number(row.attempt)) || Number(row.attempt) < 1) return null;
  const leaseExpiresAt = row.lease_expires_at === null || row.lease_expires_at === undefined ? null : Number(row.lease_expires_at);
  return {
    taskId: String(row.task_id).slice(0, 200),
    stepId: String(row.step_id).slice(0, 200),
    invocationId: String(row.invocation_id).slice(0, 300),
    idempotencyKey: String(row.idempotency_key).slice(0, 300),
    tool: String(row.tool).slice(0, 128),
    argsDigest: String(row.args_digest).slice(0, 128),
    attempt: Number(row.attempt),
    state: row.state as InvocationLedgerState,
    artifacts: refs(String(row.artifacts ?? "[]")),
    ...(row.detail ? { detail: String(row.detail).slice(0, 1000) } : {}),
    ...(row.lease_owner ? { leaseOwner: String(row.lease_owner).slice(0, 200) } : {}),
    ...(leaseExpiresAt !== null && Number.isFinite(leaseExpiresAt) ? { leaseExpiresAt } : {}),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export async function getToolInvocation(idempotencyKey: string): Promise<InvocationLedgerRecord | null> {
  if (!idempotencyKey || idempotencyKey.length > 300) return null;
  return withDb(async (db) => {
    const [row] = await db.select<Row[]>(INVOCATION_SQL.get, [idempotencyKey]);
    return row ? fromRow(row) : null;
  });
}

export async function saveToolInvocation(record: InvocationLedgerRecord): Promise<void> {
  if (!record.idempotencyKey || !STATES.has(record.state)) return;
  const artifacts = JSON.stringify(record.artifacts.slice(0, 32));
  await withDb((db) => db.execute(INVOCATION_SQL.put, [
    record.idempotencyKey,
    record.taskId,
    record.stepId,
    record.invocationId,
    record.tool,
    record.argsDigest,
    record.attempt,
    record.state,
    artifacts,
    record.detail ?? "",
    record.leaseOwner ?? null,
    record.leaseExpiresAt ?? null,
    record.createdAt,
    record.updatedAt,
  ]).then(() => undefined));
}

export async function claimToolInvocation(idempotencyKey: string, owner: string, now: number, ttlMs: number): Promise<InvocationLeaseResult> {
  if (!idempotencyKey || !owner || !Number.isFinite(now) || !Number.isFinite(ttlMs) || ttlMs <= 0) return "missing";
  return withDb(async (db) => {
    const result = await db.execute(INVOCATION_SQL.claim, [idempotencyKey, owner.slice(0, 200), now + ttlMs, now]);
    if (Number((result as { rowsAffected?: number }).rowsAffected ?? 0) > 0) return "acquired";
    const [row] = await db.select<Row[]>(INVOCATION_SQL.get, [idempotencyKey]);
    if (!row) return "missing";
    if (row.state === "applied" || row.state === "conflict") return "terminal";
    return "busy";
  });
}

export async function renewToolInvocation(idempotencyKey: string, owner: string, now: number, ttlMs: number): Promise<boolean> {
  if (!idempotencyKey || !owner || !Number.isFinite(now) || !Number.isFinite(ttlMs) || ttlMs <= 0) return false;
  return withDb(async (db) => {
    const result = await db.execute(INVOCATION_SQL.renew, [idempotencyKey, owner.slice(0, 200), now + ttlMs]);
    return Number((result as { rowsAffected?: number }).rowsAffected ?? 0) > 0;
  });
}

export async function releaseToolInvocation(idempotencyKey: string, owner: string): Promise<void> {
  if (!idempotencyKey || !owner) return;
  await withDb((db) => db.execute(INVOCATION_SQL.release, [idempotencyKey, owner.slice(0, 200)]).then(() => undefined));
}

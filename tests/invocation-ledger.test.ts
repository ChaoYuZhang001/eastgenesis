// @vitest-environment node
// 跨进程调用账本的 SQL 契约：迁移和 tauri-plugin-sql 参数绑定都在这里走一遍。
import { asDb, loadSqlite, migratedDb } from "./sqlite-helper";
import { INVOCATION_SQL } from "@/lib/db-invocation";

const sqlite = await loadSqlite();

describe.skipIf(!sqlite)("工具调用账本", () => {
  it("写入、读取，并保护 applied/conflict 终态不被旧状态覆盖", async () => {
    const raw = migratedDb(sqlite!);
    const db = asDb(() => raw);
    const base = [
      "eg-ledger-1", "task-1", "s1", "task-1:s1:1", "write_file", "deadbeef", 1, "started", JSON.stringify([{ kind: "file", action: "modify", path: "out.md", ok: false }]), "", null, null, 10, 10,
    ];
    await db.execute(INVOCATION_SQL.put, base);
    expect(await db.select<Record<string, unknown>[]>(INVOCATION_SQL.get, ["eg-ledger-1"])).toEqual([expect.objectContaining({ state: "started", attempt: 1, artifacts: JSON.stringify([{ kind: "file", action: "modify", path: "out.md", ok: false }]) })]);

    expect(await db.execute(INVOCATION_SQL.claim, ["eg-ledger-1", "owner-a", 100, 10])).toMatchObject({ rowsAffected: 1 });
    expect(await db.execute(INVOCATION_SQL.claim, ["eg-ledger-1", "owner-b", 200, 20])).toMatchObject({ rowsAffected: 0 });
    expect(await db.select<Record<string, unknown>[]>(INVOCATION_SQL.get, ["eg-ledger-1"])).toEqual([expect.objectContaining({ lease_owner: "owner-a", lease_expires_at: 100 })]);
    expect(await db.execute(INVOCATION_SQL.claim, ["eg-ledger-1", "owner-b", 100, 100])).toMatchObject({ rowsAffected: 1 });
    await db.execute(INVOCATION_SQL.put, [...base.slice(0, 7), "started", "[]", "仍在执行", "owner-b", 220, 10, 20]);
    expect(await db.select<Record<string, unknown>[]>(INVOCATION_SQL.get, ["eg-ledger-1"])).toEqual([expect.objectContaining({ lease_owner: "owner-b", lease_expires_at: 220, detail: "仍在执行" })]);
    expect(await db.execute(INVOCATION_SQL.renew, ["eg-ledger-1", "owner-b", 250])).toMatchObject({ rowsAffected: 1 });
    expect(await db.execute(INVOCATION_SQL.renew, ["eg-ledger-1", "owner-a", 300])).toMatchObject({ rowsAffected: 0 });
    expect(await db.select<Record<string, unknown>[]>(INVOCATION_SQL.get, ["eg-ledger-1"])).toEqual([expect.objectContaining({ lease_owner: "owner-b", lease_expires_at: 250 })]);
    await db.execute(INVOCATION_SQL.release, ["eg-ledger-1", "owner-b"]);
    expect(await db.select<Record<string, unknown>[]>(INVOCATION_SQL.get, ["eg-ledger-1"])).toEqual([expect.objectContaining({ lease_owner: null, lease_expires_at: null })]);

    await db.execute(INVOCATION_SQL.put, [...base.slice(0, 7), "applied", JSON.stringify([{ kind: "file", action: "modify", path: "out.md", ok: true }]), "写入成功", "owner-a", 100, 10, 20]);
    await db.execute(INVOCATION_SQL.put, [...base.slice(0, 7), "started", "[]", "不应覆盖", "owner-b", 100, 10, 30]);
    expect(await db.select<Record<string, unknown>[]>(INVOCATION_SQL.get, ["eg-ledger-1"])).toEqual([expect.objectContaining({ state: "applied", detail: "写入成功", updated_at: 30 })]);

    await db.execute(INVOCATION_SQL.put, [
      "eg-ledger-2", "task-1", "s2", "task-1:s2:1", "delete_file", "cafebabe", 1, "conflict", "[]", "需要用户判断", null, null, 11, 11,
    ]);
    await db.execute(INVOCATION_SQL.put, [
      "eg-ledger-2", "task-1", "s2", "task-1:s2:1", "delete_file", "cafebabe", 1, "not_applied", "[]", "覆盖尝试", "owner-b", 100, 11, 12,
    ]);
    expect(await db.select<Record<string, unknown>[]>(INVOCATION_SQL.get, ["eg-ledger-2"])).toEqual([expect.objectContaining({ state: "conflict", detail: "需要用户判断" })]);
  });

  it("拒绝无效的重试次数和状态", async () => {
    const raw = migratedDb(sqlite!);
    expect(() => raw.exec("INSERT INTO tool_invocations (idempotency_key, task_id, step_id, invocation_id, tool, args_digest, attempt, state, created_at, updated_at) VALUES ('bad-a', 't', 's', 'i', 'tool', 'x', 0, 'planned', 1, 1)" )).toThrow(/CHECK/);
    expect(() => raw.exec("INSERT INTO tool_invocations (idempotency_key, task_id, step_id, invocation_id, tool, args_digest, attempt, state, created_at, updated_at) VALUES ('bad-b', 't', 's', 'i', 'tool', 'x', 1, 'running', 1, 1)" )).toThrow(/CHECK/);
  });
});

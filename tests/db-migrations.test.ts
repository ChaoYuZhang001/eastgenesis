// @vitest-environment node
// 迁移：真实执行 eg-core 的迁移 SQL（node:sqlite 内存库），检查表结构、约束和从版本 3 升级。
// 桌面端由 tauri-plugin-sql 执行同一份 SQL；Mac 上首次启动后「设置 › 关于 › 版本」应显示数据库结构版本 7。
import { SCHEMA_VERSION } from "@/lib/db";
import { loadSqlite, migratedDb, readMigrations, type RawDb } from "./sqlite-helper";

const sqlite = await loadSqlite();
const cols = (db: RawDb, table: string) => (db.prepare(`PRAGMA table_info(${table})`).all({}) as { name: string }[]).map((c) => c.name);
const version = (db: RawDb) => (db.prepare("SELECT value FROM app_meta WHERE key = 'schema_version'").get({}) as { value: string }).value;

describe("迁移列表", () => {
  it("从 lib.rs 读出的版本连续，最后一条等于 SCHEMA_VERSION", () => {
    const ms = readMigrations();
    expect(ms.map((m) => m.version)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(ms.at(-1)).toMatchObject({ version: SCHEMA_VERSION, name: "add_tool_invocation_leases" });
    // 续行符已去掉，SQL 里没有 Rust 转义残留
    for (const m of ms) expect(m.sql).not.toMatch(/\\$|\\\n/m);
  });
});

describe.skipIf(!sqlite)("迁移 SQL（node:sqlite）", () => {
  it("新库执行全部迁移：结构版本 7，各表的列齐全", () => {
    const db = migratedDb(sqlite!);
    expect(version(db)).toBe("7");
    expect(cols(db, "sessions")).toEqual(["id", "project_id", "title", "turns", "created_at", "updated_at", "deleted_at"]);
    expect(cols(db, "usage_calls")).toEqual(["id", "session_id", "task_id", "goal_id", "project_id", "profile_id", "input_tokens", "output_tokens", "baseline_profile_id", "created_at"]);
    expect(cols(db, "projects")).toEqual(["id", "name", "description", "instructions", "context_folders", "routing_preference", "archived", "created_at", "updated_at", "deleted_at"]);
    expect(cols(db, "goals")).toEqual([
      "id", "project_id", "description", "instructions", "routing_preference", "status", "rounds", "max_llm_calls", "used_llm_calls", "created_at", "updated_at", "deleted_at",
    ]);
    expect(cols(db, "memories").slice(-2)).toEqual(["project_id", "deleted_at"]);
    expect(cols(db, "tool_invocations")).toEqual([
      "idempotency_key", "task_id", "step_id", "invocation_id", "tool", "args_digest", "attempt", "state", "artifacts", "detail", "created_at", "updated_at", "lease_owner", "lease_expires_at",
    ]);
  });

  it("从版本 3 升级：已有记忆保留，project_id 和 deleted_at 为空", () => {
    const db = migratedDb(sqlite!, 3);
    db.exec("INSERT INTO memories (id, kind, text, source, created_at, updated_at) VALUES ('mem-old', 'fact', '旧记忆', 'manual', 1, 1)");
    db.exec(readMigrations().find((m) => m.version === 4)!.sql);
    db.exec(readMigrations().find((m) => m.version === 5)!.sql);
    db.exec(readMigrations().find((m) => m.version === 6)!.sql);
    db.exec(readMigrations().find((m) => m.version === 7)!.sql);
    expect(version(db)).toBe("7");
    expect(db.prepare("SELECT id, text, project_id, deleted_at FROM memories").all({})).toEqual([{ id: "mem-old", text: "旧记忆", project_id: null, deleted_at: null }]);
  });

  it("约束：取值范围、外键、默认值", () => {
    const db = migratedDb(sqlite!);
    const run = (sql: string) => () => db.exec(sql);
    expect(run("INSERT INTO projects (id, name, routing_preference, created_at, updated_at) VALUES ('prj-a', 'A', 'cheap', 1, 1)")).toThrow(/CHECK/);
    db.exec("INSERT INTO projects (id, name, created_at, updated_at) VALUES ('prj-a', 'A', 1, 1)");
    expect(db.prepare("SELECT description, instructions, context_folders, routing_preference, archived FROM projects").get({})).toEqual({
      description: "", instructions: "", context_folders: "[]", routing_preference: null, archived: 0,
    });
    expect(run("INSERT INTO goals (id, project_id, description, created_at, updated_at) VALUES ('goal-x', 'prj-none', 'x', 1, 1)")).toThrow(/FOREIGN KEY/);
    expect(run("INSERT INTO goals (id, description, status, created_at, updated_at) VALUES ('goal-x', 'x', 'done', 1, 1)")).toThrow(/CHECK/);
    // 目标可以不属于任何项目
    db.exec("INSERT INTO goals (id, description, created_at, updated_at) VALUES ('goal-x', 'x', 1, 1)");
    expect(db.prepare("SELECT status, rounds, max_llm_calls, used_llm_calls FROM goals").get({})).toEqual({ status: "idle", rounds: "[]", max_llm_calls: 50, used_llm_calls: 0 });
    expect(run("INSERT INTO memories (id, kind, text, source, created_at, updated_at, project_id) VALUES ('mem-x', 'fact', 'x', 'manual', 1, 1, 'prj-none')")).toThrow(/FOREIGN KEY/);
    // 会话：项目外键；回合默认空列表。调用记录的 tokens 不能为负
    expect(run("INSERT INTO sessions (id, project_id, title, created_at, updated_at) VALUES ('ses-x', 'prj-none', 't', 1, 1)")).toThrow(/FOREIGN KEY/);
    db.exec("INSERT INTO sessions (id, title, created_at, updated_at) VALUES ('ses-x', 't', 1, 1)");
    expect(db.prepare("SELECT turns, deleted_at FROM sessions").get({})).toEqual({ turns: "[]", deleted_at: null });
    expect(run("INSERT INTO usage_calls (id, task_id, profile_id, input_tokens, output_tokens, created_at) VALUES ('u1', 't1', 'a/b', -1, 0, 1)")).toThrow(/CHECK/);
  });

  it("从版本 4 升级：已有项目、目标、记忆保留，新增两张空表", () => {
    const db = migratedDb(sqlite!, 4);
    db.exec("INSERT INTO projects (id, name, created_at, updated_at) VALUES ('prj-a', 'A', 1, 1)");
    db.exec("INSERT INTO goals (id, project_id, description, created_at, updated_at) VALUES ('goal-a', 'prj-a', 'g', 1, 1)");
    db.exec(readMigrations().find((m) => m.version === 5)!.sql);
    db.exec(readMigrations().find((m) => m.version === 6)!.sql);
    db.exec(readMigrations().find((m) => m.version === 7)!.sql);
    expect(version(db)).toBe("7");
    expect(db.prepare("SELECT id FROM projects").all({})).toEqual([{ id: "prj-a" }]);
    expect(db.prepare("SELECT id FROM goals").all({})).toEqual([{ id: "goal-a" }]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM sessions").get({})).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM tool_invocations").get({})).toEqual({ n: 0 });
  });

  it("从版本 6 升级：账本记录保留，租约列为空", () => {
    const db = migratedDb(sqlite!, 6);
    db.exec("INSERT INTO tool_invocations (idempotency_key, task_id, step_id, invocation_id, tool, args_digest, attempt, state, artifacts, detail, created_at, updated_at) VALUES ('eg-old', 't', 's', 'i', 'write_file', 'x', 1, 'unknown', '[]', '', 1, 1)");
    db.exec(readMigrations().find((m) => m.version === 7)!.sql);
    expect(version(db)).toBe("7");
    expect(db.prepare("SELECT state, lease_owner, lease_expires_at FROM tool_invocations WHERE idempotency_key = 'eg-old'").get({})).toEqual({ state: "unknown", lease_owner: null, lease_expires_at: null });
  });
});

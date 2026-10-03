// @vitest-environment node
// 迁移：真实执行 eg-core 的迁移 SQL（node:sqlite 内存库），检查表结构、约束和从版本 3 升级。
// 桌面端由 tauri-plugin-sql 执行同一份 SQL；Mac 上首次启动后侧栏应显示「SQLite · 结构版本 4」。
import { SCHEMA_VERSION } from "@/lib/db";
import { loadSqlite, migratedDb, readMigrations, type RawDb } from "./sqlite-helper";

const sqlite = await loadSqlite();
const cols = (db: RawDb, table: string) => (db.prepare(`PRAGMA table_info(${table})`).all({}) as { name: string }[]).map((c) => c.name);
const version = (db: RawDb) => (db.prepare("SELECT value FROM app_meta WHERE key = 'schema_version'").get({}) as { value: string }).value;

describe("迁移列表", () => {
  it("从 lib.rs 读出的版本连续，最后一条等于 SCHEMA_VERSION", () => {
    const ms = readMigrations();
    expect(ms.map((m) => m.version)).toEqual([1, 2, 3, 4]);
    expect(ms.at(-1)).toMatchObject({ version: SCHEMA_VERSION, name: "create_projects_goals" });
    // 续行符已去掉，SQL 里没有 Rust 转义残留
    for (const m of ms) expect(m.sql).not.toMatch(/\\$|\\\n/m);
  });
});

describe.skipIf(!sqlite)("迁移 SQL（node:sqlite）", () => {
  it("新库执行全部迁移：结构版本 4，三张表的列齐全", () => {
    const db = migratedDb(sqlite!);
    expect(version(db)).toBe("4");
    expect(cols(db, "projects")).toEqual(["id", "name", "description", "instructions", "context_folders", "routing_preference", "archived", "created_at", "updated_at", "deleted_at"]);
    expect(cols(db, "goals")).toEqual([
      "id", "project_id", "description", "instructions", "routing_preference", "status", "rounds", "max_llm_calls", "used_llm_calls", "created_at", "updated_at", "deleted_at",
    ]);
    expect(cols(db, "memories").slice(-2)).toEqual(["project_id", "deleted_at"]);
  });

  it("从版本 3 升级：已有记忆保留，project_id 和 deleted_at 为空", () => {
    const db = migratedDb(sqlite!, 3);
    db.exec("INSERT INTO memories (id, kind, text, source, created_at, updated_at) VALUES ('mem-old', 'fact', '旧记忆', 'manual', 1, 1)");
    db.exec(readMigrations().find((m) => m.version === 4)!.sql);
    expect(version(db)).toBe("4");
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
  });
});

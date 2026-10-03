// 测试用：读出 eg-core 的迁移 SQL，在 node:sqlite 的内存库里执行，并按 tauri-plugin-sql 的方式绑定参数。
// tauri-plugin-sql（sqlx）按数组位置绑定，SQLite 按首次出现的顺序给 $1、$2… 编号；
// 这里按名字绑定（$1 → bind[0]），只有在「每条语句里占位符按出现顺序递增」时才与真实行为一致，由 placeholdersAscend 检查。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Db } from "@/lib/db";

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/** 从 crates/eg-core/src/lib.rs 取出 MIGRATIONS。SQL 是 Rust 字符串字面量：行尾反斜杠续行，\n、\" 转义 */
export function readMigrations(root = process.cwd()): Migration[] {
  const src = readFileSync(resolve(root, "crates/eg-core/src/lib.rs"), "utf8");
  const start = src.indexOf("pub const MIGRATIONS");
  const block = src.slice(start, src.indexOf("\n];", start));
  const re = /\(\s*(\d+),\s*"([^"]+)",(?:\s*\/\/[^\n]*)*\s*"((?:[^"\\]|\\[\s\S])*)",?\s*\)/g;
  return [...block.matchAll(re)].map((m) => ({ version: Number(m[1]), name: m[2], sql: unescapeRust(m[3]) }));
}

function unescapeRust(s: string): string {
  return s.replace(/\\\r?\n[ \t]*/g, "").replace(/\\(["\\nt])/g, (_m, c: string) => (c === "n" ? "\n" : c === "t" ? "\t" : c));
}

/** 占位符按首次出现的顺序是 $1、$2、$3…（可以重复出现） */
export function placeholdersAscend(sql: string): boolean {
  const seen = new Set<number>();
  for (const m of sql.matchAll(/\$(\d+)/g)) {
    const n = Number(m[1]);
    if (seen.has(n)) continue;
    if (n !== seen.size + 1) return false;
    seen.add(n);
  }
  return true;
}

/** node:sqlite 的最小接口（避免在没有 node:sqlite 的 Node 版本上类型报错） */
export interface RawDb {
  exec(sql: string): void;
  prepare(sql: string): {
    all(params: Record<string, unknown>): unknown[];
    get(params: Record<string, unknown>): unknown;
    run(params: Record<string, unknown>): { changes: number | bigint; lastInsertRowid: number | bigint };
  };
}

export type SqliteModule = { DatabaseSync: new (path: string) => RawDb };

/** 没有 node:sqlite（Node 22.5 以前）时返回 null，相关测试跳过 */
export async function loadSqlite(): Promise<SqliteModule | null> {
  try {
    return (await import("node:sqlite")) as unknown as SqliteModule;
  } catch {
    return null;
  }
}

/** 新建内存库并执行迁移；upTo 指定只执行到哪个版本 */
export function migratedDb(mod: SqliteModule, upTo = Infinity): RawDb {
  const db = new mod.DatabaseSync(":memory:");
  // sqlx 打开 SQLite 时默认开启外键约束，这里保持一致
  db.exec("PRAGMA foreign_keys = ON;");
  for (const m of readMigrations()) if (m.version <= upTo) db.exec(m.sql);
  return db;
}

/** 把 RawDb 包成 src/lib/db.ts 的 Db 接口；绑定参数个数必须与语句里的占位符个数相同 */
export function asDb(get: () => RawDb): Db {
  const named = (sql: string, bind: unknown[] = []) => {
    const max = Math.max(0, ...[...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
    if (max !== bind.length) throw new Error(`占位符 ${max} 个，绑定参数 ${bind.length} 个：${sql}`);
    // tauri-plugin-sql 怎么绑定 JSON 布尔值没有核实；archived 列有 CHECK (0, 1)，代码里只绑定数字，这里遇到布尔值直接报错
    if (bind.some((v) => typeof v === "boolean")) throw new Error(`不要绑定布尔值：${sql}`);
    return Object.fromEntries(bind.map((v, i) => [`$${i + 1}`, v === undefined ? null : v]));
  };
  return {
    async select<T>(sql: string, bind?: unknown[]) {
      return get().prepare(sql).all(named(sql, bind)) as T;
    },
    async execute(sql: string, bind?: unknown[]) {
      const r = get().prepare(sql).run(named(sql, bind));
      return { rowsAffected: Number(r.changes), lastInsertId: Number(r.lastInsertRowid) };
    },
  };
}

// SQLite（tauri-plugin-sql），只在桌面端使用。迁移在 Rust 侧注册（src-tauri/src/lib.rs），前端只负责打开和查询。
// 浏览器模式不走这里，由 mock 后端用内存代替（src/platform/mock-backend.ts）。
import { toAppError } from "./ipc";

export const DB_URL = "sqlite:eastgenesis.db";
/** 设置项存进 app_meta 表，键加前缀，和 schema_version 等内部键分开 */
export const SETTING_PREFIX = "settings:";
const SETTING_KEY = /^[a-z0-9][a-z0-9_.-]{0,63}$/;

export interface Db {
  select<T>(query: string, bind?: unknown[]): Promise<T>;
  execute(query: string, bind?: unknown[]): Promise<unknown>;
}

let handle: Promise<Db> | null = null;

/** 全局共用一个连接；打开失败时清掉缓存，重试会重新打开 */
export function database(): Promise<Db> {
  handle ??= import("@tauri-apps/plugin-sql")
    .then(({ default: Database }) => Database.load(DB_URL) as Promise<Db>)
    .catch((e: unknown) => {
      handle = null;
      throw toAppError(e, "db_open_failed");
    });
  return handle;
}

/** 执行查询；错误统一为 db_query_failed，已经是 AppError 的保持原样 */
export async function withDb<T>(f: (db: Db) => Promise<T>): Promise<T> {
  try {
    return await f(await database());
  } catch (e) {
    throw toAppError(e, "db_query_failed");
  }
}

export async function readSchemaVersion(db: Db): Promise<number | null> {
  const rows = await db.select<{ value: string }[]>("SELECT value FROM app_meta WHERE key = $1", ["schema_version"]);
  const v = Number(rows[0]?.value);
  return Number.isFinite(v) ? v : null;
}

export function assertSettingKey(key: string): void {
  if (!SETTING_KEY.test(key)) throw toAppError({ code: "invalid_setting_key", message: "设置项名称无效" });
}

export async function getSetting(key: string): Promise<string | null> {
  assertSettingKey(key);
  try {
    const db = await database();
    const rows = await db.select<{ value: string }[]>("SELECT value FROM app_meta WHERE key = $1", [SETTING_PREFIX + key]);
    return rows[0]?.value ?? null;
  } catch (e) {
    throw toAppError(e, "db_query_failed");
  }
}

export async function setSetting(key: string, value: string): Promise<void> {
  assertSettingKey(key);
  try {
    const db = await database();
    await db.execute(
      "INSERT INTO app_meta (key, value) VALUES ($1, $2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      [SETTING_PREFIX + key, value],
    );
  } catch (e) {
    throw toAppError(e, "db_query_failed");
  }
}

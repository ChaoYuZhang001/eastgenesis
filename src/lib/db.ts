// SQLite（tauri-plugin-sql），只在桌面端使用。迁移在 Rust 侧注册（src-tauri/src/lib.rs），前端只负责打开和查询。
// 浏览器模式不走这里，由 mock 后端用内存代替（src/platform/mock-backend.ts）。
import { toAppError } from "./ipc";
import { recordQaStartup } from "./qa-startup";

export const DB_URL = "sqlite:eastgenesis.db";
/**
 * 数据库结构版本，等于 eg-core MIGRATIONS 里最后一条的版本（tests/db-migrations.test.ts 核对）。
 * 迁移 4：projects、goals 两张表，memories 加 project_id、deleted_at（src/lib/db-project.ts、db-goal.ts）。
 * 迁移 5：sessions、usage_calls 两张表（src/lib/db-session.ts）。
 * 迁移 6：tool_invocations 调用账本（src/lib/db-invocation.ts）。
 * 迁移 7：调用账本的跨进程恢复租约。
 */
export const SCHEMA_VERSION = 7;
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
  if (handle === null) {
    recordQaStartup("sql_import_started");
    handle = import("@tauri-apps/plugin-sql")
      .then(({ default: Database }) => {
        recordQaStartup("sql_import_resolved");
        recordQaStartup("db_load_called");
        try {
          return (Database.load(DB_URL) as Promise<Db>).then((db) => {
            recordQaStartup("db_load_resolved");
            return db;
          }, (error: unknown) => {
            recordQaStartup("db_load_failed");
            throw error;
          });
        } catch (error) {
          recordQaStartup("db_load_failed");
          throw error;
        }
      }, (error: unknown) => {
        recordQaStartup("sql_import_failed");
        throw error;
      })
      .catch((e: unknown) => {
        handle = null;
        throw toAppError(e, "db_open_failed");
      });
  }
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

/** 启动只接受当前结构；旧库、较新库和缺失元数据均不能进入任务工作台。 */
export function assertSupportedSchemaVersion(version: number | null): void {
  if (version === null || !Number.isSafeInteger(version) || version <= 0) {
    throw toAppError({ code: "db_schema_invalid", message: "无法确认数据版本。请关闭并重新打开应用；如仍失败，请联系支持。" });
  }
  if (version < SCHEMA_VERSION) {
    throw toAppError({ code: "db_schema_not_ready", message: "数据尚未完成升级。请关闭并重新打开应用后再试。" });
  }
  if (version > SCHEMA_VERSION) {
    throw toAppError({ code: "db_schema_newer", message: "当前应用不支持此数据版本。请更新应用后再打开。" });
  }
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

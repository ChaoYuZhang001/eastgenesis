//! EastGenesis 核心库。Tauri 外壳（src-tauri）只做命令封装，业务逻辑都放在这里。

pub mod error;
pub mod file_roots;
mod mcp_fields;
pub mod mcp_files;
pub mod mcp_guard;
pub mod mcp_host;
pub mod mcp_registry;
mod mcp_resolve;
pub mod mcp_secrets;
pub mod mcp_service;
pub mod mcp_template;
pub mod pdf;
pub mod providers;
pub mod redact;
pub mod secrets;

pub use error::{AppError, AppResult};

use serde::Serialize;

/// 数据库迁移：(版本, 说明, SQL)。src-tauri 把它转换为 tauri-plugin-sql 的 Migration。
/// 追加新版本，不改已发布的条目。
pub const MIGRATIONS: &[(i64, &str, &str)] = &[
    (
        1,
        "create_app_meta",
        "CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);\n\
         INSERT OR REPLACE INTO app_meta (key, value) VALUES ('schema_version', '1');",
    ),
    (
        2,
        "create_memories",
        // 记忆：只有用户添加或确认过的条目；前端经 tauri-plugin-sql 读写（src/lib/db-memory.ts）
        "CREATE TABLE IF NOT EXISTS memories (\n\
           id TEXT PRIMARY KEY NOT NULL,\n\
           kind TEXT NOT NULL CHECK (kind IN ('preference', 'fact')),\n\
           text TEXT NOT NULL,\n\
           source TEXT NOT NULL CHECK (source IN ('manual', 'task')),\n\
           created_at INTEGER NOT NULL,\n\
           updated_at INTEGER NOT NULL,\n\
           use_count INTEGER NOT NULL DEFAULT 0,\n\
           last_used_at INTEGER\n\
         );\n\
         INSERT OR REPLACE INTO app_meta (key, value) VALUES ('schema_version', '2');",
    ),
    (
        3,
        "create_skills",
        // 技能：用户保存的可复用流程，steps 列存 JSON；前端经 tauri-plugin-sql 读写（src/lib/db-skill.ts）
        "CREATE TABLE IF NOT EXISTS skills (\n\
           id TEXT PRIMARY KEY NOT NULL,\n\
           name TEXT NOT NULL,\n\
           description TEXT NOT NULL,\n\
           steps TEXT NOT NULL,\n\
           source TEXT NOT NULL CHECK (source IN ('manual', 'task')),\n\
           created_at INTEGER NOT NULL,\n\
           updated_at INTEGER NOT NULL,\n\
           use_count INTEGER NOT NULL DEFAULT 0,\n\
           last_used_at INTEGER\n\
         );\n\
         INSERT OR REPLACE INTO app_meta (key, value) VALUES ('schema_version', '3');",
    ),
    (
        4,
        "create_projects_goals",
        // 项目与目标（src/lib/db-project.ts、src/lib/db-goal.ts）。删除都是软删除：只写 deleted_at，
        // 删项目时同一个 deleted_at 级联写到它的目标和记忆。context_folders、rounds 列存 JSON。
        // routing_preference 为 NULL 表示不覆盖，沿用上一层（任务 > 目标 > 项目 > 全局默认）。
        "CREATE TABLE IF NOT EXISTS projects (\n\
           id TEXT PRIMARY KEY NOT NULL,\n\
           name TEXT NOT NULL,\n\
           description TEXT NOT NULL DEFAULT '',\n\
           instructions TEXT NOT NULL DEFAULT '',\n\
           context_folders TEXT NOT NULL DEFAULT '[]',\n\
           routing_preference TEXT CHECK (routing_preference IN ('economy', 'balanced', 'best')),\n\
           archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),\n\
           created_at INTEGER NOT NULL,\n\
           updated_at INTEGER NOT NULL,\n\
           deleted_at INTEGER\n\
         );\n\
         CREATE TABLE IF NOT EXISTS goals (\n\
           id TEXT PRIMARY KEY NOT NULL,\n\
           project_id TEXT REFERENCES projects(id),\n\
           description TEXT NOT NULL,\n\
           instructions TEXT NOT NULL DEFAULT '',\n\
           routing_preference TEXT CHECK (routing_preference IN ('economy', 'balanced', 'best')),\n\
           status TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle', 'running', 'paused', 'completed', 'failed', 'abandoned', 'deleted')),\n\
           rounds TEXT NOT NULL DEFAULT '[]',\n\
           max_llm_calls INTEGER NOT NULL DEFAULT 50 CHECK (max_llm_calls > 0),\n\
           used_llm_calls INTEGER NOT NULL DEFAULT 0 CHECK (used_llm_calls >= 0),\n\
           created_at INTEGER NOT NULL,\n\
           updated_at INTEGER NOT NULL,\n\
           deleted_at INTEGER\n\
         );\n\
         CREATE INDEX IF NOT EXISTS goals_project ON goals (project_id);\n\
         ALTER TABLE memories ADD COLUMN project_id TEXT REFERENCES projects(id);\n\
         ALTER TABLE memories ADD COLUMN deleted_at INTEGER;\n\
         CREATE INDEX IF NOT EXISTS memories_project ON memories (project_id);\n\
         INSERT OR REPLACE INTO app_meta (key, value) VALUES ('schema_version', '4');",
    ),
    (
        5,
        "create_sessions_usage",
        // 会话与模型调用记录（src/lib/db-session.ts）。turns 列存 JSON，写入前已脱敏、截断（src/decision/session.ts）。
        // 删除是软删除；删项目时同一个 deleted_at 级联写到它的会话。usage_calls 只存模型和 tokens，不存金额。
        "CREATE TABLE IF NOT EXISTS sessions (\n\
           id TEXT PRIMARY KEY NOT NULL,\n\
           project_id TEXT REFERENCES projects(id),\n\
           title TEXT NOT NULL,\n\
           turns TEXT NOT NULL DEFAULT '[]',\n\
           created_at INTEGER NOT NULL,\n\
           updated_at INTEGER NOT NULL,\n\
           deleted_at INTEGER\n\
         );\n\
         CREATE INDEX IF NOT EXISTS sessions_project ON sessions (project_id);\n\
         CREATE TABLE IF NOT EXISTS usage_calls (\n\
           id TEXT PRIMARY KEY NOT NULL,\n\
           session_id TEXT,\n\
           task_id TEXT NOT NULL,\n\
           goal_id TEXT,\n\
           project_id TEXT,\n\
           profile_id TEXT NOT NULL,\n\
           input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0),\n\
           output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),\n\
           baseline_profile_id TEXT,\n\
           created_at INTEGER NOT NULL\n\
         );\n\
         CREATE INDEX IF NOT EXISTS usage_calls_created ON usage_calls (created_at);\n\
         INSERT OR REPLACE INTO app_meta (key, value) VALUES ('schema_version', '5');",
    ),
    (
        6,
        "create_tool_invocations",
        // 工具调用账本（src/lib/db-invocation.ts）：不保存正文，只保存幂等键、参数摘要、状态和产物引用，供跨重启恢复使用。
        "CREATE TABLE IF NOT EXISTS tool_invocations (\n\
           idempotency_key TEXT PRIMARY KEY NOT NULL,\n\
           task_id TEXT NOT NULL,\n\
           step_id TEXT NOT NULL,\n\
           invocation_id TEXT NOT NULL,\n\
           tool TEXT NOT NULL,\n\
           args_digest TEXT NOT NULL,\n\
           attempt INTEGER NOT NULL CHECK (attempt > 0),\n\
           state TEXT NOT NULL CHECK (state IN ('planned', 'started', 'applied', 'not_applied', 'unknown', 'conflict')),\n\
           artifacts TEXT NOT NULL DEFAULT '[]',\n\
           detail TEXT NOT NULL DEFAULT '',\n\
           created_at INTEGER NOT NULL,\n\
           updated_at INTEGER NOT NULL\n\
         );\n\
         CREATE INDEX IF NOT EXISTS tool_invocations_task ON tool_invocations (task_id, step_id);\n\
         CREATE INDEX IF NOT EXISTS tool_invocations_updated ON tool_invocations (updated_at);\n\
         INSERT OR REPLACE INTO app_meta (key, value) VALUES ('schema_version', '6');",
    ),
    (
        7,
        "add_tool_invocation_leases",
        // 跨进程恢复租约：同一个幂等键只能由一个运行实例占用；租约过期后才允许接管。
        "ALTER TABLE tool_invocations ADD COLUMN lease_owner TEXT;\n\
         ALTER TABLE tool_invocations ADD COLUMN lease_expires_at INTEGER;\n\
         CREATE INDEX IF NOT EXISTS tool_invocations_lease ON tool_invocations (lease_expires_at);\n\
         INSERT OR REPLACE INTO app_meta (key, value) VALUES ('schema_version', '7');",
    ),
];

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct AppInfo {
    pub name: String,
    pub version: String,
    /// 只给出文件名，不暴露本机绝对路径
    pub db_path_hint: String,
}

pub fn app_info(version: &str) -> AppInfo {
    AppInfo {
        name: "EastGenesis Desktop".into(),
        version: version.into(),
        db_path_hint: "eastgenesis.db".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrations_are_ordered_and_start_at_one() {
        let versions: Vec<i64> = MIGRATIONS.iter().map(|m| m.0).collect();
        assert_eq!(versions.first(), Some(&1));
        assert!(versions.windows(2).all(|w| w[1] == w[0] + 1));
    }

    #[test]
    fn each_migration_records_its_schema_version() {
        for (v, _, sql) in MIGRATIONS {
            assert!(sql.contains(&format!("('schema_version', '{v}')")), "迁移 {v}");
        }
    }

    #[test]
    fn migration_4_adds_projects_goals_and_memory_columns() {
        let (_, name, sql) = MIGRATIONS.iter().find(|m| m.0 == 4).expect("迁移 4");
        assert_eq!(*name, "create_projects_goals");
        for part in [
            "CREATE TABLE IF NOT EXISTS projects",
            "CREATE TABLE IF NOT EXISTS goals",
            "ALTER TABLE memories ADD COLUMN project_id TEXT REFERENCES projects(id);",
            "ALTER TABLE memories ADD COLUMN deleted_at INTEGER;",
            "max_llm_calls INTEGER NOT NULL DEFAULT 50",
        ] {
            assert!(sql.contains(part), "缺少：{part}");
        }
        // 已发布的迁移不改：前三条里不出现新表
        for (v, _, old) in MIGRATIONS.iter().filter(|m| m.0 < 4) {
            assert!(!old.contains("projects") && !old.contains("goals"), "迁移 {v}");
        }
    }

    #[test]
    fn migration_5_adds_sessions_and_usage_calls() {
        let (_, name, sql) = MIGRATIONS.iter().find(|m| m.0 == 5).expect("迁移 5");
        assert_eq!(*name, "create_sessions_usage");
        for part in ["CREATE TABLE IF NOT EXISTS sessions", "CREATE TABLE IF NOT EXISTS usage_calls", "project_id TEXT REFERENCES projects(id)", "deleted_at INTEGER"] {
            assert!(sql.contains(part), "缺少：{part}");
        }
        // 金额不入库：只存模型和 tokens
        assert!(!sql.contains("cost") && !sql.contains("price"));
        for (v, _, old) in MIGRATIONS.iter().filter(|m| m.0 < 5) {
            assert!(!old.contains("sessions") && !old.contains("usage_calls"), "迁移 {v}");
        }
    }

    #[test]
    fn migration_6_adds_tool_invocation_ledger() {
        let (_, name, sql) = MIGRATIONS.iter().find(|m| m.0 == 6).expect("迁移 6");
        assert_eq!(*name, "create_tool_invocations");
        for part in [
            "CREATE TABLE IF NOT EXISTS tool_invocations",
            "idempotency_key TEXT PRIMARY KEY NOT NULL",
            "state TEXT NOT NULL CHECK",
            "CREATE INDEX IF NOT EXISTS tool_invocations_task",
        ] {
            assert!(sql.contains(part), "缺少：{part}");
        }
        for (v, _, old) in MIGRATIONS.iter().filter(|m| m.0 < 6) {
            assert!(!old.contains("tool_invocations"), "迁移 {v}");
        }
    }

    #[test]
    fn migration_7_adds_tool_invocation_leases() {
        let (_, name, sql) = MIGRATIONS.iter().find(|m| m.0 == 7).expect("迁移 7");
        assert_eq!(*name, "add_tool_invocation_leases");
        for part in [
            "ALTER TABLE tool_invocations ADD COLUMN lease_owner TEXT",
            "ALTER TABLE tool_invocations ADD COLUMN lease_expires_at INTEGER",
            "CREATE INDEX IF NOT EXISTS tool_invocations_lease",
        ] {
            assert!(sql.contains(part), "缺少：{part}");
        }
        for (v, _, old) in MIGRATIONS.iter().filter(|m| m.0 < 7) {
            assert!(!old.contains("lease_owner") && !old.contains("lease_expires_at"), "迁移 {v}");
        }
    }

    #[test]
    fn app_info_serializes_snake_case() {
        let v = serde_json::to_value(app_info("0.1.0")).unwrap();
        assert_eq!(v["name"], "EastGenesis Desktop");
        assert_eq!(v["db_path_hint"], "eastgenesis.db");
    }
}

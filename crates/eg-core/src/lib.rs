//! EastGenesis 核心库。Tauri 外壳（src-tauri）只做命令封装，业务逻辑都放在这里。

pub mod error;
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
    fn app_info_serializes_snake_case() {
        let v = serde_json::to_value(app_info("0.1.0")).unwrap();
        assert_eq!(v["name"], "EastGenesis Desktop");
        assert_eq!(v["db_path_hint"], "eastgenesis.db");
    }
}

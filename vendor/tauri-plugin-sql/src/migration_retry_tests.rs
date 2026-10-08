// Local regression tests for the SQLx path used by commands::load.
// SPDX-License-Identifier: Apache-2.0 OR MIT

use super::migrate_registered;
use crate::{DbPool, Error, Migration, MigrationKind, MigrationList, Migrations};
use sqlx::{
    SqlitePool,
    migrate::MigrateError,
    sqlite::{SqliteConnectOptions, SqlitePoolOptions},
};
use std::{
    collections::HashMap,
    future::Future,
    path::PathBuf,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::Mutex;

const DB: &str = "sqlite:owned-test.db";

fn run(test: impl Future<Output = ()>) {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(test);
}

fn definitions(sql: &'static str) -> MigrationList {
    MigrationList(vec![Migration {
        version: 1,
        description: "owned_test",
        sql,
        kind: MigrationKind::Up,
    }])
}

fn registry(sql: &'static str) -> Migrations {
    Migrations(Mutex::new(HashMap::from([(
        DB.to_owned(),
        definitions(sql),
    )])))
}

async fn memory_pool() -> SqlitePool {
    SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap()
}

async fn count(pool: &SqlitePool, sql: &str) -> i64 {
    sqlx::query_scalar(sql).fetch_one(pool).await.unwrap()
}

#[test]
fn failed_sql_rolls_back_retains_definitions_and_repair_allows_one_application() {
    run(async {
        let pool = memory_pool().await;
        sqlx::raw_sql("CREATE TABLE app_meta(key TEXT PRIMARY KEY, value TEXT); INSERT INTO app_meta VALUES('schema_version','6');")
            .execute(&pool).await.unwrap();
        let registered = registry(
            "CREATE TABLE changed(value TEXT NOT NULL); INSERT INTO changed VALUES('one'); ALTER TABLE prerequisite ADD COLUMN upgraded INTEGER; UPDATE app_meta SET value='7' WHERE key='schema_version';",
        );
        let wrapped = DbPool::Sqlite(pool.clone());
        for _ in 0..2 {
            assert!(matches!(
                migrate_registered(&wrapped, &registered, DB).await,
                Err(Error::Migration(MigrateError::ExecuteMigration(_, 1)))
            ));
            assert!(registered.0.lock().await.contains_key(DB));
            assert_eq!(
                count(
                    &pool,
                    "SELECT COUNT(*) FROM sqlite_master WHERE name='changed'"
                )
                .await,
                0
            );
            assert_eq!(
                count(&pool, "SELECT COUNT(*) FROM _sqlx_migrations").await,
                0
            );
            assert_eq!(
                sqlx::query_scalar::<_, String>(
                    "SELECT value FROM app_meta WHERE key='schema_version'"
                )
                .fetch_one(&pool)
                .await
                .unwrap(),
                "6"
            );
        }
        sqlx::raw_sql(
            "CREATE TABLE prerequisite(old_value TEXT); INSERT INTO prerequisite VALUES('retain');",
        )
        .execute(&pool)
        .await
        .unwrap();
        migrate_registered(&wrapped, &registered, DB).await.unwrap();
        assert!(!registered.0.lock().await.contains_key(DB));
        assert_eq!(count(&pool, "SELECT COUNT(*) FROM changed").await, 1);
        assert_eq!(
            count(
                &pool,
                "SELECT COUNT(*) FROM _sqlx_migrations WHERE version=1 AND success=TRUE"
            )
            .await,
            1
        );
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT old_value FROM prerequisite")
                .fetch_one(&pool)
                .await
                .unwrap(),
            "retain"
        );
        assert_eq!(
            sqlx::query_scalar::<_, String>(
                "SELECT value FROM app_meta WHERE key='schema_version'"
            )
            .fetch_one(&pool)
            .await
            .unwrap(),
            "7"
        );
        migrate_registered(&wrapped, &registered, DB).await.unwrap();
        assert_eq!(count(&pool, "SELECT COUNT(*) FROM changed").await, 1);
        pool.close().await;
    });
}

const RETAINED_SQL: &str = "CREATE TABLE retained(id INTEGER PRIMARY KEY, body TEXT NOT NULL); INSERT INTO retained VALUES(1,'unchanged');";

#[test]
fn checksum_mismatch_remains_rejected_on_every_retry() {
    run(async {
        let pool = memory_pool().await;
        let wrapped = DbPool::Sqlite(pool.clone());
        let registered = registry(RETAINED_SQL);
        migrate_registered(&wrapped, &registered, DB).await.unwrap();
        registered
            .0
            .lock()
            .await
            .insert(DB.into(), definitions(RETAINED_SQL));
        sqlx::query("UPDATE _sqlx_migrations SET checksum=zeroblob(48) WHERE version=1")
            .execute(&pool)
            .await
            .unwrap();
        for _ in 0..2 {
            assert!(matches!(
                migrate_registered(&wrapped, &registered, DB).await,
                Err(Error::Migration(MigrateError::VersionMismatch(1)))
            ));
            assert!(registered.0.lock().await.contains_key(DB));
            assert_eq!(
                sqlx::query_scalar::<_, String>("SELECT body FROM retained WHERE id=1")
                    .fetch_one(&pool)
                    .await
                    .unwrap(),
                "unchanged"
            );
            assert_eq!(
                count(
                    &pool,
                    "SELECT COUNT(*) FROM _sqlx_migrations WHERE checksum=zeroblob(48)"
                )
                .await,
                1
            );
        }
        pool.close().await;
    });
}

#[test]
fn dirty_metadata_remains_rejected_on_every_retry() {
    run(async {
        let pool = memory_pool().await;
        let wrapped = DbPool::Sqlite(pool.clone());
        let registered = registry(RETAINED_SQL);
        migrate_registered(&wrapped, &registered, DB).await.unwrap();
        registered
            .0
            .lock()
            .await
            .insert(DB.into(), definitions(RETAINED_SQL));
        sqlx::query("UPDATE _sqlx_migrations SET success=FALSE WHERE version=1")
            .execute(&pool)
            .await
            .unwrap();
        for _ in 0..2 {
            assert!(matches!(
                migrate_registered(&wrapped, &registered, DB).await,
                Err(Error::Migration(MigrateError::Dirty(1)))
            ));
            assert!(registered.0.lock().await.contains_key(DB));
            assert_eq!(
                count(
                    &pool,
                    "SELECT COUNT(*) FROM retained WHERE id=1 AND body='unchanged'"
                )
                .await,
                1
            );
            assert_eq!(
                count(
                    &pool,
                    "SELECT COUNT(*) FROM _sqlx_migrations WHERE success=FALSE"
                )
                .await,
                1
            );
        }
        pool.close().await;
    });
}

struct OwnedDirectory(PathBuf);
impl Drop for OwnedDirectory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
fn concurrent_load_cannot_bypass_an_unfinished_migration() {
    run(async {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let owned = OwnedDirectory(
            std::env::temp_dir().join(format!("eg-sql-migration-{}-{suffix}", std::process::id())),
        );
        std::fs::create_dir(&owned.0).unwrap();
        let options = SqliteConnectOptions::new()
            .filename(owned.0.join("owned.db"))
            .create_if_missing(true);
        let first_pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options.clone())
            .await
            .unwrap();
        let second_pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .unwrap();
        // The first migration can take the registry lock, but cannot yet acquire
        // its pool's only SQLite connection. The other pool remains usable.
        let held_connection = first_pool.acquire().await.unwrap();
        let registered = Arc::new(registry(RETAINED_SQL));
        let first_registered = registered.clone();
        let first_wrapped = DbPool::Sqlite(first_pool.clone());
        let first =
            tokio::spawn(
                async move { migrate_registered(&first_wrapped, &first_registered, DB).await },
            );
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if registered.0.try_lock().is_err() {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("first migration must hold the registry lock");
        let second_registered = registered.clone();
        let second_wrapped = DbPool::Sqlite(second_pool.clone());
        let (started, ready) = tokio::sync::oneshot::channel();
        let mut second = tokio::spawn(async move {
            started.send(()).unwrap();
            migrate_registered(&second_wrapped, &second_registered, DB).await
        });
        ready.await.unwrap();
        assert!(
            tokio::time::timeout(Duration::from_millis(100), &mut second)
                .await
                .is_err(),
            "second load must wait instead of publishing an unmigrated pool"
        );
        drop(held_connection);
        tokio::time::timeout(Duration::from_secs(5), first)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        tokio::time::timeout(Duration::from_secs(5), second)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(!registered.0.lock().await.contains_key(DB));
        assert_eq!(
            count(
                &second_pool,
                "SELECT COUNT(*) FROM retained WHERE body='unchanged'"
            )
            .await,
            1
        );
        assert_eq!(
            count(
                &second_pool,
                "SELECT COUNT(*) FROM _sqlx_migrations WHERE version=1 AND success=TRUE"
            )
            .await,
            1
        );
        first_pool.close().await;
        second_pool.close().await;
    });
}

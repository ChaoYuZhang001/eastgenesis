// Copyright 2019-2023 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

use indexmap::IndexMap;
use serde_json::Value as JsonValue;
use sqlx::migrate::Migrator;
use tauri::{AppHandle, Runtime, State, command};

use crate::{DbInstances, DbPool, Error, LastInsertId, Migrations};
#[cfg(feature = "qa-load-observer")]
use crate::{QaLoadStage, qa_load_observer::QaLoadObserver};
#[cfg(feature = "qa-load-observer")]
use tauri::Manager;

#[cfg(all(test, feature = "sqlite"))]
#[path = "migration_retry_tests.rs"]
mod migration_retry_tests;

async fn migrate_registered(pool: &DbPool, migrations: &Migrations, db: &str) -> Result<(), Error> {
    // Keep the definitions and this lock until success. Another load must not
    // publish a pool while the first load is still migrating or after it fails.
    let mut registered = migrations.0.lock().await;
    if let Some(definitions) = registered.get(db) {
        let migrator = Migrator::new(definitions).await?;
        pool.migrate(&migrator).await?;
        registered.remove(db);
    }
    Ok(())
}

#[command]
pub(crate) async fn load<R: Runtime>(
    app: AppHandle<R>,
    db_instances: State<'_, DbInstances>,
    migrations: State<'_, Migrations>,
    db: String,
) -> Result<String, crate::Error> {
    #[cfg(feature = "qa-load-observer")]
    let observer = app
        .try_state::<QaLoadObserver>()
        .map(|state| *state)
        .unwrap_or_default();
    #[cfg(feature = "qa-load-observer")]
    {
        observer.emit(&db, QaLoadStage::LoadEntered);
        observer.emit(&db, QaLoadStage::ConnectStarted);
    }
    let connected = DbPool::connect(&db, &app).await;
    #[cfg(feature = "qa-load-observer")]
    let connected = observer.connect_result(&db, connected);
    let pool = connected?;

    #[cfg(feature = "qa-load-observer")]
    observer.emit(&db, QaLoadStage::MigrationStarted);
    let migrated = migrate_registered(&pool, &migrations, &db).await;
    #[cfg(feature = "qa-load-observer")]
    let migrated = observer.migration_result(&db, migrated);
    migrated?;

    db_instances.0.write().await.insert(db.clone(), pool);
    #[cfg(feature = "qa-load-observer")]
    observer.emit(&db, QaLoadStage::LoadResolved);

    Ok(db)
}

/// Allows the database connection(s) to be closed; if no database
/// name is passed in then _all_ database connection pools will be
/// shut down.
#[command]
pub(crate) async fn close(
    db_instances: State<'_, DbInstances>,
    db: Option<String>,
) -> Result<bool, crate::Error> {
    let instances = db_instances.0.read().await;

    let pools = if let Some(db) = db {
        vec![db]
    } else {
        instances.keys().cloned().collect()
    };

    for pool in pools {
        let db = instances.get(&pool).ok_or(Error::DatabaseNotLoaded(pool))?;
        db.close().await;
    }

    Ok(true)
}

/// Execute a command against the database
#[command]
pub(crate) async fn execute(
    db_instances: State<'_, DbInstances>,
    db: String,
    query: String,
    values: Vec<JsonValue>,
) -> Result<(u64, LastInsertId), crate::Error> {
    let instances = db_instances.0.read().await;

    let db = instances.get(&db).ok_or(Error::DatabaseNotLoaded(db))?;
    db.execute(query, values).await
}

#[command]
pub(crate) async fn select(
    db_instances: State<'_, DbInstances>,
    db: String,
    query: String,
    values: Vec<JsonValue>,
) -> Result<Vec<IndexMap<String, JsonValue>>, crate::Error> {
    let instances = db_instances.0.read().await;

    let db = instances.get(&db).ok_or(Error::DatabaseNotLoaded(db))?;
    db.select(query, values).await
}

// Local typed observer tests; these do not launch a native Tauri application.
// SPDX-License-Identifier: Apache-2.0 OR MIT

use super::{QaLoadObserver, QaLoadStage};
use crate::{Builder, Error, Migration, MigrationKind, MigrationList};
use sqlx::{
    Connection, SqliteConnection,
    error::{DatabaseError, ErrorKind},
    migrate::{MigrateError, Migrator},
    sqlite::{SqliteConnectOptions, SqlitePoolOptions},
};
use std::{
    borrow::Cow,
    cell::RefCell,
    error::Error as StdError,
    fmt,
    future::Future,
    path::PathBuf,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const DB: &str = "sqlite:owned-observer-test.db";

thread_local! {
    static EVENTS: RefCell<Vec<QaLoadStage>> = const { RefCell::new(Vec::new()) };
}

fn record(stage: QaLoadStage) {
    EVENTS.with(|events| events.borrow_mut().push(stage));
}

fn take_events() -> Vec<QaLoadStage> {
    EVENTS.with(|events| std::mem::take(&mut *events.borrow_mut()))
}

fn panic_callback(stage: QaLoadStage) {
    record(stage);
    panic!("synthetic observer callback panic");
}

fn run(test: impl Future<Output = ()>) {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(test);
}

#[derive(Debug)]
struct NeverFormat(u8);

impl fmt::Display for NeverFormat {
    fn fmt(&self, _: &mut fmt::Formatter<'_>) -> fmt::Result {
        panic!("error text must not be inspected");
    }
}

impl StdError for NeverFormat {}

#[derive(Debug)]
struct OtherDatabaseError {
    poison: bool,
}

impl fmt::Display for OtherDatabaseError {
    fn fmt(&self, _: &mut fmt::Formatter<'_>) -> fmt::Result {
        panic!("database error text must not be inspected");
    }
}

impl StdError for OtherDatabaseError {}

impl DatabaseError for OtherDatabaseError {
    fn message(&self) -> &str {
        panic!("database message must not be inspected");
    }

    fn code(&self) -> Option<Cow<'_, str>> {
        assert!(!self.poison, "disabled observer must not classify");
        Some(Cow::Borrowed("14"))
    }

    fn as_error(&self) -> &(dyn StdError + Send + Sync + 'static) {
        assert!(!self.poison, "disabled observer must not downcast");
        self
    }

    fn as_error_mut(&mut self) -> &mut (dyn StdError + Send + Sync + 'static) {
        self
    }

    fn into_error(self: Box<Self>) -> Box<dyn StdError + Send + Sync + 'static> {
        self
    }

    fn kind(&self) -> ErrorKind {
        ErrorKind::Other
    }
}

#[test]
fn public_registration_and_success_observations_preserve_value_identity_and_order() {
    let builder = Builder::new().with_qa_load_observer(DB, record);
    let observer = builder.qa_load_observer;
    observer.plugin_ready();
    let value = Box::new(17_u8);
    let original = (&*value) as *const u8;
    let value = observer.connect_result(DB, Ok(value)).unwrap();
    assert_eq!((&*value) as *const u8, original);
    let value = observer.migration_result(DB, Ok(value)).unwrap();
    assert_eq!((&*value) as *const u8, original);
    assert_eq!(
        take_events(),
        [
            QaLoadStage::PluginReady,
            QaLoadStage::ConnectResolved,
            QaLoadStage::MigrationResolved,
        ]
    );
}

#[test]
fn absent_and_wrong_database_observers_skip_callbacks_and_error_inspection() {
    for (observer, db) in [
        (QaLoadObserver::default(), DB),
        (QaLoadObserver::new(DB, record), "sqlite:other-owned.db"),
    ] {
        observer.emit(db, QaLoadStage::LoadEntered);
        let error = Box::new(OtherDatabaseError { poison: true });
        let original = (&*error) as *const OtherDatabaseError;
        let result: Result<(), Error> =
            observer.connect_result(db, Err(Error::Sql(sqlx::Error::Database(error))));
        match result {
            Err(Error::Sql(sqlx::Error::Database(error))) => {
                // Do not invoke the poisoned trait methods even in this assertion.
                assert_eq!(
                    error.as_ref() as *const dyn DatabaseError as *const (),
                    original.cast()
                );
            }
            _ => panic!("original database error was replaced"),
        }
        assert!(matches!(
            observer.migration_result::<()>(db, Err(Error::Migration(MigrateError::Dirty(7)))),
            Err(Error::Migration(MigrateError::Dirty(7)))
        ));
    }
    QaLoadObserver::default().plugin_ready();
    assert!(take_events().is_empty());
}

#[test]
fn typed_connect_failures_keep_original_errors_without_formatting_or_foreign_code_classification() {
    let observer = QaLoadObserver::new(DB, record);
    assert!(matches!(
        observer.connect_result::<()>(DB, Err(Error::InvalidDbUrl("owned".into()))),
        Err(Error::InvalidDbUrl(value)) if value == "owned"
    ));
    let config = Box::new(NeverFormat(17));
    let original = (&*config) as *const NeverFormat;
    match observer.connect_result::<()>(DB, Err(Error::Sql(sqlx::Error::Configuration(config)))) {
        Err(Error::Sql(sqlx::Error::Configuration(error))) => {
            let returned = error.downcast_ref::<NeverFormat>().unwrap();
            assert_eq!(returned as *const NeverFormat, original);
            assert_eq!(returned.0, 17);
        }
        _ => panic!("original configuration error was replaced"),
    }
    assert!(matches!(
        observer.connect_result::<()>(DB, Err(Error::Sql(sqlx::Error::Io(
            std::io::Error::from(std::io::ErrorKind::PermissionDenied)
        )))),
        Err(Error::Sql(sqlx::Error::Io(error))) if error.kind() == std::io::ErrorKind::PermissionDenied
    ));
    let foreign = Box::new(OtherDatabaseError { poison: false });
    let original = (&*foreign) as *const OtherDatabaseError;
    match observer.connect_result::<()>(DB, Err(Error::Sql(sqlx::Error::Database(foreign)))) {
        Err(Error::Sql(sqlx::Error::Database(error))) => {
            assert_eq!(
                error.try_downcast_ref::<OtherDatabaseError>().unwrap()
                    as *const OtherDatabaseError,
                original
            );
        }
        _ => panic!("original foreign database error was replaced"),
    }
    assert!(matches!(
        observer.connect_result::<()>(DB, Err(Error::Sql(sqlx::Error::RowNotFound))),
        Err(Error::Sql(sqlx::Error::RowNotFound))
    ));
    assert_eq!(
        take_events(),
        [
            QaLoadStage::ConnectInvalidUrl,
            QaLoadStage::ConnectConfigurationFailed,
            QaLoadStage::ConnectIoPermissionDenied,
            QaLoadStage::ConnectFailed,
            QaLoadStage::ConnectFailed,
        ]
    );
}

struct OwnedDirectory(PathBuf);

impl OwnedDirectory {
    fn new() -> Self {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory =
            std::env::temp_dir().join(format!("eg-sql-observer-{}-{suffix}", std::process::id()));
        std::fs::create_dir(&directory).unwrap();
        Self(directory)
    }
}

impl Drop for OwnedDirectory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn observe_database_error(observer: &QaLoadObserver, error: sqlx::Error) -> sqlx::Error {
    let original = error.as_database_error().unwrap() as *const dyn DatabaseError;
    match observer.connect_result::<()>(DB, Err(Error::Sql(error))) {
        Err(Error::Sql(returned)) => {
            assert!(std::ptr::eq(
                returned.as_database_error().unwrap(),
                original
            ));
            returned
        }
        _ => panic!("original SQLite error was replaced"),
    }
}

#[test]
fn real_sqlite_cannot_open_lock_and_constraint_errors_have_fixed_categories() {
    run(async {
        let observer = QaLoadObserver::new(DB, record);
        let owned = OwnedDirectory::new();
        let options = SqliteConnectOptions::new()
            .filename(owned.0.join("missing-parent").join("owned.db"))
            .create_if_missing(true);
        let error = SqliteConnection::connect_with(&options).await.unwrap_err();
        observe_database_error(&observer, error);

        let options = SqliteConnectOptions::new()
            .filename(owned.0.join("owned.db"))
            .create_if_missing(true)
            .busy_timeout(Duration::from_millis(25));
        let mut first = SqliteConnection::connect_with(&options).await.unwrap();
        sqlx::query("CREATE TABLE owned(id INTEGER PRIMARY KEY)")
            .execute(&mut first)
            .await
            .unwrap();
        let mut second = SqliteConnection::connect_with(&options).await.unwrap();
        sqlx::query("BEGIN EXCLUSIVE")
            .execute(&mut first)
            .await
            .unwrap();
        let error = sqlx::query("INSERT INTO owned VALUES(1)")
            .execute(&mut second)
            .await
            .unwrap_err();
        observe_database_error(&observer, error);
        sqlx::query("ROLLBACK").execute(&mut first).await.unwrap();
        sqlx::query("INSERT INTO owned VALUES(1)")
            .execute(&mut first)
            .await
            .unwrap();
        let error = sqlx::query("INSERT INTO owned VALUES(1)")
            .execute(&mut second)
            .await
            .unwrap_err();
        observe_database_error(&observer, error);
        first.close().await.unwrap();
        second.close().await.unwrap();
        assert_eq!(
            take_events(),
            [
                QaLoadStage::ConnectCannotOpen,
                QaLoadStage::ConnectLocked,
                QaLoadStage::ConnectFailed
            ]
        );
    });
}

fn definitions(sql: &'static str) -> MigrationList {
    MigrationList(vec![Migration {
        version: 1,
        description: "owned_observer",
        sql,
        kind: MigrationKind::Up,
    }])
}

#[test]
fn real_migration_failures_keep_typed_identity_and_distinct_fixed_stages() {
    run(async {
        let observer = QaLoadObserver::new(DB, record);
        for (metadata, expected) in [
            (
                "UPDATE _sqlx_migrations SET checksum=zeroblob(48)",
                QaLoadStage::MigrationVersionMismatch,
            ),
            (
                "UPDATE _sqlx_migrations SET success=FALSE",
                QaLoadStage::MigrationDirty,
            ),
        ] {
            let pool = SqlitePoolOptions::new()
                .max_connections(1)
                .connect("sqlite::memory:")
                .await
                .unwrap();
            let migrator = Migrator::new(definitions("CREATE TABLE owned(id INTEGER PRIMARY KEY)"))
                .await
                .unwrap();
            migrator.run(&pool).await.unwrap();
            sqlx::query(metadata).execute(&pool).await.unwrap();
            let error = migrator.run(&pool).await.unwrap_err();
            let returned = observer.migration_result::<()>(DB, Err(Error::Migration(error)));
            match (expected, returned) {
                (
                    QaLoadStage::MigrationVersionMismatch,
                    Err(Error::Migration(MigrateError::VersionMismatch(1))),
                ) => (),
                (QaLoadStage::MigrationDirty, Err(Error::Migration(MigrateError::Dirty(1)))) => (),
                _ => panic!("original typed migration error was replaced"),
            }
            assert_eq!(take_events(), [expected]);
            pool.close().await;
        }
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        let migrator = Migrator::new(definitions("ALTER TABLE missing ADD COLUMN owned INTEGER"))
            .await
            .unwrap();
        let error = migrator.run(&pool).await.unwrap_err();
        let original = match &error {
            MigrateError::ExecuteMigration(error, 1) => {
                error.as_database_error().unwrap() as *const dyn DatabaseError
            }
            _ => panic!("expected real migration execution failure"),
        };
        match observer.migration_result::<()>(DB, Err(Error::Migration(error))) {
            Err(Error::Migration(MigrateError::ExecuteMigration(error, 1))) => {
                assert!(std::ptr::eq(error.as_database_error().unwrap(), original));
            }
            _ => panic!("original migration execution error was replaced"),
        }
        assert_eq!(take_events(), [QaLoadStage::MigrationFailed]);
        pool.close().await;
    });
}

#[test]
fn callback_panics_cannot_replace_success_values_or_errors() {
    let observer = QaLoadObserver::new(DB, panic_callback);
    let value = Box::new(23_u8);
    let original = (&*value) as *const u8;
    let value = observer.connect_result(DB, Ok(value)).unwrap();
    assert_eq!((&*value) as *const u8, original);
    let config = Box::new(NeverFormat(23));
    let original = (&*config) as *const NeverFormat;
    match observer.connect_result::<()>(DB, Err(Error::Sql(sqlx::Error::Configuration(config)))) {
        Err(Error::Sql(sqlx::Error::Configuration(error))) => {
            let returned = error.downcast_ref::<NeverFormat>().unwrap();
            assert_eq!(returned as *const NeverFormat, original);
            assert_eq!(returned.0, 23);
        }
        _ => panic!("panic replaced original configuration error"),
    }
    assert!(matches!(
        observer.migration_result::<()>(DB, Err(Error::Migration(MigrateError::Dirty(1)))),
        Err(Error::Migration(MigrateError::Dirty(1)))
    ));
    assert_eq!(
        take_events(),
        [
            QaLoadStage::ConnectResolved,
            QaLoadStage::ConnectConfigurationFailed,
            QaLoadStage::MigrationDirty
        ]
    );
}

// Copyright 2019-2023 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

use std::{
    fs,
    path::PathBuf,
    str::FromStr,
    sync::atomic::{AtomicU64, Ordering},
};

use sqlx::{
    Connection, Sqlite, SqlitePool, migrate::MigrateDatabase, sqlite::SqliteConnectOptions,
};

use super::path_mapper;

fn original_mapper(mut app_path: PathBuf, connection_string: &str) -> String {
    app_path.push(connection_string.split_once(':').unwrap().1);
    format!("sqlite:{}", app_path.to_str().unwrap())
}

fn parsed(url: &str) -> Result<SqliteConnectOptions, sqlx::Error> {
    SqliteConnectOptions::from_str(url)
}

#[test]
fn application_directory_is_an_opaque_filename() {
    let directory = PathBuf::from("synthetic app%FF%2F?literal#目录");
    let options = parsed(&path_mapper(directory.clone(), "sqlite:eastgenesis.db")).unwrap();
    assert_eq!(options.get_filename(), directory.join("eastgenesis.db"));
    assert!(matches!(
        parsed(&original_mapper(directory, "sqlite:eastgenesis.db")),
        Err(sqlx::Error::Configuration(_))
    ));
}

#[test]
fn verbatim_disk_and_unc_paths_survive_the_sqlx_url_parser() {
    for directory in [
        r"\\?\D:\Synthetic QA\eg-qa-appdata",
        r"\\?\UNC\synthetic-server\share\eg-qa-appdata",
        r"\\?\D:\Synthetic%FF%2F QA\eg-qa-appdata",
    ] {
        for filename in [
            "eastgenesis.db",
            "./eastgenesis.db",
            "nested/../eastgenesis.db",
        ] {
            let directory = PathBuf::from(directory);
            let url = format!("sqlite:{filename}");
            let expected = directory.join(filename);
            assert_eq!(
                parsed(&path_mapper(directory.clone(), &url))
                    .unwrap()
                    .get_filename(),
                expected,
                "native path mapping differs for synthetic verbatim path"
            );
            assert!(matches!(
                parsed(&original_mapper(directory, &url)),
                Err(sqlx::Error::Configuration(_))
            ));
        }
    }
}

#[test]
fn caller_url_query_and_existing_mapping_semantics_are_retained() {
    let directory = PathBuf::from("synthetic-safe-directory");
    for caller in [
        "sqlite:eastgenesis.db",
        "sqlite:eastgenesis.db?mode=ro",
        "sqlite:eastgenesis.db?mode=rwc&cache=private",
        "sqlite:eastgenesis.db?cache=shared&immutable=1",
        "sqlite:eastgenesis.db?vfs=synthetic-vfs",
        "sqlite:eastgenesis.db?mode=memory&cache=shared",
        "sqlite:eastgenesis.db?mode=ro&mode=rw&cache=private&cache=shared",
        "sqlite:encoded%25name%3F%23.db?mode=rwc",
        "sqlite:%2Fencoded-root.db?cache=private",
        "sqlite:%3Aencoded-colon.db",
        "sqlite:trailing%.db",
        "sqlite::memory:",
        "sqlite://synthetic-absolute/eastgenesis.db?mode=ro",
        "sqlite:../eastgenesis.db?immutable=0",
        "sqlite:./eastgenesis.db?cache=shared",
        r"sqlite:\\?\D:\synthetic-caller\eastgenesis.db",
        r"sqlite:\\?\UNC\synthetic-server\share\eastgenesis.db",
        "sqlite:eastgenesis.db?unknown=value",
        "sqlite:eastgenesis.db?mode=unknown",
        "sqlite:eastgenesis.db?cache=unknown",
        "sqlite:invalid%FF.db",
    ] {
        let before = parsed(&original_mapper(directory.clone(), caller));
        let after = parsed(&path_mapper(directory.clone(), caller));
        match (before, after) {
            (Ok(before), Ok(after)) => assert_eq!(format!("{before:?}"), format!("{after:?}")),
            (Err(sqlx::Error::Configuration(before)), Err(sqlx::Error::Configuration(after))) => {
                assert_eq!(before.to_string(), after.to_string());
            }
            _ => panic!("mapping changed a synthetic caller's parser result"),
        }
    }
}

#[cfg(unix)]
#[test]
fn absolute_caller_keeps_the_original_non_utf8_directory_behavior() {
    use std::{ffi::OsString, os::unix::ffi::OsStringExt};
    let directory = PathBuf::from(OsString::from_vec(vec![0xff]));
    let caller = "sqlite:/synthetic-absolute/eastgenesis.db?mode=ro";
    assert_eq!(
        path_mapper(directory.clone(), caller),
        original_mapper(directory.clone(), caller)
    );
    assert!(parsed(&path_mapper(directory.clone(), caller)).is_ok());
    assert!(std::panic::catch_unwind(|| path_mapper(directory, "sqlite:relative.db")).is_err());
}

#[test]
fn opaque_directory_escaping_does_not_change_caller_query_options() {
    let directory = PathBuf::from("synthetic%FF?directory");
    let url = path_mapper(
        directory.clone(),
        "sqlite:encoded%25%3F.db?mode=ro&cache=private&immutable=1",
    );
    assert!(url.ends_with("?mode=ro&cache=private&immutable=1"));
    let options = parsed(&url).unwrap();
    assert_eq!(options.get_filename(), directory.join("encoded%?.db"));
    let expected = SqliteConnectOptions::new()
        .filename(directory.join("encoded%?.db"))
        .read_only(true)
        .shared_cache(false)
        .immutable(true);
    assert_eq!(format!("{options:?}"), format!("{expected:?}"));
    assert!(matches!(
        parsed(&path_mapper(
            directory,
            "sqlite:eastgenesis.db?unknown=value"
        )),
        Err(sqlx::Error::Configuration(_))
    ));
}

static NEXT_DIRECTORY: AtomicU64 = AtomicU64::new(0);

const CLEANUP_LOCK_BUDGET: std::time::Duration = std::time::Duration::from_millis(250);

fn remove_fixture_directory(
    path: &std::path::Path,
    mut sharing_violation: impl FnMut(),
) -> std::io::Result<()> {
    let deadline = std::time::Instant::now() + CLEANUP_LOCK_BUDGET;
    let mut last_sharing_error = None;
    loop {
        if std::time::Instant::now() >= deadline {
            if let Some(error) = last_sharing_error.take() {
                return Err(error);
            }
        }
        match fs::remove_dir_all(path) {
            Ok(()) => return Ok(()),
            Err(error) => {
                // Retry only Windows sharing/lock violations after real teardown.
                // Other failures and a lock lasting beyond this budget stay fatal.
                let remaining = deadline.saturating_duration_since(std::time::Instant::now());
                if !cfg!(windows)
                    || !matches!(error.raw_os_error(), Some(32 | 33))
                    || remaining.is_zero()
                {
                    return Err(error);
                }
                sharing_violation();
                last_sharing_error = Some(error);
                std::thread::sleep(remaining.min(std::time::Duration::from_millis(10)));
            }
        }
    }
}

struct Directory(PathBuf);

impl Directory {
    fn with_runtime(operation: impl FnOnce(&Self, &tokio::runtime::Runtime)) {
        // Keep the directory alive through cancellation of runtime-owned tasks.
        let directory = Self::isolated();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        operation(&directory, &runtime);
        drop(runtime);
    }

    fn isolated() -> Self {
        let ordinal = NEXT_DIRECTORY.fetch_add(1, Ordering::Relaxed);
        // '?' is a legal filename character on Unix but not on Windows. A real
        // Windows canonical path instead supplies the verbatim-prefix '?'.
        let suffix = if cfg!(windows) {
            "%FF%2F"
        } else {
            "%FF%2F?literal"
        };
        let directory = std::env::temp_dir().join(format!(
            "eastgenesis-sql-path-{}-{ordinal}-{suffix}",
            std::process::id()
        ));
        fs::create_dir(&directory).unwrap();
        Self(directory.canonicalize().unwrap())
    }
}

impl Drop for Directory {
    fn drop(&mut self) {
        remove_fixture_directory(&self.0, || {}).unwrap();
    }
}

#[cfg(unix)]
fn file_identity(path: &std::path::Path) -> (u64, u64) {
    use std::os::unix::fs::MetadataExt;
    let metadata = fs::metadata(path).unwrap();
    (metadata.dev(), metadata.ino())
}

#[test]
fn unchanged_database_creation_and_reopen_use_one_real_file() {
    Directory::with_runtime(|directory, runtime| {
        runtime.block_on(async {
            let caller = "sqlite:eastgenesis.db?cache=private";
            let mapped = path_mapper(directory.0.clone(), caller);
            let database = directory.0.join("eastgenesis.db");
            assert_eq!(parsed(&mapped).unwrap().get_filename(), database);
            assert!(!Sqlite::database_exists(&mapped).await.unwrap());
            Sqlite::create_database(&mapped).await.unwrap();
            let pool = SqlitePool::connect(&mapped).await.unwrap();
            sqlx::query("CREATE TABLE sentinel (value TEXT NOT NULL)")
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query("INSERT INTO sentinel VALUES ('retained')")
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query("PRAGMA user_version = 7")
                .execute(&pool)
                .await
                .unwrap();
            let schema_before: String =
                sqlx::query_scalar("SELECT sql FROM sqlite_master WHERE name = 'sentinel'")
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            pool.close().await;
            #[cfg(unix)]
            let identity_before = file_identity(&database);

            let reopened = path_mapper(directory.0.clone(), caller);
            assert_eq!(reopened, mapped);
            assert!(Sqlite::database_exists(&reopened).await.unwrap());
            let mut connection = sqlx::SqliteConnection::connect(&reopened).await.unwrap();
            let sentinel: String = sqlx::query_scalar("SELECT value FROM sentinel")
                .fetch_one(&mut connection)
                .await
                .unwrap();
            let schema_after: String =
                sqlx::query_scalar("SELECT sql FROM sqlite_master WHERE name = 'sentinel'")
                    .fetch_one(&mut connection)
                    .await
                    .unwrap();
            let version: i64 = sqlx::query_scalar("PRAGMA user_version")
                .fetch_one(&mut connection)
                .await
                .unwrap();
            assert_eq!(sentinel, "retained");
            assert_eq!(schema_after, schema_before);
            assert_eq!(version, 7);
            connection.close().await.unwrap();
            assert!(database.is_file());
            #[cfg(unix)]
            assert_eq!(file_identity(&database), identity_before);
            assert_eq!(
                fs::read_dir(&directory.0)
                    .unwrap()
                    .filter_map(Result::ok)
                    .filter(|entry| entry.file_name() == "eastgenesis.db")
                    .count(),
                1
            );
        });
    });
}

#[test]
fn runtime_tasks_drop_while_the_directory_is_still_present() {
    use std::sync::{Arc, atomic::AtomicBool};
    struct PendingTask {
        path: PathBuf,
        dropped: Arc<AtomicBool>,
        directory_present: Arc<AtomicBool>,
    }
    impl Drop for PendingTask {
        fn drop(&mut self) {
            self.directory_present
                .store(self.path.is_dir(), Ordering::SeqCst);
            self.dropped.store(true, Ordering::SeqCst);
        }
    }
    let dropped = Arc::new(AtomicBool::new(false));
    let directory_present = Arc::new(AtomicBool::new(false));
    let mut path = None;
    Directory::with_runtime(|directory, runtime| {
        path = Some(directory.0.clone());
        let pending = PendingTask {
            path: directory.0.clone(),
            dropped: dropped.clone(),
            directory_present: directory_present.clone(),
        };
        runtime.spawn(async move {
            let _pending = pending;
            std::future::pending::<()>().await;
        });
        runtime.block_on(tokio::task::yield_now());
        assert!(!dropped.load(Ordering::SeqCst));
    });
    assert!(dropped.load(Ordering::SeqCst));
    assert!(directory_present.load(Ordering::SeqCst));
    assert!(!path.unwrap().exists());
}

#[test]
fn directory_cleanup_preserves_non_sharing_errors_without_retry() {
    let directory = Directory::isolated();
    let mut retries = 0;
    let error =
        remove_fixture_directory(&directory.0.join("missing"), || retries += 1).unwrap_err();
    assert_eq!(error.kind(), std::io::ErrorKind::NotFound);
    assert_eq!(retries, 0);
    assert!(directory.0.is_dir());
}

#[cfg(windows)]
#[test]
fn directory_cleanup_retries_a_real_windows_sharing_lock_until_release() {
    use std::{fs::OpenOptions, os::windows::fs::OpenOptionsExt, sync::mpsc};
    let directory = Directory::isolated();
    let child = directory.0.join("short-lock");
    fs::create_dir(&child).unwrap();
    let database = child.join("locked.db");
    fs::write(&database, b"synthetic lock fixture").unwrap();
    let held = OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(&database)
        .unwrap();
    let (first_violation, observed) = mpsc::channel();
    let cleanup_path = child.clone();
    let cleanup = std::thread::spawn(move || {
        let mut first_violation = Some(first_violation);
        remove_fixture_directory(&cleanup_path, || {
            if let Some(sender) = first_violation.take() {
                sender.send(()).unwrap();
            }
        })
    });
    // Release only after the real Windows remove operation reports contention.
    observed
        .recv_timeout(std::time::Duration::from_secs(1))
        .unwrap();
    drop(held);
    cleanup.join().unwrap().unwrap();
    assert!(!child.exists());
}

#[cfg(windows)]
#[test]
fn directory_cleanup_keeps_a_persistent_windows_sharing_lock_fatal() {
    use std::{fs::OpenOptions, os::windows::fs::OpenOptionsExt};
    let directory = Directory::isolated();
    let child = directory.0.join("persistent-lock");
    fs::create_dir(&child).unwrap();
    let database = child.join("locked.db");
    fs::write(&database, b"synthetic lock fixture").unwrap();
    let held = OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(&database)
        .unwrap();
    let start = std::time::Instant::now();
    let mut retries = 0;
    let error = remove_fixture_directory(&child, || retries += 1).unwrap_err();
    assert!(matches!(error.raw_os_error(), Some(32 | 33)));
    assert!(retries > 0);
    assert!(start.elapsed() >= CLEANUP_LOCK_BUDGET);
    assert!(database.is_file());
    drop(held);
}

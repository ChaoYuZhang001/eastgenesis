// Local, feature-only QA observer. SPDX-License-Identifier: Apache-2.0 OR MIT

use crate::Error;

/// Fixed QA load stages. This type and its registration API do not exist without
/// the `qa-load-observer` feature. No variant carries runtime or error data.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum QaLoadStage {
    PluginReady,
    LoadEntered,
    ConnectStarted,
    ConnectResolved,
    ConnectInvalidUrl,
    ConnectConfigurationFailed,
    ConnectCannotOpen,
    ConnectLocked,
    ConnectIoPermissionDenied,
    ConnectFailed,
    MigrationStarted,
    MigrationResolved,
    MigrationVersionMismatch,
    MigrationDirty,
    MigrationFailed,
    LoadResolved,
}

#[derive(Clone, Copy, Default)]
pub(crate) struct QaLoadObserver(Option<(&'static str, fn(QaLoadStage))>);

impl QaLoadObserver {
    pub(crate) fn new(expected_db: &'static str, observer: fn(QaLoadStage)) -> Self {
        Self(Some((expected_db, observer)))
    }

    pub(crate) fn emit(&self, db: &str, stage: QaLoadStage) {
        if let Some((expected_db, observer)) = self.0 {
            if db == expected_db {
                // Only the optional callback is guarded. Connection, migration,
                // publication and their original errors keep ordinary semantics.
                let _ = std::panic::catch_unwind(|| observer(stage));
            }
        }
    }

    fn enabled_for(&self, db: &str) -> bool {
        self.0.is_some_and(|(expected_db, _)| db == expected_db)
    }

    pub(crate) fn plugin_ready(&self) {
        if let Some((expected_db, _)) = self.0 {
            self.emit(expected_db, QaLoadStage::PluginReady);
        }
    }

    pub(crate) fn connect_result<T>(&self, db: &str, result: Result<T, Error>) -> Result<T, Error> {
        if !self.enabled_for(db) {
            return result;
        }
        let stage = match &result {
            Ok(_) => QaLoadStage::ConnectResolved,
            Err(error) => connect_failure(error),
        };
        self.emit(db, stage);
        result
    }

    pub(crate) fn migration_result<T>(
        &self,
        db: &str,
        result: Result<T, Error>,
    ) -> Result<T, Error> {
        if !self.enabled_for(db) {
            return result;
        }
        let stage = match &result {
            Ok(_) => QaLoadStage::MigrationResolved,
            Err(Error::Migration(sqlx::migrate::MigrateError::VersionMismatch(_))) => {
                QaLoadStage::MigrationVersionMismatch
            }
            Err(Error::Migration(sqlx::migrate::MigrateError::Dirty(_))) => {
                QaLoadStage::MigrationDirty
            }
            Err(_) => QaLoadStage::MigrationFailed,
        };
        self.emit(db, stage);
        result
    }
}

fn connect_failure(error: &Error) -> QaLoadStage {
    match error {
        Error::InvalidDbUrl(_) => QaLoadStage::ConnectInvalidUrl,
        Error::Sql(sqlx::Error::Configuration(_)) => QaLoadStage::ConnectConfigurationFailed,
        Error::Sql(sqlx::Error::Io(error))
            if error.kind() == std::io::ErrorKind::PermissionDenied =>
        {
            QaLoadStage::ConnectIoPermissionDenied
        }
        #[cfg(feature = "sqlite")]
        Error::Sql(sqlx::Error::Database(error)) => {
            let primary = error
                .try_downcast_ref::<sqlx::sqlite::SqliteError>()
                .and_then(sqlx::error::DatabaseError::code)
                .and_then(|code| code.parse::<u32>().ok())
                .map(|code| code & 0xff);
            match primary {
                Some(14) => QaLoadStage::ConnectCannotOpen,
                Some(5 | 6) => QaLoadStage::ConnectLocked,
                _ => QaLoadStage::ConnectFailed,
            }
        }
        _ => QaLoadStage::ConnectFailed,
    }
}

#[cfg(all(test, feature = "sqlite"))]
#[path = "qa_load_observer_tests.rs"]
mod tests;

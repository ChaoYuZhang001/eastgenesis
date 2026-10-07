# Local migration retry patch

This directory vendors the published `tauri-plugin-sql` 2.5.0 crate from the
already pinned Cargo dependency. `UPSTREAM.json` records the archive checksum,
the package's VCS commit, and every copied file's original SHA-256. The archive
checksum was verified against the repository's pre-patch Cargo.lock before
copying. The original Apache-2.0 and MIT licenses, SPDX record, package manifest,
and source copyright notices are retained.

The migration retry change is confined to `src/commands.rs` and a borrowed
`MigrationSource` implementation in `src/lib.rs`. A load keeps its migration
definitions registered until SQLx successfully migrates its pool. The existing
registry mutex stays held across migration, so another load cannot bypass an
unfinished attempt. Failure or cancellation releases the lock while retaining
the definitions. The public plugin API, database paths, command arguments,
return values, JSON behavior, and successful-load consumption remain unchanged.
This also serializes first migrations for different URLs in the same app.

The preload setup path is unchanged: a failed preload already fails plugin
setup, so it cannot publish an app whose next load bypasses that failed setup.

`src/migration_retry_tests.rs` uses real SQLx and isolated SQLite databases to
exercise the same private migration helper used by the load command. It checks
transaction rollback, repair and retry, repeated checksum/dirty rejection,
concurrent-load serialization, and no replay after success. The manifest only
adds Tokio runtime/time features for tests; it adds no new dependency package.

The root workspace explicitly includes this package so the existing workspace
gate also executes its SQLite unit tests. Cargo's workspace lock resolution now
includes the official package's existing optional MySQL/Postgres TLS features:
`sqlx-core` gains edges to the already locked `rustls` and `webpki-roots 0.26.11`.
No dependency package version changes. The root lock also removes this package's
registry source/checksum because the root patch resolves it to this directory;
the original checksum remains in `UPSTREAM.json`.

Run `cargo test -p tauri-plugin-sql --features sqlite --locked` from the workspace.
This test is a plugin regression, not native app or production-release upgrade
evidence. Do not edit published migrations to accommodate an old database.

Registry cache metadata, the upstream crate's independent Cargo.lock, build
output, targets, and Git directories are deliberately not vendored. Future
upstream updates should compare this narrow patch and the regression tests
before removing the root Cargo patch override.

## Feature-only QA load observer

The empty `qa-load-observer` feature adds `QaLoadStage` and
`Builder::with_qa_load_observer(expected_db: &'static str, observer: fn(QaLoadStage))`.
The observer API, builder field, managed state and command calls are compiled
out without this feature. A feature-enabled builder without a callback is a
no-op, and only the exact registered database string is observed. Missing
managed observer state is also a no-op. A disabled or nonmatching observer does
not classify errors or invoke database-error trait methods.

The 16 unit variants are `PluginReady`, `LoadEntered`, `ConnectStarted`,
`ConnectResolved`, `ConnectInvalidUrl`, `ConnectConfigurationFailed`,
`ConnectCannotOpen`, `ConnectLocked`, `ConnectIoPermissionDenied`,
`ConnectFailed`, `MigrationStarted`, `MigrationResolved`,
`MigrationVersionMismatch`, `MigrationDirty`, `MigrationFailed` and
`LoadResolved`. `PluginReady` follows installation of the connection,
migration and observer states. `LoadResolved` follows successful migration and
publication of the pool in `DbInstances`. The migration stages bracket the
registered-migration phase, which can be a no-op after a successful load has
consumed its definitions; they do not imply SQL was replayed.

Failure stages inspect only typed `Error`, SQLx and `MigrateError` variants.
SQLite codes are read only after downcasting to `SqliteError`, then masked to
the primary code: 14 means cannot open, and 5/6 mean busy/locked. A foreign
database error with the same numeric code remains `ConnectFailed`. Only direct
migration `VersionMismatch` and `Dirty` errors have distinct stages; other
migration failures remain generic. No event carries a URL, path, SQL, error
text, version, numeric code or other runtime value, and classification never
formats `Display` or reads the database error message.

The result helpers move the original `Result` through unchanged. Only callback
execution is guarded with `catch_unwind`; connection, migration, publication
and the upstream wrapper's expectations keep their existing semantics. The
ordinary panic hook is not replaced. Panic isolation assumes Rust's unwinding
panic strategy, as used by the QA build; an aborting process cannot recover a
callback panic.

`src/qa_load_observer_tests.rs` checks the public registration method, helper
event order, unchanged success/error identity, absent/nonmatching observers,
poisoned trait methods behind the gate, foreign database codes, callback panic
isolation and actual SQLite cannot-open, busy, constraint, checksum, dirty and
migration execution errors. These are typed helper and real database tests;
they do not launch a native Tauri app or prove native IPC/load-stage ordering.
The command still has the same arguments, return value, serialized errors and
pool-publication point. Native QA must verify the actual command trace.

Run `cargo test -p tauri-plugin-sql --features sqlite,qa-load-observer --locked`
for the observer tests and the existing migration-retry tests, and
`cargo test -p tauri-plugin-sql --features sqlite --locked` to check the ordinary
configuration. Future upstream refreshes must preserve both regression suites
and review observer placement against upstream load/setup changes.

## Opaque SQLite application-directory path

`src/wrapper.rs` also corrects the private SQLite URL mapper. The app config
directory is a native file path, so literal `%`, `?` and `#` in that directory
must be escaped before SQLx parses the generated SQLite URL. In particular,
Tauri's relative directory override resolves through the canonical executable
path; on Windows its verbatim `\\?\` prefix contains a `?` that SQLx otherwise
treats as the query separator. SQLx then returns a typed configuration error
before any SQLite database is opened.

The mapper escapes the directory separately from the caller's original SQLite
URL suffix. It preserves a Windows verbatim prefix until `PathBuf::push` has
performed the original native join, then URL-escapes that prefix's `?`. Caller
percent escapes and query parameters, including duplicate and unknown query
parameters, still reach the same SQLx parser. The existing native absolute and
relative path joining behavior, `sqlite://` behavior, and mapped `:memory:`
behavior are preserved. A verbatim prefix supplied by the caller itself still
has its original URL-parser behavior; only the application directory's prefix
is escaped. An absolute caller path can still discard a non-UTF-8 app directory,
while a retained non-UTF-8 directory keeps the original expectation failure.
The database-exists/create-database/pool-connect calls,
SQLx errors, migration registry and command contract are unchanged. No prefix
is removed, no database error is swallowed by this patch, and the installation
gate is unchanged.

`src/sqlite_path_tests.rs` uses the real SQLx parser to compare caller behavior
with the original mapper, exercise synthetic Windows verbatim disk/UNC paths,
and verify literal directory characters and query options. An isolated real
SQLite create/close/reopen case verifies one database path, retained schema and
sentinel, and (on Unix) unchanged device/inode identity. On Windows, this test
uses the canonical verbatim path with legal literal percent characters; Unix additionally
exercises a physical directory containing a literal question mark.

These regressions prove parser and filesystem behavior on their test platform.
They do not prove the full native Windows NSIS installation lifecycle; that
gate must still be rerun against the patched app. The existing CI's redacted
`sql_connect_configuration_failed` record establishes the typed failure branch,
while the precise unsanitized Windows path remains an inference from source
and the synthetic parser reproduction.

### Test fixture teardown (2026-10-07)

The SQLite create/reopen fixture keeps its isolated directory alive until the
Tokio runtime has been dropped, after the existing explicit connection and pool
close operations. Directory removal retries only actual Windows sharing/lock
violations (Os32/33), with a 250 ms retry budget and at most 10 ms between
attempts. Success returns immediately; other errors and persistent locks remain
fatal. This is a retry budget, not a hard deadline on filesystem operations.

The production path mapping, database-exists/create-database calls, schema-7 and
sentinel assertions, single database file check, and Unix device/inode identity
proof remain unchanged. Portable regressions check runtime-task drop ordering
and propagation of other filesystem errors. Windows regressions use real
`share_mode(0)` handles to verify eventual release and a persistent lock.

The earlier CI cleanup failure establishes a sharing violation during removal;
it does not identify the lock holder or prove a production SQLx connection
fault. The Windows regressions and complete installation gate must be run on
Windows against the new source snapshot.

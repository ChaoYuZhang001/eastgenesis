// Synthetic legacy-compatible schema-6 acceptance through the actual macOS QA
// app/plugin, followed by one restart of the same owned profile. This does not
// reproduce a database or binary from a historical production release.
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { constants } from "node:fs";
import { access, lstat, open, readdir, readFile, readlink, realpath, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join, relative, isAbsolute, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash, randomUUID } from "node:crypto";

const exec = promisify(execFile);
const repo = resolve(fileURLToPath(new URL("..", import.meta.url)));
const binaryRelative = "Contents/MacOS/eastgenesis-desktop";
const parserPath = join(repo, "tools/desktop-startup-trace.mjs");
const cleanupPath = join(repo, "tools/desktop-process-cleanup.mjs");
const sqlitePath = "/usr/bin/sqlite3";
const parserSha256 = "569b72ffa6fd6ef78bfa64db53f26ce77647fb19fd32d9f4f4e534d61dc5439f";
const cleanupSha256 = "96138f637b706f1c7707b6906dcb4abb8bbd0311d180441f767ca3f36e956c53";
const digest = (bytes, algorithm = "sha256") => createHash(algorithm).update(bytes).digest("hex");
const hash = async (path) => digest(await readFile(path));
const exists = async (path) => { try { await access(path); return true; } catch { return false; } };
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const quote = (value) => value === null ? "NULL" : typeof value === "number" ? String(value) : `'${String(value).replaceAll("'", "''")}'`;
function fail(stage) { throw Object.assign(new Error(stage), { stage }); }
function requireThat(condition, stage) { if (!condition) fail(stage); }
function within(parent, child) { const name = relative(parent, child); return name === "" || !name.startsWith("..") && !isAbsolute(name); }
const REQUIRED_NATIVE = ["native_started", "native_state_ready", "sql_plugin_ready", "sql_load_entered", "sql_connect_started", "sql_connect_resolved", "sql_migration_started", "sql_migration_resolved", "sql_load_resolved"];
const REQUIRED_FRONTEND = ["document_start", "frontend_entry", "backend_tauri", "sql_import_started", "sql_import_resolved", "db_load_resolved", "schema_read_resolved", "frontend_ready"];
const OLD_COLUMNS = {
  app_meta: ["key", "value"],
  projects: ["id", "name", "description", "instructions", "context_folders", "routing_preference", "archived", "created_at", "updated_at", "deleted_at"],
  goals: ["id", "project_id", "description", "instructions", "routing_preference", "status", "rounds", "max_llm_calls", "used_llm_calls", "created_at", "updated_at", "deleted_at"],
  memories: ["id", "kind", "text", "source", "created_at", "updated_at", "use_count", "last_used_at", "project_id", "deleted_at"],
  skills: ["id", "name", "description", "steps", "source", "created_at", "updated_at", "use_count", "last_used_at"],
  sessions: ["id", "project_id", "title", "turns", "created_at", "updated_at", "deleted_at"],
  usage_calls: ["id", "session_id", "task_id", "goal_id", "project_id", "profile_id", "input_tokens", "output_tokens", "baseline_profile_id", "created_at"],
  tool_invocations: ["idempotency_key", "task_id", "step_id", "invocation_id", "tool", "args_digest", "attempt", "state", "artifacts", "detail", "created_at", "updated_at"],
};
const ORDER_BY = { app_meta: "key", tool_invocations: "idempotency_key" };
let workDeadline = Infinity, totalDeadline = Infinity, activeProcessDeadline = Infinity, cleanupHelper, traceParser, databaseIdentity;
let ownedRoot, copy, home, database, sourceBundle, sourceBinary, sourceDataDirectory, sourceBinaryDirectory, manifestPath;
let options = {}, output = join(tmpdir(), "eastgenesis-schema-upgrade-native.json"), expectedSources, baseline, migrations, fixtureSnapshot, upgradedSnapshot;
const liveApps = new Set();
const report = {
  schemaVersion: 1, kind: "macos-isolated-qa-synthetic-schema-upgrade", startedAt: new Date().toISOString(),
  passed: false, runCompleted: false,
  budgets: { totalMs: 120_000, cleanupReserveMs: 15_000, perProcessMs: 30_000, stableObservationMs: 1_100, pollMs: 100, sqliteCommandMs: 1_000 },
  isolation: { ownedCopiedBundle: true, freshHome: true, sameProfileAcrossRounds: true,
    appdataPrecreated: true, appdataPrecreatedReason: "owned synthetic schema-6 fixture", fixtureTransactionClosedBeforeLaunch: false,
    sqliteAccessAfterFixture: "readonly", inheritedEnvironment: "none", providerKeyEnvironmentInherited: false,
    privateConfigurationRead: false, keychainGuard: "QA isolated profile with hash-bound guard source", appStdio: "ignore", axUsed: false,
    providerTarget: "unreachable synthetic loopback", syntheticModelCacheSeeded: true,
    dataRootResolution: "app_bundle_parent/eg-qa-appdata", traceSidecarResolution: "Contents/MacOS", realProviderRequested: false },
  evidenceBoundary: { proven: [], excluded: ["historical production release upgrade", "private or production database", "real Provider",
    "performance baseline", "pixel or AX UI readiness", "Windows", "Linux", "signing/notarization", "ordinary release binary",
    "legacy checkpoint parser hydration", "recovered task execution"],
    fixtureOrigin: "synthetic legacy-compatible SQLite pinned to the current Rust migration prefix 1-6",
    jsonFixtureMeaning: "nonempty synthetic completed sentinels; byte preservation does not prove historical parser hydration or recovered tool execution",
    migrationAuthority: "only the actual app SQL plugin may apply migration 7; harness applies prefix 1-6 once",
    traceCompleteMeaning: "structurally valid snapshot; required stages and physical SQL state are checked separately" },
  rounds: [
    { name: "actual_plugin_schema_6_to_7", plannedAttemptCount: 1, status: "not_run" },
    { name: "same_profile_restart_schema_7", plannedAttemptCount: 1, status: "not_run" },
  ],
};

function parseOptions(args) {
  const allowed = new Set(["--app-bundle", "--compiled-source-manifest", "--expected-binary-sha256", "--expected-harness-sha256", "--output", "--timeout-ms"]);
  const parsed = {};
  for (const argument of args) {
    const separator = argument.indexOf("=");
    const name = argument.slice(0, separator), value = argument.slice(separator + 1);
    requireThat(separator > 0 && allowed.has(name) && !Object.hasOwn(parsed, name) && value.length > 0, "arguments_invalid");
    parsed[name] = value;
  }
  return parsed;
}
function commandBudget(maximum) {
  const remaining = Math.floor(Math.min(workDeadline, activeProcessDeadline) - performance.now());
  requireThat(remaining > 0, performance.now() >= activeProcessDeadline ? "process_budget_exceeded" : "work_budget_exceeded");
  return Math.max(1, Math.min(maximum, remaining));
}
async function sqlite(db, sql, write = false) {
  requireThat(within(ownedRoot, db), "sqlite_outside_owned_root");
  const before = await lstat(db).catch(() => null);
  if (!write) requireThat(before?.isFile() && !before.isSymbolicLink() && before.dev === databaseIdentity?.dev && before.ino === databaseIdentity?.ino, "database_identity_changed");
  let result;
  try {
    result = await exec(sqlitePath, [...(write ? [] : ["-readonly"]), "-batch", "-json", "-cmd", ".timeout 250", db, sql], {
      timeout: commandBudget(write ? 5_000 : report.budgets.sqliteCommandMs), maxBuffer: 256 * 1024,
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "en_US.UTF-8", HOME: home, TMPDIR: join(home, "tmp") },
    });
  } catch (error) {
    // Inspect only to classify a fixed code; never publish helper stderr.
    if (!write && /database is locked/.test(String(error.stderr ?? ""))) fail("readonly_sqlite_locked");
    fail(write ? "fixture_sqlite_failed" : "readonly_sqlite_failed");
  }
  const after = await lstat(db);
  requireThat(after.isFile() && !after.isSymbolicLink(), "database_file_invalid");
  if (!write) requireThat(after.dev === before.dev && after.ino === before.ino, "database_identity_changed");
  try { return result.stdout.trim() ? JSON.parse(result.stdout) : []; }
  catch { fail("sqlite_json_invalid"); }
}

// Consume every token in the MIGRATIONS block. Unknown Rust escape syntax,
// unparsed tuples, changed versions and raw strings fail before app launch.
function readMigrations(source) {
  const declaration = "pub const MIGRATIONS: &[(i64, &str, &str)] = &[";
  requireThat(source.split(declaration).length === 2, "migration_declaration_invalid");
  const start = source.indexOf(declaration) + declaration.length, end = source.indexOf("\n];", start);
  requireThat(end > start, "migration_block_invalid");
  const text = source.slice(start, end); let position = 0;
  function skip() {
    for (;;) {
      while (/\s/.test(text[position] ?? "") && position < text.length) position++;
      if (text.slice(position, position + 2) !== "//") return;
      const newline = text.indexOf("\n", position); position = newline < 0 ? text.length : newline + 1;
    }
  }
  function token(expected) { skip(); requireThat(text[position++] === expected, "migration_token_invalid"); }
  function literal() {
    token('"'); let value = "";
    while (position < text.length) {
      const character = text[position++];
      if (character === '"') return value;
      if (character !== "\\") { value += character; continue; }
      const escaped = text[position++];
      if (escaped === "\n" || escaped === "\r" && text[position] === "\n") {
        if (escaped === "\r") position++;
        while (/[ \t\r\n]/.test(text[position] ?? "") && position < text.length) position++;
      } else {
        const escapes = { n: "\n", t: "\t", r: "\r", "\\": "\\", '"': '"', "'": "'", 0: "\0" };
        requireThat(Object.hasOwn(escapes, escaped), "migration_escape_unsupported"); value += escapes[escaped];
      }
    }
    fail("migration_literal_unterminated");
  }
  const result = [];
  for (;;) {
    skip(); if (position === text.length) break;
    token("("); skip(); const versionMatch = /^\d+/.exec(text.slice(position));
    requireThat(versionMatch, "migration_version_invalid"); position += versionMatch[0].length;
    token(","); const description = literal(); token(","); const sql = literal(); token(","); token(")"); token(",");
    const version = Number(versionMatch[0]);
    requireThat(/^[a-z_]{1,100}$/.test(description) && sql.includes(`('schema_version', '${version}')`), "migration_contents_invalid");
    result.push({ version, description, sql, sqlUtf8Bytes: Buffer.byteLength(sql, "utf8"), checksumSha384: digest(sql, "sha384") });
  }
  requireThat(same(result.map((m) => m.version), [1, 2, 3, 4, 5, 6, 7]), "migration_prefix_contract_changed");
  requireThat(result[6].description === "add_tool_invocation_leases", "migration_7_contract_changed");
  return result;
}

function fixtureRows() {
  const stamp = 1_000, deleted = 1_500;
  const rounds = JSON.stringify([{ index: 1, title: "Synthetic finished round", items: [{ id: "item-fixture", text: "Synthetic completed item", status: "done" }],
    status: "done", evidence: { tool_calls: [], file_changes: [], command_outputs: [] }, verdict: { verdict: "done", reason: "Synthetic fixture", by: "user" },
    task_id: "task-fixture-goal", started_at: stamp, finished_at: 1_100 }]);
  const turns = JSON.stringify([{ id: "task-fixture-session", seq: 1, goal: "Synthetic finished turn", status: "completed", summary: "Synthetic summary",
    events: [{ type: "run_end", status: "completed", summary: "Synthetic summary" }], lock: null, permission: "confirm", files: [], multi: false, startedAt: stamp, endedAt: 1_100,
    goalId: null, mode: "quick", preference: "balanced", preferenceSource: "global", surfaceHint: "chat", streamingText: "", streamingInterrupted: false }]);
  const settings = {
    routing: { preference: "economy", latency: "patient", maxCostTier: 3 }, profiles: {}, provider_prefs: {}, net_timeout: 60,
    model_cache: { "custom:qa": { models: ["fixture-model"], fetchedAt: stamp } }, onboarded: true, show_reasoning: true, default_permission: "confirm",
  };
  const rows = {
    app_meta: Object.entries(settings).map(([key, value]) => [`settings:${key}`, JSON.stringify(value)]),
    projects: [], goals: [], memories: [], skills: [], sessions: [], usage_calls: [], tool_invocations: [],
  };
  for (const [suffix, deletedAt] of [["active", null], ["deleted", deleted]]) {
    const project = `prj-fixture-${suffix}`, goal = `goal-fixture-${suffix}`, session = `ses-fixture-${suffix}`;
    rows.projects.push([project, `Synthetic ${suffix} project`, "Synthetic description", "Synthetic instructions", JSON.stringify(["synthetic-folder-label"]), "balanced", suffix === "deleted" ? 1 : 0, stamp, 1_200, deletedAt]);
    rows.goals.push([goal, project, "Synthetic goal", "Synthetic instructions", "economy", suffix === "deleted" ? "deleted" : "completed", rounds, 9, 2, stamp, 1_200, deletedAt]);
    rows.memories.push([`mem-fixture-${suffix}`, "fact", "Synthetic memory", "manual", stamp, 1_200, 4, 1_100, project, deletedAt]);
    rows.skills.push([`skill-fixture-${suffix}`, `Synthetic ${suffix} skill`, "Synthetic description", JSON.stringify([{ goal: "Synthetic manual step", tool: null }]), "manual", stamp, 1_200, 5, 1_100]);
    rows.sessions.push([session, project, `Synthetic ${suffix} session`, turns, stamp, 1_200, deletedAt]);
    rows.usage_calls.push([`usage-fixture-${suffix}`, session, "task-fixture-usage", goal, project, "custom:qa/fixture-model", 7, 11, "synthetic-baseline", stamp]);
  }
  for (const [index, state] of ["unknown", "started", "applied", "conflict"].entries()) rows.tool_invocations.push([
    `eg-fixture-${state}`, `task-fixture-ledger-${state}`, `step-fixture-${state}`, `inv-fixture-${state}`, "synthetic_tool",
    digest(`synthetic-arguments-${state}`), index + 1, state, JSON.stringify([{ kind: "synthetic", ref: `fixture-${state}` }]), `Synthetic ${state} detail`, stamp + index, 1_200 + index,
  ]);
  return rows;
}
async function createFixture() {
  const dataDirectory = dirname(database); await mkdir(dataDirectory);
  requireThat(!await exists(database), "fixture_database_already_exists");
  const tableSql = "CREATE TABLE _sqlx_migrations (version BIGINT PRIMARY KEY, description TEXT NOT NULL, installed_on TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, success BOOLEAN NOT NULL, checksum BLOB NOT NULL, execution_time BIGINT NOT NULL);";
  const statements = ["PRAGMA foreign_keys=ON; PRAGMA journal_mode=DELETE; BEGIN IMMEDIATE;", tableSql];
  for (const migration of migrations.slice(0, 6)) {
    statements.push(migration.sql);
    statements.push(`INSERT INTO _sqlx_migrations(version,description,installed_on,success,checksum,execution_time) VALUES (${migration.version},${quote(migration.description)},'2000-01-01 00:00:00',1,X'${migration.checksumSha384}',0);`);
  }
  const rows = fixtureRows();
  for (const [table, values] of Object.entries(rows)) for (const row of values) {
    requireThat(row.length === OLD_COLUMNS[table].length, "fixture_column_count_invalid");
    statements.push(`INSERT INTO ${table}(${OLD_COLUMNS[table].join(",")}) VALUES (${row.map(quote).join(",")});`);
  }
  statements.push("COMMIT;");
  report.fixture = { origin: report.evidenceBoundary.fixtureOrigin, schemaVersion: 6,
    creationSqlSha256: digest(statements.join("\n")), transactionCount: 1, executedMigrationVersions: [1, 2, 3, 4, 5, 6],
    migration7ExecutedByHarness: false, migrationMetadata: migrations.map(({ version, description, sqlUtf8Bytes, checksumSha384 }) => ({ version, description, sqlUtf8Bytes, checksumSha384 })),
    metadataReference: { sqlxVersion: "0.8.6", checksum: "SHA384 of exact decoded Rust SQL UTF-8 bytes", checksumSource: "sqlx-core/src/migrate/migration.rs:25",
      tableSource: "sqlx-sqlite/src/migrate.rs:72-79", legacyInstalledOn: "synthetic fixed timestamp", legacyExecutionTime: "synthetic zero nanoseconds" } };
  await sqlite(database, statements.join("\n"), true);
  const metadata = await lstat(database); databaseIdentity = { dev: metadata.dev, ino: metadata.ino };
  report.isolation.fixtureTransactionClosedBeforeLaunch = true;
  report.fixture.databaseStartSha256 = await hash(database);
  fixtureSnapshot = await readSnapshot();
  requireThat(fixtureSnapshot.schemaVersion === 6 && same(fixtureSnapshot.columns, OLD_COLUMNS) && fixtureSnapshot.integrity === "ok" && fixtureSnapshot.foreignKeyViolations === 0, "fixture_schema_invalid");
  const expectedRows = Object.fromEntries(Object.entries(rows).map(([table, values]) => [table, values.map((row) => Object.fromEntries(OLD_COLUMNS[table].map((column, index) => [column, row[index]]))).sort((a, b) => String(a[ORDER_BY[table] ?? "id"]).localeCompare(String(b[ORDER_BY[table] ?? "id"]))) ]));
  requireThat(same(fixtureSnapshot.tables, expectedRows), "fixture_rows_invalid");
  requireThat(validMigrationRows(fixtureSnapshot.migrations, 6) && fixtureSnapshot.leases.length === 0 && fixtureSnapshot.leaseIndex.length === 0, "fixture_migration_metadata_invalid");
  report.fixture.validation = projectedSnapshot(fixtureSnapshot);
  report.fixture.readonlyValidated = true;
}

async function readSnapshot() {
  const tableParts = [];
  for (const [table, columns] of Object.entries(OLD_COLUMNS)) {
    const args = columns.flatMap((column) => [quote(column), column]).join(",");
    const filter = table === "app_meta" ? "WHERE key != 'schema_version'" : "";
    tableParts.push(`${quote(table)},(SELECT json_group_array(json_object(${args})) FROM (SELECT ${columns.join(",")} FROM ${table} ${filter} ORDER BY ${ORDER_BY[table] ?? "id"}))`);
  }
  const rows = await sqlite(database, `SELECT json_object('tables',json_object(${tableParts.join(",")}),
    'schemaVersion',(SELECT CAST(value AS INTEGER) FROM app_meta WHERE key='schema_version'),
    'migrations',(SELECT json_group_array(json_object('version',version,'description',description,'installed_on',installed_on,'success',success,'checksumSha384',lower(hex(checksum)),'execution_time',execution_time)) FROM (SELECT * FROM _sqlx_migrations ORDER BY version)),
    'integrity',(SELECT integrity_check FROM pragma_integrity_check LIMIT 1),
    'foreignKeyViolations',(SELECT COUNT(*) FROM pragma_foreign_key_check)) AS snapshot;`);
  requireThat(rows.length === 1 && typeof rows[0].snapshot === "string", "sqlite_snapshot_invalid");
  let snapshot; try { snapshot = JSON.parse(rows[0].snapshot); } catch { fail("sqlite_snapshot_invalid"); }
  snapshot.columns = {};
  for (const table of Object.keys(OLD_COLUMNS)) snapshot.columns[table] = (await sqlite(database, `PRAGMA table_info(${table});`)).map((row) => row.name);
  snapshot.leases = snapshot.columns.tool_invocations.includes("lease_owner") && snapshot.columns.tool_invocations.includes("lease_expires_at")
    ? await sqlite(database, "SELECT idempotency_key,lease_owner,lease_expires_at FROM tool_invocations ORDER BY idempotency_key;") : [];
  snapshot.leaseIndex = await sqlite(database, "PRAGMA index_info(tool_invocations_lease);");
  return snapshot;
}
function validMigrationRows(rows, count) {
  return Array.isArray(rows) && rows.length === count && rows.every((row, index) => row.version === index + 1 && row.description === migrations[index].description
    && row.success === 1 && row.checksumSha384 === migrations[index].checksumSha384 && typeof row.installed_on === "string"
    && Number.isSafeInteger(row.execution_time) && row.execution_time >= 0);
}
function projectedSnapshot(snapshot) {
  return { schemaVersion: snapshot.schemaVersion, integrity: snapshot.integrity, foreignKeyViolations: snapshot.foreignKeyViolations,
    tables: Object.fromEntries(Object.entries(snapshot.tables).map(([table, rows]) => [table, { rowCount: rows.length, allOldFieldsSha256: digest(JSON.stringify(rows)), columnCount: snapshot.columns[table].length }])),
    toolInvocationStates: snapshot.tables.tool_invocations.map((row) => row.state),
    migrations: snapshot.migrations, leaseColumnCount: snapshot.columns.tool_invocations.filter((column) => ["lease_owner", "lease_expires_at"].includes(column)).length,
    allLegacyLeasesNull: snapshot.leases.length === 4 && snapshot.leases.every((row) => row.lease_owner === null && row.lease_expires_at === null),
    leaseIndexColumns: snapshot.leaseIndex.map((row) => row.name), totalSnapshotSha256: digest(JSON.stringify(snapshot)) };
}
function preservationChecks(snapshot) {
  const expectedColumns = { ...OLD_COLUMNS, tool_invocations: [...OLD_COLUMNS.tool_invocations, "lease_owner", "lease_expires_at"] };
  const checks = Object.fromEntries(Object.keys(OLD_COLUMNS).map((table) => [`${table}_all_old_fields_preserved`, same(snapshot.tables[table], fixtureSnapshot.tables[table])]));
  Object.assign(checks, { schema_7: snapshot.schemaVersion === 7, all_table_columns_match: same(snapshot.columns, expectedColumns),
    integrity_ok: snapshot.integrity === "ok", foreign_keys_clean: snapshot.foreignKeyViolations === 0,
    legacy_sqlx_metadata_unchanged: same(snapshot.migrations.slice(0, 6), fixtureSnapshot.migrations),
    sqlx_exact_versions_checksums_success: validMigrationRows(snapshot.migrations, 7),
    legacy_lease_fields_null: snapshot.leases.length === 4 && snapshot.leases.every((row) => row.lease_owner === null && row.lease_expires_at === null),
    lease_index_exact: snapshot.leaseIndex.length === 1 && snapshot.leaseIndex[0].seqno === 0 && snapshot.leaseIndex[0].name === "lease_expires_at",
    unknown_started_applied_conflict_preserved: same(snapshot.tables.tool_invocations.map((row) => row.state), fixtureSnapshot.tables.tool_invocations.map((row) => row.state)),
    goals_rounds_nonempty_preserved: snapshot.tables.goals.every((row) => row.rounds !== "[]") && same(snapshot.tables.goals, fixtureSnapshot.tables.goals),
    sessions_turns_nonempty_preserved: snapshot.tables.sessions.every((row) => row.turns !== "[]") && same(snapshot.tables.sessions, fixtureSnapshot.tables.sessions),
    soft_deleted_rows_preserved: ["projects", "goals", "memories", "sessions"].every((table) => snapshot.tables[table].filter((row) => row.deleted_at !== null).length === 1 && same(snapshot.tables[table], fixtureSnapshot.tables[table])),
  });
  return checks;
}

async function sourceHashes(expected) {
  requireThat(expected && typeof expected === "object" && !Array.isArray(expected) && Object.keys(expected).length >= 286, "full_source_manifest_required");
  for (const name of ["Cargo.toml", "Cargo.lock", "crates/eg-core/src/lib.rs", "src-tauri/Cargo.toml", "src-tauri/src/main.rs", "src-tauri/src/lib.rs", "src-tauri/src/keychain.rs",
    "src-tauri/src/qa_install_probe.rs", "src-tauri/src/qa_startup_diagnostics.rs", "src/lib/qa-startup.ts", "src/lib/db.ts", "src/platform/tauri-backend.ts", "src/stores/app.ts", "src/stores/settings.ts",
    "src-tauri/tauri.windows.install.qa.conf.json", "vendor/tauri-plugin-sql/Cargo.toml", "vendor/tauri-plugin-sql/build.rs", "vendor/tauri-plugin-sql/src/lib.rs", "vendor/tauri-plugin-sql/src/commands.rs", "vendor/tauri-plugin-sql/src/wrapper.rs", "vendor/tauri-plugin-sql/src/qa_load_observer.rs"]) {
    requireThat(/^[a-f0-9]{64}$/.test(expected[name] ?? ""), "required_source_input_missing");
  }
  for (const [name, sha] of Object.entries(expected)) requireThat(!isAbsolute(name) && within(repo, resolve(repo, name)) && /^[a-f0-9]{64}$/.test(sha), "source_manifest_entry_invalid");
  return Object.fromEntries(await Promise.all(Object.keys(expected).map(async (name) => [name, await hash(join(repo, name))])));
}
async function bundleSnapshot(directory) {
  const entries = {};
  async function walk(current) {
    for (const name of (await readdir(current)).sort()) {
      const path = join(current, name), metadata = await lstat(path), key = relative(directory, path);
      if (metadata.isSymbolicLink()) {
        requireThat(within(directory, await realpath(path)), "bundle_symlink_outside_copy");
        entries[key] = { kind: "symlink", sha256: digest(await readlink(path)) };
      } else if (metadata.isDirectory()) await walk(path);
      else if (metadata.isFile()) entries[key] = { kind: "file", sha256: await hash(path) };
      else fail("bundle_entry_invalid");
    }
  }
  await walk(directory); return entries;
}
async function originalMembersSnapshot() {
  const result = {};
  for (const [name, expected] of Object.entries(baseline)) {
    const path = join(copy, name), metadata = await lstat(path);
    requireThat(expected.kind === "symlink" ? metadata.isSymbolicLink() && within(copy, await realpath(path)) : metadata.isFile() && !metadata.isSymbolicLink(), "copy_member_type_changed");
    result[name] = { kind: expected.kind, sha256: expected.kind === "symlink" ? digest(await readlink(path)) : await hash(path) };
  }
  return result;
}
async function sidecars(directory) { return (await readdir(directory)).filter((name) => /^eg-qa-startup-.*\.jsonl$/.test(name)).sort(); }
const alive = (child) => child && !cleanupHelper.hasProcessExited(child);
function groupGone(child) {
  try { process.kill(-child.pid, 0); return false; }
  catch (error) { return error.code === "ESRCH"; }
}
async function cleanupApp(child) {
  if (!Number.isSafeInteger(child.pid) || child.pid <= 0) return { controlledCleanup: false, processGroupGone: true, code: "spawn_without_pid" };
  let result;
  try { result = await cleanupHelper.stopDetachedProcess(child, { graceMs: 2_000, killMs: 2_000 }); }
  catch { result = { controlledCleanup: false, processAlreadyExited: !alive(child), code: "owned_process_cleanup_failed" }; }
  const until = Math.min(totalDeadline, performance.now() + 500);
  while (!groupGone(child) && performance.now() < until) await pause(50);
  result.processGroupGone = groupGone(child);
  if (result.processGroupGone && !alive(child)) liveApps.delete(child);
  return result;
}
async function readTrace(path, runId) {
  const unobserved = (reason) => ({ projected: traceParser.validateStartupTraceReport({ status: "unobserved", reason, runId, records: [] }), bytes: null, sha256: null });
  let metadata, handle;
  try { metadata = await lstat(path); } catch (error) { return unobserved(error.code === "ENOENT" ? "missing" : "read_failed"); }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > traceParser.MAX_TRACE_BYTES) return unobserved("invalid");
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); const opened = await handle.stat();
    requireThat(opened.isFile() && opened.dev === metadata.dev && opened.ino === metadata.ino, "trace_identity_changed");
    const buffer = Buffer.alloc(traceParser.MAX_TRACE_BYTES + 1); let size = 0;
    while (size < buffer.length) { const read = await handle.read(buffer, size, buffer.length - size, null); if (!read.bytesRead) break; size += read.bytesRead; }
    const after = await lstat(path);
    if (!after.isFile() || after.isSymbolicLink() || after.dev !== opened.dev || after.ino !== opened.ino || size > traceParser.MAX_TRACE_BYTES) return unobserved("invalid");
    let text; try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, size)); } catch { return unobserved("invalid"); }
    return { projected: traceParser.parseStartupTraceText(text, runId), bytes: size, sha256: digest(buffer.subarray(0, size)) };
  } catch { return unobserved("read_failed"); }
  finally { if (handle) await handle.close().catch(() => {}); }
}
function traceReady(trace) {
  return trace.status === "observed" && trace.reason === "complete" && REQUIRED_NATIVE.every((stage) => trace.records.some((record) => record.source === "native" && record.stage === stage))
    && REQUIRED_FRONTEND.every((stage) => trace.records.some((record) => record.source === "frontend" && record.stage === stage))
    && !trace.records.some((record) => /(?:_failed|_error|_rejection)$/.test(record.stage) || record.stage === "backend_mock");
}
async function captureTrace(round, tracePath) {
  const read = await readTrace(tracePath, round.runId); round.trace = read.projected; round.traceFileBytes = read.bytes; round.traceFileSha256 = read.sha256;
}
async function roundRun(round, index) {
  const binary = join(copy, binaryRelative), binaryDirectory = dirname(binary);
  round.startedAt = new Date().toISOString(); round.attemptCount = 1; round.runId = randomUUID(); round.schemaReadCounts = { schema6: 0, schema7: 0, other: 0, locked: 0 };
  const tracePath = join(binaryDirectory, `eg-qa-startup-${round.runId}.jsonl`); let child, processTimer;
  try {
    requireThat(liveApps.size === 0 && !await exists(tracePath), "prior_process_or_trace_present");
    round.prelaunch = { schemaVersion: (await readSnapshot()).schemaVersion, existingSidecarCount: (await sidecars(binaryDirectory)).length };
    requireThat(round.prelaunch.schemaVersion === (index === 0 ? 6 : 7) && round.prelaunch.existingSidecarCount === index, "round_prelaunch_state_invalid");
    round.binding = { binaryStartSha256: await hash(binary), originalMembersStart: await originalMembersSnapshot() };
    requireThat(round.binding.binaryStartSha256 === report.binding.expectedBinarySha256 && same(round.binding.originalMembersStart, baseline), "owned_copy_start_mismatch");
    const env = { HOME: home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", TMPDIR: join(home, "tmp"), LANG: "en_US.UTF-8",
      EASTGENESIS_QA_ISOLATED_PROFILE: "1", EASTGENESIS_QA_INSTALL_ISOLATION_REQUIRED: "1", EASTGENESIS_QA_STARTUP_DIAGNOSTICS: "1", EASTGENESIS_QA_STARTUP_RUN_ID: round.runId,
      EASTGENESIS_QA_PROVIDER_BASE_URL: "http://127.0.0.1:1", EASTGENESIS_QA_PROVIDER_MODEL: "fixture-model", EASTGENESIS_QA_PROVIDER_PROTOCOL: "openai" };
    const processStarted = performance.now(), until = Math.min(workDeadline, processStarted + report.budgets.perProcessMs);
    child = spawn(binary, [], { env, cwd: ownedRoot, detached: true, stdio: "ignore" }); child.on("error", () => {}); liveApps.add(child);
    requireThat(alive(child) && Number.isSafeInteger(child.pid) && child.pid > 0, "owned_app_spawn_failed");
    activeProcessDeadline = until;
    processTimer = setTimeout(() => {
      if (alive(child) || !groupGone(child)) {
        round.processBudgetExceeded = true;
        try { process.kill(-child.pid, "SIGKILL"); } catch { /* cleanup still proves group disappearance */ }
      }
    }, Math.max(1, until - performance.now()));
    let parent;
    try { parent = (await exec("/bin/ps", ["-p", String(child.pid), "-o", "ppid="], { timeout: commandBudget(1_000), maxBuffer: 1_024 })).stdout.trim(); }
    catch { fail("owned_app_parent_unverified"); }
    requireThat(Number(parent) === process.pid, "owned_app_parent_mismatch"); round.ownedParentVerified = true;
    round.ownedAppPid = child.pid; round.ownedParentPid = process.pid;
    let ready = false;
    while (performance.now() < until) {
      requireThat(alive(child), "owned_app_early_exit");
      let rows;
      try { rows = await sqlite(database, "SELECT CAST(value AS INTEGER) AS version FROM app_meta WHERE key='schema_version';"); }
      catch (error) {
        if (error.stage !== "readonly_sqlite_locked") throw error;
        round.schemaReadCounts.locked++; await pause(Math.min(report.budgets.pollMs, Math.max(0, until - performance.now()))); continue;
      }
      round.observedSchemaVersion = rows[0]?.version ?? null;
      round.schemaReadCounts[round.observedSchemaVersion === 6 ? "schema6" : round.observedSchemaVersion === 7 ? "schema7" : "other"]++;
      await captureTrace(round, tracePath);
      if (round.observedSchemaVersion === 7 && traceReady(round.trace)) { ready = true; break; }
      await pause(Math.min(report.budgets.pollMs, Math.max(0, until - performance.now())));
    }
    requireThat(ready, "schema_upgrade_or_frontend_ready_timeout");
    requireThat(performance.now() + report.budgets.stableObservationMs <= until, "process_observation_budget_exceeded");
    await pause(report.budgets.stableObservationMs); requireThat(alive(child), "owned_app_early_exit_after_ready");
    round.processAliveAfterObservation = true; round.processObservationElapsedMs = Math.round(performance.now() - processStarted);
    const snapshot = await readSnapshot(); round.validation = projectedSnapshot(snapshot); round.checks = preservationChecks(snapshot);
    if (index === 1) round.checks.restart_snapshot_unchanged = same(snapshot, upgradedSnapshot);
    await captureTrace(round, tracePath); round.checks.required_trace_stages = traceReady(round.trace);
    round.checks.expected_sidecar_count = (await sidecars(binaryDirectory)).length === index + 1;
    requireThat(Object.values(round.checks).every((value) => value === true), "migration_preservation_contract_failed");
    round.status = "passed";
  } catch (error) { round.status = "failed"; round.failure = { code: /^[a-z0-9_]{1,100}$/.test(error.stage ?? "") ? error.stage : "round_harness_error" }; }
  finally {
    try { await captureTrace(round, tracePath); } catch { round.traceCaptureFailed = true; }
    if (child) { round.appAliveAtCleanupEntry = alive(child); round.cleanupAttemptCount = 1; round.cleanup = await cleanupApp(child); }
    if (processTimer) clearTimeout(processTimer); activeProcessDeadline = Infinity;
    if (round.binding) {
      try {
        round.binding.binaryEndSha256 = await hash(binary); round.binding.originalMembersEnd = await originalMembersSnapshot();
        round.binding.unchanged = round.binding.binaryStartSha256 === round.binding.binaryEndSha256 && same(round.binding.originalMembersStart, round.binding.originalMembersEnd);
      } catch { round.binding.unchanged = false; }
    }
    if (!liveApps.size) {
      try {
        const afterStop = await readSnapshot(); round.afterStopValidation = projectedSnapshot(afterStop);
        round.afterStopChecks = preservationChecks(afterStop);
        if (index === 1) round.afterStopChecks.restart_snapshot_unchanged = same(afterStop, upgradedSnapshot);
        round.afterStopChecks.trace_ready = traceReady(round.trace);
        if (!Object.values(round.afterStopChecks).every((value) => value === true)) { round.status = "failed"; round.failure ??= { code: "after_stop_preservation_failed" }; }
        if (index === 0 && round.status === "passed") upgradedSnapshot = afterStop;
      } catch { round.status = "failed"; round.failure ??= { code: "after_stop_read_failed" }; }
    }
    round.finishedAt = new Date().toISOString();
    round.passed = round.status === "passed" && round.processBudgetExceeded !== true && round.binding?.unchanged === true && round.cleanup?.controlledCleanup === true && round.cleanup.processGroupGone === true;
    if (!round.passed) { round.status = "failed"; round.failure ??= { code: "round_cleanup_or_binding_failed" }; }
  }
}

try {
  options = parseOptions(process.argv.slice(2));
  if (options["--output"]) output = resolve(options["--output"]);
  requireThat(process.platform === "darwin", "macos_required");
  const totalMs = Number(options["--timeout-ms"] ?? 120_000);
  requireThat(Number.isInteger(totalMs) && totalMs >= 60_000 && totalMs <= 120_000, "bounded_total_budget"); report.budgets.totalMs = totalMs;
  totalDeadline = performance.now() + totalMs; workDeadline = totalDeadline - report.budgets.cleanupReserveMs;
  requireThat(output.endsWith(".json"), "json_output_required");
  for (const name of ["--expected-binary-sha256", "--expected-harness-sha256"]) requireThat(/^[a-f0-9]{64}$/.test(options[name] ?? ""), "explicit_hash_binding_required");
  requireThat(options["--compiled-source-manifest"], "explicit_compiled_manifest_required");
  sourceBundle = await realpath(resolve(options["--app-bundle"] ?? join(repo, "target/release/bundle/macos/EastGenesis Desktop.app")));
  requireThat(sourceBundle.endsWith(".app") && !within(sourceBundle, output), "app_bundle_or_output_invalid");
  sourceBinary = join(sourceBundle, binaryRelative); sourceBinaryDirectory = dirname(sourceBinary); sourceDataDirectory = join(dirname(sourceBundle), "eg-qa-appdata");
  manifestPath = resolve(options["--compiled-source-manifest"]); const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  requireThat(manifest.passed === true && manifest.sourceUnchanged === true && manifest.timedOut !== true && manifest.binarySha256 === options["--expected-binary-sha256"], "compiled_manifest_not_passed");
  expectedSources = manifest.sourceHashes;
  report.binding = { evidenceType: "worktree_isolated_qa_compiled_source_manifest", formalReleaseBinding: false,
    expectedBinarySha256: options["--expected-binary-sha256"], expectedHarnessSha256: options["--expected-harness-sha256"],
    manifestStartSha256: await hash(manifestPath), sourceInputs: manifest.sourceInputs, expectedSourceHashes: expectedSources, sourceStartHashes: await sourceHashes(expectedSources),
    binaryStartSha256: await hash(sourceBinary), harnessStartSha256: await hash(new URL(import.meta.url)), parserStartSha256: await hash(parserPath),
    cleanupHelperStartSha256: await hash(cleanupPath), sqliteHelperStartSha256: await hash(sqlitePath) };
  requireThat(report.binding.binaryStartSha256 === report.binding.expectedBinarySha256 && report.binding.harnessStartSha256 === report.binding.expectedHarnessSha256
    && report.binding.parserStartSha256 === parserSha256 && report.binding.cleanupHelperStartSha256 === cleanupSha256
    && same(report.binding.sourceStartHashes, expectedSources) && Object.keys(expectedSources).length === manifest.sourceInputs, "runtime_input_binding_failed");
  report.binding.sourceAppdataAbsentStart = !await exists(sourceDataDirectory);
  requireThat(report.binding.sourceAppdataAbsentStart && (await sidecars(sourceBinaryDirectory)).length === 0, "source_bundle_not_clean");
  traceParser = await import(`${pathToFileURL(parserPath).href}?binding=${parserSha256}`);
  cleanupHelper = await import(`${pathToFileURL(cleanupPath).href}?binding=${cleanupSha256}`);
  requireThat(await hash(parserPath) === parserSha256 && await hash(cleanupPath) === cleanupSha256 && traceParser.MAX_TRACE_BYTES === 32 * 1024, "helper_import_binding_failed");
  const lock = await readFile(join(repo, "Cargo.lock"), "utf8");
  requireThat(/name = "sqlx-core"\nversion = "0\.8\.6"/.test(lock) && /name = "sqlx-sqlite"\nversion = "0\.8\.6"/.test(lock), "sqlx_metadata_version_changed");
  migrations = readMigrations(await readFile(join(repo, "crates/eg-core/src/lib.rs"), "utf8"));
  baseline = await bundleSnapshot(sourceBundle); report.binding.sourceBundleStart = baseline;
  ownedRoot = await realpath(await mkdtemp(join(tmpdir(), "eg-schema-upgrade-"))); home = join(ownedRoot, "profile"); copy = join(ownedRoot, "Owned QA.app");
  database = join(ownedRoot, "eg-qa-appdata/eastgenesis.db");
  await mkdir(home); await mkdir(join(home, "Downloads")); await mkdir(join(home, "tmp"));
  await exec("/usr/bin/ditto", [sourceBundle, copy], { timeout: commandBudget(15_000), maxBuffer: 4_096 });
  requireThat(same(await originalMembersSnapshot(), baseline) && (await sidecars(join(copy, "Contents/MacOS"))).length === 0, "owned_bundle_copy_mismatch");
  await createFixture();
  for (let index = 0; index < report.rounds.length; index++) {
    if (liveApps.size || performance.now() >= workDeadline || index > 0 && !report.rounds[index - 1].passed) {
      report.rounds[index].blockedReason = liveApps.size ? "prior_app_cleanup_incomplete" : performance.now() >= workDeadline ? "work_budget_exceeded" : "prior_round_failed_no_retry"; break;
    }
    await roundRun(report.rounds[index], index);
  }
  report.runCompleted = report.rounds.every((round) => round.attemptCount === 1 && round.finishedAt);
} catch (error) { report.failure = { code: /^[a-z0-9_]{1,100}$/.test(error.stage ?? "") ? error.stage : "binding_or_harness_error" }; }
finally {
  report.cleanup = { remainingOwnedApps: liveApps.size, longLivedSqliteHelperStarted: false, finalCleanupAttempts: 0 };
  for (const child of [...liveApps]) {
    report.cleanup.finalCleanupAttempts++; const result = await cleanupApp(child);
    report.cleanup.finalAppCleanup ??= []; report.cleanup.finalAppCleanup.push(result);
  }
  report.cleanup.remainingOwnedApps = liveApps.size;
  if (report.binding) {
    try {
      Object.assign(report.binding, { manifestEndSha256: await hash(manifestPath), sourceEndHashes: await sourceHashes(expectedSources), binaryEndSha256: await hash(sourceBinary),
        sourceBundleEnd: await bundleSnapshot(sourceBundle), sourceAppdataAbsentEnd: !await exists(sourceDataDirectory),
        harnessEndSha256: await hash(new URL(import.meta.url)), parserEndSha256: await hash(parserPath), cleanupHelperEndSha256: await hash(cleanupPath), sqliteHelperEndSha256: await hash(sqlitePath) });
      report.binding.unchanged = report.binding.manifestStartSha256 === report.binding.manifestEndSha256 && same(report.binding.sourceStartHashes, report.binding.sourceEndHashes)
        && report.binding.binaryStartSha256 === report.binding.binaryEndSha256 && same(report.binding.sourceBundleStart, report.binding.sourceBundleEnd)
        && report.binding.sourceAppdataAbsentStart === true && report.binding.sourceAppdataAbsentEnd === true
        && report.binding.harnessStartSha256 === report.binding.harnessEndSha256 && report.binding.parserStartSha256 === report.binding.parserEndSha256
        && report.binding.cleanupHelperStartSha256 === report.binding.cleanupHelperEndSha256 && report.binding.sqliteHelperStartSha256 === report.binding.sqliteHelperEndSha256;
    } catch { report.binding.unchanged = false; report.binding.endReadFailed = true; }
  }
  if (ownedRoot && !liveApps.size) {
    try { await rm(ownedRoot, { recursive: true, force: true }); report.cleanup.ownedRootRemoved = !await exists(ownedRoot); report.cleanup.profileAndCopiedBundleRemoved = report.cleanup.ownedRootRemoved; }
    catch { report.cleanup.ownedRootRemoved = false; report.cleanup.profileAndCopiedBundleRemoved = false; }
  }
  report.budgets.totalBudgetRespected = performance.now() <= totalDeadline;
  report.passed = report.runCompleted && report.rounds.every((round) => round.passed === true) && report.binding?.unchanged === true
    && report.cleanup.remainingOwnedApps === 0 && report.cleanup.ownedRootRemoved === true && report.cleanup.profileAndCopiedBundleRemoved === true && report.budgets.totalBudgetRespected;
  if (report.passed) report.evidenceBoundary.proven = ["actual isolated macOS QA SQL plugin upgrades a synthetic current-prefix schema 6 to schema 7",
    "all synthetic legacy table fields, nonempty JSON, soft deletion and four ledger states survive", "migration 7 supplies NULL legacy leases and the lease index",
    "same owned profile restart preserves all fixture rows and SQLx metadata without repeating migration", "compiled sources, actual binary, copied code, harness and helpers remain hash bound"];
  report.finishedAt = new Date().toISOString(); report.elapsedMs = Date.parse(report.finishedAt) - Date.parse(report.startedAt);
  try {
    if (await exists(output)) {
      const metadata = await lstat(output); requireThat(metadata.isFile() && !metadata.isSymbolicLink() && metadata.size <= 2 * 1024 * 1024, "previous_report_invalid");
      const bytes = await readFile(output); const previous = JSON.parse(bytes);
      requireThat(previous.kind === report.kind && previous.schemaVersion === 1, "previous_report_kind_mismatch");
      report.previousReportSha256 = digest(bytes);
      const archive = output.replace(/\.json$/, `.previous-${report.previousReportSha256}.json`);
      try { await writeFile(archive, bytes, { flag: "wx" }); }
      catch (error) { if (error.code !== "EEXIST") throw error; requireThat(await hash(archive) === report.previousReportSha256, "previous_report_archive_mismatch"); }
    }
    await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  } catch { report.passed = false; report.outputWriteFailed = true; }
  console.log(JSON.stringify({ passed: report.passed, runCompleted: report.runCompleted, fixtureReadonlyValidated: report.fixture?.readonlyValidated ?? false,
    rounds: report.rounds.map((round) => ({ name: round.name, attemptCount: round.attemptCount ?? 0, status: round.status, passed: round.passed ?? false, failure: round.failure?.code ?? round.blockedReason ?? null })),
    bindingUnchanged: report.binding?.unchanged ?? false, ownedRootRemoved: report.cleanup.ownedRootRemoved ?? false, remainingOwnedApps: report.cleanup.remainingOwnedApps,
    elapsedMs: report.elapsedMs, failure: report.failure ?? null, outputWriteFailed: report.outputWriteFailed ?? false }));
  process.exitCode = report.passed ? 0 : 1;
}

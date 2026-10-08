// QA-only startup trace reader. Publish fixed phase observations; never forward
// raw native/frontend messages, exception details, paths, SQL, URLs or keys.
import { constants } from "node:fs";
import { lstat, open, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const MAX_TRACE_BYTES = 32 * 1024;
export const TRACE_RECORD_LIMIT = 64;
export const NATIVE_STARTUP_STAGES = Object.freeze([
  "native_started", "builder_started", "plugin_setup_started", "plugin_setup_finished",
  "page_started", "page_finished", "setup_started", "app_config_path_resolved",
  "app_config_path_failed", "provider_store_loaded", "provider_store_failed", "native_state_ready",
  "setup_finished", "setup_failed", "builder_finished", "builder_failed",
  "get_app_info_received", "record_limit_reached",
  "sql_plugin_ready", "sql_load_entered", "sql_connect_started", "sql_connect_resolved",
  "sql_connect_invalid_url", "sql_connect_configuration_failed", "sql_connect_cannot_open",
  "sql_connect_locked", "sql_connect_io_permission_denied", "sql_connect_failed",
  "sql_migration_started", "sql_migration_resolved", "sql_migration_version_mismatch",
  "sql_migration_dirty", "sql_migration_failed", "sql_load_resolved",
]);
export const FRONTEND_STARTUP_STAGES = Object.freeze([
  "document_start", "document_error", "document_unhandled_rejection", "frontend_entry",
  "react_render_called", "bootstrap_started", "backend_tauri", "backend_mock",
  "backend_init_started", "app_info_started", "app_info_resolved", "app_info_failed",
  "sql_import_started", "sql_import_resolved", "sql_import_failed", "db_load_called",
  "db_load_resolved", "db_load_failed", "schema_read_started", "schema_read_resolved",
  "schema_read_failed", "backend_init_resolved", "backend_init_failed", "frontend_ready", "frontend_boot_failed",
]);
const nativeStages = new Set(NATIVE_STARTUP_STAGES);
const frontendStages = new Set(FRONTEND_STARTUP_STAGES);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HEADER_FIELDS = ["schemaVersion", "kind", "runId", "recordLimit"];
const RECORD_FIELDS = ["seq", "source", "stage", "elapsedMs", "frontendSeq"];
const REPORT_FIELDS = ["status", "reason", "runId", "records"];
const unobservedReasons = new Set(["missing", "invalid", "read_failed", "capture_failed"]);
const isUuid = (value) => typeof value === "string" && UUID.test(value);
const boundedInteger = (value, minimum, maximum) => Number.isSafeInteger(value) && value >= minimum && value <= maximum;
const hasOnlyFields = (value, fields) => value !== null && typeof value === "object" && !Array.isArray(value)
  && Reflect.ownKeys(value).length === fields.length && Reflect.ownKeys(value).every((key) => fields.includes(key));
const unobserved = (runId, reason) => ({ status: "unobserved", reason, runId, records: [] });

function projectRecords(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > TRACE_RECORD_LIMIT) throw new Error("startup_trace_invalid");
  const frontendSequences = new Set();
  let previousElapsed = 0;
  return value.map((record, index) => {
    if (!hasOnlyFields(record, RECORD_FIELDS) || record.seq !== index + 1
      || !boundedInteger(record.elapsedMs, 0, 600_000) || record.elapsedMs < previousElapsed
      || (record.source === "native" ? !nativeStages.has(record.stage) || record.frontendSeq !== null
        : record.source === "frontend" ? !frontendStages.has(record.stage) || !boundedInteger(record.frontendSeq, 1, TRACE_RECORD_LIMIT)
          || frontendSequences.has(record.frontendSeq) : true)
      || record.stage === "record_limit_reached" && (record.seq !== TRACE_RECORD_LIMIT || index !== value.length - 1)
      || record.seq === TRACE_RECORD_LIMIT && record.stage !== "record_limit_reached") throw new Error("startup_trace_invalid");
    // IPC arrival order can differ from frontend call order. Keep the explicit
    // frontend sequence without deriving a causal failure from reordering.
    if (record.source === "frontend") frontendSequences.add(record.frontendSeq);
    previousElapsed = record.elapsedMs;
    return Object.fromEntries(RECORD_FIELDS.map((field) => [field, record[field]]));
  });
}

export function validateStartupTraceReport(value) {
  try {
    if (!hasOnlyFields(value, REPORT_FIELDS) || !isUuid(value.runId)) throw new Error("startup_trace_invalid");
    if (value.status === "unobserved") {
      if (!unobservedReasons.has(value.reason) || !Array.isArray(value.records) || value.records.length !== 0) throw new Error("startup_trace_invalid");
      return unobserved(value.runId, value.reason);
    }
    if (value.status !== "observed" || !["complete", "record_limit"].includes(value.reason)) throw new Error("startup_trace_invalid");
    const records = projectRecords(value.records);
    const reachedLimit = records.at(-1).stage === "record_limit_reached";
    if ((value.reason === "record_limit") !== reachedLimit) throw new Error("startup_trace_invalid");
    return { status: "observed", reason: value.reason, runId: value.runId, records };
  } catch {
    throw new Error("startup_trace_invalid");
  }
}

// JSON.parse alone silently accepts duplicate object keys. Scan string tokens
// after parsing so even escaped duplicate names cannot hide a second value.
function parseUniqueObject(line) {
  const parsed = JSON.parse(line);
  let keys = 0;
  for (let index = 0; index < line.length; index++) {
    if (line[index] !== '"') continue;
    index++;
    while (index < line.length && line[index] !== '"') {
      if (line[index] === "\\") index++;
      index++;
    }
    let after = index + 1;
    while (/\s/.test(line[after] ?? "") && after < line.length) after++;
    if (line[after] === ":") keys++;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) || keys !== Object.keys(parsed).length) throw new Error("startup_trace_invalid");
  return parsed;
}

export function parseStartupTraceText(text, expectedRunId) {
  if (!isUuid(expectedRunId)) throw new Error("startup_trace_invalid");
  try {
    if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > MAX_TRACE_BYTES || !text.endsWith("\n")) throw new Error("startup_trace_invalid");
    const lines = text.slice(0, -1).split("\n");
    if (lines.length < 2 || lines.length > TRACE_RECORD_LIMIT + 1) throw new Error("startup_trace_invalid");
    const header = parseUniqueObject(lines[0]);
    if (!hasOnlyFields(header, HEADER_FIELDS) || header.schemaVersion !== 1 || header.kind !== "desktop-qa-startup"
      || header.runId !== expectedRunId || header.recordLimit !== TRACE_RECORD_LIMIT) throw new Error("startup_trace_invalid");
    const records = projectRecords(lines.slice(1).map(parseUniqueObject));
    return validateStartupTraceReport({ status: "observed", reason: records.at(-1).stage === "record_limit_reached" ? "record_limit" : "complete", runId: expectedRunId, records });
  } catch {
    return unobserved(expectedRunId, "invalid");
  }
}

async function readTrace(path, runId) {
  if (basename(path) !== `eg-qa-startup-${runId}.jsonl`) return unobserved(runId, "invalid");
  let metadata;
  try { metadata = await lstat(path); }
  catch (error) { return unobserved(runId, error?.code === "ENOENT" ? "missing" : "read_failed"); }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_TRACE_BYTES) return unobserved(runId, "invalid");
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > MAX_TRACE_BYTES || opened.dev !== metadata.dev || opened.ino !== metadata.ino) return unobserved(runId, "invalid");
    const buffer = Buffer.alloc(MAX_TRACE_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
      if (bytesRead === 0) break;
      size += bytesRead;
    }
    // Also check the path after opening on platforms without O_NOFOLLOW.
    const current = await lstat(path);
    if (!current.isFile() || current.isSymbolicLink() || current.dev !== opened.dev || current.ino !== opened.ino || size > MAX_TRACE_BYTES) return unobserved(runId, "invalid");
    let text;
    try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, size)); }
    catch { return unobserved(runId, "invalid"); }
    return parseStartupTraceText(text, runId);
  } catch {
    return unobserved(runId, "read_failed");
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

async function main(args) {
  let options;
  try {
    options = {};
    for (let index = 0; index < args.length; index++) {
      const flag = args[index];
      if (!["--trace", "--run-id", "--output"].includes(flag) || Object.hasOwn(options, flag) || !args[index + 1] || args[index + 1].startsWith("--")) throw new Error("startup_trace_invalid");
      options[flag] = args[++index];
    }
    if (Object.keys(options).length !== 3 || !isUuid(options["--run-id"])) throw new Error("startup_trace_invalid");
  } catch { process.exitCode = 1; return; }
  const report = await readTrace(options["--trace"], options["--run-id"]);
  try { await writeFile(options["--output"], `${JSON.stringify(report)}\n`, "utf8"); }
  catch { process.exitCode = 1; }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main(process.argv.slice(2));

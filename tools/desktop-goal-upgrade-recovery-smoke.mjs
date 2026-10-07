// Exact historical-source QA writer -> current-source QA reader. Apps alone
// write SQLite. This is neither a release upgrade nor a schema6 fixture.
import { createServer } from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, writeFile, open, lstat, stat, readlink, realpath, readdir, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { hasProcessExited, stopDetachedProcess } from "./desktop-process-cleanup.mjs";

const OLD_REVISION = "4a88d966aa327122695d62f8035cd1eb79c79b8c";
const GOAL_HARNESS_SHA = "235b13ce1c8b7bc08dd418f513a56a06c8505cc9d14c076e6136be8c257246bd";
const CLEANUP_SHA = "96138f637b706f1c7707b6906dcb4abb8bbd0311d180441f767ca3f36e956c53";
const APP_ID = "com.eastgenesis.desktop";
const SCENARIO = "after_tool_before_ledger_commit";
const LEASE_MS = 30_000;
const BUDGET_MS = 120_000;
const HEX40 = /^[a-f0-9]{40}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const HERE = dirname(fileURLToPath(import.meta.url));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const digest = async (path) => hash(await readFile(path));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sorted = (record) => Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const exists = (path) => access(path).then(() => true, () => false);
function fail(stage) { const error = new Error(stage); error.stage = stage; throw error; }
function requireThat(value, stage) { if (!value) fail(stage); }
function fixedFailure(error) { return /^[a-z][a-z0-9_]{0,95}$/.test(error?.stage ?? "") ? error.stage : "unexpected_failure"; }
function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function safeRelative(path) {
  return typeof path === "string" && path.length > 0 && path.length < 1024 && !isAbsolute(path)
    && !path.includes("\\") && !/[\x00-\x1f]/.test(path) && path.split("/").every((part) => part && part !== "." && part !== "..");
}

export function parseOptions(args) {
  const required = ["writer-app", "reader-app", "writer-source-root", "reader-source-root", "writer-manifest", "reader-manifest",
    "expected-writer-revision", "expected-reader-revision", "expected-writer-binary-sha256", "expected-reader-binary-sha256", "output"];
  const options = {};
  for (const arg of args) {
    if (arg === "--check-inputs-only" || arg === "--help") {
      const name = arg.slice(2); requireThat(!(name in options), "duplicate_option"); options[name] = true; continue;
    }
    const match = /^--([a-z][a-z0-9-]*)=([^\x00-\x1f]+)$/.exec(arg);
    requireThat(match && required.includes(match[1]), "invalid_option");
    requireThat(!(match[1] in options), "duplicate_option"); options[match[1]] = match[2];
  }
  if (options.help) { requireThat(Object.keys(options).length === 1, "help_with_other_options"); return options; }
  requireThat(required.every((name) => typeof options[name] === "string"), "required_option_missing");
  requireThat(options["expected-writer-revision"] === OLD_REVISION, "writer_revision_not_supported");
  requireThat(HEX40.test(options["expected-reader-revision"]), "reader_revision_invalid");
  requireThat(HEX64.test(options["expected-writer-binary-sha256"]) && HEX64.test(options["expected-reader-binary-sha256"]), "binary_sha_invalid");
  for (const name of required.filter((name) => !name.startsWith("expected-"))) options[name] = resolve(options[name]);
  requireThat(options["writer-app"] !== options["reader-app"], "distinct_app_inputs_required");
  requireThat(options["writer-source-root"] !== options["reader-source-root"], "distinct_source_roots_required");
  return options;
}

export function validateManifest(manifest, role, options) {
  requireThat(object(manifest) && manifest.schemaVersion === 1 && manifest.passed === true && manifest.sourceUnchanged === true, "build_manifest_not_passed");
  requireThat(object(manifest.sourceHashes) && object(manifest.sourceEndHashes), "source_hash_map_invalid");
  const sources = sorted(manifest.sourceHashes); const keys = Object.keys(sources);
  requireThat(keys.length > 0 && keys.length <= 4096 && keys.length === manifest.sourceInputs, "source_input_count_invalid");
  requireThat(keys.every((name) => safeRelative(name) && HEX64.test(sources[name])), "source_hash_entry_invalid");
  requireThat(same(sources, sorted(manifest.sourceEndHashes)), "build_source_end_hash_mismatch");
  requireThat(manifest.binarySha256 === options[`expected-${role}-binary-sha256`], "build_binary_sha_mismatch");
  const qa = (Array.isArray(manifest.features) && manifest.features.includes("qa-faults"))
    || (typeof manifest.command === "string" && /(?:^|\s)--features(?:=|\s+)qa-faults(?:\s|$)/.test(manifest.command))
    || (role === "reader" && manifest.command === "pnpm tauri:build:mac:qa --bundles app");
  requireThat(qa, "qa_build_feature_not_bound");
  requireThat(typeof manifest.command === "string" && !/(?:--config\b|TAURI_CONFIG)/.test(manifest.command), "default_home_build_config_not_bound");
  requireThat(manifest.formalReleaseBinding !== true, "formal_release_claim_not_supported");
  if (role === "writer") requireThat(manifest.sourceRevision === options["expected-writer-revision"] && manifest.archivedTreeVerified === true && HEX40.test(manifest.sourceExportTree ?? ""), "writer_export_provenance_invalid");
  else requireThat(HEX40.test(manifest.localParentRevision ?? ""), "reader_manifest_parent_invalid");
  return sources;
}

const ROOT_INPUTS = new Set(["Cargo.toml", "Cargo.lock", "package.json", "pnpm-lock.yaml", "vite.config.ts", "tailwind.config.ts", "postcss.config.js", "tsconfig.json", "tsconfig.app.json", "index.html", "scripts/brand/sync_theme.mjs", "docs/BRAND.md"]);
const compiledInput = (name) => ROOT_INPUTS.has(name) || ["src/", "src-tauri/", "crates/", "vendor/", "assets/", "public/"].some((prefix) => name.startsWith(prefix));
export function validateCompiledCoverage(sourceHashes, trackedPaths) {
  requireThat(object(sourceHashes) && Array.isArray(trackedPaths) && trackedPaths.length > 0 && trackedPaths.length <= 8192
    && trackedPaths.every(safeRelative), "compiled_input_index_invalid");
  const required = trackedPaths.filter(compiledInput);
  requireThat(required.includes("index.html") && required.every((name) => Object.hasOwn(sourceHashes, name)), "compiled_input_coverage_missing");
  return { requiredInputs: required.length, covered: true };
}
function git(root, args, binary = false) {
  try { return execFileSync("git", args, { cwd: root, encoding: binary ? undefined : "utf8", timeout: 10_000, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }); }
  catch { fail("scoped_git_read_failed"); }
}
function treeEntries(root, tree) {
  // gitRoot cwd and --full-tree prevent project prefix filtering of a subtree.
  const entries = git(root, ["ls-tree", "--full-tree", "-rz", tree]).split("\0").filter(Boolean).map((row) => {
    const match = /^(100644|100755|120000) blob ([a-f0-9]{40})\t(.+)$/.exec(row);
    requireThat(match && safeRelative(match[3]), "git_tree_entry_invalid");
    return { mode: match[1], blob: match[2], name: match[3] };
  });
  requireThat(entries.length > 0 && entries.length <= 8192, "git_tree_empty_or_unbounded"); return entries;
}
export async function resolveScopedGitProject(sourceRoot) {
  const canonicalSourceRoot = await realpath(sourceRoot);
  const gitRoot = await realpath(git(canonicalSourceRoot, ["rev-parse", "--show-toplevel"]).trim());
  const prefix = relative(gitRoot, canonicalSourceRoot).split(sep).join("/");
  requireThat(prefix === "EastGenesis", "scoped_git_project_invalid");
  return { gitRoot, canonicalSourceRoot, prefix };
}
async function sourceSnapshot(root, expected) {
  const hashes = {}; const canonicalRoot = await realpath(root);
  for (const name of Object.keys(expected)) {
    const path = join(root, name); const canonical = await realpath(path);
    requireThat(canonical.startsWith(`${canonicalRoot}${sep}`) && (await lstat(path)).isFile(), "source_input_not_regular_or_outside_root");
    hashes[name] = await digest(path);
  }
  return sorted(hashes);
}
async function verifyExport(root, entries) {
  const canonicalRoot = await realpath(root);
  for (const entry of entries) {
    const path = join(root, entry.name); const status = await lstat(path);
    const parent = await realpath(dirname(path));
    requireThat(parent === canonicalRoot || parent.startsWith(`${canonicalRoot}${sep}`), "writer_export_parent_outside_root");
    requireThat(entry.mode === "120000" ? status.isSymbolicLink() : status.isFile(), "writer_export_file_type_mismatch");
    const bytes = entry.mode === "120000" ? Buffer.from(await readlink(path)) : await readFile(path);
    requireThat(createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") === entry.blob, "writer_export_blob_mismatch");
    if (entry.mode !== "120000") requireThat(Boolean(status.mode & 0o111) === (entry.mode === "100755"), "writer_export_mode_mismatch");
  }
  requireThat(entries.length > 0, "writer_export_empty"); return { trackedBlobCount: entries.length, verified: true };
}
function appBundle(binary) {
  requireThat(basename(binary) === "eastgenesis-desktop" && basename(dirname(binary)) === "MacOS" && basename(dirname(dirname(binary))) === "Contents", "app_bundle_layout_invalid");
  const bundle = dirname(dirname(dirname(binary))); requireThat(bundle.endsWith(".app"), "app_bundle_layout_invalid"); return bundle;
}
function plist(bundle, field) {
  try { return execFileSync("/usr/libexec/PlistBuddy", ["-c", `Print :${field}`, join(bundle, "Contents/Info.plist")], { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "pipe"] }).trim(); }
  catch { fail("app_plist_read_failed"); }
}
async function bundleSnapshot(bundle) {
  const hashes = {};
  async function visit(path, prefix = "") {
    for (const name of (await readdir(path)).sort()) {
      const file = join(path, name); const key = prefix ? `${prefix}/${name}` : name; const status = await lstat(file);
      if (status.isDirectory()) await visit(file, key);
      else if (status.isSymbolicLink()) hashes[key] = `symlink:${hash(await readlink(file))}`;
      else { requireThat(status.isFile(), "app_bundle_file_type_invalid"); hashes[key] = await digest(file); }
    }
  }
  await visit(bundle); requireThat(Object.keys(hashes).length > 0, "app_bundle_empty"); return sorted(hashes);
}

async function bindInputs(options, report) {
  const { gitRoot, prefix } = await resolveScopedGitProject(options["reader-source-root"]);
  const readerHead = git(gitRoot, ["rev-parse", "HEAD"]).trim();
  requireThat(readerHead === options["expected-reader-revision"], "reader_source_head_mismatch");
  const writerTree = git(gitRoot, ["rev-parse", `${OLD_REVISION}:${prefix}`]).trim();
  const oldEntries = treeEntries(gitRoot, writerTree);
  const readerEntries = treeEntries(gitRoot, `${readerHead}:${prefix}`);
  const inputs = { gitRoot, prefix, readerHead, writerTree, oldEntries, roles: {} };
  for (const role of ["writer", "reader"]) {
    const manifestPath = options[`${role}-manifest`]; const bytes = await readFile(manifestPath);
    requireThat(bytes.length <= 2 * 1024 * 1024, "build_manifest_unbounded");
    let manifest; try { manifest = JSON.parse(bytes.toString("utf8")); } catch { fail("build_manifest_invalid_json"); }
    const expected = validateManifest(manifest, role, options); const entries = role === "writer" ? oldEntries : readerEntries;
    // Writer's complete build-time Git export covers entry/assets omitted from
    // its smaller compiler subset. Reader has no such historical export map.
    const compiledCoverage = role === "reader" ? validateCompiledCoverage(expected, entries.map((entry) => entry.name)) : undefined;
    const sourceRoot = options[`${role}-source-root`]; const startHashes = await sourceSnapshot(sourceRoot, expected);
    requireThat(same(startHashes, expected), "source_start_hash_mismatch");
    const binary = options[`${role}-app`]; const bundle = appBundle(binary);
    requireThat((await lstat(binary)).isFile(), "app_binary_not_regular");
    const binarySha = await digest(binary); requireThat(binarySha === options[`expected-${role}-binary-sha256`], "binary_start_hash_mismatch");
    requireThat(plist(bundle, "CFBundleIdentifier") === APP_ID, "app_identifier_mismatch");
    const version = plist(bundle, "CFBundleShortVersionString"); requireThat(/^\d+\.\d+\.\d+(?:[-+.][a-zA-Z0-9.-]+)?$/.test(version), "app_version_invalid");
    const bundleHashes = await bundleSnapshot(bundle);
    const binding = { manifestStartSha256: hash(bytes), sourceInputs: Object.keys(expected).length, expectedSourceHashes: expected,
      sourceStartHashes: startHashes, binaryStartSha256: binarySha, appVersion: version, bundleStartSha256: hash(JSON.stringify(bundleHashes)), bundleFiles: Object.keys(bundleHashes).length };
    if (compiledCoverage) binding.compiledCoverage = compiledCoverage;
    if (role === "writer") {
      requireThat(manifest.sourceExportTree === writerTree, "writer_export_tree_mismatch");
      const exportHashes = sorted(Object.fromEntries(oldEntries.map((entry) => [entry.name, { mode: entry.mode, gitBlobSha1: entry.blob }])));
      requireThat(manifest.exportSourceUnchanged === true && manifest.exportSourceFiles === oldEntries.length
        && object(manifest.exportSourceBlobHashes) && object(manifest.exportSourceEndBlobHashes)
        && same(sorted(manifest.exportSourceBlobHashes), exportHashes) && same(sorted(manifest.exportSourceEndBlobHashes), exportHashes), "writer_build_export_binding_invalid");
      binding.sourceRevision = OLD_REVISION; binding.sourceExportTree = writerTree; binding.exportStart = await verifyExport(sourceRoot, oldEntries);
    } else {
      binding.actualSourceRevision = readerHead; binding.compiledSourceEquivalentToRevision = readerHead; binding.originalManifestParent = manifest.localParentRevision;
      for (const name of Object.keys(expected)) requireThat(hash(git(gitRoot, ["show", `${readerHead}:${prefix}/${name}`], true)) === expected[name], "reader_compiled_source_revision_mismatch");
    }
    if (manifest.command === "pnpm tauri:build:mac:qa --bundles app") {
      const packageJson = JSON.parse(await readFile(join(sourceRoot, "package.json"), "utf8"));
      requireThat(packageJson.scripts?.["tauri:build:mac:qa"] === "CI=true tauri build --features qa-faults", "qa_build_script_unbound");
    }
    const config = JSON.parse(await readFile(join(sourceRoot, "src-tauri/tauri.conf.json"), "utf8"));
    requireThat(config.identifier === APP_ID && config.app?.appDirectoriesOverride === undefined, "shared_home_config_mismatch");
    report.bindings[role] = binding; inputs.roles[role] = { manifestPath, sourceRoot, expected, bundle, bundleHashes, binary };
  }
  return inputs;
}
async function verifyEnd(inputs, options, report) {
  let failure;
  for (const role of ["writer", "reader"]) {
    const input = inputs.roles[role]; const binding = report.bindings[role];
    try {
    binding.manifestEndSha256 = await digest(input.manifestPath); binding.sourceEndHashes = await sourceSnapshot(input.sourceRoot, input.expected);
    binding.binaryEndSha256 = await digest(input.binary); const bundle = await bundleSnapshot(input.bundle); binding.bundleEndSha256 = hash(JSON.stringify(bundle));
    requireThat(binding.manifestEndSha256 === binding.manifestStartSha256 && same(binding.sourceEndHashes, input.expected)
      && binding.binaryEndSha256 === options[`expected-${role}-binary-sha256`] && same(bundle, input.bundleHashes), "source_or_bundle_changed_during_run");
    if (role === "writer") binding.exportEnd = await verifyExport(input.sourceRoot, inputs.oldEntries);
    binding.sourceAndBinaryUnchanged = true;
    } catch (error) { binding.sourceAndBinaryUnchanged = false; binding.endFailure = fixedFailure(error); failure ??= binding.endFailure; }
  }
  if (git(inputs.gitRoot, ["rev-parse", "HEAD"]).trim() !== inputs.readerHead) failure ??= "reader_source_head_changed";
  if (failure) fail(failure);
}

async function fixture() {
  const counts = { catalogGet: 0, plan: 0, args: 0, stream: 0, jsonOther: 0, unexpected: 0 }; const sockets = new Set();
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/v1/models") { counts.catalogGet++; res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ data: [{ id: "gpt-5.6-luna", object: "model" }] })); return; }
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") { counts.unexpected++; res.writeHead(404).end(); return; }
    const chunks = []; let bytes = 0;
    req.on("data", (chunk) => { bytes += chunk.length; if (bytes <= 1_048_576) chunks.push(chunk); else req.destroy(); });
    req.on("end", () => {
      let body; try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { counts.unexpected++; res.writeHead(400).end(); return; }
      if (!object(body) || body.model !== "gpt-5.6-luna" || !Array.isArray(body.messages)) { counts.unexpected++; res.writeHead(400).end(); return; }
      const planner = body.messages.some((m) => object(m) && m.role === "system" && typeof m.content === "string" && m.content.includes("任务规划器"));
      const generatingArgs = body.messages.some((m) => object(m) && m.role === "system" && typeof m.content === "string" && m.content.includes("你为工具生成调用参数"));
      const args = { src: "~/Downloads/source.txt", dst: "~/Downloads/target.txt" };
      const text = planner ? JSON.stringify({ steps: [{ goal: "移动隔离沙箱文件；依据：固定测试输入", tool: "mcp__files__move_file", args }] }) : generatingArgs ? JSON.stringify(args) : "已移动文件到 ~/Downloads/target.txt，固定目标已完成。";
      if (planner) counts.plan++; else if (generatingArgs) counts.args++; else if (body.stream !== true) counts.jsonOther++;
      if (body.stream === true) {
        counts.stream++; res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`);
        res.end('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
      } else { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ model: "gpt-5.6-luna", choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 } })); }
    });
  });
  server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  return { server, sockets, counts, base: `http://127.0.0.1:${server.address().port}/v1` };
}
async function fingerprint(path) {
  const metadata = await stat(path, { bigint: true }); return { inode: metadata.ino.toString(), mtimeNs: metadata.mtimeNs.toString(), sha256: await digest(path) };
}
function readDatabase(path, deadline) {
  const read = (sql) => {
    try { const text = execFileSync("/usr/bin/sqlite3", ["-readonly", "-json", path, sql], { encoding: "utf8", timeout: timeoutFor(deadline), maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }).trim(); return text ? JSON.parse(text) : []; }
    catch { fail("sqlite_read_only_query_failed"); }
  };
  const goals = read("SELECT id, status, rounds FROM goals WHERE deleted_at IS NULL");
  const ledger = read("SELECT idempotency_key, task_id, step_id, invocation_id, tool, args_digest, attempt, state, artifacts, lease_owner, lease_expires_at, created_at, updated_at FROM tool_invocations");
  const schema = read("SELECT value FROM app_meta WHERE key='schema_version'");
  const migrations = read("SELECT version, description, installed_on, success, hex(checksum) AS checksum_hex, execution_time FROM _sqlx_migrations ORDER BY version");
  requireThat(schema.length === 1 && String(schema[0].value) === "7" && migrations.length === 7 && migrations.every((row, index) => Number(row.version) === index + 1 && Number(row.success) === 1), "sqlite_schema_or_migrations_not_ready");
  let rounds; try { rounds = goals.length === 1 ? JSON.parse(goals[0].rounds) : []; } catch { fail("checkpoint_json_invalid"); }
  const round = rounds.at(-1); const events = round?.task_checkpoint?.events;
  return { goals, goal: goals[0], rounds, round, ledger, migrations, events: Array.isArray(events) ? events : [] };
}
function identity(db) {
  requireThat(db.goals.length === 1 && db.rounds.length === 1 && db.ledger.length === 1, "unique_goal_round_ledger_required");
  const row = db.ledger[0]; const round = db.round;
  requireThat(typeof db.goal.id === "string" && typeof round?.task_id === "string" && round.task_checkpoint?.id === round.task_id && row.task_id === round.task_id, "task_identity_invalid");
  requireThat(row.tool === "mcp__files__move_file" && Number(row.attempt) === 1 && typeof row.idempotency_key === "string" && row.idempotency_key.length > 0 && typeof row.invocation_id === "string" && typeof row.args_digest === "string", "move_invocation_identity_invalid");
  return { goalId: db.goal.id, roundIndex: round.index, taskId: round.task_id, invocationId: row.invocation_id, idempotencyKey: row.idempotency_key, stepId: row.step_id, tool: row.tool, argsDigest: row.args_digest, attempt: row.attempt, createdAt: row.created_at };
}

function timeoutFor(deadline) { requireThat(Date.now() < deadline, "observation_budget_exceeded"); return Math.max(1, Math.min(5_000, deadline - Date.now())); }
async function observeMcpChild(child, binary, role, state) {
  requireThat(!hasProcessExited(child), "owned_app_not_alive");
  let children;
  try { children = execFileSync("/usr/bin/pgrep", ["-P", String(child.pid)], { encoding: "utf8", timeout: timeoutFor(state.deadline), stdio: ["ignore", "pipe", "pipe"] }).trim().split(/\s+/); }
  catch (error) { if (error.status === 1) fail("owned_mcp_child_missing"); fail("owned_child_inspection_failed"); }
  requireThat(children.length > 0 && children.length <= 64 && children.every((pid) => /^\d+$/.test(pid)), "owned_child_list_invalid");
  const matches = [];
  for (const pid of children) {
    let line;
    try { line = execFileSync("/bin/ps", ["-p", pid, "-o", "ppid=,pgid=,args="], { encoding: "utf8", timeout: timeoutFor(state.deadline), stdio: ["ignore", "pipe", "pipe"] }).trim(); }
    catch { continue; }
    const match = /^(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!match || !match[3].startsWith(`${binary} --mcp-files `)) continue;
    const record = { role, pid: Number(pid), parentPid: Number(match[1]), processGroupId: Number(match[2]), binarySha256: await digest(binary), mode: "same_app_binary_mcp_files" };
    state.scenario.ownedMcpHelpers.push(record);
    if (record.parentPid !== child.pid || record.processGroupId !== child.pid) { state.helperCleanupUnknown = true; fail("owned_mcp_group_or_parent_mismatch"); }
    matches.push(record);
  }
  requireThat(Date.now() < state.deadline, "native_budget_exceeded");
  requireThat(matches.length === 1, "unique_owned_mcp_child_required"); return matches[0];
}

async function nativeRun(inputs, report, state) {
  state.root = await mkdtemp(join(tmpdir(), "eg-historical-goal-"));
  const home = join(state.root, "profile"); const sandbox = join(home, "Downloads");
  const src = join(sandbox, "source.txt"); const dst = join(sandbox, "target.txt");
  const appdata = join(home, "Library/Application Support", APP_ID); const db = join(appdata, "eastgenesis.db"); const providerConfig = join(appdata, "providers.json");
  const scenario = { scenario: SCENARIO, status: "running", assertions: {}, actions: [], observations: [], ownedMcpHelpers: [] };
  report.attempts.push(scenario); state.scenario = scenario; state.deadline = Date.now() + BUDGET_MS;
  const assertion = (name, value) => { scenario.assertions[name] = Boolean(value); requireThat(value, name); };
  const bounded = () => requireThat(Date.now() < state.deadline, "native_budget_exceeded");
  async function waitFor(fn, stage, ms = 15_000) {
    const until = Math.min(state.deadline, Date.now() + ms);
    while (Date.now() < until) {
      let ready; state.observationDeadline = until;
      try { ready = await fn(); } finally { state.observationDeadline = undefined; }
      bounded(); requireThat(Date.now() < until, stage);
      if (ready) return; await pause(100);
    }
    fail(stage);
  }
  function ax(child, content) {
    bounded(); requireThat(state.liveApps.has(child) && !hasProcessExited(child), "owned_app_not_alive");
    try {
      return execFileSync("/usr/bin/osascript", ["-e", `tell application "System Events"
tell (first process whose unix id is ${child.pid})
set frontmost to true
tell window 1
try
set value of attribute "AXMinimized" to false
perform action "AXRaise"
end try
set allElements to entire contents
${content}
end tell
end tell
end tell`], { encoding: "utf8", timeout: timeoutFor(Math.min(state.deadline, state.observationDeadline ?? Infinity)), stdio: ["ignore", "pipe", "pipe"] }).trim();
    } catch (error) {
      const code = String(error.stderr ?? "").match(/\((-?\d+)\)\s*$/)?.[1];
      scenario.lastAxFailure = code ? `ax_operation_${code.replace("-", "minus")}` : "ax_operation"; fail(scenario.lastAxFailure);
    }
  }
  function hasLabel(child, label) {
    return ax(child, `repeat with e in allElements
try
if (name of e as text) is ${JSON.stringify(label)} then return "found"
end try
end repeat
return "missing"`) === "found";
  }
  function click(child, label, name, role = "Button") {
    const action = { name, status: "attempted" }; scenario.actions.push(action);
    const result = ax(child, `set chosen to missing value
repeat with e in allElements
try
if (role of e as text) contains ${JSON.stringify(role)} and (name of e as text) starts with ${JSON.stringify(label)} then
set chosen to e
exit repeat
end if
end try
end repeat
if chosen is missing value then return "missing"
click chosen
return "clicked"`);
    requireThat(result === "clicked", "ax_control_missing"); action.status = "passed";
  }
  async function stableLabel(child, label, stage) {
    let consecutive = 0;
    await waitFor(async () => {
      if (!hasLabel(child, label)) {
        consecutive = 0;
        // Only this owned App's do-not-reopen alert is dismissed. Permission
        // approval prompts are never accepted by this tool.
        for (const choice of ["Don't Reopen", "Don’t Reopen", "不重新打开", "不要重新打开"]) {
          if (hasLabel(child, choice)) { click(child, choice, "owned_restore_do_not_reopen"); break; }
        }
        return false;
      }
      if (++consecutive < 2) { await pause(250); return false; }
      return true;
    }, stage);
  }
  function start(role, binary, fault) {
    bounded();
    const env = { HOME: home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", TMPDIR: join(state.root, "tmp"), LANG: "en_US.UTF-8",
      EASTGENESIS_QA_ISOLATED_PROFILE: "1", EASTGENESIS_QA_PROVIDER_BASE_URL: state.fixture.base,
      EASTGENESIS_QA_PROVIDER_MODEL: "gpt-5.6-luna", EASTGENESIS_QA_PROVIDER_PROTOCOL: "openai", EASTGENESIS_QA_LEDGER_LEASE_MS: String(LEASE_MS),
      ...(fault ? { EASTGENESIS_QA_FAULT_POINT: SCENARIO } : {}) };
    const child = spawn(binary, [], { env, detached: true, stdio: ["ignore", "ignore", "ignore"] });
    child.on("error", () => { scenario.spawnFailure = true; });
    requireThat(Number.isInteger(child.pid) && child.pid > 0, "owned_app_spawn_failed");
    state.liveApps.add(child); state.roles.set(child, role);
    report.ownedProcesses.push({ role, pid: child.pid, ownerPid: process.pid, detached: true, builtinMcpSource: "same_bound_app_binary_current_exe_mcp_files" });
    return child;
  }
  await mkdir(sandbox, { recursive: true }); await mkdir(join(state.root, "tmp"));
  assertion("fresh_profile_without_appdata", !await exists(appdata));
  await writeFile(src, "synthetic goal recovery input\n"); const original = await fingerprint(src); scenario.originalArtifact = original;
  for (const role of ["writer", "reader"]) {
    const copy = join(state.root, role === "writer" ? "Writer.app" : "Reader.app");
    await cp(inputs.roles[role].bundle, copy, { recursive: true, dereference: false, force: false, errorOnExist: true });
    assertion(`${role}_bundle_copy_bound`, same(await bundleSnapshot(copy), inputs.roles[role].bundleHashes));
    state.copiedBundles[role] = copy;
    report.bindings[role].copiedBinaryStartSha256 = await digest(join(copy, "Contents/MacOS/eastgenesis-desktop"));
  }
  state.fixture = await fixture(); report.nativeExecutionAttempted = true;
  const writer = start("writer", join(state.copiedBundles.writer, "Contents/MacOS/eastgenesis-desktop"), true);
  await stableLabel(writer, "添加", "writer_window_not_ready"); click(writer, "添加", "writer_add"); await pause(200);
  click(writer, "目标", "writer_goal_mode", "MenuItem");
  await waitFor(() => hasLabel(writer, "移除目标模式"), "writer_goal_mode_not_ready");
  execFileSync("/usr/bin/pbcopy", [], { input: "把 ~/Downloads/source.txt 移动到 ~/Downloads/target.txt", timeout: 5_000, stdio: ["pipe", "ignore", "ignore"] }); state.clipboardTouched = true;
  const pasted = ax(writer, `set chosen to missing value
repeat with e in allElements
try
if (role of e as text) contains "TextArea" then
set chosen to e
exit repeat
end if
end try
end repeat
if chosen is missing value then return "missing"
click chosen
delay 0.2
keystroke "v" using command down
delay 0.2
if (value of chosen as text) is "把 ~/Downloads/source.txt 移动到 ~/Downloads/target.txt" then return "pasted"
return "missing"`);
  assertion("writer_prompt_roundtrip", pasted === "pasted"); click(writer, "提交任务", "writer_submit_goal");
  await waitFor(() => hasLabel(writer, "开始"), "writer_goal_not_created"); click(writer, "开始", "writer_start");
  await waitFor(() => hasLabel(writer, "批准"), "writer_confirmation_missing");
  await observeMcpChild(writer, join(state.copiedBundles.writer, "Contents/MacOS/eastgenesis-desktop"), "writer", state);
  click(writer, "批准", "writer_approve_move");
  await waitFor(() => hasProcessExited(writer), "writer_fault_exit_missing"); assertion("writer_real_abort", writer.signalCode === "SIGABRT");
  const crashed = readDatabase(db, state.deadline); const originalIdentity = identity(crashed);
  assertion("writer_started_ledger", crashed.ledger[0].state === "started");
  assertion("writer_identity_checkpoint", crashed.events.some((event) => event.type === "plan") && crashed.events.some((event) => event.type === "gate" && event.idempotencyKey === originalIdentity.idempotencyKey && event.invocationId === originalIdentity.invocationId));
  assertion("writer_completed_actual_move", !await exists(src) && await exists(dst));
  assertion("writer_move_preserved_file_identity", same(original, await fingerprint(dst)));
  assertion("writer_checkpoint_before_final_ledger", !crashed.events.some((event) => event.type === "tool_result"));
  const writerModelEvents = crashed.events.filter((event) => event.type === "llm");
  assertion("writer_fixture_only_model_events", writerModelEvents.length > 0 && writerModelEvents.every((event) => event.profileId?.startsWith("custom:qa/")));
  assertion("no_persisted_provider_config", !await exists(providerConfig));
  const expiry = Number(crashed.ledger[0].lease_expires_at);
  assertion("real_qa_lease_observed", Number.isSafeInteger(expiry) && expiry > Date.now());
  scenario.identitySha256 = hash(JSON.stringify(originalIdentity));
  scenario.writerMigrationMetadataSha256 = hash(JSON.stringify(crashed.migrations));
  scenario.observations.push({ stage: "writer_crashed", signal: writer.signalCode, ledgerState: "started", schemaVersion: 7, checkpointHasInvocationIdentity: true, fixtureCounts: { ...state.fixture.counts } });
  await stopOwned(writer, state, report);
  const reader = start("reader", join(state.copiedBundles.reader, "Contents/MacOS/eastgenesis-desktop"), false);
  await stableLabel(reader, "继续", "reader_hydration_not_ready"); const hydrated = readDatabase(db, state.deadline);
  await observeMcpChild(reader, join(state.copiedBundles.reader, "Contents/MacOS/eastgenesis-desktop"), "reader", state);
  assertion("reader_hydrated_same_identity", same(identity(hydrated), originalIdentity)); assertion("reader_same_single_round", hydrated.rounds.length === 1);
  assertion("reader_hydrated_migration_metadata_preserved", same(hydrated.migrations, crashed.migrations));
  assertion("active_lease_still_observable", Date.now() + 1_000 < expiry); click(reader, "继续", "reader_resume_active_lease");
  await waitFor(() => {
    const value = readDatabase(db, Math.min(state.deadline, state.observationDeadline ?? Infinity));
    return value.goal.status === "paused" && value.round?.task_checkpoint?.status === "needs_user" && value.events.some((event) => event.type === "probe" && event.invocationId === originalIdentity.invocationId && event.idempotencyKey === originalIdentity.idempotencyKey && event.step?.id === originalIdentity.stepId && typeof event.detail === "string" && event.detail.includes("另一个运行实例"));
  }, "reader_active_lease_not_blocked");
  const active = readDatabase(db, state.deadline);
  assertion("reader_active_lease_same_identity", same(identity(active), originalIdentity));
  assertion("reader_active_lease_preserved_ledger", same(active.ledger[0], crashed.ledger[0]));
  assertion("reader_active_migration_metadata_preserved", same(active.migrations, crashed.migrations));
  assertion("reader_active_lease_no_replay", !await exists(src) && same(original, await fingerprint(dst)));
  scenario.observations.push({ stage: "reader_active_lease_blocked", ledgerState: active.ledger[0].state, taskStatus: active.round.task_checkpoint.status, fixtureCounts: { ...state.fixture.counts } });
  const waitingAt = Date.now(); await waitFor(() => Date.now() > expiry + 50, "real_qa_lease_not_expired", LEASE_MS + 2_000); scenario.realLeaseWaitMs = Date.now() - waitingAt;
  click(reader, "继续", "reader_resume_expired_lease");
  await waitFor(() => { const value = readDatabase(db, Math.min(state.deadline, state.observationDeadline ?? Infinity)); return value.ledger.length === 1 && value.ledger[0].state === "applied" && value.round?.task_checkpoint?.status === "completed"; }, "reader_probe_recovery_not_completed");
  const recovered = readDatabase(db, state.deadline);
  assertion("reader_completed_same_identity", same(identity(recovered), originalIdentity)); assertion("reader_actual_probe_applied", recovered.events.some((event) => event.type === "probe" && event.state === "applied" && event.invocationId === originalIdentity.invocationId && event.idempotencyKey === originalIdentity.idempotencyKey && event.step?.id === originalIdentity.stepId && event.step?.tool === originalIdentity.tool));
  assertion("reader_recovered_migration_metadata_preserved", same(recovered.migrations, crashed.migrations));
  assertion("reader_recovery_tool_result_zero", recovered.events.filter((event) => event.type === "tool_result").length === 0);
  assertion("reader_ledger_applied", recovered.ledger[0].state === "applied" && recovered.ledger[0].lease_owner === null && recovered.ledger[0].lease_expires_at === null);
  assertion("reader_file_not_moved_again", !await exists(src) && same(original, await fingerprint(dst)));
  assertion("reader_fixture_only_model_events", recovered.events.filter((event) => event.type === "llm").every((event) => event.profileId?.startsWith("custom:qa/")));
  assertion("reader_alive_after_recovery", !hasProcessExited(reader)); assertion("fixture_no_unexpected_requests", state.fixture.counts.unexpected === 0);
  assertion("provider_config_not_created", !await exists(providerConfig));
  scenario.observations.push({ stage: "reader_recovered", goalStatus: recovered.goal.status, taskStatus: recovered.round.task_checkpoint.status, ledgerState: "applied", recoveryToolResults: 0, probeApplied: true, fixtureCounts: { ...state.fixture.counts } });
  scenario.finalArtifact = await fingerprint(dst);
  scenario.readerMigrationMetadataSha256 = hash(JSON.stringify(recovered.migrations));
  bounded(); scenario.status = "passed";
}

async function stopOwned(child, state, report) {
  if (!state.liveApps.has(child)) return;
  const role = state.roles.get(child); let result;
  try { result = await stopDetachedProcess(child, { graceMs: 1_000, killMs: 2_000 }); }
  catch (error) {
    // This helper stage itself proves leader exit plus zero live owned-group
    // members. Merely seeing the leader exit never clears ownership.
    if (error.stage !== "process_early_exit") { report.cleanup.appAttempts.push({ role, passed: false, stage: fixedFailure(error) }); throw error; }
    result = { controlledCleanup: true, leaderExited: true, liveProcessGroupGone: true, processGroupGone: null,
      exitCode: child.exitCode, signal: child.signalCode, groupProbe: "frozen-helper-early-exit-live-zero", fullGroupAbsenceNotAsserted: true };
  }
  report.cleanup.appAttempts.push({ role, passed: true, ...result }); state.liveApps.delete(child);
}
async function closeFixture(value) {
  if (!value) return { attempted: false, passed: true };
  let closed = false; value.server.close(() => { closed = true; }); value.server.closeIdleConnections?.();
  const until = Date.now() + 1_000; while (!closed && Date.now() < until) await pause(50);
  if (!closed) for (const socket of value.sockets) socket.destroy();
  const final = Date.now() + 1_000; while ((!closed || value.sockets.size) && Date.now() < final) await pause(50);
  return { attempted: true, passed: closed && value.sockets.size === 0, serverClosed: closed, socketsRemaining: value.sockets.size };
}

export async function main(args = process.argv.slice(2)) {
  const report = { schemaVersion: 1, kind: "historical-native-goal-upgrade-recovery", createdAt: new Date().toISOString(),
    passed: false, inputGatePassed: false, nativeExecutionAttempted: false, scenario: SCENARIO, platform: process.platform, architecture: process.arch,
    bindings: {}, attempts: [], ownedProcesses: [], cleanup: { appAttempts: [] },
    guard: { qaFaultsRequired: true, isolatedProfile: "1", requiredInstallIsolationFlag: "absent_for_default_home_config", provider: "synthetic_http_loopback", inheritedEnvironment: false,
      environmentKeys: ["HOME", "PATH", "TMPDIR", "LANG", "EASTGENESIS_QA_ISOLATED_PROFILE", "EASTGENESIS_QA_PROVIDER_BASE_URL", "EASTGENESIS_QA_PROVIDER_MODEL", "EASTGENESIS_QA_PROVIDER_PROTOCOL", "EASTGENESIS_QA_LEDGER_LEASE_MS", "EASTGENESIS_QA_FAULT_POINT"],
      dataRootResolution: "fresh_HOME/Library/Application Support/com.eastgenesis.desktop", databaseAccessByHarness: "readonly", precreatedAppdata: false, qaLeaseMs: LEASE_MS, productionLeaseMs: 600_000, nativeBudgetMs: BUDGET_MS },
    evidenceBoundary: { proven: [], excluded: ["released-version upgrade", "schema6 old application", "schema6-to7 migration", "natural plan-only crash from this barrier-protected writer", "native SQLite read fault", "real Provider", "Windows or Linux", "signed or notarized release", "production ten-minute lease takeover", "arbitrary duplicate tool attempts", "full OS XPC process cleanup"] } };
  const state = { liveApps: new Set(), roles: new Map(), copiedBundles: {} }; let options; let inputs; let outputHandle;
  const outputArgs = args.filter((arg) => /^--output=[^\x00-\x1f]+$/.test(arg));
  let outputPath = outputArgs.length === 1 ? resolve(outputArgs[0].slice("--output=".length)) : null;
  try {
    options = parseOptions(args);
    if (options.help) { console.log("Two App QA: --writer-app=... --reader-app=... --writer-source-root=... --reader-source-root=... --writer-manifest=... --reader-manifest=... --expected-writer-revision=... --expected-reader-revision=... --expected-writer-binary-sha256=... --expected-reader-binary-sha256=... --output=... [--check-inputs-only]. Native execution requires authorization; --check-inputs-only never launches Apps."); outputPath = null; return 0; }
    // Reserve the output before reading manifests or launching anything. A
    // pre-existing report or unwritable parent must never consume a GUI run.
    try { outputHandle = await open(options.output, "wx", 0o600); report.outputReservedBeforeInputGate = true; }
    catch (error) { fail(error.code === "EEXIST" ? "report_output_exists" : "report_output_not_writable"); }
    requireThat(process.platform === "darwin", "macos_required");
    report.harnessStartSha256 = await digest(fileURLToPath(import.meta.url));
    report.cleanupHelperStartSha256 = await digest(join(HERE, "desktop-process-cleanup.mjs")); report.frozenGoalHarnessStartSha256 = await digest(join(HERE, "desktop-goal-recovery-smoke.mjs"));
    requireThat(report.cleanupHelperStartSha256 === CLEANUP_SHA && report.frozenGoalHarnessStartSha256 === GOAL_HARNESS_SHA, "frozen_support_file_changed");
    inputs = await bindInputs(options, report); report.inputGatePassed = true;
    if (options["check-inputs-only"]) report.executionStatus = "inputs_verified_only";
    else { report.executionStatus = "native_running"; await nativeRun(inputs, report, state); report.executionStatus = "native_completed"; }
  } catch (error) {
    report.failedStage = fixedFailure(error); report.executionStatus = "failed";
    if (state.scenario) { state.scenario.status = "failed"; state.scenario.failedStage = report.failedStage; }
  } finally {
    for (const child of [...state.liveApps]) { try { await stopOwned(child, state, report); } catch { /* keep ownership until cleanup is proven */ } }
    report.cleanup.fixture = await closeFixture(state.fixture); report.cleanup.ownedAppGroupsCleaned = state.liveApps.size === 0; report.cleanup.ownedAppGroupsUnknown = state.liveApps.size;
    if (state.clipboardTouched) {
      try { execFileSync("/usr/bin/pbcopy", [], { input: "", timeout: 5_000, stdio: ["pipe", "ignore", "ignore"] }); report.cleanup.syntheticClipboardCleared = true; }
      catch { report.cleanup.syntheticClipboardCleared = false; }
    }
    if (inputs) {
      try { await verifyEnd(inputs, options, report); report.inputEndGatePassed = true; }
      catch (error) { report.inputEndGatePassed = false; report.failedStage ??= fixedFailure(error); }
      for (const role of Object.keys(state.copiedBundles)) {
        try {
          const binding = report.bindings[role];
          binding.copiedBinaryEndSha256 = await digest(join(state.copiedBundles[role], "Contents/MacOS/eastgenesis-desktop"));
          binding.copiedBundleUnchanged = same(await bundleSnapshot(state.copiedBundles[role]), inputs.roles[role].bundleHashes);
          if (!binding.copiedBundleUnchanged) report.failedStage ??= "copied_bundle_changed_during_run";
        } catch { report.failedStage ??= "copied_bundle_end_check_failed"; }
      }
    }
    if (report.harnessStartSha256) {
      try {
        report.harnessEndSha256 = await digest(fileURLToPath(import.meta.url)); report.cleanupHelperEndSha256 = await digest(join(HERE, "desktop-process-cleanup.mjs")); report.frozenGoalHarnessEndSha256 = await digest(join(HERE, "desktop-goal-recovery-smoke.mjs"));
        report.supportFilesUnchanged = report.harnessEndSha256 === report.harnessStartSha256 && report.cleanupHelperEndSha256 === CLEANUP_SHA && report.frozenGoalHarnessEndSha256 === GOAL_HARNESS_SHA;
      } catch { report.supportFilesUnchanged = false; }
    }
    report.cleanup.ownedMcpHelperCleanupUnknown = Boolean(state.helperCleanupUnknown);
    if (state.root && state.liveApps.size === 0 && report.cleanup.fixture.passed && !state.helperCleanupUnknown) {
      try { await rm(state.root, { recursive: true, force: true }); report.cleanup.ownedRootDeleted = true; }
      catch { report.cleanup.ownedRootDeleted = false; }
    } else if (state.root) report.cleanup.ownedRootDeleted = false;
    report.cleanup.passed = report.cleanup.ownedAppGroupsCleaned && !state.helperCleanupUnknown && report.cleanup.fixture.passed && report.cleanup.syntheticClipboardCleared !== false && report.cleanup.ownedRootDeleted !== false;
    if (state.fixture) {
      report.fixtureRequestCounts = { ...state.fixture.counts };
      const noUnexpectedRequests = report.fixtureRequestCounts.unexpected === 0;
      if (state.scenario) state.scenario.assertions.fixture_final_no_unexpected_requests = noUnexpectedRequests;
      if (!noUnexpectedRequests) report.failedStage ??= "fixture_no_unexpected_requests";
    }
    if (!report.cleanup.passed) report.failedStage ??= "cleanup_unverified";
    if (report.supportFilesUnchanged === false) report.failedStage ??= "support_files_changed_during_run";
    report.passed = report.nativeExecutionAttempted && report.attempts.length === 1 && report.attempts[0].status === "passed" && report.inputEndGatePassed === true && report.supportFilesUnchanged === true && report.cleanup.passed && !report.failedStage;
    if (report.failedStage && state.scenario) { state.scenario.status = "failed"; state.scenario.failedStage = report.failedStage; }
    if (report.passed) report.evidenceBoundary.proven = ["exact historical Git export writer created a native checkpoint", "two source-bound App binaries share one fresh HOME", "real MCP move followed by process SIGABRT", "new reader UI hydrates same task and single round", "active QA lease blocks replay", "actual QA expiry enables applied file probe", "same durable invocation applied with zero recovery tool results", "artifact inode mtime and hash preserved", "owned live process groups cleaned"];
    report.finishedAt = new Date().toISOString();
    if (outputHandle) {
      let original;
      const persistenceFailed = (category) => {
        report.failedStage = "report_output_not_written"; report.passed = false;
        report.reportPersistenceFailure = category; report.evidenceBoundary.proven = [];
        if (state.scenario) { state.scenario.status = "failed"; state.scenario.failedStage = report.failedStage; }
      };
      const writeSnapshot = async (handle) => {
        // A failed rewrite must not leave an earlier parseable passed report.
        await handle.truncate(0);
        const bytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
        let offset = 0;
        while (offset < bytes.length) {
          const result = await handle.write(bytes, offset, bytes.length - offset, offset);
          requireThat(result.bytesWritten > 0, "report_write_incomplete"); offset += result.bytesWritten;
        }
        await handle.sync();
      };
      try {
        original = await outputHandle.stat(); const current = await lstat(options.output);
        requireThat(current.isFile() && current.ino === original.ino && current.dev === original.dev, "report_output_identity_changed");
        await writeSnapshot(outputHandle);
      } catch {
        persistenceFailed("write_or_sync_failed");
        try { await writeSnapshot(outputHandle); } catch { try { await outputHandle.truncate(0); } catch { /* terminal output identifies persistence failure */ } }
      }
      try { await outputHandle.close(); }
      catch {
        persistenceFailed("close_failed");
        let recoveryHandle;
        try {
          recoveryHandle = await open(options.output, "r+"); const current = await recoveryHandle.stat();
          requireThat(original && current.isFile() && current.ino === original.ino && current.dev === original.dev, "report_output_identity_changed");
          await writeSnapshot(recoveryHandle);
        } catch { try { await outputHandle.truncate(0); } catch { /* retain fixed terminal failure */ } }
        finally { try { await recoveryHandle?.close(); } catch { /* original failure already captured */ } }
      }
    } else if (!options && outputPath) {
      try { await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" }); }
      catch { report.failedStage = "report_output_not_written"; report.passed = false; }
    }
    if (!options?.help) console.log(JSON.stringify({ passed: report.passed, inputGatePassed: report.inputGatePassed, inputEndGatePassed: report.inputEndGatePassed ?? false,
      nativeExecutionAttempted: report.nativeExecutionAttempted, executionStatus: report.executionStatus, failedStage: report.failedStage ?? null, cleanupPassed: report.cleanup.passed,
      reportPersistenceFailure: report.reportPersistenceFailure ?? null }));
  }
  return report.failedStage || (!report.passed && !options?.["check-inputs-only"]) ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then((code) => { process.exitCode = code; }).catch(() => { console.log(JSON.stringify({ passed: false, failedStage: "harness_terminal_failure" })); process.exitCode = 1; });
}

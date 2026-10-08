// @vitest-environment node
// Pure metadata and CLI rejection only: no App, AX, fixture or build runs.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const script = resolve("tools/desktop-goal-upgrade-recovery-smoke.mjs");
const oldRevision = "4a88d966aa327122695d62f8035cd1eb79c79b8c";
const oldParent = "b781765b3ed346d6da1d91f193f5279aaeb4caff";
const readerRevision = "a035aa93659a6b834a85aa166677fd663913b9b5";
const sha = "a".repeat(64);
const metadata = () => ({ schemaVersion: 1, passed: true, sourceUnchanged: true, formalReleaseBinding: false,
  sourceHashes: { "src/lib/db.ts": sha }, sourceEndHashes: { "src/lib/db.ts": sha }, sourceInputs: 1,
  binarySha256: sha, command: "CI=true pnpm exec tauri build --features qa-faults --bundles app", features: ["qa-faults"],
  sourceRevision: oldRevision, sourceExportTree: "1".repeat(40), archivedTreeVerified: true, localParentRevision: oldParent });

function validate(value: unknown, role = "writer") {
  const program = `import { validateManifest } from ${JSON.stringify(pathToFileURL(script).href)};
const input = JSON.parse(process.argv[1]);
try { const sources = validateManifest(input.value, input.role, input.options); console.log(JSON.stringify({ accepted: true, count: Object.keys(sources).length })); }
catch (error) { console.log(JSON.stringify({ accepted: false, stage: error.stage })); }`;
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", program, JSON.stringify({ value, role,
    options: { "expected-writer-revision": oldRevision, "expected-reader-revision": readerRevision,
      "expected-writer-binary-sha256": sha, "expected-reader-binary-sha256": sha } })], { encoding: "utf8", timeout: 5_000 });
  expect(child.status).toBe(0); expect(child.stderr).toBe(""); return JSON.parse(child.stdout.trim()) as { accepted: boolean; count?: number; stage?: string };
}

function coverage(value: Record<string, string>, trackedPaths: string[]) {
  const program = `import { validateCompiledCoverage } from ${JSON.stringify(pathToFileURL(script).href)};
const input = JSON.parse(process.argv[1]);
try { console.log(JSON.stringify({ accepted: true, ...validateCompiledCoverage(input.value, input.trackedPaths) })); }
catch (error) { console.log(JSON.stringify({ accepted: false, stage: error.stage })); }`;
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", program, JSON.stringify({ value, trackedPaths })], { encoding: "utf8", timeout: 5_000 });
  expect(child.status).toBe(0); expect(child.stderr).toBe(""); return JSON.parse(child.stdout.trim());
}

describe("historical two-App input gates", () => {
  it("accepts a reader's original worktree parent without relabeling it as the later source commit", () => {
    const value = metadata();
    const reader = { ...value, command: "pnpm tauri:build:mac:qa --bundles app", sourceRevision: undefined,
      archivedTreeVerified: undefined, sourceExportTree: undefined };
    expect(validate(reader, "reader")).toEqual({ accepted: true, count: 1 });
    expect(reader.localParentRevision).toBe(oldParent); expect(reader.localParentRevision).not.toBe(readerRevision);
  });

  it.each([
    ["not passed", { ...metadata(), passed: false }, "build_manifest_not_passed"],
    ["empty map", { ...metadata(), sourceHashes: {}, sourceEndHashes: {}, sourceInputs: 0 }, "source_input_count_invalid"],
    ["wrong count", { ...metadata(), sourceInputs: 2 }, "source_input_count_invalid"],
    ["changed end", { ...metadata(), sourceEndHashes: { "src/lib/db.ts": "b".repeat(64) } }, "build_source_end_hash_mismatch"],
    ["binary mismatch", { ...metadata(), binarySha256: "b".repeat(64) }, "build_binary_sha_mismatch"],
    ["export not verified", { ...metadata(), archivedTreeVerified: false }, "writer_export_provenance_invalid"],
    ["ordinary build", { ...metadata(), features: [], command: "pnpm exec tauri build" }, "qa_build_feature_not_bound"],
    ["alternate data-root config", { ...metadata(), command: "pnpm exec tauri build --features qa-faults --config other.json" }, "default_home_build_config_not_bound"],
    ["path escape", { ...metadata(), sourceHashes: { "../fixture-secret-endpoint": sha }, sourceEndHashes: { "../fixture-secret-endpoint": sha } }, "source_hash_entry_invalid"],
  ])("rejects %s before any native launch", (_name, value, stage) => {
    expect(validate(value)).toEqual({ accepted: false, stage });
  });

  const buildPaths = ["index.html", "assets/brand/mark.svg", "public/favicon.svg", "src/main.tsx", "src-tauri/build.rs",
    "crates/eg_core/src/lib.rs", "vendor/tauri-plugin-sql/src/commands.rs", "Cargo.lock", "package.json", "vite.config.ts"];
  it("accepts complete declared Vite and native inputs while excluding unrelated tools and user memory", () => {
    const sources = Object.fromEntries(buildPaths.map((name) => [name, sha]));
    expect(coverage(sources, [...buildPaths, "tools/non-build.mjs", "MEMORY.md"])).toEqual({ accepted: true, requiredInputs: buildPaths.length, covered: true });
  });
  it.each(["index.html", "assets/brand/mark.svg", "public/favicon.svg"])("rejects a manifest omitting actual build input %s", (omitted) => {
    const sources = Object.fromEntries(buildPaths.filter((name) => name !== omitted).map((name) => [name, sha]));
    expect(coverage(sources, buildPaths)).toEqual({ accepted: false, stage: "compiled_input_coverage_missing" });
  });

  it.each(["EastGenesis", "UnexpectedProject"])("resolves real Git roots through a directory symlink while preserving the %s prefix gate", (project) => {
    const root = mkdtempSync(join(tmpdir(), "eg-upgrade-git-alias-"));
    try {
      const actualGitRoot = join(root, "actual"); const alias = join(root, "alias");
      mkdirSync(join(actualGitRoot, project), { recursive: true });
      execFileSync("git", ["init", "--quiet", actualGitRoot], { timeout: 5_000, stdio: "ignore" });
      symlinkSync(actualGitRoot, alias, "dir");
      const sourceRoot = join(alias, project);
      const program = `import { resolveScopedGitProject } from ${JSON.stringify(pathToFileURL(script).href)};
try { console.log(JSON.stringify({ accepted: true, ...await resolveScopedGitProject(process.argv[1]) })); }
catch (error) { console.log(JSON.stringify({ accepted: false, stage: error.stage })); }`;
      const child = spawnSync(process.execPath, ["--input-type=module", "--eval", program, sourceRoot], { encoding: "utf8", timeout: 5_000 });
      expect(child.status).toBe(0); expect(child.stderr).toBe("");
      const result = JSON.parse(child.stdout.trim());
      if (project === "EastGenesis") {
        // fs/promises.realpath uses the native API. The legacy synchronous
        // implementation may retain Windows 8.3 components for the same path.
        expect(result).toEqual({ accepted: true, gitRoot: realpathSync.native(actualGitRoot), canonicalSourceRoot: realpathSync.native(sourceRoot), prefix: "EastGenesis" });
        for (const [actual, expected] of [[result.gitRoot, actualGitRoot], [result.canonicalSourceRoot, sourceRoot]]) {
          const actualDirectory = statSync(actual, { bigint: true });
          const expectedDirectory = statSync(expected, { bigint: true });
          expect(actualDirectory.isDirectory()).toBe(true);
          expect({ dev: actualDirectory.dev, ino: actualDirectory.ino }).toEqual({ dev: expectedDirectory.dev, ino: expectedDirectory.ino });
        }
      } else expect(result).toEqual({ accepted: false, stage: "scoped_git_project_invalid" });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("preserves a fixed CLI rejection report without exposing supplied paths or starting native execution", () => {
    const root = mkdtempSync(join(tmpdir(), "eg-upgrade-input-test-"));
    try {
      const output = join(root, "report.json");
      const child = spawnSync(process.execPath, [script, "--writer-app=/fixture-secret-provider/token", `--output=${output}`, "--unknown=/fixture-secret-provider/token"], { encoding: "utf8", timeout: 5_000 });
      expect(child.status).toBe(1); expect(child.stderr).toBe("");
      expect(child.stdout).not.toContain("fixture-secret-provider");
      const bytes = readFileSync(output, "utf8"); expect(bytes).not.toContain("fixture-secret-provider");
      expect(JSON.parse(bytes)).toMatchObject({ passed: false, inputGatePassed: false, nativeExecutionAttempted: false,
        failedStage: "invalid_option", attempts: [], ownedProcesses: [] });
      expect(JSON.parse(child.stdout.trim())).toMatchObject({ passed: false, nativeExecutionAttempted: false, failedStage: "invalid_option" });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("does not overwrite an earlier failed report", () => {
    const root = mkdtempSync(join(tmpdir(), "eg-upgrade-report-test-"));
    try {
      const output = join(root, "report.json"); const original = '{"fixedEarlierFailure":true}\n'; writeFileSync(output, original);
      const child = spawnSync(process.execPath, [script, `--output=${output}`], { encoding: "utf8", timeout: 5_000 });
      expect(child.status).toBe(1); expect(child.stderr).toBe(""); expect(readFileSync(output, "utf8")).toBe(original);
      expect(JSON.parse(child.stdout.trim())).toMatchObject({ passed: false, nativeExecutionAttempted: false, failedStage: "report_output_not_written" });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("rejects an existing output before source reads or GUI with a complete legal CLI", () => {
    const root = mkdtempSync(join(tmpdir(), "eg-upgrade-output-gate-"));
    try {
      const output = join(root, "report.json"); const original = '{"earlierNativeAttempt":true}\n'; writeFileSync(output, original);
      const args = ["--writer-app=/synthetic/Writer.app/Contents/MacOS/eastgenesis-desktop", "--reader-app=/synthetic/Reader.app/Contents/MacOS/eastgenesis-desktop",
        "--writer-source-root=/synthetic/writer", "--reader-source-root=/synthetic/reader", "--writer-manifest=/synthetic/writer.json", "--reader-manifest=/synthetic/reader.json",
        `--expected-writer-revision=${oldRevision}`, `--expected-reader-revision=${readerRevision}`, `--expected-writer-binary-sha256=${sha}`,
        `--expected-reader-binary-sha256=${sha}`, `--output=${output}`];
      const child = spawnSync(process.execPath, [script, ...args], { encoding: "utf8", timeout: 5_000 });
      expect(child.status).toBe(1); expect(child.stderr).toBe(""); expect(readFileSync(output, "utf8")).toBe(original);
      expect(JSON.parse(child.stdout.trim())).toMatchObject({ passed: false, inputGatePassed: false, nativeExecutionAttempted: false, failedStage: "report_output_exists" });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

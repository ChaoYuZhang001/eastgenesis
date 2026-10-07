// @vitest-environment node
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FRONTEND_STARTUP_STAGES, MAX_TRACE_BYTES, NATIVE_STARTUP_STAGES, TRACE_RECORD_LIMIT,
  parseStartupTraceText, validateStartupTraceReport,
} from "../tools/desktop-startup-trace.mjs";
import { validateHelperReport } from "../tools/desktop-windows-install-smoke.mjs";

const runId = "01234567-89ab-4cde-8123-456789abcdef";
const otherRunId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const header = { schemaVersion: 1, kind: "desktop-qa-startup", runId, recordLimit: TRACE_RECORD_LIMIT };
const native = (patch: Record<string, unknown> = {}) => ({ seq: 1, source: "native", stage: "native_started", elapsedMs: 0, frontendSeq: null, ...patch });
const frontend = (patch: Record<string, unknown> = {}) => ({ seq: 2, source: "frontend", stage: "document_start", elapsedMs: 1, frontendSeq: 1, ...patch });
const text = (records: unknown[] = [native(), frontend()], first: unknown = header) => `${[first, ...records].map((value) => JSON.stringify(value)).join("\n")}\n`;
const unobserved = (reason: string) => ({ status: "unobserved", reason, runId, records: [] });
const fixture = (startupTrace?: unknown) => ({
  schemaVersion: 1, passed: false, checks: { hostedRunner: true }, stages: ["hostedRunner"], errors: ["database_timeout"],
  attempts: { install: true, reinstall: false, uninstall: false }, launches: [], payloadBinding: null,
  startupDiagnostics: [{
    cycle: 1, outcome: "failed", failureStage: "database_timeout", elapsedMs: 34_000, stableWindowPassed: true,
    databaseExists: false, schemaProbeAttempts: 0, schemaProbeFailures: 0, schemaProbeState: "not_attempted", lastProbeFailureStage: null,
    rootProcessAlive: true, rootWindowPresent: true, jobActiveProcessCount: 4,
    ...(startupTrace === undefined ? {} : { startupTrace }),
  }],
});

async function runCli(content: string | Buffer | null, options: { symlink?: boolean; directory?: boolean; pathName?: string; outputMissingParent?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "eastgenesis-startup-trace-test-"));
  const trace = join(root, options.pathName ?? `eg-qa-startup-${runId}.jsonl`);
  const output = options.outputMissingParent ? join(root, "missing-parent", "report.json") : join(root, "report.json");
  try {
    if (options.directory) await mkdir(trace);
    else if (content !== null) {
      if (options.symlink) {
        const real = join(root, "synthetic-private-source.jsonl");
        await writeFile(real, content);
        await symlink(real, trace);
      } else await writeFile(trace, content);
    }
    const result = spawnSync(process.execPath, [resolve("tools/desktop-startup-trace.mjs"), "--trace", trace, "--run-id", runId, "--output", output], { encoding: "utf8", timeout: 5000 });
    const serialized = await readFile(output, "utf8").catch(() => null);
    return { result, serialized, report: serialized === null ? null : JSON.parse(serialized) };
  } finally { await rm(root, { recursive: true, force: true }); }
}

describe("fixed startup trace parsing and public projection", () => {
  it("projects the exact header-bound observations", () => {
    const report = parseStartupTraceText(text(), runId);
    expect(report).toEqual({ status: "observed", reason: "complete", runId, records: [native(), frontend()] });
    expect(validateStartupTraceReport(report)).toEqual(report);
    expect(parseStartupTraceText(text().replace(/\n/g, "\r\n"), runId)).toEqual(report);
  });

  it("preserves frontend call sequence when IPC arrivals are reordered", () => {
    const records = [native(), frontend({ frontendSeq: 2 }), frontend({ seq: 3, elapsedMs: 2, frontendSeq: 1, stage: "frontend_entry" })];
    expect(parseStartupTraceText(text(records), runId)).toMatchObject({ status: "observed", records });
  });

  it("accepts every fixed stage with its matching source", () => {
    for (const stage of NATIVE_STARTUP_STAGES.filter((name) => name !== "record_limit_reached")) {
      expect(parseStartupTraceText(text([native({ stage })]), runId).status).toBe("observed");
    }
    for (const stage of FRONTEND_STARTUP_STAGES) {
      expect(parseStartupTraceText(text([frontend({ seq: 1, stage })]), runId).status).toBe("observed");
    }
  });

  it("SQL typed observations cannot be attributed to the renderer or carry original error details", () => {
    const stages = NATIVE_STARTUP_STAGES.filter((stage) => stage.startsWith("sql_"));
    expect(stages.length).toBeGreaterThan(0);
    for (const stage of stages) {
      expect(parseStartupTraceText(text([native({ stage })]), runId).status).toBe("observed");
      expect(parseStartupTraceText(text([frontend({ seq: 1, stage })]), runId)).toEqual(unobserved("invalid"));
      expect(parseStartupTraceText(text([native({ stage, originalError: "synthetic confidential SQL/path" })]), runId))
        .toEqual(unobserved("invalid"));
    }
    expect(parseStartupTraceText(text([native({ stage: "sql_connect_unreviewed_detail" })]), runId))
      .toEqual(unobserved("invalid"));
  });

  it("requires an explicit final record at the 64-record cap", () => {
    const records = Array.from({ length: 64 }, (_, index) => native({ seq: index + 1, elapsedMs: index, stage: index === 63 ? "record_limit_reached" : "page_started" }));
    expect(parseStartupTraceText(text(records), runId)).toMatchObject({ status: "observed", reason: "record_limit", records });
    expect(parseStartupTraceText(text(records.map((record) => ({ ...record, stage: "page_started" }))), runId)).toEqual(unobserved("invalid"));
    expect(parseStartupTraceText(text([...records, native({ seq: 65, elapsedMs: 64 })]), runId)).toEqual(unobserved("invalid"));
    expect(parseStartupTraceText(text([native({ stage: "record_limit_reached" })]), runId)).toEqual(unobserved("invalid"));
  });

  it.each([
    [native({ seq: 0 })], [native({ seq: 2 })], [native(), native({ seq: 3 })],
    [native({ elapsedMs: -1 })], [native({ elapsedMs: 600_001 })], [native({ elapsedMs: 1.1 })],
    [native({ elapsedMs: 2 }), frontend({ elapsedMs: 1 })], [native({ source: "unknown" })],
    [native({ source: "frontend" })], [frontend({ seq: 1, stage: "native_started" })],
    [native({ frontendSeq: 1 })], [frontend({ seq: 1, frontendSeq: null })],
    [frontend({ seq: 1, frontendSeq: 0 })], [frontend({ seq: 1, frontendSeq: 65 })],
    [frontend({ seq: 1 }), frontend({ seq: 2, elapsedMs: 2 })],
    [native({ stage: "synthetic-private-url" })], [native({ detail: "synthetic-private-error" })],
  ])("rejects invalid record constraints without keeping a partial prefix (%#)", (...records) => {
    expect(parseStartupTraceText(text(records), runId)).toEqual(unobserved("invalid"));
  });

  it("rejects extra header fields and wrong header/run binding", () => {
    for (const first of [{ ...header, privateUrl: "https://synthetic.invalid" }, { ...header, runId: otherRunId }, { ...header, schemaVersion: 2 }, { ...header, kind: "other" }, { ...header, recordLimit: 65 }]) {
      expect(parseStartupTraceText(text([native()], first), runId)).toEqual(unobserved("invalid"));
    }
    expect(() => parseStartupTraceText(text(), runId.toUpperCase())).toThrow(/^startup_trace_invalid$/);
  });

  it("rejects truncation, blank lines, BOM, header-only and bounded excess", () => {
    for (const input of ["", text().slice(0, -1), text().slice(0, -5), text([]), `${text()}\n`, `\uFEFF${text()}`, `${text()}${" ".repeat(MAX_TRACE_BYTES)}\n`]) {
      expect(parseStartupTraceText(input, runId)).toEqual(unobserved("invalid"));
    }
  });

  it("bounds UTF8 bytes and accepts a valid snapshot exactly at the byte cap", () => {
    const padded = `${" ".repeat(MAX_TRACE_BYTES - Buffer.byteLength(text()))}${text()}`;
    expect(Buffer.byteLength(padded)).toBe(MAX_TRACE_BYTES);
    expect(parseStartupTraceText(padded, runId).status).toBe("observed");
    expect(parseStartupTraceText(` ${padded}`, runId)).toEqual(unobserved("invalid"));
    const multiByteExcess = `${"界".repeat(MAX_TRACE_BYTES / 2)}${text()}`;
    expect(multiByteExcess.length).toBeLessThan(MAX_TRACE_BYTES);
    expect(parseStartupTraceText(multiByteExcess, runId)).toEqual(unobserved("invalid"));
  });

  it("rejects repeated JSON keys including escaped key spellings", () => {
    const doubled = JSON.stringify(native()).replace('"seq":1', '"seq":1,"seq":1');
    const escaped = JSON.stringify(native()).replace('"seq":1', '"seq":1,"s\\u0065q":1');
    expect(parseStartupTraceText(`${JSON.stringify(header)}\n${doubled}\n`, runId)).toEqual(unobserved("invalid"));
    expect(parseStartupTraceText(`${JSON.stringify(header)}\n${escaped}\n`, runId)).toEqual(unobserved("invalid"));
  });

  it("validates public reports with fixed errors and no arbitrary field passthrough", () => {
    const observed = parseStartupTraceText(text(), runId);
    const invalid: unknown[] = [null, [], { ...observed, privatePath: "synthetic-private-path" }, { ...observed, runId: "synthetic-private-run" },
      { ...observed, reason: "record_limit" }, { ...observed, records: [] }, { ...unobserved("missing"), records: [native()] },
      { ...unobserved("missing"), reason: "complete" }, { ...observed, records: [{ ...native(), url: "synthetic-private-url" }] }];
    for (const value of invalid) expect(() => validateStartupTraceReport(value)).toThrow(/^startup_trace_invalid$/);
    for (const reason of ["missing", "invalid", "read_failed", "capture_failed"]) {
      expect(validateStartupTraceReport(unobserved(reason))).toEqual(unobserved(reason));
    }
    const projected = validateStartupTraceReport(observed);
    expect(projected).not.toBe(observed);
    if (projected.status === "observed" && observed.status === "observed") expect(projected.records[0]).not.toBe(observed.records[0]);
  });

  it("sanitizes exceptional getters and rejects hidden or symbol fields", () => {
    const value = Object.defineProperty({ ...unobserved("missing") }, "reason", { enumerable: true, get() { throw new Error("synthetic-private-provider-error"); } });
    expect(() => validateStartupTraceReport(value)).toThrow(/^startup_trace_invalid$/);
    for (const invalid of [Object.defineProperty({ ...unobserved("missing") }, "privatePath", { value: "synthetic-private", enumerable: false }),
      { ...unobserved("missing"), [Symbol("private")]: "synthetic-private" }]) {
      expect(() => validateStartupTraceReport(invalid)).toThrow(/^startup_trace_invalid$/);
    }
  });
});

describe("startup trace CLI bounded read and privacy", () => {
  it("reads a real JSONL file and writes only a fixed JSON report with silent output", async () => {
    const { result, report } = await runCli(text());
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    expect(report).toEqual(parseStartupTraceText(text(), runId));
  });

  it.each([
    [null, "missing"],
    [text([native()], { ...header, runId: otherRunId }), "invalid"],
    [text().slice(0, -1), "invalid"],
    [Buffer.concat([Buffer.from(text()), Buffer.from([0xff, 0x0a])]), "invalid"],
    [text([native({ detail: "synthetic-private-body" })]), "invalid"],
    ["x".repeat(MAX_TRACE_BYTES + 1), "invalid"],
  ])("returns %s as an unobserved snapshot without failing app evidence", async (content, reason) => {
    const { result, report, serialized } = await runCli(content);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    expect(report).toEqual(unobserved(reason));
    expect(serialized).not.toMatch(/synthetic-private|synthetic\.invalid|Error|ENOENT|\.jsonl|\/Users\//);
  });

  it("rejects a symlink even when its target contains a valid bound trace", async () => {
    const { result, report } = await runCli(text(), { symlink: true });
    expect(result.status).toBe(0);
    expect(report).toEqual(unobserved("invalid"));
    expect(result.stdout + result.stderr).toBe("");
  });

  it("rejects a nonregular trace and accepts exactly the bounded file size", async () => {
    const directory = await runCli(null, { directory: true });
    expect(directory.result.status).toBe(0);
    expect(directory.report).toEqual(unobserved("invalid"));
    const bounded = await runCli(`${" ".repeat(MAX_TRACE_BYTES - Buffer.byteLength(text()))}${text()}`);
    expect(bounded.result.status).toBe(0);
    expect(bounded.report).toEqual(parseStartupTraceText(text(), runId));
  });

  it("requires the bound sidecar filename and keeps output I/O errors silent", async () => {
    const wrongName = await runCli(text(), { pathName: "synthetic-private.jsonl" });
    expect(wrongName.result.status).toBe(0);
    expect(wrongName.report).toEqual(unobserved("invalid"));
    const unwritable = await runCli(text(), { outputMissingParent: true });
    expect(unwritable.result.status).toBe(1);
    expect(unwritable.report).toBeNull();
    expect(unwritable.result.stdout + unwritable.result.stderr).toBe("");
  });

  it("rejects invalid CLI arguments without printing paths or supplied values", () => {
    for (const args of [["--private-url", "https://synthetic.invalid"], ["--trace", "synthetic-private-path"], ["--trace", "fixture", "--run-id", "synthetic-private-run", "--output", "fixture"]]) {
      const result = spawnSync(process.execPath, [resolve("tools/desktop-startup-trace.mjs"), ...args], { encoding: "utf8", timeout: 5000 });
      expect(result.status).toBe(1);
      expect(result.stdout + result.stderr).toBe("");
    }
  });
});

describe("Windows startup diagnostic optional fixed trace", () => {
  it("keeps old startup records readable and preserves observed or missing trace without changing app outcome", () => {
    expect(validateHelperReport(fixture())).toMatchObject({ passed: false, errors: ["database_timeout"] });
    for (const trace of [parseStartupTraceText(text(), runId), unobserved("missing"), unobserved("invalid"), unobserved("capture_failed")]) {
      expect(validateHelperReport(fixture(trace))).toMatchObject({ passed: false, errors: ["database_timeout"], startupDiagnostics: [{ startupTrace: trace }] });
    }
  });

  it("rejects malformed optional traces instead of exposing raw helper data", () => {
    const observed = parseStartupTraceText(text(), runId);
    for (const value of [null, { ...observed, privateError: "synthetic-private-detail" }, { ...observed, reason: "record_limit" }, { ...unobserved("missing"), records: [native()] }]) {
      expect(() => validateHelperReport(fixture(value))).toThrow(/^helper_report_invalid$/);
    }
  });

  it("rejects reusing one startup trace for two cycles, including unobserved traces", () => {
    for (const trace of [parseStartupTraceText(text(), runId), unobserved("missing")]) {
      const initial = fixture(trace);
      const first = { ...initial.startupDiagnostics[0], outcome: "database_ready", failureStage: null, databaseExists: true, schemaProbeAttempts: 1, schemaProbeState: "ready" };
      const second = { ...initial.startupDiagnostics[0], cycle: 2 };
      const twoCycles = { ...initial, attempts: { ...initial.attempts, reinstall: true }, startupDiagnostics: [first, second] };
      expect(() => validateHelperReport(twoCycles)).toThrow(/^helper_report_invalid$/);
      expect(validateHelperReport({ ...twoCycles, startupDiagnostics: [first, { ...second, startupTrace: { ...trace, runId: otherRunId } }] }))
        .toMatchObject({ startupDiagnostics: [{ startupTrace: { runId } }, { startupTrace: { runId: otherRunId } }] });
    }
  });

  it("declares the owned runtime and fixed reader to the Windows helper", async () => {
    const source = await readFile(resolve("tools/desktop-windows-install-smoke.mjs"), "utf8");
    expect(source).toContain("nodeBinary: process.execPath");
    expect(source).toContain('startupTraceReader: join(scriptDirectory, "desktop-startup-trace.mjs")');
  });
});

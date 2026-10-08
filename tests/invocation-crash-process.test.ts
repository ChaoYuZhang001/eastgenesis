// @vitest-environment node
// 真实独立 Node 进程故障窗口：副作用先落盘，再在最终账本提交前 SIGKILL，随后由新进程恢复。
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { loadSqlite } from "./sqlite-helper";

const sqlite = await loadSqlite();
const worker = resolve(process.cwd(), "tests/invocation-crash-worker.ts");
const TASK_ROW_SQL = "SELECT state, lease_owner, lease_expires_at FROM tool_invocations WHERE task_id = $1 AND step_id = $2";

type SyncDb = {
  exec(sql: string): void;
  prepare(sql: string): { get(params: Record<string, unknown>): Record<string, unknown> | undefined };
  close(): void;
};

function runWorker(mode: "crash" | "recover" | "crash-stale" | "recover-stale" | "recover-read-error", dbPath: string, artifactPath: string): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  return new Promise((resolveWorker, rejectWorker) => {
    const child = spawn(process.execPath, ["--import", "tsx/esm", worker, mode, dbPath, artifactPath], {
      cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", rejectWorker);
    child.once("close", (code, signal) => resolveWorker({ code, signal, stdout, stderr }));
  });
}

describe.skipIf(!sqlite)("真实独立进程崩溃窗口", () => {
  it.each(["recover-stale", "recover-read-error"] as const)("仅计划的落后 checkpoint 在 %s 时保持同一任务并等待用户", async (recoveryMode) => {
    const root = mkdtempSync(join(tmpdir(), "eastgenesis-stale-checkpoint-"));
    const dbPath = join(root, "eastgenesis.db");
    const artifactPath = join(root, "marker.txt");
    try {
      const crashed = await runWorker("crash-stale", dbPath, artifactPath);
      if (process.platform === "win32") expect(crashed.code).not.toBe(0);
      else expect(crashed.signal).toBe("SIGKILL");
      const hash = () => createHash("sha256").update(readFileSync(artifactPath)).digest("hex");
      expect(readFileSync(artifactPath, "utf8")).toBe("applied\n");
      const originalHash = hash();
      const afterCrash = new DatabaseSync(dbPath) as unknown as SyncDb;
      let startedLedger: Record<string, unknown> | undefined;
      try {
        expect(afterCrash.prepare(TASK_ROW_SQL).get({ $1: "task-process-crash-window", $2: "s1" })).toMatchObject({
          state: "started", lease_owner: expect.any(String), lease_expires_at: 110,
        });
        startedLedger = afterCrash.prepare("SELECT * FROM tool_invocations WHERE task_id=$1 AND step_id=$2")
          .get({ $1: "task-process-crash-window", $2: "s1" });
        expect(startedLedger).toBeDefined();
        const row = afterCrash.prepare("SELECT rounds FROM goals WHERE id=$1").get({ $1: "goal-process-crash" });
        const rounds = JSON.parse(String(row?.rounds));
        expect(rounds).toHaveLength(1);
        expect(rounds[0].task_checkpoint.events.map((event: { type: string }) => event.type)).toEqual(["run_start", "plan"]);
      } finally { afterCrash.close(); }
      const recovered = await runWorker(recoveryMode, dbPath, artifactPath);
      expect(recovered.code, `${recovered.stderr}\n${recovered.stdout}`).toBe(0);
      expect(recovered.signal).toBeNull();
      expect(JSON.parse(recovered.stdout.trim())).toEqual({
        status: "needs_user", runCalls: 0, probeCalls: 0, confirmCalls: 0, goalStatus: "paused",
        taskId: "task-process-crash-window", roundCount: 1, ledgerState: "started", checkpointRecords: 0,
        reasonCategory: recoveryMode === "recover-read-error" ? "ledger_read_failed" : "missing_original_identity",
        ...(recoveryMode === "recover-read-error" ? { sqliteReadFaultObserved: true } : {}),
      });
      expect(hash()).toBe(originalHash);
      const afterRecovery = new DatabaseSync(dbPath) as unknown as SyncDb;
      try {
        expect(afterRecovery.prepare(TASK_ROW_SQL).get({ $1: "task-process-crash-window", $2: "s1" })).toMatchObject({
          state: "started", lease_owner: expect.any(String), lease_expires_at: 110,
        });
        expect(afterRecovery.prepare("SELECT COUNT(*) AS n FROM tool_invocations").get({})?.n).toBe(1);
        expect(afterRecovery.prepare("SELECT * FROM tool_invocations WHERE task_id=$1 AND step_id=$2")
          .get({ $1: "task-process-crash-window", $2: "s1" })).toEqual(startedLedger);
      } finally { afterRecovery.close(); }
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 20_000);

  it("副作用已落地但账本仍为 started 时，重启实例用 probe 恢复为 applied", async () => {
    const root = mkdtempSync(join(tmpdir(), "eastgenesis-crash-window-"));
    const dbPath = join(root, "eastgenesis.db");
    const artifactPath = join(root, "marker.txt");
    try {
      const crashed = await runWorker("crash", dbPath, artifactPath);
      // Windows reports process.kill(..., "SIGKILL") as a non-zero exit code
      // instead of exposing a Unix signal name; both represent the crash edge.
      if (process.platform === "win32") expect(crashed.code).not.toBe(0);
      else expect(crashed.signal).toBe("SIGKILL");
      expect(readFileSync(artifactPath, "utf8").trim()).toBe("applied");
      const afterCrash = new DatabaseSync(dbPath) as unknown as SyncDb;
      const started = afterCrash.prepare(TASK_ROW_SQL).get({ $1: "task-process-crash-window", $2: "s1" });
      expect(started, `${crashed.stderr}\n${crashed.stdout}`).toMatchObject({ state: "started", lease_owner: expect.any(String), lease_expires_at: 110 });
      afterCrash.close();

      const recovered = await runWorker("recover", dbPath, artifactPath);
      expect(recovered.code, `${recovered.stderr}\n${recovered.stdout}`).toBe(0);
      expect(recovered.signal).toBeNull();
      expect(JSON.parse(recovered.stdout.trim())).toMatchObject({
        status: "completed", runCalls: 0, goalStatus: "completed", taskId: "task-process-crash-window", ledgerState: "applied",
      });
      const afterRecovery = new DatabaseSync(dbPath) as unknown as SyncDb;
      const applied = afterRecovery.prepare(TASK_ROW_SQL).get({ $1: "task-process-crash-window", $2: "s1" });
      expect(applied).toMatchObject({ state: "applied", lease_owner: null, lease_expires_at: null });
      afterRecovery.close();

      const evidencePath = process.env.EASTGENESIS_CRASH_EVIDENCE_PATH;
      if (evidencePath) {
        writeFileSync(evidencePath, `${JSON.stringify({
          schemaVersion: 1,
          kind: "goal-recovery-crash-smoke",
          passed: true,
          goalStatus: "completed",
          taskId: "task-process-crash-window",
          runCalls: 0,
          ledgerState: "applied",
          evidenceBoundary: {
            proven: [
              "production goal state transitions across two Node processes",
              "same task id after restart",
              "ledger probe avoids duplicate side effect",
            ],
            excluded: [
              "real Tauri WebView interaction",
              "real Provider availability",
              "signed/notarized distribution",
            ],
          },
        }, null, 2)}\n`, "utf8");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);
});

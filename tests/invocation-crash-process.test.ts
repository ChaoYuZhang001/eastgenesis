// @vitest-environment node
// 真实独立 Node 进程故障窗口：副作用先落盘，再在最终账本提交前 SIGKILL，随后由新进程恢复。
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { loadSqlite } from "./sqlite-helper";

const sqlite = await loadSqlite();
const worker = resolve(process.cwd(), "tests/invocation-crash-worker.ts");
const TASK_ROW_SQL = "SELECT state, lease_owner, lease_expires_at FROM tool_invocations WHERE task_id = $1 AND step_id = $2";

type SyncDb = {
  exec(sql: string): void;
  prepare(sql: string): { get(params: Record<string, unknown>): Record<string, unknown> | undefined };
  close(): void;
};

function runWorker(mode: "crash" | "recover", dbPath: string, artifactPath: string): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
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
  it("副作用已落地但账本仍为 started 时，重启实例用 probe 恢复为 applied", async () => {
    const root = mkdtempSync(join(tmpdir(), "eastgenesis-crash-window-"));
    const dbPath = join(root, "eastgenesis.db");
    const artifactPath = join(root, "marker.txt");
    try {
      const crashed = await runWorker("crash", dbPath, artifactPath);
      expect(crashed.signal).toBe("SIGKILL");
      expect(readFileSync(artifactPath, "utf8").trim()).toBe("applied");
      const afterCrash = new DatabaseSync(dbPath) as unknown as SyncDb;
      const started = afterCrash.prepare(TASK_ROW_SQL).get({ $1: "process-crash-window", $2: "s1" });
      expect(started, `${crashed.stderr}\n${crashed.stdout}`).toMatchObject({ state: "started", lease_owner: expect.any(String), lease_expires_at: 110 });
      afterCrash.close();

      const recovered = await runWorker("recover", dbPath, artifactPath);
      expect(recovered.code, `${recovered.stderr}\n${recovered.stdout}`).toBe(0);
      expect(recovered.signal).toBeNull();
      expect(JSON.parse(recovered.stdout.trim())).toMatchObject({ status: "completed", runCalls: 0 });
      const afterRecovery = new DatabaseSync(dbPath) as unknown as SyncDb;
      const applied = afterRecovery.prepare(TASK_ROW_SQL).get({ $1: "process-crash-window", $2: "s1" });
      expect(applied).toMatchObject({ state: "applied", lease_owner: null, lease_expires_at: null });
      afterRecovery.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);
});

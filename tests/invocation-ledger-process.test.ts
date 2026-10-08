// @vitest-environment node
// 真实文件 SQLite 的跨进程租约验证：比 mock ledger 更接近 Tauri 的多实例行为。
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { INVOCATION_SQL } from "@/lib/db-invocation";
import { loadSqlite, readMigrations, type SqliteModule } from "./sqlite-helper";

const sqlite = await loadSqlite();
const worker = resolve(process.cwd(), "tests/invocation-ledger-worker.ts");

type SyncDb = {
  exec(sql: string): void;
  prepare(sql: string): {
    run(params: Record<string, unknown>): { changes: number | bigint };
    get(params: Record<string, unknown>): unknown;
  };
  close(): void;
};

type WorkerResult = { command: string; owner: string; changes: number };

function createLedgerFile(mod: SqliteModule, path: string): void {
  const db = new mod.DatabaseSync(path) as unknown as SyncDb;
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  for (const migration of readMigrations()) db.exec(migration.sql);
  db.prepare(INVOCATION_SQL.put).run({
    $1: "eg-process-race",
    $2: "task-race",
    $3: "s1",
    $4: "task-race:s1:1",
    $5: "write_file",
    $6: "deadbeef",
    $7: 1,
    $8: "started",
    $9: "[]",
    $10: "",
    $11: null,
    $12: null,
    $13: 1,
    $14: 1,
  });
  db.close();
}

function wait(ms: number): Promise<void> {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms));
}

async function waitForFiles(paths: readonly string[], timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (paths.every((path) => {
      try {
        return readFileSync(path, "utf8").trim() === "ready";
      } catch {
        return false;
      }
    })) return;
    await wait(10);
  }
  throw new Error(`等待账本 worker 就绪超时：${paths.join(", ")}`);
}

function runWorker(args: { dbPath: string; readyPath: string; goPath: string; command: string; key: string; owner: string; now: number; ttl: number }): Promise<WorkerResult> {
  return new Promise((resolveWorker, rejectWorker) => {
    const child = spawn(process.execPath, ["--import", "tsx/esm", worker, args.dbPath, args.readyPath, args.goPath, args.command, args.key, args.owner, String(args.now), String(args.ttl)], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", rejectWorker);
    child.once("close", (code) => {
      if (code !== 0) {
        rejectWorker(new Error(`账本 worker 退出 ${code}: ${stderr || stdout}`));
        return;
      }
      try {
        resolveWorker(JSON.parse(stdout.trim()) as WorkerResult);
      } catch (error) {
        const detail = new Error(`账本 worker 输出无效：${stdout || stderr}`);
        (detail as Error & { cause?: unknown }).cause = error;
        rejectWorker(detail);
      }
    });
  });
}

async function runRacingClaim(dbPath: string, root: string): Promise<WorkerResult[]> {
  const goPath = join(root, "go");
  const specs = ["owner-a", "owner-b"].map((owner) => ({
    dbPath,
    readyPath: join(root, `${owner}.ready`),
    goPath,
    command: "claim",
    key: "eg-process-race",
    owner,
    now: 100,
    ttl: 20,
  }));
  const results = specs.map(runWorker);
  await waitForFiles(specs.map((spec) => spec.readyPath));
  writeFileSync(goPath, "go\n", "utf8");
  return Promise.all(results);
}

async function runSingle(dbPath: string, root: string, command: string, owner: string, now: number, ttl: number): Promise<WorkerResult> {
  const spec = {
    dbPath,
    readyPath: join(root, `${command}-${owner}.ready`),
    goPath: join(root, `${command}-${owner}.go`),
    command,
    key: "eg-process-race",
    owner,
    now,
    ttl,
  };
  const result = runWorker(spec);
  await waitForFiles([spec.readyPath]);
  writeFileSync(spec.goPath, "go\n", "utf8");
  return result;
}

describe.skipIf(!sqlite)("真实 SQLite 跨进程调用租约", () => {
  it("两个独立进程只能有一个取得租约，过期后可接管并由新持有者续期/释放", async () => {
    const root = mkdtempSync(join(tmpdir(), "eastgenesis-ledger-race-"));
    const dbPath = join(root, "eastgenesis.db");
    try {
      createLedgerFile(sqlite!, dbPath);
      const raced = await runRacingClaim(dbPath, root);
      expect(raced.map((result) => result.changes).sort()).toEqual([0, 1]);

      const db = new DatabaseSync(dbPath) as unknown as SyncDb;
      const current = db.prepare(INVOCATION_SQL.get).get({ $1: "eg-process-race" }) as { lease_owner: string; lease_expires_at: number };
      expect(["owner-a", "owner-b"]).toContain(current.lease_owner);
      expect(current.lease_expires_at).toBe(120);
      db.close();

      const takeover = await runSingle(dbPath, root, "claim", "owner-c", 120, 30);
      expect(takeover.changes).toBe(1);
      const renewed = await runSingle(dbPath, root, "renew", "owner-c", 125, 30);
      expect(renewed.changes).toBe(1);
      const wrongOwner = await runSingle(dbPath, root, "renew", "owner-a", 130, 30);
      expect(wrongOwner.changes).toBe(0);
      const released = await runSingle(dbPath, root, "release", "owner-c", 140, 1);
      expect(released.changes).toBe(1);

      const finalDb = new DatabaseSync(dbPath) as unknown as SyncDb;
      expect(finalDb.prepare(INVOCATION_SQL.get).get({ $1: "eg-process-race" })).toMatchObject({ lease_owner: null, lease_expires_at: null });
      finalDb.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);
});

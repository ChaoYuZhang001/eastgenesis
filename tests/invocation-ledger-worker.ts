// 跨进程账本测试 worker：使用独立 Node 进程打开同一 SQLite 文件。
// 这里故意复用生产 SQL，而不是复刻一套内存锁，验证 SQLite 条件 UPDATE 的真实原子性。
import { DatabaseSync } from "node:sqlite";
import { existsSync, writeFileSync } from "node:fs";
import { INVOCATION_SQL } from "@/lib/db-invocation";

type Statement = {
  run(params: Record<string, unknown>): { changes: number | bigint };
};

type SyncDb = {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  close(): void;
};

const [, , dbPath, readyPath, goPath, command, key, owner, nowText, ttlText] = process.argv;

if (!dbPath || !readyPath || !goPath || !command || !key || !owner || !nowText || !ttlText) {
  throw new Error("账本 worker 参数不完整");
}

const now = Number(nowText);
const ttl = Number(ttlText);
if (!Number.isFinite(now) || !Number.isFinite(ttl) || ttl <= 0) throw new Error("账本 worker 时间参数无效");

const db = new DatabaseSync(dbPath) as unknown as SyncDb;
db.exec("PRAGMA busy_timeout = 5000;");
writeFileSync(readyPath, "ready\n", "utf8");

// 由父进程同时放行，尽量让两个独立进程在同一个竞争窗口执行。
while (!existsSync(goPath)) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
}

try {
  let changes = 0;
  if (command === "claim") {
    changes = Number(db.prepare(INVOCATION_SQL.claim).run({ $1: key, $2: owner, $3: now + ttl, $4: now }).changes);
  } else if (command === "renew") {
    changes = Number(db.prepare(INVOCATION_SQL.renew).run({ $1: key, $2: owner, $3: now + ttl }).changes);
  } else if (command === "release") {
    changes = Number(db.prepare(INVOCATION_SQL.release).run({ $1: key, $2: owner }).changes);
  } else {
    throw new Error(`未知账本 worker 操作：${command}`);
  }
  process.stdout.write(`${JSON.stringify({ command, owner, changes })}\n`);
} finally {
  db.close();
}

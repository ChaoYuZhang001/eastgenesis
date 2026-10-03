// 桌面端记忆存储：只验证 SQL 语句和绑定参数（真实 SQLite 在 Mac 上验证；语句另用 Python sqlite3 跑过一遍）
const db = vi.hoisted(() => ({ select: vi.fn(), execute: vi.fn() }));
vi.mock("@tauri-apps/plugin-sql", () => ({ default: { load: async () => db } }));

import { MEMORY_SQL, deleteMemory, listMemories, saveMemory, touchMemories } from "@/lib/db-memory";

const code = (p: Promise<unknown>) => p.then(() => "ok", (e: { code: string }) => e.code);
const row = { id: "mem-1", kind: "fact", text: "我的时区是 UTC+8", source: "manual", created_at: 100, updated_at: 100, use_count: 0, last_used_at: null };

beforeEach(() => {
  db.select.mockReset();
  db.execute.mockReset().mockResolvedValue(undefined);
});

describe("记忆的 SQLite 读写", () => {
  it("新建：先查数量，再插入并读回", async () => {
    db.select.mockResolvedValueOnce([{ n: 3 }]).mockResolvedValueOnce([row]);
    expect(await saveMemory({ kind: "fact", text: " 我的时区是 UTC+8 " }, 100)).toEqual(row);
    expect(db.select.mock.calls[0]).toEqual([MEMORY_SQL.count]);
    const [sql, bind] = db.execute.mock.calls[0];
    expect(sql).toBe(MEMORY_SQL.insert);
    // 第 5 个是 project_id：不属于项目时为 null
    expect(bind).toEqual([expect.stringMatching(/^mem-/), "fact", "我的时区是 UTC+8", "manual", null, 100, 100]);
    expect(db.select.mock.calls[1]).toEqual([MEMORY_SQL.get, [bind[0]]]);
  });

  it("编辑只改类型、内容和更新时间；找不到时报错", async () => {
    db.select.mockResolvedValueOnce([{ ...row, kind: "preference", updated_at: 200 }]);
    await saveMemory({ id: "mem-1", kind: "preference", text: "用 UTC+8 显示时间" }, 200);
    expect(db.execute.mock.calls[0]).toEqual([MEMORY_SQL.update, ["preference", "用 UTC+8 显示时间", 200, "mem-1"]]);
    db.select.mockResolvedValueOnce([]);
    expect(await code(saveMemory({ id: "mem-2", kind: "fact", text: "x" }))).toBe("memory_not_found");
    expect(await code(saveMemory({ id: "../jev", kind: "fact", text: "x" }))).toBe("invalid_memory_id");
  });

  it("满 200 条不再插入；像密钥的内容不进数据库", async () => {
    db.select.mockResolvedValueOnce([{ n: 200 }]);
    expect(await code(saveMemory({ kind: "fact", text: "再来一条" }))).toBe("memory_full");
    expect(await code(saveMemory({ kind: "fact", text: "token=abcdef123456" }))).toBe("invalid_memory");
    expect(db.execute).not.toHaveBeenCalled();
  });

  it("列表、删除、计数；无效 ID 直接跳过；数据库错误统一为 db_query_failed", async () => {
    db.select.mockResolvedValueOnce([row]);
    expect(await listMemories()).toEqual([row]);
    expect(db.select.mock.calls[0]).toEqual([MEMORY_SQL.list]);
    await deleteMemory("mem-1");
    await touchMemories(["mem-1", "bad id"], 300);
    expect(db.execute.mock.calls).toEqual([
      [MEMORY_SQL.remove, ["mem-1"]],
      [MEMORY_SQL.touch, [300, "mem-1"]],
    ]);
    expect(await code(deleteMemory("bad id"))).toBe("invalid_memory_id");
    db.select.mockRejectedValueOnce(new Error("disk I/O error"));
    expect(await code(listMemories())).toBe("db_query_failed");
  });
});

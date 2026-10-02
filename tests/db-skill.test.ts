// 桌面端技能库存储：只验证 SQL 语句和绑定参数（真实 SQLite 在 Mac 上验证；语句另用 Python sqlite3 跑过一遍）
const db = vi.hoisted(() => ({ select: vi.fn(), execute: vi.fn() }));
vi.mock("@tauri-apps/plugin-sql", () => ({ default: { load: async () => db } }));

import { SKILL_SQL, deleteSkill, listSkills, saveSkill, touchSkills } from "@/lib/db-skill";

const code = (p: Promise<unknown>) => p.then(() => "ok", (e: { code: string }) => e.code);
const steps = [
  { goal: "汇总本周进展", tool: "demo_search" },
  { goal: "写成周报", tool: null },
];
const row = { id: "skill-1", name: "整理周报", description: "", steps: JSON.stringify(steps), source: "manual", created_at: 100, updated_at: 100, use_count: 0, last_used_at: null };

beforeEach(() => {
  db.select.mockReset();
  db.execute.mockReset().mockResolvedValue(undefined);
});

describe("技能的 SQLite 读写", () => {
  it("新建：步骤存成 JSON，读回时解析", async () => {
    db.select.mockResolvedValueOnce([{ n: 0 }]).mockResolvedValueOnce([row]);
    expect(await saveSkill({ name: "整理周报", description: "", steps }, 100)).toEqual({ ...row, steps });
    expect(db.select.mock.calls[0]).toEqual([SKILL_SQL.count]);
    const [sql, bind] = db.execute.mock.calls[0];
    expect(sql).toBe(SKILL_SQL.insert);
    expect(bind).toEqual([expect.stringMatching(/^skill-/), "整理周报", "", JSON.stringify(steps), "manual", 100, 100]);
    expect(db.select.mock.calls[1]).toEqual([SKILL_SQL.get, [bind[0]]]);
  });

  it("编辑改名称、说明、步骤和更新时间；满 100 个不再插入；找不到时报错", async () => {
    db.select.mockResolvedValueOnce([row]);
    await saveSkill({ id: "skill-1", name: "整理月报", description: "每月", steps }, 200);
    expect(db.execute.mock.calls[0]).toEqual([SKILL_SQL.update, ["整理月报", "每月", JSON.stringify(steps), 200, "skill-1"]]);
    db.select.mockResolvedValueOnce([{ n: 100 }]);
    expect(await code(saveSkill({ name: "再来一个", description: "", steps }))).toBe("skill_full");
    db.select.mockResolvedValueOnce([]);
    expect(await code(saveSkill({ id: "skill-2", name: "x", description: "", steps }))).toBe("skill_not_found");
    expect(await code(saveSkill({ id: "../x", name: "x", description: "", steps }))).toBe("invalid_skill_id");
  });

  it("steps 列损坏的行不返回；删除和计数跳过无效 ID", async () => {
    db.select.mockResolvedValueOnce([row, { ...row, id: "skill-2", steps: "{broken" }, { ...row, id: "skill-3", steps: "[]" }]);
    expect((await listSkills()).map((s) => s.id)).toEqual(["skill-1"]);
    await deleteSkill("skill-1");
    await touchSkills(["skill-1", "bad id"], 300);
    expect(db.execute.mock.calls).toEqual([
      [SKILL_SQL.remove, ["skill-1"]],
      [SKILL_SQL.touch, [300, "skill-1"]],
    ]);
    expect(await code(deleteSkill("bad id"))).toBe("invalid_skill_id");
  });
});

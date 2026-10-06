// @vitest-environment node
// 会话与调用记录的存储（迁移 5）：同一组用例跑浏览器模式和真实 SQLite（node:sqlite），桌面端另查脱敏后的原始行。
import type { Db } from "@/lib/db";

const raw = vi.hoisted(() => ({ db: null as Db | null }));
vi.mock("@tauri-apps/plugin-sql", () => ({ default: { load: async () => raw.db } }));

import { MAX_FIELD, MAX_STORED_EVENTS, newSessionId, normalizeSession, parseTurns, type StoredTurn } from "@/decision/session";
import { createMockBackend } from "@/platform/mock-backend";
import { createTauriBackend } from "@/platform/tauri-backend";
import type { Backend } from "@/platform/types";
import { asDb, loadSqlite, migratedDb, type RawDb } from "./sqlite-helper";

const sqlite = await loadSqlite();
let rawDb: RawDb;
const SECRET = ["sk", "live", "0123456789abcdefghijkl"].join("-");
const code = (p: Promise<unknown>) => p.then(() => "ok", (e: { code: string }) => e.code);

const turn = (p: Partial<StoredTurn> = {}): StoredTurn => ({
  id: "task-1", seq: 1, goal: "整理周报", status: "completed", summary: "已写好", events: [], lock: null, permission: "confirm",
  files: [], multi: false, startedAt: 1, endedAt: 2, goalId: null, mode: "quick", preference: "balanced", preferenceSource: "global", ...p,
});

function backend(kind: "mock" | "sqlite"): Backend {
  if (kind === "mock") return createMockBackend();
  rawDb = migratedDb(sqlite!);
  raw.db = asDb(() => rawDb);
  return createTauriBackend();
}

for (const kind of ["mock", "sqlite"] as const) {
  describe.skipIf(kind === "sqlite" && !sqlite)(`会话存储（${kind}）`, () => {
    let b: Backend;
    beforeEach(() => {
      b = backend(kind);
    });

    it("整条写入：新建、覆盖；列表按最近更新；删除后查不到，再删报错", async () => {
      const a = newSessionId();
      const c = newSessionId();
      await b.saveSession({ id: a, title: "甲", project_id: null, turns: [turn()], created_at: 1, updated_at: 1 });
      await b.saveSession({ id: c, title: "乙", project_id: null, turns: [], created_at: 2, updated_at: 2 });
      await b.saveSession({ id: a, title: "甲（改）", project_id: null, turns: [turn(), turn({ id: "task-2", seq: 2, goal: "再写一次" })], created_at: 1, updated_at: 3 });
      const list = await b.listSessions();
      expect(list.map((s) => s.title)).toEqual(["甲（改）", "乙"]);
      // 重存一次（updated_at 不变）不会把会话顶到最前
      await b.saveSession({ id: c, title: "乙", project_id: null, turns: [], created_at: 2, updated_at: 2 });
      expect((await b.listSessions()).map((s) => s.title)).toEqual(["甲（改）", "乙"]);
      expect(list[0]!.turns.map((t) => t.goal)).toEqual(["整理周报", "再写一次"]);
      await b.deleteSession(a);
      expect((await b.listSessions()).map((s) => s.id)).toEqual([c]);
      expect(await code(b.deleteSession(a))).toBe("session_not_found");
      expect(await code(b.deleteSession("../x"))).toBe("invalid_session_id");
    });

    it("写入前脱敏：目标、成果、事件里的密钥都替换掉；附件只存文件名", async () => {
      const id = newSessionId();
      const events = [{ type: "tool_result", step: { id: "s1", goal: "g", tool: "read", args: { path: "/a" } }, ok: true, content: `token=${SECRET}`, latencyMs: 1 }];
      const saved = await b.saveSession({ id, title: `问 ${SECRET}`, project_id: null, turns: [turn({ goal: `用 ${SECRET} 调接口`, summary: `Bearer ${SECRET}`, events, files: ["a.txt"] })], created_at: 1, updated_at: 1 });
      expect(JSON.stringify(saved)).not.toContain(SECRET);
      expect(JSON.stringify(await b.listSessions())).not.toContain(SECRET);
      expect(saved.turns[0]!.files).toEqual(["a.txt"]);
      if (kind === "sqlite") {
        const row = rawDb.prepare("SELECT title, turns FROM sessions").get({}) as { title: string; turns: string };
        expect(row.title + row.turns).not.toContain(SECRET);
        expect(row.turns).toContain("[REDACTED]");
      }
    });

    it("项目：挂到不存在的项目下不写；删除项目时连带删除它的会话，二次确认里有会话数", async () => {
      expect(await code(b.saveSession({ id: newSessionId(), title: "x", project_id: "prj-none", turns: [], created_at: 1, updated_at: 1 }))).toBe("project_not_found");
      const p = await b.saveProject({ name: "P" });
      const keep = newSessionId();
      await b.saveSession({ id: newSessionId(), title: "属于项目", project_id: p.id, turns: [], created_at: 1, updated_at: 1 });
      await b.saveSession({ id: keep, title: "不属于", project_id: null, turns: [], created_at: 1, updated_at: 1 });
      expect(await b.projectUsage(p.id)).toEqual({ goals: 0, memories: 0, sessions: 1 });
      expect(await b.deleteProject(p.id)).toEqual({ goals: 0, memories: 0, sessions: 1 });
      expect((await b.listSessions()).map((s) => s.id)).toEqual([keep]);
    });

    it("调用记录：同一个 id 只记一次；按时间过滤；不存金额", async () => {
      const call = (id: string, at: number) => ({ id, session_id: null, task_id: "task-1", goal_id: null, project_id: null, profile_id: "kimi/kimi-k3", input_tokens: 1000, output_tokens: 200, baseline_profile_id: "anthropic/claude-fable-5-1", created_at: at });
      await b.recordUsage([call("u1", 10), call("u2", 20)]);
      await b.recordUsage([call("u1", 10)]);
      expect((await b.listUsage(0)).map((c) => c.id)).toEqual(["u1", "u2"]);
      expect((await b.listUsage(15)).map((c) => c.id)).toEqual(["u2"]);
      expect(Object.keys((await b.listUsage(0))[0]!)).not.toContain("cost");
    });

    it("运行中的回合可以作为脱敏 checkpoint 保存，供下次启动恢复", async () => {
      const id = newSessionId();
      await b.saveSession({
        id,
        title: "恢复",
        project_id: null,
        turns: [turn({ status: "running", summary: null, endedAt: null, events: [{ type: "plan", revision: 1 }] })],
        created_at: 1,
        updated_at: 2,
      });
      const saved = (await b.listSessions()).find((s) => s.id === id);
      expect(saved?.turns[0]).toMatchObject({ status: "running", summary: null, endedAt: null });
      expect(saved?.turns[0]?.events).toEqual([{ type: "plan", revision: 1 }]);
    });
  });
}

describe("会话的规范化", () => {
  it("事件太多时保留开头和结尾；单个字段截断；回合 JSON 坏了跳过，不让会话消失", () => {
    const events = Array.from({ length: MAX_STORED_EVENTS + 50 }, (_, i) => ({ type: "llm", n: i, text: "x".repeat(MAX_FIELD + 10) }));
    const s = normalizeSession({ id: newSessionId(), title: "  多\n行  标题  ", project_id: null, turns: [turn({ events })], created_at: 1, updated_at: 1 });
    expect(s.title).toBe("多 行 标题");
    const kept = s.turns[0]!.events as { n: number; text: string }[];
    expect(kept).toHaveLength(MAX_STORED_EVENTS);
    expect(kept[0]!.n).toBe(0);
    expect(kept.at(-1)!.n).toBe(MAX_STORED_EVENTS + 49);
    expect(kept[0]!.text).toHaveLength(MAX_FIELD);
    expect(parseTurns("{坏")).toEqual([]);
    expect(parseTurns(JSON.stringify([turn(), { goal: "没有 id" }, 3]))).toHaveLength(1);

    const codex = normalizeSession({
      id: newSessionId(),
      title: "Codex 会话",
      project_id: null,
      turns: [turn({ surfaceHint: "codex" })],
      created_at: 1,
      updated_at: 1,
    });
    expect(codex.turns[0]!.surfaceHint).toBe("codex");
    // 老记录没有能力面字段时，规范化结果仍保持可读且显式为空。
    expect(parseTurns(JSON.stringify([turn()]))[0]!.surfaceHint).toBeNull();
  });
});

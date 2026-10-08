// @vitest-environment node
// 项目与目标的存储：同一组用例分别跑浏览器模式（mock）和桌面端（tauri-backend → lib/db-*.ts → node:sqlite 里执行真实迁移）。
// 桌面端在 Mac 上由 tauri-plugin-sql 执行同样的 SQL；这里的 asDb 按它的方式做位置绑定。
import type { Db } from "@/lib/db";

const raw = vi.hoisted(() => ({ db: null as Db | null }));
vi.mock("@tauri-apps/plugin-sql", () => ({ default: { load: async () => raw.db } }));

import { createMockBackend } from "@/platform/mock-backend";
import { createTauriBackend } from "@/platform/tauri-backend";
import { insertLegacyArrayGoal } from "./legacy-goal-fixture";
import type { Backend } from "@/platform/types";
import { GOAL_SQL } from "@/lib/db-goal";
import { MEMORY_SQL } from "@/lib/db-memory";
import { PROJECT_SQL } from "@/lib/db-project";
import { SESSION_SQL } from "@/lib/db-session";
import { goalPhase, type GoalInput } from "@/decision/goal";
import { CLAIM_ONLY_REASON } from "@/decision/evidence";
import { asDb, loadSqlite, migratedDb, placeholdersAscend, type RawDb } from "./sqlite-helper";

const sqlite = await loadSqlite();
let rawDb: RawDb;
const code = (p: Promise<unknown>) => p.then(() => "ok", (e: { code: string }) => e.code);

function backend(kind: "mock" | "sqlite"): Backend {
  if (kind === "mock") return createMockBackend();
  rawDb = migratedDb(sqlite!);
  // database() 只打开一次并缓存：缓存的是这个包装，每次查询取当前测试的库
  raw.db = asDb(() => rawDb);
  return createTauriBackend();
}

for (const kind of ["mock", "sqlite"] as const) {
  describe.skipIf(kind === "sqlite" && !sqlite)(`项目与目标存储（${kind}）`, () => {
    let b: Backend;
    beforeEach(() => {
      b = backend(kind);
    });

    const legacy=async(input:GoalInput)=>{
      const g=kind==="sqlite"?await insertLegacyArrayGoal(raw.db!,input):await b.saveGoal(input);
      expect(g.quota).toBeUndefined();return g;
    };

    it("项目：新建、只改给了的字段、归档和取消归档；无效输入不写入", async () => {
      const p = await b.saveProject({ name: " 季度报告 ", instructions: "结论放最前", context_folders: ["~/work/q3/"], routing_preference: "economy" });
      expect(p).toMatchObject({ name: "季度报告", description: "", instructions: "结论放最前", context_folders: ["~/work/q3"], routing_preference: "economy", archived: false });
      expect(p.id).toMatch(/^prj-/);
      const e = await b.saveProject({ id: p.id, description: "Q3 对外报告" });
      expect(e).toMatchObject({ name: "季度报告", description: "Q3 对外报告", instructions: "结论放最前", routing_preference: "economy" });
      expect((await b.saveProject({ id: p.id, routing_preference: null })).routing_preference).toBeNull();
      expect((await b.archiveProject(p.id)).archived).toBe(true);
      expect((await b.listProjects()).map((x) => [x.id, x.archived])).toEqual([[p.id, true]]);
      expect((await b.unarchiveProject(p.id)).archived).toBe(false);
      expect(await code(b.saveProject({ name: "  " }))).toBe("invalid_project");
      expect(await code(b.saveProject({ id: "prj-none", name: "x" }))).toBe("project_not_found");
      expect(await code(b.archiveProject("../x"))).toBe("invalid_project_id");
      expect(await b.listProjects()).toHaveLength(1);
    });

    it("历史数组目标：显式旧格式 seed 为 idle、上限 50；按项目列出；编辑保持没给的字段；项目不存在或换项目时报错", async () => {
      const p = await b.saveProject({ name: "整理" });
      const g = await legacy({ project_id: p.id, description: "整理下载文件夹" });
      expect(g).toMatchObject({ project_id: p.id, status: "idle", max_llm_calls: 50, used_llm_calls: 0, rounds: [], instructions: "", routing_preference: null });
      const free = await legacy({ description: "不属于项目的目标" });
      expect(free.project_id).toBeNull();
      expect((await b.listGoals(p.id)).map((x) => x.id)).toEqual([g.id]);
      expect((await b.listGoals()).map((x) => x.id).sort()).toEqual([g.id, free.id].sort());
      const e = await b.saveGoal({ id: g.id, max_llm_calls: 80 });
      expect(e).toMatchObject({ description: "整理下载文件夹", max_llm_calls: 80, project_id: p.id });
      expect(await code(b.saveGoal({ project_id: "prj-none", description: "x" }))).toBe("project_not_found");
      expect(await code(b.saveGoal({ id: free.id, project_id: p.id }))).toBe("invalid_goal");
      expect(await code(b.saveGoal({ id: "goal-none", description: "x" }))).toBe("goal_not_found");
      expect(await code(b.listGoals("../x"))).toBe("invalid_project_id");
    });
    it("历史数组目标生命周期：开始 → 一轮 → AI 只有自述（等你确认）→ 你确认完成；每步写回后读出一致；非法转换不改数据", async () => {
      const g = await legacy({ description: "总结这份文档" });
      expect(await code(b.updateGoal(g.id, { op: "transition", to: "completed" }))).toBe("invalid_goal_transition");
      expect((await b.listGoals())[0].status).toBe("idle");
      await b.updateGoal(g.id, { op: "transition", to: "running" });
      let cur = await b.updateGoal(g.id, { op: "start_round", plan: { title: "读文档并总结", items: ["读取", "总结"] } });
      cur = await b.updateGoal(g.id, { op: "update_item", item_id: "r1-1", status: "done" });
      cur = await b.updateGoal(g.id, { op: "append_evidence", evidence: { tool_calls: [{ tool: "read_file", read_only: true, ok: true, target: "/a.pdf" }], file_changes: [], command_outputs: [], claim: "总结好了" } });
      cur = await b.updateGoal(g.id, { op: "record_llm_calls", count: 2 });
      cur = await b.updateGoal(g.id, { op: "finish_round", result: { verdict: "uncertain", reason: CLAIM_ONLY_REASON, by: "rules" } });
      expect(goalPhase(cur)).toBe("awaiting_user");
      expect((await b.listGoals())[0]).toEqual(cur);
      expect(await code(b.updateGoal(g.id, { op: "start_round", plan: {} }))).toBe("invalid_goal_round");
      const done = await b.updateGoal(g.id, { op: "resolve_uncertain", choice: "done" });
      expect(done).toMatchObject({ status: "completed", used_llm_calls: 2 });
      expect(done.rounds[0]).toMatchObject({ status: "done", verdict: { verdict: "done", by: "user" } });
      expect(done.rounds[0].evidence.claim).toBe("总结好了");
      expect((await b.listGoals())[0]).toEqual(done);
      expect(await code(b.saveGoal({ id: g.id, description: "改一下" }))).toBe("goal_locked");
    });

    it("历史数组目标重启恢复：SQLite/mock 都把 running 轮次写回 paused/interrupted，且理由可读回", async () => {
      const g = await legacy({ description: "重启后继续整理文件" });
      await b.updateGoal(g.id, { op: "transition", to: "running" });
      await b.updateGoal(g.id, { op: "start_round", plan: { title: "第一轮", items: ["读取文件"] } });
      const recovered = await b.updateGoal(g.id, { op: "recover_after_restart" });
      expect(recovered).toMatchObject({ status: "paused" });
      expect(recovered.rounds[0]).toMatchObject({
        status: "interrupted",
        interruption_reason: "应用在目标执行期间退出，上一轮已暂停；继续前会重新检查未完成步骤",
      });
      expect((await b.listGoals())[0]).toEqual(recovered);
    });

    it("删除目标是软删除：之后列表里没有，再操作报 goal_not_found", async () => {
      const g = await b.saveGoal({ description: "临时目标" });
      expect((await b.updateGoal(g.id, { op: "transition", to: "deleted" })).status).toBe("deleted");
      expect(await b.listGoals()).toEqual([]);
      expect(await code(b.updateGoal(g.id, { op: "transition", to: "deleted" }))).toBe("goal_not_found");
      expect(await code(b.updateGoal(g.id, { op: "transition", to: "running" }))).toBe("goal_not_found");
    });

    it("删除项目：先给出会连带删除的数量；删除后它的目标和记忆都查不到，其他项目和全局记忆不受影响", async () => {
      const a = await b.saveProject({ name: "A" });
      const other = await b.saveProject({ name: "B" });
      const ga = await legacy({ project_id: a.id, description: "A 的目标" });
      await b.updateGoal(ga.id, { op: "transition", to: "running" });
      await b.updateGoal(ga.id, { op: "start_round", plan: {} });
      await b.saveGoal({ project_id: a.id, description: "A 的第二个目标" });
      const gb = await b.saveGoal({ project_id: other.id, description: "B 的目标" });
      await b.saveMemory({ kind: "fact", text: "A 项目用 UTC+8", project_id: a.id });
      await b.saveMemory({ kind: "preference", text: "全局：用简体中文回答" });
      expect(await b.projectUsage(a.id)).toEqual({ goals: 2, memories: 1, sessions: 0 });
      expect(await b.deleteProject(a.id)).toEqual({ goals: 2, memories: 1, sessions: 0 });
      expect((await b.listProjects()).map((p) => p.id)).toEqual([other.id]);
      expect((await b.listGoals()).map((g) => g.id)).toEqual([gb.id]);
      expect(await b.listGoals(a.id)).toEqual([]);
      expect((await b.listMemories()).map((m) => m.text)).toEqual(["全局：用简体中文回答"]);
      expect(await code(b.deleteProject(a.id))).toBe("project_not_found");
      expect(await code(b.projectUsage(a.id))).toBe("project_not_found");
      expect(await code(b.updateGoal(ga.id, { op: "transition", to: "paused" }))).toBe("goal_not_found");
      // 删掉的项目不能再挂目标和记忆
      expect(await code(b.saveGoal({ project_id: a.id, description: "x" }))).toBe("project_not_found");
      expect(await code(b.saveMemory({ kind: "fact", text: "x", project_id: a.id }))).toBe("project_not_found");
    });

    it("记忆：默认不属于项目；编辑不改所属项目；项目 ID 格式不对时拒绝", async () => {
      const p = await b.saveProject({ name: "P" });
      expect((await b.saveMemory({ kind: "fact", text: "全局事实" })).project_id).toBeNull();
      const m = await b.saveMemory({ kind: "fact", text: "项目事实", project_id: p.id });
      expect(m.project_id).toBe(p.id);
      expect((await b.saveMemory({ id: m.id, kind: "preference", text: "改过的项目事实", project_id: null })).project_id).toBe(p.id);
      expect(await code(b.saveMemory({ kind: "fact", text: "x", project_id: "../x" }))).toBe("invalid_project_id");
    });

    it("历史数组目标的并发更新排队执行，不会互相覆盖", async () => {
      const g = await legacy({ description: "并发" });
      await Promise.all(Array.from({ length: 5 }, () => b.updateGoal(g.id, { op: "record_llm_calls", count: 1 })));
      expect((await b.listGoals())[0].used_llm_calls).toBe(5);
    });
  });
}

describe.skipIf(!sqlite)("桌面端 SQL（node:sqlite）", () => {
  beforeEach(() => {
    backend("sqlite");
  });

  it("每条语句的占位符按出现顺序递增、不重复，个数和绑定参数一致（用例里已逐条执行）", () => {
    for (const [name, sql] of Object.entries({ ...prefixed("project", PROJECT_SQL), ...prefixed("goal", GOAL_SQL), ...prefixed("memory", MEMORY_SQL), ...prefixed("session", SESSION_SQL) })) {
      expect(placeholdersAscend(sql), name).toBe(true);
      const nums = [...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
      expect(nums, name).toEqual(nums.map((_, i) => i + 1));
    }
  });

  it("连带删除用同一个时间戳写 deleted_at；目标状态写成 deleted", async () => {
    const b = createTauriBackend();
    const p = await b.saveProject({ name: "P" });
    const g = await b.saveGoal({ project_id: p.id, description: "G" });
    await b.saveMemory({ kind: "fact", text: "M", project_id: p.id });
    await b.deleteProject(p.id);
    const one = (sql: string) => rawDb.prepare(sql).get({}) as Record<string, unknown>;
    const pr = one(`SELECT deleted_at FROM projects WHERE id = '${p.id}'`);
    const gr = one(`SELECT status, deleted_at FROM goals WHERE id = '${g.id}'`);
    const mr = one(`SELECT deleted_at FROM memories WHERE project_id = '${p.id}'`);
    expect(typeof pr.deleted_at).toBe("number");
    expect(gr).toEqual({ status: "deleted", deleted_at: pr.deleted_at });
    expect(mr.deleted_at).toBe(pr.deleted_at);
  });

  it("新 V1 rounds 列损坏不返回，直接更新明确报 protocol 错误；context_folders 损坏的项目照常返回（文件夹为空）", async () => {
    const b = createTauriBackend();
    const p = await b.saveProject({ name: "P", context_folders: ["/a"] });
    const g = await b.saveGoal({ description: "G" });
    rawDb.exec(`UPDATE goals SET rounds = '{bad' WHERE id = '${g.id}'; UPDATE projects SET context_folders = 'oops' WHERE id = '${p.id}';`);
    expect(await b.listGoals()).toEqual([]);
    expect(await code(b.updateGoal(g.id, { op: "transition", to: "running" }))).toBe("quota_protocol_invalid");
    expect((await b.listProjects())[0]).toMatchObject({ id: p.id, context_folders: [] });
  });
});

function prefixed(prefix: string, o: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [`${prefix}.${k}`, v]));
}

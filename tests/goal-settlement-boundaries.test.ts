// @vitest-environment node
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Db } from "@/lib/db";
const raw = vi.hoisted(() => ({ db: null as Db | null }));
vi.mock("@tauri-apps/plugin-sql", () => ({ default: { load: async () => ({
  select<T>(query: string, bind?: unknown[]) { return raw.db!.select<T>(query, bind); },
  execute(query: string, bind?: unknown[]) { return raw.db!.execute(query, bind); },
}) } }));
import { insertLegacyArrayGoal } from "./legacy-goal-fixture";
import * as dbGoals from "@/lib/db-goal";
import { asDb, loadSqlite, migratedDb } from "./sqlite-helper";
const sqlite = await loadSqlite();

import { AgentRuntime, Coordinator, ToolRegistry, type LlmRequest } from "@/agent";
import { ProviderError } from "@/core/llm/errors";
import { DecisionLayer } from "@/decision/decision-layer";
import { parseRounds, type Goal } from "@/decision/goal";
import { executeWithFallback, type RouteDecision } from "@/decision/router";
import * as engine from "@/lib/engine";
import { goalRunner } from "@/lib/goal-run";
import { createMockBackend, setBackend } from "@/platform";
import { useGoals } from "@/stores/goals";
import { hydrateGoalCheckpoints } from "@/stores/history";
import { useTasks } from "@/stores/tasks";
import { useSettings } from "@/stores/settings";

const GOAL = "读取项目文件，修改本地仓库代码文件，再分析项目并给出结论，最后汇总所有成果";
const MARKER = "SYNTHETIC_GOAL_CHAT_CONCLUSION_928f";
const PARTIAL = "已写入代码并完成分析，最终总结的受控部分输出";
const BODY = "export const goalRecoveryVerified = true;\n";
const digest = (body: string) => createHash("sha256").update(body).digest("hex");

/** Only the model transport/tools are synthetic. The store's lazy handles,
 * AgentRuntime, goal state machine, checkpoint serializer and hydration run
 * normally; the test never seeds a completed StepRecord or checkpoint. */
async function fixture(maxLlmCalls: number, failStoppedCheckpoint = false, holdSummary = false, faults: { failSettlement?: boolean; failCompletedCheckpoint?: boolean; completeInitially?: boolean; sqlite?: boolean; lateSummary?: boolean; sqlRejectSettlement?: boolean; pauseBeforeSummaryCompletion?: boolean; noiseOnResumedSummary?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "eastgenesis-goal-failed-"));
  const sourcePath = join(directory, "source.txt");
  const resultPath = join(directory, "result.ts");
  await writeFile(sourcePath, "受控项目输入");
  const read = vi.fn(async () => ({ ok: true, content: await readFile(sourcePath, "utf8"), data: {} }));
  const write = vi.fn(async () => {
    await writeFile(resultPath, BODY);
    return { ok: true, content: "修改本地仓库代码文件完成", data: {} };
  });
  const tools = new ToolRegistry([
    { name: "mcp__files__read_file", description: "读取项目文件", sideEffect: "none", run: read },
    { name: "mcp__files__write_file", description: "修改本地代码文件", sideEffect: "local_write", run: write },
  ]);
  const requests: LlmRequest[] = [];
  const budgets: number[] = [];
  const checkDone = vi.fn(async () => ({ verdict: "done" as const, by: "rules" as const, reason: "受控文件与结论已核验" }));
  let resumed = false;
  let releaseLateSummary: (() => void) | undefined;
  let stressNoiseEvents = 0;
  vi.spyOn(engine, "createEngine").mockImplementation((options) => {
    if (options.budget?.maxLlmCalls) budgets.push(options.budget.maxLlmCalls);
    const decision = DecisionLayer.fromEnv({ OPENAI_API_KEY: "synthetic" }, { tools: tools.defs(), permission: "full" });
    vi.spyOn(decision, "checkDoneWithEvidence").mockImplementation(checkDone);
    const deps = {
      decision, tools, budget: options.budget, onEvent: (event: import("@/agent").AgentEvent) => {
        options.onEvent?.(event);
        // The load is injected only from the genuine main Runtime.run_start
        // callback, after the real persisted run identity has reached the store.
        // These are synthetic presentation events, not model calls/tool results.
        if (event.type === "run_start" && resumed && faults.noiseOnResumedSummary) for (let i = 0; i < 700; i++) {
          options.onEvent?.({ type: "skill", items: [{ id: `skill-synthetic-${i}`, name: "受控事件窗口压力" }] });
          stressNoiseEvents++;
        }
      },
      beforeSideEffect: options.beforeSideEffect,
      ...(options.backend.getToolInvocation && options.backend.saveToolInvocation ? { ledger: {
        get: (key: string) => options.backend.getToolInvocation!(key),
        put: (record: import("@/agent/tool-contract").InvocationLedgerRecord) => options.backend.saveToolInvocation!(record),
        ...(options.backend.claimToolInvocation ? { claim: (key: string, owner: string, now: number, ttl: number) => options.backend.claimToolInvocation!(key, owner, now, ttl) } : {}),
        ...(options.backend.renewToolInvocation ? { renew: (key: string, owner: string, now: number, ttl: number) => options.backend.renewToolInvocation!(key, owner, now, ttl) } : {}),
        ...(options.backend.releaseToolInvocation ? { release: (key: string, owner: string) => options.backend.releaseToolInvocation!(key, owner) } : {}),
      } } : {}),
      llm: (route: RouteDecision) => async (request: LlmRequest, signal?: AbortSignal) => {
        requests.push(request);
        const { result } = await executeWithFallback(route.chain.slice(0, 1), async () => {
          let text: string;
          if (request.purpose === "plan") text = JSON.stringify({ steps: [
            { goal: "读取项目文件", tool: "mcp__files__read_file", args: { path: sourcePath } },
            { goal: "修改本地仓库代码文件", tool: "mcp__files__write_file", args: { path: resultPath, content: BODY } },
            { goal: "分析项目并给出结论", tool: null },
          ] });
          else if (request.purpose === "answer") text = `分析项目并给出结论：${MARKER}。代码修改完成。`;
          else if (request.purpose === "summary") {
            if (faults.pauseBeforeSummaryCompletion) await new Promise<void>((resolve) => { releaseLateSummary = resolve; });
            if (!resumed && !faults.completeInitially) {
              request.onDelta?.({ text: PARTIAL, profileId: "openai/synthetic" });
              if (faults.lateSummary) await new Promise<void>((resolve) => { releaseLateSummary = resolve; });
              if (holdSummary) await new Promise<void>((_resolve, reject) => {
                const abort = () => reject({ code: "aborted", message: "SYNTHETIC_OWNED_TASK_STOP" });
                if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
              });
              throw new ProviderError("invalid_response", "openai", { partialOutput: true });
            }
            text = "读取项目文件、修改代码文件、分析项目并给出结论全部完成";
          } else throw new Error("unexpected synthetic purpose");
          return { text, profileId: "openai/synthetic", latencyMs: 1, usage: null };
        });
        return result;
      },
    };
    return { runtime: new AgentRuntime(deps), coordinator: new Coordinator(deps), decision, profiles: [] };
  });
  const mockBackend = createMockBackend();
  if (faults.sqlite && !sqlite) throw new Error("node:sqlite is required for the settlement storage regression");
  const rawDb = faults.sqlite ? migratedDb(sqlite!) : null;
  if (rawDb) raw.db = asDb(() => rawDb);
  const backend = rawDb ? { ...mockBackend, listGoals: dbGoals.listGoals, saveGoal: dbGoals.saveGoal, updateGoal: dbGoals.updateGoal } : mockBackend;
  if (faults.sqlRejectSettlement) rawDb!.exec("CREATE TRIGGER reject_settlement BEFORE UPDATE ON goals WHEN NEW.used_llm_calls > OLD.used_llm_calls BEGIN SELECT RAISE(ABORT, 'SYNTHETIC_SQL_SETTLEMENT_REJECT'); END;");
  let rejectStoppedCheckpoint = failStoppedCheckpoint;
  const rejectedCheckpoints = vi.fn();
  let rejectSettlement = faults.failSettlement === true;
  let rejectReceiptCount: number | undefined;
  let rejectCompleted = faults.failCompletedCheckpoint === true;
  const rejectedSettlements = vi.fn();
  const rejectedCompleted = vi.fn();
  setBackend({ ...backend, async updateGoal(id, change) {
    const stored = (await backend.listGoals()).find((goal) => goal.id === id);
    if (rejectSettlement && change.op === "record_llm_calls" && (rejectReceiptCount === undefined || rejectReceiptCount === change.count)) {
      rejectedSettlements(id, change.count);
      throw { code: "db_query_failed", message: "SYNTHETIC_GOAL_SETTLEMENT_WRITE_FAILURE" };
    }
    if (rejectCompleted && change.op === "checkpoint_round" && change.task.status === "completed") {
      rejectedCompleted(id, change.task.id);
      throw { code: "db_query_failed", message: "SYNTHETIC_COMPLETED_CHECKPOINT_WRITE_FAILURE" };
    }
    if (rejectStoppedCheckpoint && change.op === "checkpoint_round" && stored?.status === "paused" && stored.rounds.at(-1)?.status === "interrupted") {
      rejectedCheckpoints(id, change.task.id);
      throw { code: "db_query_failed", message: "SYNTHETIC_STOPPED_CHECKPOINT_STORAGE_FAILURE" };
    }
    return backend.updateGoal(id, change);
  } });
  useSettings.setState({ defaultPermission: "full" });
  useGoals.setState({ items: [], loaded: true, error: null });
  useTasks.setState({ tasks: [], activeId: null });
  // These cases are persisted legacy main-call accounting, not fresh native V1 inclusive enrollment.
  const created = faults.sqlite
    ? await insertLegacyArrayGoal(raw.db!,{description:GOAL,max_llm_calls:maxLlmCalls})
    : await useGoals.getState().save({ description: GOAL, max_llm_calls: maxLlmCalls });
  if(faults.sqlite){expect(typeof created).toBe("object");expect((created as Goal).quota).toBeUndefined();await useGoals.getState().load();}
  if (typeof created === "string") throw new Error(created);
  await useGoals.getState().start(created.id);
  const starts = vi.spyOn(useTasks.getState(), "runGoalRound");
  const resumes = vi.spyOn(useTasks.getState(), "resumeGoalRound");
  const apply = vi.spyOn(useGoals.getState(), "apply");
  const checkpoints = { mock: { get calls() { return apply.mock.calls.filter(([, change]) => change.op === "checkpoint_round"); } } };
  const runner = goalRunner;
  return {
    id: created.id, directory, resultPath, runner, requests, budgets, read, write, starts, resumes, checkpoints, checkDone, apply, backend, rejectedCheckpoints, rejectedSettlements, rejectedCompleted,
    rawDb,
    stressNoiseEvents: () => stressNoiseEvents,
    releaseLateSummary: () => releaseLateSummary?.(),
    goal: () => useGoals.getState().items.find((goal) => goal.id === created.id)!,
    allowSummary: () => { resumed = true; },
    allowCheckpoint: () => { rejectStoppedCheckpoint = false; },
    allowSettlement: () => { rejectSettlement = false; },
    rejectNextSettlement: (count?: number) => { rejectSettlement = true; rejectReceiptCount = count; },
    allowCompletedCheckpoint: () => { rejectCompleted = false; },
  };
}

const originalPermission = useSettings.getState().defaultPermission;
afterEach(() => { vi.restoreAllMocks(); setBackend(null); useSettings.setState({ defaultPermission: originalPermission }); });


const outputIdentity = async (f: Awaited<ReturnType<typeof fixture>>) => {
  const info = await stat(f.resultPath, { bigint: true });
  return [info.ino, info.mtimeNs, digest(await readFile(f.resultPath, "utf8"))];
};
const reload = async () => {
  useTasks.setState({ tasks: [], activeId: null });
  await useGoals.getState().load();
  hydrateGoalCheckpoints();
};
const dispose = async (f: Awaited<ReturnType<typeof fixture>>) => {
  await rm(f.directory, { recursive: true, force: true });
  (f.rawDb as (typeof f.rawDb & { close?(): void }))?.close?.();
};
const storedRow = (f: Awaited<ReturnType<typeof fixture>>) => f.rawDb!.prepare("SELECT used_llm_calls, rounds FROM goals WHERE id = $id").get({ $id: f.id }) as { used_llm_calls: number; rounds: string };
const rewriteStoredRounds = (f: Awaited<ReturnType<typeof fixture>>, edit: (g: Goal["rounds"]) => void) => {
  const rounds = JSON.parse(storedRow(f).rounds) as Goal["rounds"];
  edit(rounds);
  f.rawDb!.prepare("UPDATE goals SET rounds = $rounds WHERE id = $id").run({ $rounds: JSON.stringify(rounds), $id: f.id });
};

describe("Legacy 数组 Goal 按主运行结算的真实边界（新 V1 由 inclusive host 单独覆盖）", () => {
  it("真实 SQLite 的结算 UPDATE 拒绝时 used 与 receipt 一起保留旧值；补结算后3+1且重复/并发receipt不加费", async () => {
    const f = await fixture(5, false, false, { sqlite: true, sqlRejectSettlement: true });
    try {
      await f.runner.run(f.id);
      expect(f.goal()).toMatchObject({ status: "paused", used_llm_calls: 0 });
      let row = storedRow(f);
      expect(row.used_llm_calls).toBe(0);
      expect(JSON.parse(row.rounds)[0].llm_settlements).toEqual([]);
      expect(JSON.parse(row.rounds)[0].task_checkpoint.recovery_accounting).toMatchObject({ final: true, llm_calls: 3 });
      const before = await outputIdentity(f);
      f.rawDb!.exec("DROP TRIGGER reject_settlement");
      f.allowSummary(); await reload(); await useGoals.getState().start(f.id);
      await Promise.all([f.runner.run(f.id), f.runner.run(f.id), f.runner.run(f.id)]);
      expect(f.goal()).toMatchObject({ status: "completed", used_llm_calls: 4 });
      const round = f.goal().rounds[0];
      expect(round.llm_settlements?.map((r) => r.llm_calls)).toEqual([3, 1]);
      const receipts = round.llm_settlements!;
      expect(receipts[0].run_id).not.toBe(receipts[1].run_id);
      await Promise.all(receipts.flatMap((r) => [0, 1].map(() => useGoals.getState().apply(f.id, { op: "record_llm_calls", task_id: round.task_id!, run_id: r.run_id, count: r.llm_calls }))));
      row = storedRow(f);
      expect(row.used_llm_calls).toBe(4); expect(JSON.parse(row.rounds)[0].llm_settlements).toEqual(receipts);
      expect(f.requests.map((r) => r.purpose)).toEqual(["plan", "answer", "summary", "summary"]);
      expect(f.budgets).toEqual([5, 2]); expect(f.resumes).toHaveBeenCalledOnce();
      expect(f.read).toHaveBeenCalledOnce(); expect(f.write).toHaveBeenCalledOnce();
      expect(await outputIdentity(f)).toEqual(before);
    } finally { await dispose(f); }
  });

  it("持续拒绝真实Goal结算不能解锁下一次summary；多次明确继续保持原task和已接受Chat", async () => {
    const f = await fixture(5, false, false, { failSettlement: true });
    try {
      await f.runner.run(f.id);
      const taskId = f.goal().rounds[0].task_id!;
      const before = await outputIdentity(f);
      f.allowSummary();
      for (let attempt = 0; attempt < 3; attempt++) {
        await reload(); expect(await useGoals.getState().start(f.id)).toBeNull();
        await Promise.all([f.runner.run(f.id), f.runner.run(f.id)]);
        expect(f.goal()).toMatchObject({ status: "paused", used_llm_calls: 0 });
        expect(f.goal().rounds[0]).toMatchObject({ task_id: taskId, llm_settlements: [] });
        expect(useTasks.getState().tasks[0].events.some((e) => e.type === "reflect" && e.accepted && e.output?.includes(MARKER))).toBe(true);
      }
      expect(f.rejectedSettlements).toHaveBeenCalledTimes(4);
      expect(f.requests.map((r) => r.purpose)).toEqual(["plan", "answer", "summary"]);
      expect(f.resumes).not.toHaveBeenCalled(); expect(f.starts).toHaveBeenCalledOnce();
      expect(f.read).toHaveBeenCalledOnce(); expect(f.write).toHaveBeenCalledOnce();
      expect(await outputIdentity(f)).toEqual(before);
    } finally { await dispose(f); }
  });

  it("completed补结算恰好max3时，真实规则不确定则等用户验收；没有Jev引擎或第4模型请求", async () => {
    const f = await fixture(3, false, false, { completeInitially: true, failSettlement: true });
    try {
      await f.runner.run(f.id); const before = await outputIdentity(f);
      f.allowSettlement(); await reload(); await useGoals.getState().start(f.id);
      const enginesBefore = vi.mocked(engine.createEngine).mock.calls.length;
      await f.runner.run(f.id);
      expect(f.goal()).toMatchObject({ status: "running", used_llm_calls: 3 });
      expect(f.goal().rounds[0]).toMatchObject({ status: "uncertain", verdict: { by: "rules" }, task_checkpoint: { status: "completed" } });
      expect(vi.mocked(engine.createEngine).mock.calls.length).toBe(enginesBefore);
      expect(f.checkDone).not.toHaveBeenCalled(); expect(f.resumes).not.toHaveBeenCalled();
      expect(f.requests.map((r) => r.purpose)).toEqual(["plan", "answer", "summary"]);
      expect(await useGoals.getState().resolve(f.id, "done")).toBeNull();
      expect(f.goal()).toMatchObject({ status: "completed", used_llm_calls: 3 });
      expect(f.goal().rounds[0].verdict?.by).toBe("user");
      expect(f.read).toHaveBeenCalledOnce(); expect(f.write).toHaveBeenCalledOnce(); expect(await outputIdentity(f)).toEqual(before);
    } finally { await dispose(f); }
  });

  it("completed/max3若已有规则能核对命名文件，则直接收尾仍不创建Jev或新Runtime", async () => {
    const f = await fixture(3, false, false, { completeInitially: true, failSettlement: true });
    try {
      expect(typeof await useGoals.getState().save({ id: f.id, description: "生成 result.ts" })).toBe("object");
      await f.runner.run(f.id); const before = await outputIdentity(f);
      f.allowSettlement(); await reload(); await useGoals.getState().start(f.id);
      const enginesBefore = vi.mocked(engine.createEngine).mock.calls.length;
      await f.runner.run(f.id);
      expect(f.goal()).toMatchObject({ status: "completed", used_llm_calls: 3 });
      expect(f.goal().rounds[0].verdict).toMatchObject({ by: "rules", verdict: "done" });
      expect(vi.mocked(engine.createEngine).mock.calls.length).toBe(enginesBefore); expect(f.checkDone).not.toHaveBeenCalled();
      expect(f.requests).toHaveLength(3); expect(f.starts).toHaveBeenCalledOnce(); expect(f.resumes).not.toHaveBeenCalled();
      expect(f.read).toHaveBeenCalledOnce(); expect(f.write).toHaveBeenCalledOnce(); expect(await outputIdentity(f)).toEqual(before);
    } finally { await dispose(f); }
  });

  it("真实SQLite历史去掉新字段仍可读和hydrate，但调用次数unknown不能伪造旧receipt或自动summary", async () => {
    const f = await fixture(5, false, false, { sqlite: true });
    try {
      await f.runner.run(f.id); const before = await outputIdentity(f);
      rewriteStoredRounds(f, (rounds) => { delete rounds[0].llm_settlements; delete rounds[0].task_checkpoint!.recovery_accounting; });
      await reload(); const taskId = f.goal().rounds[0].task_id!;
      expect(useTasks.getState().tasks[0]).toMatchObject({ id: taskId, status: "failed", recovery_accounting: null });
      f.allowSummary(); await useGoals.getState().start(f.id); await f.runner.run(f.id);
      expect(f.goal()).toMatchObject({ status: "paused", used_llm_calls: 3 });
      expect(useGoals.getState().error).toContain("最终调用次数未知");
      expect(f.goal().rounds[0].llm_settlements).toBeUndefined();
      expect(JSON.parse(storedRow(f).rounds)[0].llm_settlements).toBeUndefined();
      expect(f.requests).toHaveLength(3); expect(f.resumes).not.toHaveBeenCalled();
      expect(f.read).toHaveBeenCalledOnce(); expect(f.write).toHaveBeenCalledOnce(); expect(await outputIdentity(f)).toEqual(before);
    } finally { await dispose(f); }
  });

  it("legacy completed只做已有规则/用户验收，不补造未知计数或申请新模型", async () => {
    const f = await fixture(5, false, false, { sqlite: true, completeInitially: true, failSettlement: true });
    try {
      await f.runner.run(f.id); const before = await outputIdentity(f);
      rewriteStoredRounds(f, (rounds) => { delete rounds[0].llm_settlements; delete rounds[0].task_checkpoint!.recovery_accounting; });
      f.allowSettlement(); await reload(); await useGoals.getState().start(f.id);
      await f.runner.run(f.id);
      expect(f.goal()).toMatchObject({ status: "running", used_llm_calls: 0 });
      expect(f.goal().rounds[0]).toMatchObject({ status: "uncertain", verdict: { by: "rules" } });
      expect(f.goal().rounds[0].llm_settlements).toBeUndefined(); expect(f.checkDone).not.toHaveBeenCalled();
      expect(f.requests).toHaveLength(3); expect(f.resumes).not.toHaveBeenCalled();
      expect(await useGoals.getState().resolve(f.id, "done")).toBeNull(); expect(f.goal().status).toBe("completed");
      expect(f.goal().used_llm_calls).toBe(0); expect(await outputIdentity(f)).toEqual(before);
    } finally { await dispose(f); }
  });

  it("只持久running计数2、后来已有第3请求时，重启不能把下界当完整费用释放余额", async () => {
    const f = await fixture(5, false, false, { sqlite: true, completeInitially: true, failCompletedCheckpoint: true, pauseBeforeSummaryCompletion: true });
    const running = f.runner.run(f.id);
    try {
      await vi.waitFor(() => expect(f.requests).toHaveLength(3));
      await vi.waitFor(() => expect(JSON.parse(storedRow(f).rounds)[0].task_checkpoint.recovery_accounting).toMatchObject({ final: false, llm_calls: 2 }));
      f.releaseLateSummary(); await running; const before = await outputIdentity(f);
      const row = storedRow(f);
      const checkpoint = (JSON.parse(row.rounds) as Goal["rounds"])[0].task_checkpoint!;
      expect(checkpoint).toMatchObject({ status: "running", recovery_accounting: { final: false, llm_calls: 2 } });
      expect(f.requests).toHaveLength(3); expect(row.used_llm_calls).toBe(0);
      // No test changes this persisted lower bound. The completed in-memory
      // record is genuinely lost by clearing cards and loading real SQLite.
      f.allowCompletedCheckpoint(); await reload(); await useGoals.getState().start(f.id); await f.runner.run(f.id);
      expect(f.goal()).toMatchObject({ status: "paused", used_llm_calls: 0 });
      expect(f.goal().rounds[0].llm_settlements).toEqual([]);
      expect(useGoals.getState().error).toContain("最终调用次数未知");
      expect(f.requests).toHaveLength(3); expect(f.resumes).not.toHaveBeenCalled();
      expect(f.read).toHaveBeenCalledOnce(); expect(f.write).toHaveBeenCalledOnce(); expect(await outputIdentity(f)).toEqual(before);
    } finally { f.releaseLateSummary(); await running; await dispose(f); }
  });

  it("pause后的真实模型晚失败先终态保存和结算；旧运行未结算前并发继续均不能启动新Runtime", async () => {
    const f = await fixture(5, false, false, { lateSummary: true });
    const running = f.runner.run(f.id);
    try {
      await vi.waitFor(() => expect(f.requests).toHaveLength(3));
      const taskId = f.goal().rounds[0].task_id!; const before = await outputIdentity(f);
      // Reproduce the actual pause ordering while holding the model's late
      // result, without waiting for the 2s UI stopper polling window.
      expect(typeof await useGoals.getState().apply(f.id, { op: "transition", to: "paused" })).toBe("object");
      expect(f.runner.stop(f.id)).toBe(true);
      await useGoals.getState().start(f.id);
      await Promise.all([f.runner.run(f.id), f.runner.run(f.id)]);
      expect(f.requests).toHaveLength(3); expect(f.resumes).not.toHaveBeenCalled();
      f.releaseLateSummary(); await running;
      expect(f.goal().used_llm_calls).toBe(3);
      expect(f.goal().rounds[0].llm_settlements).toHaveLength(1);
      expect(f.goal().rounds[0].task_checkpoint?.recovery_accounting).toMatchObject({ final: true, llm_calls: 3 });
      f.allowSummary(); await Promise.all([f.runner.run(f.id), f.runner.run(f.id)]);
      expect(f.goal()).toMatchObject({ status: "completed", used_llm_calls: 4 });
      expect(f.goal().rounds[0].task_id).toBe(taskId); expect(f.goal().rounds).toHaveLength(1); expect(f.resumes).toHaveBeenCalledOnce();
      expect(f.requests.map((r) => r.purpose)).toEqual(["plan", "answer", "summary", "summary"]);
      expect(f.read).toHaveBeenCalledOnce(); expect(f.write).toHaveBeenCalledOnce(); expect(await outputIdentity(f)).toEqual(before);
    } finally { f.releaseLateSummary(); await running; await dispose(f); }
  });

  it("直接cancel的晚结果仍记录实际3次，终态后并发恢复只增加一次summary且保持同任务", async () => {
    const f = await fixture(5, false, false, { lateSummary: true });
    const running = f.runner.run(f.id);
    try {
      await vi.waitFor(() => expect(f.requests).toHaveLength(3));
      const taskId = f.goal().rounds[0].task_id!; const before = await outputIdentity(f);
      useTasks.getState().cancel(taskId);
      await Promise.all([f.runner.run(f.id), f.runner.run(f.id)]);
      expect(f.requests).toHaveLength(3); expect(f.resumes).not.toHaveBeenCalled();
      f.releaseLateSummary(); await running;
      expect(f.goal()).toMatchObject({ status: "paused", used_llm_calls: 3 });
      expect(f.goal().rounds[0].task_checkpoint?.recovery_accounting).toMatchObject({ final: true, llm_calls: 3 });
      expect(f.goal().rounds[0].llm_settlements).toHaveLength(1);
      f.allowSummary(); await useGoals.getState().start(f.id);
      await Promise.all([f.runner.run(f.id), f.runner.run(f.id)]);
      expect(f.goal()).toMatchObject({ status: "completed", used_llm_calls: 4 });
      expect(f.goal().rounds[0].task_id).toBe(taskId); expect(f.resumes).toHaveBeenCalledOnce(); expect(f.starts).toHaveBeenCalledOnce();
      expect(f.read).toHaveBeenCalledOnce(); expect(f.write).toHaveBeenCalledOnce(); expect(await outputIdentity(f)).toEqual(before);
      expect(f.requests.map((r) => r.purpose)).toEqual(["plan", "answer", "summary", "summary"]);
    } finally { f.releaseLateSummary(); await running; await dispose(f); }
  });

  it("当前真实run的700条额外事件仍保持500/300上限和最近run_start，结算按run元数据而不sum残余历史", async () => {
    const f = await fixture(5, false, false, { noiseOnResumedSummary: true });
    try {
      await f.runner.run(f.id); const before = await outputIdentity(f);
      const firstRun = f.goal().rounds[0].llm_settlements![0].run_id;
      f.allowSummary(); f.rejectNextSettlement(1);
      await useGoals.getState().start(f.id); await f.runner.run(f.id);
      expect(f.goal()).toMatchObject({ status: "paused", used_llm_calls: 3 });
      const taskId = f.goal().rounds[0].task_id!;
      const card = useTasks.getState().tasks.find((t) => t.id === taskId)!;
      const checkpoint = f.goal().rounds[0].task_checkpoint!;
      expect(f.stressNoiseEvents()).toBe(700);
      expect(card.events).toHaveLength(500); expect(checkpoint.events).toHaveLength(300);
      expect(card.recovery_accounting).toMatchObject({ final: true, llm_calls: 1 });
      const runId = card.recovery_accounting!.run_id; expect(runId).not.toBe(firstRun);
      expect(card.events.some((e) => e.type === "run_start" && e.runId === runId)).toBe(true);
      expect(checkpoint.events.some((e) => !!e && typeof e === "object" && (e as { type: string; runId?: string }).type === "run_start" && (e as { runId?: string }).runId === runId)).toBe(true);
      // The bounded event list no longer contains all four logical calls.
      expect(card.events.filter((e) => e.type === "llm" || e.type === "llm_failed").length).toBeLessThan(4);
      f.allowSettlement(); await reload(); await useGoals.getState().start(f.id); await f.runner.run(f.id);
      expect(f.goal()).toMatchObject({ status: "completed", used_llm_calls: 4 });
      expect(f.goal().rounds[0].llm_settlements?.map((r) => r.llm_calls)).toEqual([3, 1]);
      expect(f.requests).toHaveLength(4); expect(f.resumes).toHaveBeenCalledOnce(); expect(f.starts).toHaveBeenCalledOnce();
      expect(f.read).toHaveBeenCalledOnce(); expect(f.write).toHaveBeenCalledOnce(); expect(await outputIdentity(f)).toEqual(before);
    } finally { await dispose(f); }
  });

  it("receipt拒绝保留名、foreign task/run、负数/小数/不一致总数；真实Goal保存前后完全相同", async () => {
    const f = await fixture(5, false, false, { sqlite: true });
    try {
      await f.runner.run(f.id); const round = f.goal().rounds[0]; const receipt = round.llm_settlements![0];
      const before = storedRow(f);
      const invalid = [
        { task_id: "task-foreign", run_id: receipt.run_id, count: 3 },
        { task_id: round.task_id!, run_id: "run-foreign", count: 3 },
        ...["__proto__", "constructor", "prototype"].map((run_id) => ({ task_id: round.task_id!, run_id, count: 3 })),
        ...[-1, 1.5, 501, 4].map((count) => ({ task_id: round.task_id!, run_id: receipt.run_id, count })),
        { task_id: round.task_id!, count: 3 },
      ];
      for (const identity of invalid) {
        expect(typeof await useGoals.getState().apply(f.id, { op: "record_llm_calls", ...identity })).toBe("string");
        expect(storedRow(f)).toEqual(before);
      }
      for (const receipt of [{ run_id: "__proto__", llm_calls: 1 }, { run_id: "run-foreign", llm_calls: -1 }, { run_id: "run-ok", llm_calls: 1.1 }]) {
        const corrupted = JSON.parse(before.rounds); corrupted[0].llm_settlements = [receipt]; expect(parseRounds(JSON.stringify(corrupted))).toBeNull();
      }
      const duplicated = JSON.parse(before.rounds); duplicated[0].llm_settlements.push(duplicated[0].llm_settlements[0]); expect(parseRounds(JSON.stringify(duplicated))).toBeNull();
      expect(Object.prototype).not.toHaveProperty("llm_calls");
      expect(f.requests).toHaveLength(3); expect(f.read).toHaveBeenCalledOnce(); expect(f.write).toHaveBeenCalledOnce();
    } finally { await dispose(f); }
  });
});

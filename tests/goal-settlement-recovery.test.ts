// @vitest-environment node
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRuntime, Coordinator, ToolRegistry, type LlmRequest } from "@/agent";
import { ProviderError } from "@/core/llm/errors";
import { DecisionLayer } from "@/decision/decision-layer";
import { parseRounds, type Goal } from "@/decision/goal";
import { executeWithFallback, type RouteDecision } from "@/decision/router";
import * as engine from "@/lib/engine";
import { goalRunner } from "@/lib/goal-run";
import { recoveryCheckpoint } from "@/lib/recovery";
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
async function fixture(maxLlmCalls: number, failStoppedCheckpoint = false, holdSummary = false, faults: { failSettlement?: boolean; failCompletedCheckpoint?: boolean; completeInitially?: boolean } = {}) {
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
  vi.spyOn(engine, "createEngine").mockImplementation((options) => {
    if (options.budget?.maxLlmCalls) budgets.push(options.budget.maxLlmCalls);
    const decision = DecisionLayer.fromEnv({ OPENAI_API_KEY: "synthetic" }, { tools: tools.defs(), permission: "full" });
    vi.spyOn(decision, "checkDoneWithEvidence").mockImplementation(checkDone);
    const deps = {
      decision, tools, budget: options.budget, onEvent: options.onEvent,
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
            if (!resumed && !faults.completeInitially) {
              request.onDelta?.({ text: PARTIAL, profileId: "openai/synthetic" });
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
  const backend = createMockBackend();
  let rejectStoppedCheckpoint = failStoppedCheckpoint;
  const rejectedCheckpoints = vi.fn();
  let rejectSettlement = faults.failSettlement === true;
  let rejectCompleted = faults.failCompletedCheckpoint === true;
  const rejectedSettlements = vi.fn();
  const rejectedCompleted = vi.fn();
  setBackend({ ...backend, async updateGoal(id, change) {
    const stored = (await backend.listGoals()).find((goal) => goal.id === id);
    if (rejectSettlement && change.op === "record_llm_calls") {
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
  const created = await useGoals.getState().save({ description: GOAL, max_llm_calls: maxLlmCalls });
  if (typeof created === "string") throw new Error(created);
  await useGoals.getState().start(created.id);
  const starts = vi.spyOn(useTasks.getState(), "runGoalRound");
  const resumes = vi.spyOn(useTasks.getState(), "resumeGoalRound");
  const apply = vi.spyOn(useGoals.getState(), "apply");
  const checkpoints = { mock: { get calls() { return apply.mock.calls.filter(([, change]) => change.op === "checkpoint_round"); } } };
  const runner = goalRunner;
  return {
    id: created.id, directory, resultPath, runner, requests, budgets, read, write, starts, resumes, checkpoints, checkDone, apply, backend, rejectedCheckpoints, rejectedSettlements, rejectedCompleted,
    goal: () => useGoals.getState().items.find((goal) => goal.id === created.id)!,
    allowSummary: () => { resumed = true; },
    allowCheckpoint: () => { rejectStoppedCheckpoint = false; },
    allowSettlement: () => { rejectSettlement = false; },
    allowCompletedCheckpoint: () => { rejectCompleted = false; },
  };
}

const originalPermission = useSettings.getState().defaultPermission;
afterEach(() => { vi.restoreAllMocks(); setBackend(null); useSettings.setState({ defaultPermission: originalPermission }); });

describe("Goal 执行失败保留原轮的真实任务恢复", () => {
  it("文件与 Chat 已完成、总结部分输出失败时暂停；重启继续仅总结，不重放或重复记费", async () => {
    const f = await fixture(5);
    try {
      await f.runner.run(f.id);
      expect.soft(f.starts).toHaveBeenCalledOnce();
      expect.soft(f.read).toHaveBeenCalledOnce();
      expect.soft(f.write).toHaveBeenCalledOnce();
      expect.soft(f.requests.map((request) => request.purpose)).toEqual(["plan", "answer", "summary"]);
      expect(f.goal().status).toBe("paused");
      expect(f.goal().rounds).toHaveLength(1);
      expect(f.goal().rounds[0].status).toBe("interrupted");
      expect(f.starts).toHaveBeenCalledOnce();
      expect(f.checkDone).not.toHaveBeenCalled();
      expect(f.checkpoints.mock.calls.length).toBeGreaterThan(0);
      expect(f.goal().used_llm_calls).toBe(3);
      expect(f.requests.map((request) => request.purpose)).toEqual(["plan", "answer", "summary"]);
      const originalTask = f.goal().rounds[0].task_id!;
      const card = useTasks.getState().tasks.find((task) => task.id === originalTask)!;
      expect(card).toMatchObject({ status: "failed", streamingText: PARTIAL, streamingInterrupted: true });
      expect(recoveryCheckpoint(card.events)?.nextStepIndex).toBe(3);
      const before = await stat(f.resultPath, { bigint: true });
      const fingerprint = digest(await readFile(f.resultPath, "utf8"));

      // JSON round parsing and the production bootstrap hydrator recreate the
      // task. No test-written step state/output is supplied to resume.
      const saved = JSON.parse(JSON.stringify(f.goal())) as Goal;
      saved.rounds = parseRounds(JSON.stringify(saved.rounds))!;
      useTasks.setState({ tasks: [], activeId: null });
      useGoals.setState({ items: [saved] });
      hydrateGoalCheckpoints();
      expect(useTasks.getState().tasks[0]).toMatchObject({ id: originalTask, status: "failed", streamingText: PARTIAL, streamingInterrupted: true });
      f.allowSummary();
      expect(await useGoals.getState().start(f.id)).toBeNull();
      await f.runner.run(f.id);
      expect(f.goal().status).toBe("completed");
      expect(f.goal().rounds).toHaveLength(1);
      expect(f.goal().rounds[0]).toMatchObject({ task_id: originalTask, status: "done", task_checkpoint: { id: originalTask, status: "completed" } });
      expect(f.starts).toHaveBeenCalledOnce();
      expect(f.resumes).toHaveBeenCalledOnce();
      expect(f.requests.map((request) => request.purpose)).toEqual(["plan", "answer", "summary", "summary"]);
      expect(f.requests.at(-1)!.messages.map((message) => message.content).join("\n")).toContain(MARKER);
      expect(f.budgets).toEqual([5, 2]);
      expect(f.goal().used_llm_calls).toBe(4);
      expect(f.read).toHaveBeenCalledOnce();
      expect(f.write).toHaveBeenCalledOnce();
      const after = await stat(f.resultPath, { bigint: true });
      expect([after.ino, after.mtimeNs, digest(await readFile(f.resultPath, "utf8"))]).toEqual([before.ino, before.mtimeNs, fingerprint]);
      expect(useTasks.getState().tasks).toHaveLength(1);
    } finally { await rm(f.directory, { recursive: true, force: true }); }
  });

  it("失败已用尽目标预算时，继续入口不再调用模型或新建任务", async () => {
    const f = await fixture(3);
    try {
      await f.runner.run(f.id);
      expect(f.goal()).toMatchObject({ status: "paused", used_llm_calls: 3 });
      expect(f.goal().rounds[0].status).toBe("interrupted");
      f.allowSummary();
      await useGoals.getState().start(f.id);
      await f.runner.run(f.id);
      expect(f.goal()).toMatchObject({ status: "failed", used_llm_calls: 3 });
      expect(f.goal().rounds).toHaveLength(1);
      expect(f.starts).toHaveBeenCalledOnce();
      expect(f.resumes).not.toHaveBeenCalled();
      expect(f.requests.map((request) => request.purpose)).toEqual(["plan", "answer", "summary"]);
      expect(f.read).toHaveBeenCalledOnce();
      expect(f.write).toHaveBeenCalledOnce();
      expect(f.checkDone).not.toHaveBeenCalled();
    } finally { await rm(f.directory, { recursive: true, force: true }); }
  });
  it("真实 backend 写失败经 store 返回字符串时，停止并显示存储错误；显式恢复仍沿用同轮且不重放已写文件", async () => {
    const f = await fixture(5, true);
    try {
      await f.runner.run(f.id);
      const originalTask = f.goal().rounds[0].task_id!;
      expect(f.rejectedCheckpoints).toHaveBeenCalledWith(f.id, originalTask);
      const applied = await Promise.all(f.apply.mock.results.map((result) => result.value));
      expect(applied).toContain("SYNTHETIC_STOPPED_CHECKPOINT_STORAGE_FAILURE");
      expect(useGoals.getState().error).toBe("无法保存任务恢复记录，请检查本地存储后继续");
      expect(f.goal()).toMatchObject({ status: "paused", used_llm_calls: 3 });
      expect(f.goal().rounds).toHaveLength(1);
      expect(f.goal().rounds[0]).toMatchObject({ status: "interrupted", task_id: originalTask });
      expect(f.runner.running(f.id)).toBe(false);
      expect(f.checkDone).not.toHaveBeenCalled();
      const before = await stat(f.resultPath, { bigint: true });
      const fingerprint = digest(await readFile(f.resultPath, "utf8"));
      // A paused Goal cannot progress merely by running the loop again.
      await f.runner.run(f.id);
      expect(f.starts).toHaveBeenCalledOnce();
      expect(f.resumes).not.toHaveBeenCalled();
      expect(f.requests.map((request) => request.purpose)).toEqual(["plan", "answer", "summary"]);
      expect(f.read).toHaveBeenCalledOnce(); expect(f.write).toHaveBeenCalledOnce();
      // The task store already persisted its terminal snapshot before pause.
      // Reload that actual backend record, rather than fabricating checkpoint steps.
      f.allowCheckpoint();
      useTasks.setState({ tasks: [], activeId: null });
      await useGoals.getState().load();
      hydrateGoalCheckpoints();
      expect(useTasks.getState().tasks).toHaveLength(1);
      expect(useTasks.getState().tasks[0]).toMatchObject({ id: originalTask, status: "failed" });
      f.allowSummary();
      expect(await useGoals.getState().start(f.id)).toBeNull();
      await f.runner.run(f.id);
      expect(f.goal()).toMatchObject({ status: "completed", used_llm_calls: 4 });
      expect(f.goal().rounds).toHaveLength(1);
      expect(f.goal().rounds[0]).toMatchObject({ task_id: originalTask, status: "done" });
      expect(f.starts).toHaveBeenCalledOnce(); expect(f.resumes).toHaveBeenCalledOnce();
      expect(f.requests.map((request) => request.purpose)).toEqual(["plan", "answer", "summary", "summary"]);
      expect(f.read).toHaveBeenCalledOnce(); expect(f.write).toHaveBeenCalledOnce();
      const after = await stat(f.resultPath, { bigint: true });
      expect([after.ino, after.mtimeNs, digest(await readFile(f.resultPath, "utf8"))]).toEqual([before.ino, before.mtimeNs, fingerprint]);
      expect((await f.backend.listGoals()).find((goal) => goal.id === f.id)?.rounds).toHaveLength(1);
    } finally { await rm(f.directory, { recursive: true, force: true }); }
  });

  it("真实 pause stopper 的后端 checkpoint 错误字符串必须可见，原任务停止且不会恢复或重放", async () => {
    const f = await fixture(5, true, true);
    let running: Promise<void> | undefined;
    try {
      running = f.runner.run(f.id);
      await vi.waitFor(() => expect(f.requests.map((request) => request.purpose)).toEqual(["plan", "answer", "summary"]));
      const originalTask = f.goal().rounds[0].task_id!;
      const before = await stat(f.resultPath, { bigint: true });
      const fingerprint = digest(await readFile(f.resultPath, "utf8"));
      await expect(useGoals.getState().pause(f.id)).resolves.toBeNull();
      await running;
      const applied = await Promise.all(f.apply.mock.results.map((result) => result.value));
      expect(applied).toContain("SYNTHETIC_STOPPED_CHECKPOINT_STORAGE_FAILURE");
      expect(f.rejectedCheckpoints).toHaveBeenCalledWith(f.id, originalTask);
      expect(useGoals.getState().error).toBe("无法保存任务恢复记录，请检查本地存储后继续");
      expect(f.goal().status).toBe("paused"); expect(f.goal().rounds).toHaveLength(1);
      expect(f.goal().rounds[0]).toMatchObject({ status: "interrupted", task_id: originalTask });
      expect(f.runner.running(f.id)).toBe(false);
      expect(useTasks.getState().tasks).toHaveLength(1);
      expect(useTasks.getState().tasks[0].status).not.toBe("running");
      await f.runner.run(f.id);
      expect(f.starts).toHaveBeenCalledOnce(); expect(f.resumes).not.toHaveBeenCalled();
      expect(f.checkDone).not.toHaveBeenCalled();
      expect(f.read).toHaveBeenCalledOnce(); expect(f.write).toHaveBeenCalledOnce();
      expect(f.requests.map((request) => request.purpose)).toEqual(["plan", "answer", "summary"]);
      const after = await stat(f.resultPath, { bigint: true });
      expect([after.ino, after.mtimeNs, digest(await readFile(f.resultPath, "utf8"))]).toEqual([before.ino, before.mtimeNs, fingerprint]);
    } finally {
      if (f.runner.running(f.id)) { f.runner.stop(f.id); await running; }
      await rm(f.directory, { recursive: true, force: true });
    }
  });

});


describe("完整 Goal：任务终态持久化与调用结算失败恢复", () => {
  it("终态 checkpoint 成功但旧3次调用结算失败时，重启继续先补结算且不越过 max3", async () => {
    const f = await fixture(3, false, false, { failSettlement: true });
    try {
      await f.runner.run(f.id);
      expect(f.rejectedSettlements).toHaveBeenCalledWith(f.id, 3);
      const taskId = f.goal().rounds[0].task_id!;
      const persisted = (await f.backend.listGoals()).find((goal) => goal.id === f.id)!;
      expect(persisted.rounds[0]).toMatchObject({ task_id: taskId, task_checkpoint: { id: taskId, status: "failed" } });
      expect(f.requests.map((request) => request.purpose)).toEqual(["plan", "answer", "summary"]);
      const before = await stat(f.resultPath, { bigint: true });
      const beforeDigest = digest(await readFile(f.resultPath, "utf8"));
      f.allowSettlement(); f.allowSummary();
      useTasks.setState({ tasks: [], activeId: null });
      await useGoals.getState().load(); hydrateGoalCheckpoints();
      expect(await useGoals.getState().start(f.id)).toBeNull();
      await f.runner.run(f.id);
      // The previous three requests are real runtime events, not seeded counters.
      // Recovery has no budget for another summary, even though storage has healed.
      expect.soft(f.requests.map((request) => request.purpose)).toEqual(["plan", "answer", "summary"]);
      expect.soft(f.goal()).toMatchObject({ status: "failed", used_llm_calls: 3, max_llm_calls: 3 });
      expect.soft((await f.backend.listGoals()).find((goal) => goal.id === f.id)?.used_llm_calls).toBe(3);
      expect(f.goal().rounds).toHaveLength(1); expect(f.goal().rounds[0].task_id).toBe(taskId);
      expect(f.starts).toHaveBeenCalledOnce(); expect(f.read).toHaveBeenCalledOnce(); expect(f.write).toHaveBeenCalledOnce();
      const after = await stat(f.resultPath, { bigint: true });
      expect([after.ino, after.mtimeNs, digest(await readFile(f.resultPath, "utf8"))]).toEqual([before.ino, before.mtimeNs, beforeDigest]);
    } finally { await rm(f.directory, { recursive: true, force: true }); }
  });

  it("completed checkpoint 已成功而调用结算失败时，重启继续仅补结算和Goal收尾，不再执行模型或文件", async () => {
    const f = await fixture(5, false, false, { failSettlement: true, completeInitially: true });
    try {
      await f.runner.run(f.id);
      expect(f.rejectedSettlements).toHaveBeenCalledWith(f.id, 3);
      const taskId = f.goal().rounds[0].task_id!;
      expect((await f.backend.listGoals()).find((goal) => goal.id === f.id)?.rounds[0]).toMatchObject({ task_id: taskId, task_checkpoint: { id: taskId, status: "completed" } });
      const before = await stat(f.resultPath, { bigint: true });
      const beforeDigest = digest(await readFile(f.resultPath, "utf8"));
      f.allowSettlement();
      useTasks.setState({ tasks: [], activeId: null });
      await useGoals.getState().load(); hydrateGoalCheckpoints();
      expect(useTasks.getState().tasks[0]).toMatchObject({ id: taskId, status: "completed" });
      expect(await useGoals.getState().start(f.id)).toBeNull();
      await f.runner.run(f.id);
      expect.soft(f.goal()).toMatchObject({ status: "completed", used_llm_calls: 3 });
      expect.soft(f.checkDone).toHaveBeenCalledOnce();
      expect(f.requests.map((request) => request.purpose)).toEqual(["plan", "answer", "summary"]);
      expect(f.starts).toHaveBeenCalledOnce(); expect(f.read).toHaveBeenCalledOnce(); expect(f.write).toHaveBeenCalledOnce();
      expect(f.goal().rounds).toHaveLength(1); expect(f.goal().rounds[0].task_id).toBe(taskId);
      const after = await stat(f.resultPath, { bigint: true });
      expect([after.ino, after.mtimeNs, digest(await readFile(f.resultPath, "utf8"))]).toEqual([before.ino, before.mtimeNs, beforeDigest]);
    } finally { await rm(f.directory, { recursive: true, force: true }); }
  });

  it("Runtime完成但completed checkpoint拒写时，同进程继续仅补保存和Goal收尾，保留已接受Chat且无副作用重放", async () => {
    const f = await fixture(5, false, false, { failCompletedCheckpoint: true, completeInitially: true });
    try {
      await f.runner.run(f.id);
      expect(f.rejectedCompleted).toHaveBeenCalled();
      const taskId = f.goal().rounds[0].task_id!;
      const card = useTasks.getState().tasks.find((task) => task.id === taskId)!;
      expect(card.status).toBe("needs_user");
      expect(card.events.at(-1)).toMatchObject({ type: "run_end", status: "completed" });
      expect(card.events.some((event) => event.type === "reflect" && event.accepted && event.step?.tool === null && event.output?.includes(MARKER))).toBe(true);
      const before = await stat(f.resultPath, { bigint: true });
      const beforeDigest = digest(await readFile(f.resultPath, "utf8"));
      f.allowCompletedCheckpoint();
      expect(await useGoals.getState().start(f.id)).toBeNull();
      await f.runner.run(f.id);
      expect.soft(f.goal()).toMatchObject({ status: "completed", used_llm_calls: 3 });
      expect.soft(f.checkDone).toHaveBeenCalledOnce();
      expect.soft((await f.backend.listGoals()).find((goal) => goal.id === f.id)?.rounds[0]).toMatchObject({ task_id: taskId, status: "done", task_checkpoint: { id: taskId, status: "completed" } });
      expect(f.requests.map((request) => request.purpose)).toEqual(["plan", "answer", "summary"]);
      expect(f.starts).toHaveBeenCalledOnce(); expect(f.read).toHaveBeenCalledOnce(); expect(f.write).toHaveBeenCalledOnce();
      expect(f.goal().rounds).toHaveLength(1); expect(f.goal().rounds[0].task_id).toBe(taskId);
      const latest = useTasks.getState().tasks.find((task) => task.id === taskId)!;
      expect(latest.events.some((event) => event.type === "reflect" && event.accepted && event.step?.tool === null && event.output?.includes(MARKER))).toBe(true);
      const after = await stat(f.resultPath, { bigint: true });
      expect([after.ino, after.mtimeNs, digest(await readFile(f.resultPath, "utf8"))]).toEqual([before.ino, before.mtimeNs, beforeDigest]);
    } finally { await rm(f.directory, { recursive: true, force: true }); }
  });
});

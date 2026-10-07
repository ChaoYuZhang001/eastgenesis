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
async function fixture(maxLlmCalls: number, failStoppedCheckpoint = false, holdSummary = false) {
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
            if (!resumed) {
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
  setBackend({ ...backend, async updateGoal(id, change) {
    const stored = (await backend.listGoals()).find((goal) => goal.id === id);
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
    id: created.id, directory, resultPath, runner, requests, budgets, read, write, starts, resumes, checkpoints, checkDone, apply, backend, rejectedCheckpoints,
    goal: () => useGoals.getState().items.find((goal) => goal.id === created.id)!,
    allowSummary: () => { resumed = true; },
    allowCheckpoint: () => { rejectStoppedCheckpoint = false; },
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

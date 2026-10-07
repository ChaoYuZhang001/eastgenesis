import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRuntime, Coordinator, ToolRegistry, type LlmRequest } from "@/agent";
import { GoalDetail } from "@/components/goal/GoalDetail";
import { ProviderError } from "@/core/llm/errors";
import { DecisionLayer } from "@/decision/decision-layer";
import { emptyEvidence } from "@/decision/evidence";
import { newGoal, normalizeGoal, parseRounds, type Goal } from "@/decision/goal";
import { executeWithFallback, type RouteDecision } from "@/decision/router";
import * as engine from "@/lib/engine";
import * as goalRun from "@/lib/goal-run";
import { GoalRunner } from "@/lib/goal-runner";
import { recoveryCheckpoint } from "@/lib/recovery";
import { hydrateGoalCheckpoints } from "@/stores/history";
import { useGoals } from "@/stores/goals";
import { taskToStoredTurn, useTasks, type TaskCard } from "@/stores/tasks";
import { LONG, resetStores } from "./ui-helpers";

const DESCRIPTION = "读取项目文件，修改本地代码文件，再分析项目并给出结论，最后汇总所有成果";
const PARTIAL = "已完成文件修改，正在整理本轮的受控总结正文";
const FINAL_DELTA = "恢复同一轮后，正在生成最终总结";
const FINAL = "本轮读取、代码修改和分析已完成，文件只写入一次。";
const CHAT = "SYNTHETIC_GOAL_OUTPUT_CONTEXT_340a";
const BODY = "export const goalOutputVerified = true;\n";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

beforeEach(() => resetStores());
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

/** Production Runtime, stores, serializer, hydrator and runner; only the
 * model transport, tools and completion-verdict dependency are synthetic. */
async function liveFixture() {
  const directory = await mkdtemp(join(tmpdir(), "eastgenesis-goal-output-"));
  const source = join(directory, "source.txt");
  const resultPath = join(directory, "result.ts");
  await writeFile(source, "受控项目输入");
  const read = vi.fn(async () => ({ ok: true, content: await readFile(source, "utf8"), data: {} }));
  const write = vi.fn(async () => { await writeFile(resultPath, BODY); return { ok: true, content: "本地代码修改完成", data: {} }; });
  const tools = new ToolRegistry([
    { name: "mcp__files__read_file", description: "读取项目文件", sideEffect: "none", run: read },
    { name: "mcp__files__write_file", description: "修改本地代码文件", sideEffect: "local_write", run: write },
  ]);
  const first = gate();
  const final = gate();
  const requests: LlmRequest[] = [];
  const runs: Promise<void>[] = [];
  let resumed = false;
  vi.spyOn(engine, "createEngine").mockImplementation((options) => {
    const decision = DecisionLayer.fromEnv({ OPENAI_API_KEY: "synthetic" }, { tools: tools.defs(), permission: "full" });
    const deps = {
      decision, tools, budget: options.budget, onEvent: options.onEvent, beforeSideEffect: options.beforeSideEffect,
      llm: (route: RouteDecision) => async (request: LlmRequest) => {
        requests.push(request);
        const { result } = await executeWithFallback(route.chain.slice(0, 1), async () => {
          let text: string;
          if (request.purpose === "plan") text = JSON.stringify({ steps: [
            { goal: "读取项目文件", tool: "mcp__files__read_file", args: { path: source } },
            { goal: "修改本地代码文件", tool: "mcp__files__write_file", args: { path: resultPath, content: BODY } },
            { goal: "分析项目并给出结论", tool: null },
          ] });
          else if (request.purpose === "answer") text = `分析项目并给出结论：${CHAT}`;
          else if (request.purpose === "summary") {
            if (!resumed) {
              request.onDelta?.({ text: PARTIAL, profileId: "openai/synthetic" });
              await first.promise;
              throw new ProviderError("invalid_response", "openai", { partialOutput: true });
            }
            request.onDelta?.({ text: FINAL_DELTA, profileId: "openai/synthetic" });
            await final.promise;
            text = FINAL;
          } else throw new Error("unexpected synthetic request");
          return { text, profileId: "openai/synthetic", latencyMs: 1, usage: null };
        });
        return result;
      },
    };
    return { runtime: new AgentRuntime(deps), coordinator: new Coordinator(deps), decision, profiles: [] };
  });
  const created = await useGoals.getState().save({ description: DESCRIPTION, max_llm_calls: 5 });
  if (typeof created === "string") throw new Error(created);
  const starts = vi.fn((goal: Goal, _round: number, _hint: string | null, max: number) => useTasks.getState().runGoalRound(goal.description, { goalId: goal.id, mode: "goal", permission: "full", maxLlmCalls: max }));
  const resumes = vi.fn((goal: Goal, _round: number, max: number) => useTasks.getState().resumeGoalRound(goal.description, { goalId: goal.id, taskId: goal.rounds.at(-1)!.task_id!, mode: "goal", permission: "full", maxLlmCalls: max }));
  const runner = new GoalRunner({
    read: (id) => useGoals.getState().items.find((goal) => goal.id === id) ?? null,
    apply: (id, change) => useGoals.getState().apply(id, change), startRoundTask: starts, resumeRoundTask: resumes,
    checkpointTask: async (id) => {
      const card = useTasks.getState().tasks.find((task) => task.id === id)!;
      const saved = await useGoals.getState().apply(card.goalId!, { op: "checkpoint_round", task: taskToStoredTurn(card) });
      if (typeof saved === "string") throw new Error(saved);
    },
    cancelTask: (id) => useTasks.getState().cancel(id),
    checkDone: async () => ({ verdict: "done", by: "rules", reason: "受控文件与结论已核验" }),
  });
  // Keep GoalDetail's start/continue actions and production store transitions;
  // dispatch into the production runner with the controlled verifier above.
  vi.spyOn(goalRun, "runGoal").mockImplementation((id) => { runs.push(runner.run(id)); });
  return { id: created.id, directory, resultPath, first, final, requests, runs, read, write, starts, resumes,
    goal: () => useGoals.getState().items.find((goal) => goal.id === created.id)!,
    allowSummary: () => { resumed = true; },
  };
}

function stoppedCard(status: TaskCard["status"], summary: string | null, streamingText = ""): TaskCard {
  return {
    id: "task-goal-output", seq: 1, sessionId: null, goal: DESCRIPTION, goalId: "goal-output", status, summary, streamingText,
    streamingInterrupted: false, events: [], collapsed: false, pendingConfirm: null, pendingPlan: null, override: null, lock: null,
    permission: "confirm", onboarding: false, files: [], multi: false, startedAt: 1, endedAt: 2, proposal: null, projectId: null,
    mode: "goal", preference: "balanced", preferenceSource: "global",
  };
}
function renderStopped(card: TaskCard) {
  const goal: Goal = { ...newGoal(normalizeGoal({ description: DESCRIPTION }), 1, "goal-output"), status: "paused", rounds: [
    { index: 1, title: "", items: [], status: "interrupted", evidence: emptyEvidence(), verdict: null, task_id: card.id, started_at: 1, finished_at: 2 },
  ] };
  useGoals.setState({ items: [goal], loaded: true });
  useTasks.setState({ tasks: [card] });
  return render(<GoalDetail id={goal.id} />);
}

describe("Goal 轮次正文", () => {
  it("实际生成→失败→检查点重载→顶部继续→总结，正文保留在同Goal同轮同任务且只显示一次", async () => {
    const f = await liveFixture();
    try {
      render(<GoalDetail id={f.id} />);
      const main = screen.getByRole("main", { name: "目标" });
      fireEvent.click(within(main).getByRole("button", { name: "开始" }));
      await waitFor(() => expect(useTasks.getState().tasks[0]?.streamingText).toBe(PARTIAL), LONG);
      const generating = within(main).getByRole("region", { name: "第 1 轮的正在生成" });
      expect(generating).toHaveTextContent(PARTIAL);
      expect(within(main).getAllByText(PARTIAL)).toHaveLength(1);
      expect(within(main).getByRole("region", { name: "正在执行的一轮" })).not.toHaveTextContent(PARTIAL);
      expect(screen.queryByRole("article", { name: /^任务：/ })).not.toBeInTheDocument();
      const taskId = f.goal().rounds[0].task_id!;
      await act(async () => { f.first.release(); await f.runs[0]; });
      expect(f.goal()).toMatchObject({ status: "paused", used_llm_calls: 3 });
      const partial = within(main).getByRole("region", { name: "第 1 轮的部分输出" });
      expect(partial).toHaveTextContent(PARTIAL);
      expect(within(main).getAllByText(PARTIAL)).toHaveLength(1);
      expect(within(main).queryByRole("region", { name: "第 1 轮的总结" })).not.toBeInTheDocument();
      expect(within(main).queryByRole("button", { name: "从未完成步骤继续" })).not.toBeInTheDocument();
      expect(recoveryCheckpoint(useTasks.getState().tasks[0].events)?.nextStepIndex).toBe(3);
      const before = await stat(f.resultPath, { bigint: true });
      const fingerprint = sha(await readFile(f.resultPath, "utf8"));
      const saved = JSON.parse(JSON.stringify(f.goal())) as Goal;
      saved.rounds = parseRounds(JSON.stringify(saved.rounds))!;
      act(() => { useTasks.setState({ tasks: [] }); useGoals.setState({ items: [saved] }); hydrateGoalCheckpoints(); });
      expect(useTasks.getState().tasks[0].id).toBe(taskId);
      expect(within(main).getByRole("region", { name: "第 1 轮的部分输出" })).toHaveTextContent(PARTIAL);
      expect(within(main).getAllByText(PARTIAL)).toHaveLength(1);
      f.allowSummary();
      fireEvent.click(within(main).getByRole("button", { name: "继续" }));
      const resumed = await within(main).findByRole("region", { name: "第 1 轮的正在生成" }, LONG);
      expect(resumed).toHaveTextContent(FINAL_DELTA);
      expect(within(main).queryByRole("region", { name: "第 1 轮的部分输出" })).not.toBeInTheDocument();
      await act(async () => { f.final.release(); await f.runs[1]; });
      const summary = within(main).getByRole("region", { name: "第 1 轮的总结" });
      expect(summary).toHaveTextContent(FINAL);
      expect(within(main).getAllByText(FINAL)).toHaveLength(1);
      expect(within(main).queryByRole("region", { name: "第 1 轮的正在生成" })).not.toBeInTheDocument();
      expect(f.goal()).toMatchObject({ status: "completed", used_llm_calls: 4 });
      expect(f.goal().rounds).toHaveLength(1);
      expect(f.goal().rounds[0].task_id).toBe(taskId);
      expect(f.starts).toHaveBeenCalledOnce();
      expect(f.resumes).toHaveBeenCalledOnce();
      expect(f.requests.map((r) => r.purpose)).toEqual(["plan", "answer", "summary", "summary"]);
      expect(f.requests.at(-1)!.messages.map((m) => m.content).join("\n")).toContain(CHAT);
      expect(f.read).toHaveBeenCalledOnce();
      expect(f.write).toHaveBeenCalledOnce();
      const after = await stat(f.resultPath, { bigint: true });
      expect([after.ino, after.mtimeNs, sha(await readFile(f.resultPath, "utf8"))]).toEqual([before.ino, before.mtimeNs, fingerprint]);
    } finally {
      await act(async () => { f.first.release(); f.final.release(); await Promise.all(f.runs); });
      await rm(f.directory, { recursive: true, force: true });
    }
  });

  it.each(["failed", "aborted", "needs_user"] as const)("%s 停止后的非空正文可见，结果不标为完成，HTML与长行仅作为安全文本", (status) => {
    const raw = '<img src=x onerror="alert(1)">';
    const longLine = "A".repeat(2048);
    renderStopped(stoppedCard(status, raw, longLine));
    const partial = screen.getByRole("region", { name: "第 1 轮的部分输出" });
    expect(partial).toHaveTextContent(longLine);
    const output = screen.getByRole("region", { name: "第 1 轮的结果" });
    expect(output).toHaveTextContent(raw);
    expect(output.querySelector("img,script")).toBeNull();
    expect(screen.queryByRole("region", { name: "第 1 轮的总结" })).not.toBeInTheDocument();
    expect(within(partial).getByText(longLine)).toHaveClass("whitespace-pre-wrap", "[overflow-wrap:anywhere]");
  });

  it("没有正文或仅空白时不创建生成、部分输出或总结的假占位", () => {
    renderStopped(stoppedCard("failed", " \n ", " \n "));
    expect(screen.queryByRole("region", { name: /第 1 轮的(正在生成|部分输出|总结|结果)/ })).not.toBeInTheDocument();
  });

  it("成功总结替换旧的流式正文，不把成功时留下的文本重复标成部分输出", () => {
    renderStopped(stoppedCard("completed", FINAL, FINAL));
    expect(screen.getByRole("region", { name: "第 1 轮的总结" })).toHaveTextContent(FINAL);
    expect(screen.getAllByText(FINAL)).toHaveLength(1);
    expect(screen.queryByRole("region", { name: "第 1 轮的部分输出" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "第 1 轮的结果" })).not.toBeInTheDocument();
  });

  it("运行时只展示当前流式正文，不把陈旧总结显示为当前结果", () => {
    renderStopped(stoppedCard("running", FINAL, PARTIAL));
    expect(screen.getByRole("region", { name: "第 1 轮的正在生成" })).toHaveTextContent(PARTIAL);
    expect(screen.queryByText(FINAL)).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "第 1 轮的总结" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "第 1 轮的结果" })).not.toBeInTheDocument();
  });
});

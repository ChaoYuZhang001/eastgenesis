// @vitest-environment node
// 进程退出后的会话 checkpoint：运行中回合必须能被读回为可解释的 aborted，
// 并保留足够的计划/步骤事件让恢复入口继续工作。
import type { AgentEvent, PlanStep } from "@/agent";
import { recoveryCheckpoint } from "@/lib/recovery";
import { fromStoredTurn, hydrateGoalCheckpoints, loadHistory, saveSession } from "@/stores/history";
import { useGoals } from "@/stores/goals";
import { newGoal, normalizeGoal } from "@/decision/goal";
import { createMockBackend, setBackend } from "@/platform";
import type { StoredSession, StoredTurn } from "@/decision/session";
import { useChat } from "@/stores/chat";
import { useTasks } from "@/stores/tasks";

const session = (id = "ses-recovery-test"): StoredSession => ({
  id,
  title: "可恢复会话",
  project_id: null,
  turns: [],
  created_at: 1,
  updated_at: 2,
});

const step: PlanStep = { id: "s1", goal: "读取项目文件", tool: "read_file" };
const runningEvents: AgentEvent[] = [
  { type: "run_start", runId: "run-1", goal: "整理项目" },
  { type: "plan", plan: { source: "fallback", steps: [step] }, revision: 1 },
  { type: "step_start", step, attempt: 1, surface: "work" },
];

const runningTurn = (id = "task-recovery-test"): StoredTurn => ({
  id,
  seq: 1,
  goal: "整理项目",
  status: "running",
  summary: null,
  events: runningEvents,
  lock: null,
  permission: "confirm",
  files: [],
  multi: false,
  startedAt: 1,
  endedAt: null,
  goalId: null,
  mode: "quick",
  preference: "balanced",
  preferenceSource: "global",
  surfaceHint: null,
});

describe("运行中会话 checkpoint", () => {
  afterEach(() => {
    useTasks.setState({ tasks: [], activeId: null });
    useChat.setState({ sessions: [], activeId: null });
    useGoals.setState({ loaded: false, items: [], error: null });
  });

  it("进程退出后补出明确终态，并保留可恢复的计划步骤", () => {
    const card = fromStoredTurn(runningTurn(), session());
    expect(card.status).toBe("aborted");
    expect(card.summary).toContain("应用在任务完成前退出");
    expect(card.events.at(-1)).toMatchObject({ type: "run_end", status: "aborted" });

    const checkpoint = recoveryCheckpoint(card.events);
    expect(checkpoint).toMatchObject({ status: "aborted", nextStepIndex: 0, failedStep: { id: "s1" } });
    expect(checkpoint?.uncertainSteps.map((s) => s.id)).toEqual(["s1"]);
  });

  it("进程在流式输出期间退出时保留部分输出，并显示中断状态", () => {
    const turn = runningTurn("task-recovery-partial");
    turn.streamingText = "已经收到一部分";
    turn.streamingInterrupted = true;
    const card = fromStoredTurn(turn, session());
    expect(card).toMatchObject({
      status: "aborted",
      streamingText: "已经收到一部分",
      streamingInterrupted: true,
      recoveredFromRestart: true,
    });
    expect(recoveryCheckpoint(card.events)).toMatchObject({ status: "aborted", nextStepIndex: 0 });
  });

  it("如果终态事件已经落盘，优先使用终态而不误报为崩溃", () => {
    const turn = runningTurn();
    turn.events = [...runningEvents, { type: "run_end", status: "completed", summary: "整理完成" }];
    const card = fromStoredTurn(turn, session());
    expect(card.status).toBe("completed");
    expect(card.summary).toBe("整理完成");
    expect(card.events.filter((e) => e.type === "run_end")).toHaveLength(1);
  });

  it("续跑后再次崩溃时只认最近一次 run_start 之后的终态", () => {
    const turn = runningTurn("task-restarted-twice");
    turn.events = [
      ...runningEvents,
      { type: "run_end", status: "completed", summary: "第一次完成" },
      { type: "run_start", runId: "run-2", goal: turn.goal },
      { type: "plan", plan: { source: "fallback", steps: [step] }, revision: 2 },
    ];
    const card = fromStoredTurn(turn, session());
    expect(card.status).toBe("aborted");
    expect(card.summary).toContain("应用在任务完成前退出");
    expect(card.recoveredFromRestart).toBe(true);
  });

  it("运行中回合写入会话，重启读回后出现恢复入口所需的事件", async () => {
    const backend = createMockBackend();
    setBackend(backend);
    const s = session("ses-checkpoint-persist");
    const stored = { ...runningTurn("task-checkpoint-persist"), streamingText: "已经收到一部分", streamingInterrupted: true };
    const card = fromStoredTurn(stored, s);
    // 模拟进程退出前的内存状态：这里必须是 running，saveSession 才会保留 checkpoint。
    useChat.setState({ sessions: [{ id: s.id, title: s.title, projectId: null, createdAt: 1, updatedAt: 2 }] });
    useTasks.setState({ tasks: [{ ...card, status: "running", events: runningEvents, summary: null, endedAt: null }], activeId: card.id });
    await saveSession(s.id);

    const beforeRestart = await backend.listSessions();
    expect(beforeRestart[0]?.turns[0]).toMatchObject({ id: stored.id, status: "running", streamingText: "已经收到一部分", streamingInterrupted: true });

    useChat.setState({ sessions: [], activeId: null });
    useTasks.setState({ tasks: [], activeId: null });
    await loadHistory();
    const recovered = useTasks.getState().tasks.find((t) => t.id === stored.id);
    expect(recovered).toMatchObject({ status: "aborted", summary: expect.stringContaining("应用在任务完成前退出") });
    expect(recovered).toMatchObject({ streamingText: "已经收到一部分", streamingInterrupted: true });
    expect(recovered?.recoveredFromRestart).toBe(true);
    expect(useChat.getState().activeId).toBe(s.id);
    expect(recovered && recoveryCheckpoint(recovered.events)).toMatchObject({ nextStepIndex: 0 });
  });

  it("目标 checkpoint 启动 hydration 回任务列表，但不伪装成普通会话", () => {
    const g = newGoal(normalizeGoal({ description: "恢复目标" }), 1, "goal-recovery-hydrate");
    const task = runningTurn("task-goal-recovery");
    task.goalId = g.id;
    g.status = "paused";
    g.rounds = [{
      index: 1, title: "原轮次", items: [{ id: "r1-1", text: "读取项目", status: "pending" }],
      status: "interrupted", evidence: { tool_calls: [], file_changes: [], command_outputs: [] }, verdict: null,
      task_id: task.id, task_checkpoint: task, interruption_reason: "应用在目标执行期间退出，上一轮已暂停；继续前会重新检查未完成步骤",
      started_at: 1, finished_at: 2,
    }];
    useGoals.setState({ loaded: true, items: [g], error: null });
    hydrateGoalCheckpoints();
    const card = useTasks.getState().tasks.find((t) => t.id === task.id);
    expect(card).toMatchObject({ sessionId: null, goalId: g.id, mode: "goal", status: "aborted", recoveredFromRestart: true });
    expect(useChat.getState().sessions).toHaveLength(0);
  });
});

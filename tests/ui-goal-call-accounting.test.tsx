import { act, cleanup, render, screen, within } from "@testing-library/react";
import { GoalDetail } from "@/components/goal/GoalDetail";
import { emptyEvidence } from "@/decision/evidence";
import { applyGoalChange, newGoal, normalizeGoal, parseRounds, type Goal } from "@/decision/goal";
import * as engine from "@/lib/engine";
import { createMockBackend } from "@/platform";
import { useGoals } from "@/stores/goals";
import { hydrateGoalCheckpoints } from "@/stores/history";
import { taskToStoredTurn, useTasks, type TaskCard } from "@/stores/tasks";
import { resetStores } from "./ui-helpers";

const TASK = "task-saved-calls";
const RUN = "run-saved-calls";
const ID = "goal-saved-calls";
const SUMMARY = "已经保存的结论";
function savedGoal(known: boolean, completed = false): Goal {
  const card: TaskCard = {
    id: TASK, seq: 1, sessionId: null, goal: "整理已保存的结论", goalId: ID,
    status: completed ? "completed" : "failed", summary: SUMMARY, events: [
      { type: "run_start", runId: RUN, goal: "整理已保存的结论" },
      { type: "run_end", status: completed ? "completed" : "failed", summary: SUMMARY },
    ],
    collapsed: false, pendingConfirm: null, pendingPlan: null, override: null, lock: null, permission: "confirm",
    onboarding: false, files: [], multi: false, startedAt: 1, endedAt: 2, proposal: null, projectId: null,
    mode: "goal", preference: "balanced", preferenceSource: "global",
    ...(known ? { recovery_accounting: { version: 1, task_id: TASK, run_id: RUN, llm_calls: 3, final: true } } : {}),
  };
  const checkpoint = taskToStoredTurn(card);
  if (!known) delete checkpoint.recovery_accounting;
  return {
    ...newGoal(normalizeGoal({ description: card.goal, max_llm_calls: 5 }), 1, ID),
    status: completed ? "completed" : "paused", used_llm_calls: known ? 3 : 0,
    rounds: [{
      index: 1, title: "保存的一轮", items: [], status: completed ? "done" : "interrupted",
      evidence: emptyEvidence(), verdict: completed ? { verdict: "done", by: "user", reason: "已确认成果" } : null,
      task_id: TASK, task_checkpoint: checkpoint, started_at: 1, finished_at: 2,
      ...(known ? { llm_settlements: [{ run_id: RUN, llm_calls: 3 }] } : {}),
    }],
  };
}

/** Reload through backend, real rounds parser and store.load; no live error or
 * hydrated task is needed for the durable accounting notice. */
async function loadSaved(goal: Goal) {
  let stored = JSON.stringify(goal);
  const backend = createMockBackend();
  resetStores(backend);
  backend.listGoals = async () => {
    const row = JSON.parse(stored) as Goal;
    return [{ ...row, rounds: parseRounds(JSON.stringify(row.rounds))! }];
  };
  backend.updateGoal = async (_id, change) => {
    const row = JSON.parse(stored) as Goal;
    const next = applyGoalChange({ ...row, rounds: parseRounds(JSON.stringify(row.rounds))! }, change, row.updated_at + 1);
    stored = JSON.stringify(next);
    return structuredClone(next);
  };
  const model = vi.spyOn(engine, "createEngine").mockImplementation(() => { throw new Error("unexpected model execution"); });
  useGoals.getState().reportError("旧的易失错误");
  await useGoals.getState().load();
  expect(useGoals.getState().error).toBeNull();
  expect(useTasks.getState().tasks).toHaveLength(0);
  return { model, readStored: () => JSON.parse(stored) as Goal };
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("旧任务的未知调用提示从持久记录重载，清除易失错误和任务卡仍可见", async () => {
  const f = await loadSaved(savedGoal(false));
  const view = render(<GoalDetail id={ID} />);
  const main = screen.getByRole("main", { name: "目标" });
  expect(within(main).getByText(/历史调用次数未知/)).toBeVisible();
  expect(within(main).queryByText(/模型调用 0 \/ 5/)).not.toBeInTheDocument();
  expect(within(main).getByRole("button", { name: "继续" })).toBeEnabled();
  expect(within(main).queryByRole("button", { name: /恢复预算/ })).not.toBeInTheDocument();
  const before = f.readStored();
  view.unmount();
  act(() => { useGoals.setState({ items: [], loaded: false, error: null }); useTasks.setState({ tasks: [] }); });
  await act(() => useGoals.getState().load());
  render(<GoalDetail id={ID} />);
  expect(screen.getByText(/历史调用次数未知/)).toBeVisible();
  expect(f.readStored()).toEqual(before);
  expect(f.readStored().rounds[0].llm_settlements).toBeUndefined();
  expect(f.model).not.toHaveBeenCalled();
});

it("completed旧记录0仍显示历史未知，保存成果不变且没有模型或新预算入口", async () => {
  const f = await loadSaved(savedGoal(false, true));
  act(() => hydrateGoalCheckpoints());
  render(<GoalDetail id={ID} />);
  const main = screen.getByRole("main", { name: "目标" });
  expect(within(main).getByText(/历史调用次数未知.*旧保存记录 0.*原上限 5/)).toBeVisible();
  expect(within(main).queryByText(/模型调用 0 \/ 5/)).not.toBeInTheDocument();
  expect(within(main).getByRole("region", { name: "第 1 轮的总结" })).toHaveTextContent(SUMMARY);
  expect(within(main).queryByRole("button", { name: "继续" })).not.toBeInTheDocument();
  expect(within(main).queryByRole("button", { name: /恢复预算/ })).not.toBeInTheDocument();
  expect(f.readStored()).toMatchObject({ status: "completed", used_llm_calls: 0, max_llm_calls: 5 });
  expect(f.readStored().rounds[0].llm_settlements).toBeUndefined();
  expect(f.model).not.toHaveBeenCalled();
});

it("已完整保存和结算3次的现代记录仍显示3/5，不误报未知或修改凭据", async () => {
  const known = savedGoal(true);
  const f = await loadSaved(known);
  render(<GoalDetail id={ID} />);
  const main = screen.getByRole("main", { name: "目标" });
  expect(within(main).getByText(/模型调用 3 \/ 5/)).toBeVisible();
  expect(within(main).queryByText(/历史调用次数未知/)).not.toBeInTheDocument();
  expect(f.readStored()).toEqual(known);
  expect(f.model).not.toHaveBeenCalled();
});

it("停止的检查点只有下界2时保持未知，不将它加到旧记录或升级成final", async () => {
  const g = savedGoal(true);
  g.used_llm_calls = 0;
  g.rounds[0].llm_settlements = [];
  g.rounds[0].task_checkpoint!.status = "running";
  g.rounds[0].task_checkpoint!.recovery_accounting = { version: 1, task_id: TASK, run_id: RUN, llm_calls: 2, final: false };
  g.rounds[0].task_checkpoint!.events.pop();
  const f = await loadSaved(g);
  render(<GoalDetail id={ID} />);
  expect(screen.getByText(/历史调用次数未知.*旧保存记录 0/)).toBeVisible();
  expect(f.readStored().rounds[0].task_checkpoint!.recovery_accounting).toMatchObject({ llm_calls: 2, final: false });
  expect(f.readStored().rounds[0].llm_settlements).toEqual([]);
  expect(f.model).not.toHaveBeenCalled();
});

it("后轮现代计数完整不能掩盖前轮的未知历史", async () => {
  const g = savedGoal(true, true);
  const legacy = savedGoal(false).rounds[0];
  legacy.task_id = "task-prior-legacy-calls";
  legacy.task_checkpoint!.id = legacy.task_id;
  g.rounds = [{ ...legacy, index: 1 }, { ...g.rounds[0], index: 2 }];
  const f = await loadSaved(g);
  render(<GoalDetail id={ID} />);
  expect(screen.getByText(/历史调用次数未知.*旧保存记录 3/)).toBeVisible();
  expect(f.readStored().rounds[0].llm_settlements).toBeUndefined();
  expect(f.readStored().rounds[1].llm_settlements).toEqual([{ run_id: RUN, llm_calls: 3 }]);
  expect(f.model).not.toHaveBeenCalled();
});

it("只有终态计数但还没有匹配结算凭据时，不把旧0/5展示成完整总量", async () => {
  const g = savedGoal(true);
  g.used_llm_calls = 0;
  g.rounds[0].llm_settlements = [];
  const f = await loadSaved(g);
  render(<GoalDetail id={ID} />);
  expect(screen.getByText(/历史调用次数未知.*旧保存记录 0/)).toBeVisible();
  expect(f.readStored().rounds[0].task_checkpoint!.recovery_accounting).toMatchObject({ final: true, llm_calls: 3 });
  expect(f.readStored().rounds[0].llm_settlements).toEqual([]);
  expect(f.model).not.toHaveBeenCalled();
});

it("新目标尚无轮次时保留0/5，不误标为旧历史未知", async () => {
  const g = newGoal(normalizeGoal({ description: "新的目标", max_llm_calls: 5 }), 1, ID);
  const f = await loadSaved(g);
  render(<GoalDetail id={ID} />);
  expect(screen.getByText(/模型调用 0 \/ 5/)).toBeVisible();
  expect(screen.queryByText(/历史调用次数未知/)).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "开始" })).toBeEnabled();
  expect(f.model).not.toHaveBeenCalled();
});

it("现代live下界尚在增长时不误标legacy，冷重载停止后仍不把下界升级为完整数", async () => {
  const g = savedGoal(true);
  g.used_llm_calls = 0;
  g.status = "running";
  g.rounds[0].status = "running";
  g.rounds[0].llm_settlements = [];
  g.rounds[0].task_checkpoint!.status = "running";
  g.rounds[0].task_checkpoint!.events.pop();
  g.rounds[0].task_checkpoint!.recovery_accounting = { version: 1, task_id: TASK, run_id: RUN, llm_calls: 2, final: false };
  const f = await loadSaved(g);
  act(() => useGoals.setState({ items: [g] }));
  render(<GoalDetail id={ID} />);
  expect(screen.queryByText(/历史调用次数未知/)).not.toBeInTheDocument();
  expect(screen.getByText(/模型调用 0 \/ 5/)).toBeVisible();
  await act(() => useGoals.getState().load());
  expect(screen.getByText(/历史调用次数未知.*旧保存记录 0/)).toBeVisible();
  expect(f.readStored()).toMatchObject({ status: "paused" });
  expect(f.readStored().rounds[0].task_checkpoint!.recovery_accounting).toMatchObject({ llm_calls: 2, final: false });
  expect(f.model).not.toHaveBeenCalled();
});

it("POLICY RED: 停止轮缺失最新checkpoint时，既往receipt不能证明历史完整", async () => {
  const g = savedGoal(true);
  delete g.rounds[0].task_checkpoint;
  const f = await loadSaved(g);
  expect(useGoals.getState().items[0].rounds[0].task_checkpoint).toBeUndefined();
  expect(useGoals.getState().items[0].rounds[0].llm_settlements).toEqual([{ run_id: RUN, llm_calls: 3 }]);
  render(<GoalDetail id={ID} />);
  expect(f.readStored()).toMatchObject({ status: "paused", used_llm_calls: 3, max_llm_calls: 5 });
  expect(f.model).not.toHaveBeenCalled();
  expect(screen.getByText(/历史调用次数未知.*旧保存记录 3.*原上限 5/)).toBeVisible();
  expect(screen.queryByText(/模型调用 3 \/ 5/)).not.toBeInTheDocument();
});

it("新轮live尚无checkpoint时，不因空settlements误报旧历史未知", async () => {
  const g = savedGoal(true);
  g.status = "running";
  g.used_llm_calls = 0;
  g.rounds[0].status = "running";
  g.rounds[0].llm_settlements = [];
  delete g.rounds[0].task_checkpoint;
  const f = await loadSaved(g);
  // load correctly pauses a persisted running round; this models the separate
  // live pre-start window before that lifecycle ends, without starting a model.
  act(() => useGoals.setState({ items: [g] }));
  render(<GoalDetail id={ID} />);
  expect(screen.queryByText(/历史调用次数未知/)).not.toBeInTheDocument();
  expect(screen.getByText(/模型调用 0 \/ 5/)).toBeVisible();
  expect(f.model).not.toHaveBeenCalled();
  await act(() => useGoals.getState().load());
  expect(screen.getByText(/历史调用次数未知/)).toBeVisible();
  expect(f.readStored().rounds[0].task_checkpoint).toBeUndefined();
  expect(f.readStored().rounds[0].llm_settlements).toEqual([]);
});

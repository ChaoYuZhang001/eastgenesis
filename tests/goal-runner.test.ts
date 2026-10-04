// 目标执行器（M10）：目标模式的自动多轮循环。全部用假依赖：不碰 store、不碰网络、不调模型。
import { applyGoalChange, newGoal, normalizeGoal, MAX_ROUNDS, type Goal, type GoalChange, type GoalRound, type RoundVerdict } from "@/decision/goal";
import { emptyEvidence, type Evidence, type EvidenceResult } from "@/decision/evidence";
import { GoalRunner, type RoundHandle, type RoundResult } from "@/lib/goal-runner";

const T = 1_700_000_000_000;
const ev = (claim?: string): Evidence => ({ ...emptyEvidence(), ...(claim ? { claim } : {}) });
/** 一轮没跑完时的默认结果 */
const round1: RoundResult = { taskId: "task-r1", status: "completed", summary: "做完了", evidence: ev("做完了"), llmCalls: 1, items: [{ text: "做事", status: "done" }] };

/** 一行的判定：verify 是这次 checkDone 返回什么（"throw" 表示抛错） */
interface Step {
  result?: Partial<RoundResult>;
  verify?: EvidenceResult | "throw" | "hold";
}
const notDone = (reason = "还没做完"): EvidenceResult => ({ verdict: "not_done", reason, by: "rules" });
const done = (reason = "已经产出结果"): EvidenceResult => ({ verdict: "done", reason, by: "rules" });

function harness(description = "把下载文件夹里的合同归档", o: { maxLlmCalls?: number; applyFails?: string } = {}) {
  let goal: Goal = { ...newGoal(normalizeGoal({ description, ...(o.maxLlmCalls ? { max_llm_calls: o.maxLlmCalls } : {}) }), T), status: "running" };
  const calls: { round: number; hint: string | null; maxLlmCalls: number; goalText?: string }[] = [];
  const cancelled: string[] = [];
  const errors: string[] = [];
  let steps: Step[] = [];
  /** 每轮被创建时的手柄：hold 用它让这一轮永不结束 */
  const held: ((r: RoundResult) => void)[] = [];
  let n = 0;

  const runner = new GoalRunner({
    read: () => goal,
    apply: async (id, change: GoalChange) => {
      if (id !== goal.id) return "没有找到这个目标";
      if (o.applyFails) return o.applyFails;
      goal = applyGoalChange(goal, change, T + ++n);
      return goal;
    },
    startRoundTask(_g, round, hint, maxLlmCalls): RoundHandle {
      calls.push({ round, hint, maxLlmCalls });
      const taskId = `task-r${round}`;
      // 脚本用完时按最后一条重复（用例只关心一种情况时不用把每一轮都写出来）
      const step = steps[round - 1] ?? steps.at(-1) ?? {};
      const result = { ...round1, taskId, ...step.result };
      // hold：这一轮先不结束，测试自己决定什么时候放行（用来测暂停、重复启动）
      const p = step.verify === "hold" ? new Promise<RoundResult>((resolve) => held.push(resolve)) : Promise.resolve(result);
      return { taskId, result: p };
    },
    async checkDone(_g, evidence, taskId): Promise<EvidenceResult> {
      void evidence;
      void taskId;
      const i = calls.length - 1;
      const verify = (steps[i] ?? steps.at(-1) ?? {}).verify;
      if (verify === "throw") throw new Error("Jev 调用失败");
      if (verify === "hold" || verify === undefined) return done("默认判定");
      return verify;
    },
    cancelTask: (id) => void cancelled.push(id),
    onError: (m) => void errors.push(m),
    now: () => T + ++n,
  });

  return {
    runner,
    goal: () => goal,
    calls,
    cancelled,
    errors,
    setGoal: (g: Goal) => void (goal = g),
    setSteps: (s: Step[]) => void (steps = s),
    release: (r?: Partial<RoundResult>) => {
      const f = held.shift();
      if (f) f({ ...round1, ...r });
      return held.length;
    },
  };
}

const emptyRound = (index: number, status: GoalRound["status"] = "running", verdict: RoundVerdict | null = null) => ({
  index,
  title: `第 ${index} 轮`,
  items: [],
  status,
  evidence: emptyEvidence(),
  verdict,
  task_id: null,
  started_at: T,
  finished_at: null,
});

describe("目标执行器：多轮循环", () => {
  it("未达成自动开下一轮，直到判定 done 才收尾；轮次、标题、步骤和调用次数都记在目标上", async () => {
    const h = harness();
    h.setSteps([{ verify: notDone("还差第 2 步") }, { verify: notDone("还差最后一步") }, { verify: done("已经产出归档清单") }]);
    await h.runner.run(h.goal().id);
    const g = h.goal();
    expect(g.rounds.map((r) => r.status)).toEqual(["not_done", "not_done", "done"]);
    expect(g.status).toBe("completed");
    expect(g.used_llm_calls).toBe(3);
    expect(h.calls.map((c) => c.round)).toEqual([1, 2, 3]);
    // 第二轮起把「上一轮为什么没做完」当作这一轮的重点；第一轮没有
    expect(h.calls[0].hint).toBeNull();
    expect(h.calls[1].hint).toBe("还差第 2 步");
    expect(h.calls[2].hint).toBe("还差最后一步");
    // 标题取自上一轮的判定，步骤来自执行记录，轮次挂到执行它的任务上
    expect(g.rounds[0].title).toBe("第 1 轮");
    expect(g.rounds[1].title).toBe("还差第 2 步");
    expect(g.rounds[0].items).toEqual([{ id: "r1-1", text: "做事", status: "done" }]);
    expect(g.rounds.map((r) => r.task_id)).toEqual(["task-r1", "task-r2", "task-r3"]);
    // 判定原因原样存下来（界面按 by 写「规则判定」「Jev 判定」）
    expect(g.rounds[2].verdict).toMatchObject({ verdict: "done", by: "rules", reason: "已经产出归档清单" });
  });

  it("判定拿不准时停下等你确认：不开下一轮，也不收尾", async () => {
    const h = harness();
    h.setSteps([{ verify: { verdict: "uncertain", reason: "AI 声称完成，但无实据", by: "rules" } }]);
    await h.runner.run(h.goal().id);
    const g = h.goal();
    expect(g.status).toBe("running");
    expect(g.rounds).toHaveLength(1);
    expect(g.rounds[0].status).toBe("uncertain");
    expect(h.calls).toHaveLength(1);
  });

  it("执行出错也记一轮，连续失败到上限（3 次）时目标判失败", async () => {
    const h = harness("整理照片");
    h.setSteps([{ result: { status: "failed", summary: "模型全都不可用", llmCalls: 2 } }]);
    await h.runner.run(h.goal().id);
    const g = h.goal();
    expect(g.rounds.map((r) => r.status)).toEqual(["failed", "failed", "failed"]);
    expect(g.rounds[0].verdict).toMatchObject({ by: "runtime" });
    expect(g.rounds[0].verdict?.reason).toContain("模型全都不可用");
    expect(g.status).toBe("failed");
    // 执行出错的一轮不问「达成没有」，但调用次数照样记（钱已经花了）
    expect(g.used_llm_calls).toBe(6);
  });

  it("模型调用到上限时判失败（budget）；每轮的预算按剩余额度递减", async () => {
    const h = harness("整理照片", { maxLlmCalls: 3 });
    h.setSteps([{ result: { llmCalls: 1 }, verify: notDone("还早") }]);
    await h.runner.run(h.goal().id);
    const g = h.goal();
    expect(g.rounds).toHaveLength(3);
    expect(g.used_llm_calls).toBe(3);
    expect(g.status).toBe("failed");
    expect(h.calls.map((c) => c.maxLlmCalls)).toEqual([3, 2, 1]);
  });

  it("轮数到达 MAX_ROUNDS 时判失败，不会无限跑下去", async () => {
    const h = harness();
    const rounds = Array.from({ length: MAX_ROUNDS }, (_, i) => emptyRound(i + 1, "not_done", { verdict: "not_done", reason: "没做完", by: "rules" }));
    h.setGoal({ ...h.goal(), rounds });
    await h.runner.run(h.goal().id);
    expect(h.calls).toHaveLength(0);
    expect(h.goal().status).toBe("failed");
  });

  it("目标不是「进行中」或上一轮在等你确认时，什么都不做", async () => {
    const h = harness();
    h.setGoal({ ...h.goal(), status: "idle" });
    await h.runner.run(h.goal().id);
    expect(h.calls).toHaveLength(0);

    h.setGoal({ ...h.goal(), status: "running", rounds: [emptyRound(1, "uncertain", { verdict: "uncertain", reason: "拿不准", by: "rules" })] });
    await h.runner.run(h.goal().id);
    expect(h.calls).toHaveLength(0);
  });

  it("同一个目标不会同时跑两个循环", async () => {
    const h = harness();
    h.setSteps([{ verify: "hold" }]);
    const first = h.runner.run(h.goal().id);
    expect(h.runner.running(h.goal().id)).toBe(true);
    // 第二次调用直接返回，不会开出第二轮
    await h.runner.run(h.goal().id);
    expect(h.calls).toHaveLength(1);
    h.release({ status: "aborted", summary: "任务已取消" });
    await first;
  });

  it("暂停时打断正在跑的一轮：取消任务、不写判定、目标停在已暂停", async () => {
    const h = harness();
    h.setSteps([{ verify: "hold" }]);
    const p = h.runner.run(h.goal().id);
    // 让循环走到「等这一轮结果」的位置
    await new Promise((r) => setTimeout(r, 0));
    expect(h.runner.running(h.goal().id)).toBe(true);
    expect(h.cancelled).toEqual([]);
    // 界面上的暂停：先把目标改成 paused，再停循环（和 stores/goals.ts 的顺序一致）
    h.setGoal({ ...h.goal(), status: "paused" });
    expect(h.runner.stop(h.goal().id)).toBe(true);
    expect(h.cancelled).toEqual(["task-r1"]);
    h.release();
    await p;
    expect(h.runner.running(h.goal().id)).toBe(false);
    // 暂停时被打断的那一轮保留在目标上，没有判定，也没有下一轮
    expect(h.goal().rounds).toHaveLength(1);
    expect(h.calls).toHaveLength(1);
  });

  it("用户停掉这一轮（aborted）时目标一起暂停，不偷偷开下一轮", async () => {
    const h = harness();
    h.setSteps([{ result: { status: "aborted", summary: "任务已取消", llmCalls: 0 } }]);
    await h.runner.run(h.goal().id);
    expect(h.goal().status).toBe("paused");
    expect(h.goal().rounds).toHaveLength(1);
    expect(h.calls).toHaveLength(1);
  });

  it("需要用户处理和超出预算都按执行出错记，说明写进判定", async () => {
    for (const status of ["needs_user", "budget_exceeded"] as const) {
      const h = harness();
      h.setSteps([{ result: { status, summary: "这一轮没跑完的原因" }, verify: done() }, { result: { status, summary: "这一轮没跑完的原因" }, verify: done() }, { result: { status, summary: "这一轮没跑完的原因" }, verify: done() }]);
      await h.runner.run(h.goal().id);
      expect(h.goal().rounds[0].verdict?.reason).toContain("这一轮没跑完的原因");
      expect(h.goal().rounds[0].status).toBe("failed");
      expect(h.goal().status).toBe("failed");
    }
  });

  it("完成校验抛错时按「拿不准」停下来等你确认，循环不崩", async () => {
    const h = harness();
    h.setSteps([{ verify: "throw" }]);
    await h.runner.run(h.goal().id);
    expect(h.goal().rounds[0].status).toBe("uncertain");
    expect(h.goal().rounds[0].verdict?.reason).toContain("完成校验没能做完");
    expect(h.goal().status).toBe("running");
    expect(h.calls).toHaveLength(1);
  });

  it("写回目标失败时停下并报错，不再继续", async () => {
    const h = harness("整理照片", { applyFails: "目标已完成，不能执行" });
    h.setSteps([{ verify: notDone() }]);
    await h.runner.run(h.goal().id);
    // 开一轮失败：这一轮的任务被取消，循环退出
    expect(h.errors).toEqual(["目标已完成，不能执行"]);
    expect(h.calls).toHaveLength(1);
    expect(h.cancelled).toEqual(["task-r1"]);
    expect(h.runner.running(h.goal().id)).toBe(false);
  });

  it("轮次跑到一半写回失败（目标被删或被改状态）时立刻停下，不空转", async () => {
    let goal: Goal = { ...newGoal(normalizeGoal({ description: "整理照片" }), T), status: "running" };
    const calls: number[] = [];
    let failAfter = 1; // 第 1 次写回（开轮）成功后，之后的写回都失败
    let applies = 0;
    const errors: string[] = [];
    const runner = new GoalRunner({
      read: () => goal,
      apply: async () => (++applies > failAfter ? "没有找到这个目标" : goal),
      startRoundTask(g, round, hint, max): RoundHandle {
        calls.push(round);
        void hint;
        void max;
        void g;
        return { taskId: `task-r${round}`, result: Promise.resolve({ ...round1, taskId: `task-r${round}` }) };
      },
      checkDone: async () => notDone(),
      cancelTask: () => {},
      onError: (m) => void errors.push(m),
    });
    await runner.run(goal.id);
    expect(calls).toEqual([1]);
    expect(errors).toEqual(["没有找到这个目标"]);
    expect(runner.running(goal.id)).toBe(false);
  });

  it("已经在「等你确认」的目标，用户选继续后由界面再启动循环；这里只验状态机允许", async () => {
    const h = harness();
    const g = h.goal();
    h.setGoal({
      ...g,
      rounds: [emptyRound(1, "uncertain", { verdict: "uncertain", reason: "拿不准", by: "rules" })],
      used_llm_calls: 1,
    });
    await h.runner.run(h.goal().id);
    expect(h.calls).toHaveLength(0);
    // 用户裁决「继续」：状态机把这一轮改成 not_done，循环就能接着开下一轮
    h.setGoal(applyGoalChange(h.goal(), { op: "resolve_uncertain", choice: "continue" }, T + 100));
    expect(h.goal().rounds[0].status).toBe("not_done");
    h.setSteps([{ verify: done() }]);
    await h.runner.run(h.goal().id);
    expect(h.calls.map((c) => c.round)).toEqual([2]);
    expect(h.goal().status).toBe("completed");
  });
});

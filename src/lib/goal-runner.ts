// 目标执行器（M10）：目标模式的自动多轮循环。
// 每一轮：开一轮（先登记，界面立刻看到「第 N 轮 进行中」）→ 跑一轮任务 → 收集实据 → 调决策层
// checkDoneWithEvidence → 未达成自动开下一轮，达成收尾，拿不准停下来等你确认。
// 这里只有循环本身：读目标、写目标、跑一轮、判定、取消全由外部注入（lib/goal-run.ts 接真实实现，测试接假的）。
import type { Evidence, EvidenceResult } from "@/decision/evidence";
import { FAIL_CAUSE_LABEL, failCause, goalPhase, nextRoundHint, type Goal, type GoalChange, type ItemStatus } from "@/decision/goal";
import type { RunStatus } from "@/agent";

/** 一轮执行完的结果，由跑一轮的实现给出（lib/run-evidence.ts 从运行结果算出实据和步骤） */
export interface RoundResult {
  taskId: string;
  status: RunStatus;
  summary: string;
  evidence: Evidence;
  /** 这一轮实际用了几次模型调用；记进目标的用量（暂停、放弃也照记，钱已经花了） */
  llmCalls: number;
  items: readonly { text: string; status: ItemStatus }[];
}

/** 已经开始的一轮：taskId 立刻可用，result 等这一轮结束 */
export interface RoundHandle {
  taskId: string;
  result: Promise<RoundResult>;
}

export interface GoalRunnerDeps {
  /** 同步读当前目标（store 里的最新值）；不存在返回 null */
  read(id: string): Goal | null;
  /** 写回目标：状态转换和轮次操作；失败返回错误说明 */
  apply(id: string, change: GoalChange): Promise<Goal | string>;
  /** 开始一轮：建任务、跑一轮任务；maxLlmCalls 是这一轮还能用的模型调用次数上限 */
  startRoundTask(goal: Goal, round: number, hint: string | null, maxLlmCalls: number): RoundHandle;
  /** 目标达成没有：决策层 checkDoneWithEvidence（先规则，再 Jev，拿不准交给用户） */
  checkDone(goal: Goal, evidence: Evidence, taskId: string): Promise<EvidenceResult>;
  /** 停止一轮的任务（放弃、删除目标或执行器被停掉时） */
  cancelTask(taskId: string): void;
  /** 记一条错误说明给界面（不抛出：一轮的意外不应该让整个循环塌掉） */
  onError?(message: string): void;
  now?(): number;
}

/** 跑一轮失败时的说明（执行出错、需要用户处理、超出预算） */
const FAILED_TEXT: Partial<Record<RunStatus, string>> = {
  failed: "这一轮执行出错",
  needs_user: "这一轮需要你处理才能继续",
  budget_exceeded: "这一轮用完了一轮的模型调用预算",
};

export class GoalRunner {
  /** 正在跑的目标：abort 后循环在下一个检查点退出 */
  readonly #active = new Map<string, AbortController>();
  /** 每个目标当前那一轮的任务 id：停下时连任务一起取消，不等它自己跑完 */
  readonly #currentTask = new Map<string, string>();

  constructor(private readonly deps: GoalRunnerDeps) {}

  /** 这个目标的循环是不是正在跑 */
  running(id: string): boolean {
    return this.#active.has(id);
  }

  /** 停掉某个目标的循环（暂停、放弃、删除时调用）：先取消当前这一轮的任务，再让循环退出 */
  stop(id: string): boolean {
    const ctrl = this.#active.get(id);
    if (!ctrl) return false;
    this.#active.delete(id);
    const taskId = this.#currentTask.get(id);
    this.#currentTask.delete(id);
    if (taskId) this.deps.cancelTask(taskId);
    ctrl.abort();
    return true;
  }

  /**
   * 自动多轮循环。目标不是「进行中」、上一轮在等你确认、已经在跑时直接返回。
   * 返回时目标可能已完成、已失败、已暂停、已放弃，或停在「等你确认」。
   */
  async run(id: string): Promise<void> {
    if (this.#active.has(id)) return;
    const ctrl = new AbortController();
    this.#active.set(id, ctrl);
    const aborted = () => ctrl.signal.aborted;
    try {
      for (;;) {
        if (aborted()) return;
        const g = this.deps.read(id);
        if (!g) return;
        // 只有「进行中且可以开下一轮」才继续：暂停、放弃、完成、失败、等你确认都停下来
        if (g.status !== "running") return;
        const phase = goalPhase(g);
        if (phase === "awaiting_user" || phase === "working") return;
        if ((await this.#failIfExhausted(g)) !== null) return;

        const round = g.rounds.length + 1;
        const hint = nextRoundHint(g);
        // 这一轮的模型调用预算：目标还剩多少就最多用多少（至少 1，运行时会按上限抛 budget_exceeded）
        const left = Math.max(1, g.max_llm_calls - g.used_llm_calls);
        const handle = this.deps.startRoundTask(g, round, hint, left);
        this.#currentTask.set(id, handle.taskId);
        // 先登记这一轮再等结果：写失败（例如刚被删除）就取消任务并退出
        const started = await this.#apply(id, { op: "start_round", plan: { ...(hint ? { title: hint } : {}), task_id: handle.taskId } });
        if (started === null) {
          this.deps.cancelTask(handle.taskId);
          return;
        }
        const r = await handle.result;
        this.#currentTask.delete(id);
        // 钱已经花了：调用次数先记上，暂停和放弃也照记。
        // 写不进去（目标被删了、状态不允许）说明这个目标已经不该由我们推进了，整个循环退出：
        // 继续转下去只会一遍遍失败
        if (r.llmCalls > 0 && (await this.#apply(id, { op: "record_llm_calls", count: r.llmCalls })) === null) return;
        if (aborted()) return;
        const cur = this.deps.read(id);
        // 暂停、放弃、删除：轮次已经被状态机打断，不再写判定
        if (!cur || cur.status !== "running") return;
        if (r.items.length && (await this.#apply(id, { op: "set_round_items", items: r.items.map((i) => ({ ...i })) })) === null) return;
        if (aborted()) return;

        // 只有正常跑完的一轮才问「达成没有」；执行出错直接按未达成记，连续失败到上限时目标失败
        if (r.status !== "completed") {
          // 用户自己停了这一轮：把目标一起暂停，不要偷偷再开一轮
          if (r.status === "aborted") {
            await this.#apply(id, { op: "transition", to: "paused" });
            return;
          }
          if ((await this.#apply(id, { op: "fail_round", message: `${FAILED_TEXT[r.status] ?? "这一轮没有跑完"}：${r.summary}` })) === null) return;
          continue;
        }
        const verdict = await this.#check(g, r);
        if (verdict === null) return;
        await this.#apply(id, { op: "finish_round", result: verdict });
      }
    } catch (e) {
      this.deps.onError?.(e instanceof Error ? e.message : String(e));
    } finally {
      if (this.#active.get(id) === ctrl) this.#active.delete(id);
      this.#currentTask.delete(id);
    }
  }

  /** 到了失败条件就把目标判失败并停下；返回失败原因（没到条件返回 null） */
  async #failIfExhausted(g: Goal): Promise<string | null> {
    const cause = failCause(g);
    if (!cause) return null;
    await this.#apply(g.id, { op: "transition", to: "failed" });
    return FAIL_CAUSE_LABEL[cause];
  }

  /** 完成校验；出错时按「拿不准」处理，交给用户确认，不让循环崩掉 */
  async #check(g: Goal, r: RoundResult): Promise<EvidenceResult | null> {
    try {
      return await this.deps.checkDone(g, r.evidence, r.taskId);
    } catch (e) {
      if (e && typeof e === "object" && (e as { code?: string }).code === "aborted") return null;
      const why = e instanceof Error ? e.message : String(e);
      this.deps.onError?.(`完成校验失败：${why}`);
      return { verdict: "uncertain", reason: `完成校验没能做完（${why}），请你确认`, by: "rules" };
    }
  }

  /** 写回目标；失败返回 null（目标已删除或状态不允许），并把原因交给界面 */
  async #apply(id: string, change: GoalChange): Promise<Goal | null> {
    const r = await this.deps.apply(id, change);
    if (typeof r === "string") {
      this.deps.onError?.(r);
      return null;
    }
    return r;
  }
}

/** 便捷入口：一个执行器实例，配好依赖（测试里用假依赖，应用里用 lib/goal-run.ts 的真实依赖） */
export function createGoalRunner(deps: GoalRunnerDeps): GoalRunner {
  return new GoalRunner(deps);
}

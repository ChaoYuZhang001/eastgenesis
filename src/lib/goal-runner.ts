// 目标执行器（M10）：目标模式的自动多轮循环。
// 每一轮：开一轮（先登记，界面立刻看到「第 N 轮 进行中」）→ 跑一轮任务 → 收集实据 → 调决策层
// checkDoneWithEvidence → 未达成自动开下一轮，达成收尾，拿不准停下来等你确认。
// 这里只有循环本身：读目标、写目标、跑一轮、判定、取消全由外部注入（lib/goal-run.ts 接真实实现，测试接假的）。
import type { Evidence, EvidenceResult } from "@/decision/evidence";
import { FAIL_CAUSE_LABEL, failCause, goalPhase, nextRoundHint, type Goal, type GoalChange, type ItemStatus } from "@/decision/goal";
import type { RunStatus } from "@/agent";
import type { RecoveryAccounting } from "@/decision/session";
import { GoalQuotaControlError, isGoalQuotaControlError, type GoalQuotaErrorCode } from "@/core/goal-quota";
import { freeCompletedPublication, type GoalExecutionSession } from "./goal-execution";
import type { GoalQuotaPublication } from "./goal-quota-storage";
import { isGoalContinuation, type GoalContinuation } from "./goal-continuation";

/** 一轮执行完的结果，由跑一轮的实现给出（lib/run-evidence.ts 从运行结果算出实据和步骤） */
export interface RoundResult {
  taskId: string;
  status: RunStatus;
  summary: string;
  evidence: Evidence;
  /** 本次运行实际用了几次模型调用；恢复同一轮时不重复计入已结算的旧调用。 */
  llmCalls: number;
  /** 实际主运行的完整计数；缺省供旧纯循环测试使用，null 明确表示未知。 */
  accounting?: RecoveryAccounting | null;
  items: readonly { text: string; status: ItemStatus }[];
  quotaControl?: { code: GoalQuotaErrorCode };
}

export interface RecoveryPreparation {
  accounting: RecoveryAccounting | null;
  completed: RoundResult | null;
  continuation?: GoalContinuation;
}

/** 已经开始的一轮：taskId 立刻可用，result 等这一轮结束 */
export interface RoundHandle {
  taskId: string;
  result: Promise<RoundResult>;
  /** 可选的惰性启动钩子；提供时 runner 会在 start_round/resume_round 成功落库后调用。 */
  prepare?(): Promise<GoalExecutionSession | null>;
  session?(): GoalExecutionSession | null;
  start?(): void;
}

export interface GoalRunnerDeps {
  /** 同步读当前目标（store 里的最新值）；不存在返回 null */
  read(id: string): Goal | null;
  /** 写回目标：状态转换和轮次操作；失败返回错误说明 */
  apply(id: string, change: GoalChange): Promise<Goal | string>;
  refresh?(id: string): Promise<Goal | null>;
  /** 开始一轮：建任务、跑一轮任务；maxLlmCalls 是这一轮还能用的模型调用次数上限 */
  startRoundTask(goal: Goal, round: number, hint: string | null, maxLlmCalls: number): RoundHandle;
  /** 重启后继续同一个任务账本；返回 null 表示没有足够 checkpoint，禁止新开任务。 */
  resumeRoundTask?(goal: Goal, round: number, maxLlmCalls: number, continuation?: GoalContinuation): RoundHandle | null;
  /** 目标达成没有：决策层 checkDoneWithEvidence（先规则，再 Jev，拿不准交给用户） */
  checkDone(goal: Goal, evidence: Evidence, taskId: string, allowModel?: boolean, session?: GoalExecutionSession | null): Promise<EvidenceResult>;
  prepareRecovery?(goal: Goal): Promise<RecoveryPreparation>;
  /** 停止一轮的任务（放弃、删除目标或执行器被停掉时） */
  cancelTask(taskId: string): void;
  /** 目标状态已经切到 paused/interrupted 后，把最新任务事件同步写入可恢复 checkpoint。 */
  checkpointTask?(taskId:string,session?:GoalExecutionSession|null):Promise<void>|void;
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
  /** stop 后旧任务仍可能结算晚结果；结算结束前禁止同目标的另一条恢复循环。 */
  readonly #settling = new Set<string>();
  readonly #sessions = new Map<string, GoalExecutionSession>();
  readonly #freeProof = new Map<string, GoalQuotaPublication>();
  readonly #renewals = new Map<string, ReturnType<typeof setInterval>>();

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
   * 给界面暂停/放弃/删除用的有序停止：先 abort 当前 Agent，再等待任务账本写入 checkpoint。
   * 普通 stop 保持同步，供 runner 内部和测试使用；只有状态机需要安全恢复时才调用这个版本。
   */
  async stopAndCheckpoint(id: string): Promise<boolean> {
    const taskId = this.#currentTask.get(id);
    const session=this.#sessions.get(id)??null;
    const stopped = this.stop(id);
    if (taskId) {
      try { await this.deps.checkpointTask?.(taskId,session); }
      catch { this.deps.onError?.("无法保存任务恢复记录，请检查本地存储后继续"); }
    }
    return stopped;
  }

  /**
   * 自动多轮循环。目标不是「进行中」、上一轮在等你确认、已经在跑时直接返回。
   * 返回时目标可能已完成、已失败、已暂停、已放弃，或停在「等你确认」。
   */
  async run(id: string): Promise<void> {
    if (this.#active.has(id) || this.#settling.has(id)) return;
    const ctrl = new AbortController();
    this.#active.set(id, ctrl);
    this.#settling.add(id);
    const aborted = () => ctrl.signal.aborted;
    try {
      for (;;) {
        if (aborted()) return;
        let g = this.deps.refresh?await this.#refresh(id):this.deps.read(id);
        if (!g) return;
        // 只有「进行中且可以开下一轮」才继续：暂停、放弃、完成、失败、等你确认都停下来
        if (g.status !== "running") return;
        const owned=this.#sessions.get(id)?.publication;
        if(g.quota?.active&&g.quota.leaseUntil>(this.deps.now?.()??Date.now())&&(!owned||owned.ownerId!==g.quota.ownerId||owned.fence!==g.quota.fence)){
          this.deps.onError?.("目标仍由另一个有效执行持有，不能自动恢复或暂停该执行");
          return;
        }
        const phase = goalPhase(g);
        if (phase === "awaiting_user") return;
        const openRound = g.rounds.at(-1);
        let recoveryAccounting: RecoveryAccounting | null = null;
        let continuation: GoalContinuation | undefined;
        if ((openRound?.status === "interrupted" || openRound?.status === "running") && this.deps.prepareRecovery) {
          let pending: RecoveryPreparation;
          try { pending = await this.deps.prepareRecovery(g); }
          catch (e) {
            if(isGoalQuotaControlError(e))throw e;
            this.deps.onError?.("无法保存任务恢复记录，请检查本地存储后继续");
            await this.#apply(id, { op: "transition", to: "paused" });
            return;
          }
          if(g.quota && pending.completed){
            const proof=freeCompletedPublication(g,openRound.task_id!);
            if(!proof)throw new GoalQuotaControlError("quota_denied");
            this.#freeProof.set(id,proof);
          }
          if(pending.accounting){
            if(g.quota && !pending.completed)recoveryAccounting=pending.accounting;
            else if(!await this.#settle(id,openRound.task_id!,pending.accounting))return;
          }
          if (aborted()) return;
          g = await this.#refresh(id);
          if (!g || g.status !== "running") return;
          const currentOwner = this.#sessions.get(id)?.publication;
          if (g.quota?.active && g.quota.leaseUntil > (this.deps.now?.() ?? Date.now())
            && (!currentOwner || currentOwner.ownerId !== g.quota.ownerId || currentOwner.fence !== g.quota.fence)) {
            this.deps.onError?.("目标已由另一个有效执行持有，已停止本窗口续跑");
            return;
          }
          if (pending.completed) {
            if (g.rounds.at(-1)?.status === "interrupted" && await this.#apply(id, { op: "resume_round" }) === null) return;
            if (pending.completed.items.length && await this.#apply(id, { op: "set_round_items", items: pending.completed.items.map((i) => ({ ...i })) }) === null) return;
            if (aborted()) return;
            const latest = this.deps.read(id);
            if (!latest || latest.status !== "running") return;
            // 已有成果可规则/用户验收；未知历史开销与零余额都禁止 Jev 调用。
            const verdict = await this.#check(latest, pending.completed, !latest.quota && Boolean(pending.accounting) && latest.used_llm_calls < latest.max_llm_calls);
            if (verdict && !aborted() && this.deps.read(id)?.status === "running") await this.#apply(id, { op: "finish_round", result: verdict, evidence: pending.completed.evidence });
            return;
          }
          if (!pending.accounting) {
            if (isGoalContinuation(pending.continuation, g, this.deps.now?.() ?? Date.now())) continuation = pending.continuation;
            else {
              this.deps.onError?.(g.quota
                ? "上一轮缺少完整结算或可验证的续跑凭证，已停止续跑；请确认本地恢复记录"
                : "上一轮最终调用次数未知，已暂停；请确认本地恢复记录，不能自动分配新调用预算");
              await this.#pause(id);
              return;
            }
          }
        } else if (phase === "working") return;
        if(g.quota&&(g.quota.pending||g.quota.unknown))throw new GoalQuotaControlError("quota_outcome_unknown");
        if ((await this.#failIfExhausted(g)) !== null) return;

        const interrupted = g.rounds.at(-1)?.status === "interrupted";
        const round = interrupted ? g.rounds.length : g.rounds.length + 1;
        const hint = interrupted ? null : nextRoundHint(g);
        // 这一轮的模型调用预算：目标还剩多少就最多用多少（至少 1，运行时会按上限抛 budget_exceeded）
        const left = Math.max(1, g.max_llm_calls - g.used_llm_calls);
        let handle: RoundHandle;
        if (interrupted) {
          const last = g.rounds.at(-1);
          if (!last?.task_id || !last.task_checkpoint || !this.deps.resumeRoundTask) {
            this.deps.onError?.("上一轮缺少可验证的任务恢复记录，已暂停以避免重复执行");
            await this.#apply(id, { op: "transition", to: "paused" });
            return;
          }
          const resumed = this.deps.resumeRoundTask(g, round, left, continuation);
          if (!resumed) {
            this.deps.onError?.("原任务账本不可恢复，已暂停以避免重复执行");
            await this.#apply(id, { op: "transition", to: "paused" });
            return;
          }
          handle = resumed;
          if (continuation && handle.taskId !== last.task_id) throw new GoalQuotaControlError("quota_denied");
        } else {
          handle = this.deps.startRoundTask(g, round, hint, left);
        }
        this.#currentTask.set(id, handle.taskId);
        const session=await handle.prepare?.()??null;
        if(g.quota&&!session)throw new GoalQuotaControlError("quota_invalid_request");
        if(session){
          this.#sessions.set(id,session);
          this.#renewals.set(id,setInterval(()=>{void session.renew().catch(()=>{
            this.deps.onError?.("目标额度所有权无法确认，已停止当前执行");
            this.stop(id);
          });},60_000));
          await this.#refresh(id);
        }
        if(aborted()){this.deps.cancelTask(handle.taskId);return;}
        if(recoveryAccounting&&!await this.#settle(id,handle.taskId,recoveryAccounting))return;
        if(interrupted&&await this.#apply(id,{op:"resume_round"})===null){this.deps.cancelTask(handle.taskId);return;}
        // 先登记这一轮再等结果：写失败（例如刚被删除）就取消任务并退出
        if (!interrupted) {
          const started = await this.#apply(id, { op: "start_round", plan: { ...(hint ? { title: hint } : {}), task_id: handle.taskId } });
          if (started === null) {
            this.deps.cancelTask(handle.taskId);
            return;
          }
        }
        if (aborted() || this.deps.read(id)?.status !== "running") {
          this.deps.cancelTask(handle.taskId);
          return;
        }
        // 真实任务使用惰性句柄，确保轮次账本先于 Agent 副作用落库；测试假句柄没有该钩子。
        handle.start?.();
        const r = await handle.result;
        this.#currentTask.delete(id);
        // Main receipts remain recovery evidence. Enrolled quota was already occupied by admission.
        if(r.quotaControl){
          this.deps.onError?.(`目标调用额度无法安全继续（${r.quotaControl.code}），请检查当前执行状态`);
          if(this.deps.read(id)?.status==="running")await this.#apply(id,{op:"transition",to:"paused"});
          await this.deps.checkpointTask?.(r.taskId,this.#sessions.get(id)??null);
          if(r.accounting?.final)await this.#settle(id,r.taskId,r.accounting);
          return;
        }
        // 钱已经花了：调用次数先记上，暂停和放弃也照记。
        // 写不进去（目标被删了、状态不允许）说明这个目标已经不该由我们推进了，整个循环退出：
        // 继续转下去只会一遍遍失败
        if (r.accounting !== undefined) {
          if (!r.accounting?.final) this.deps.onError?.("这一轮最终调用次数未知，请检查本地存储后继续");
          if (!r.accounting?.final || !await this.#settle(id, r.taskId, r.accounting)) {
            if (this.deps.read(id)?.status === "running") await this.#apply(id, { op: "transition", to: "paused" });
            return;
          }
        } else if (r.llmCalls > 0 && (await this.#apply(id, { op: "record_llm_calls", count: r.llmCalls })) === null) return;
        if (aborted()) return;
        const cur = this.deps.read(id);
        // 暂停、放弃、删除：轮次已经被状态机打断，不再写判定
        if (!cur || cur.status !== "running") return;
        if (r.items.length && (await this.#apply(id, { op: "set_round_items", items: r.items.map((i) => ({ ...i })) })) === null) return;
        if (aborted()) return;

        // 只有正常跑完的一轮才问「达成没有」。执行失败保留原任务，
        // 防止已落地的副作用被下一轮的新任务身份重新执行。
        if (r.status !== "completed") {
          // 用户自己停了这一轮：把目标一起暂停，不要偷偷再开一轮
          if (r.status === "aborted") {
            await this.#apply(id, { op: "transition", to: "paused" });
            return;
          }
          // needs_user 表示权限、外部资料或副作用状态需要人工处理；不能把未知状态当成普通失败自动重跑。
          if (r.status === "needs_user") {
            this.deps.onError?.(`${FAILED_TEXT.needs_user ?? "这一轮需要你处理"}：${r.summary}`);
            await this.#apply(id, { op: "transition", to: "paused" });
            return;
          }
          if (r.status === "failed") {
            if ((await this.#apply(id, { op: "transition", to: "paused" })) === null) return;
            // The handle has settled and #currentTask is already cleared.
            // Persist this exact task directly rather than relying on stop().
            try { await this.deps.checkpointTask?.(r.taskId,this.#sessions.get(id)??null); }
            catch {
              this.deps.onError?.("无法保存任务恢复记录，请检查本地存储后继续");
              return;
            }
            this.deps.onError?.("这一轮执行出错，已暂停；继续时将恢复原任务");
            return;
          }
          if ((await this.#apply(id, { op: "fail_round", message: `${FAILED_TEXT[r.status] ?? "这一轮没有跑完"}：${r.summary}` })) === null) return;
          await this.#release(id);
          continue;
        }
        const verdict = await this.#check(cur, r, cur.used_llm_calls < cur.max_llm_calls);
        if (verdict === null || aborted() || this.deps.read(id)?.status !== "running") return;
        await this.#apply(id, { op: "finish_round", result: verdict, evidence: r.evidence });
        await this.#release(id);
      }
    } catch (e) {
      if(isGoalQuotaControlError(e)){
        this.deps.onError?.(`目标调用额度无法安全继续（${e.code}），请检查当前执行状态`);
        const task=this.#currentTask.get(id);if(task)this.deps.cancelTask(task);
        const current=await this.#refresh(id).catch(()=>null);
        if(current?.status==="running"&&(!current.quota?.active||this.#sessions.has(id)))try{await this.#apply(id,{op:"transition",to:"paused"});}catch{this.deps.onError?.("目标停止状态未能保存，请检查当前执行记录");}
      }else this.deps.onError?.(e instanceof Error ? e.message : String(e));
    } finally {
      try{await this.#release(id);}catch{this.deps.onError?.("目标调用额度停止状态无法确认，请检查本地存储");}
      this.#freeProof.delete(id);
      if (this.#active.get(id) === ctrl) this.#active.delete(id);
      this.#currentTask.delete(id);
      this.#settling.delete(id);
    }
  }

  async #refresh(id:string):Promise<Goal|null>{return this.deps.refresh?this.deps.refresh(id):this.deps.read(id);}
  /** Automatic recovery is not an explicit user pause. Without our fenced
   * publication, a fresh owner may arrive during any await, so do not revoke it. */
  async #pause(id:string):Promise<Goal|null>{
    if(this.deps.read(id)?.quota&&!this.#sessions.has(id)&&!this.#freeProof.has(id))return null;
    return this.#apply(id,{op:"transition",to:"paused"});
  }
  async #release(id:string):Promise<void>{
    const timer=this.#renewals.get(id);if(timer)clearInterval(timer);this.#renewals.delete(id);
    const session=this.#sessions.get(id);if(session)await session.release();
    if(this.#sessions.get(id)===session)this.#sessions.delete(id);
    if(session)await this.#refresh(id);
  }
  async #settle(id: string, taskId: string, a: RecoveryAccounting): Promise<boolean> {
    const settled = await this.#apply(id, { op: "record_llm_calls", count: a.llm_calls, task_id: taskId, run_id: a.run_id });
    if (settled) return true;
    if (this.deps.read(id)?.status === "running") await this.#apply(id, { op: "transition", to: "paused" });
    return false;
  }

  /** 到了失败条件就把目标判失败并停下；返回失败原因（没到条件返回 null） */
  async #failIfExhausted(g: Goal): Promise<string | null> {
    const cause = failCause(g);
    if (!cause) return null;
    await this.#apply(g.id, { op: "transition", to: "failed" });
    return FAIL_CAUSE_LABEL[cause];
  }

  /** 完成校验；出错时按「拿不准」处理，交给用户确认，不让循环崩掉 */
  async #check(g: Goal, r: RoundResult, allowModel = true): Promise<EvidenceResult | null> {
    try {
      const session=this.#sessions.get(g.id)??null;
      return await this.deps.checkDone(g,r.evidence,r.taskId,allowModel&&(!g.quota||Boolean(session)),session);
    } catch (e) {
      if(isGoalQuotaControlError(e))throw e;
      if (e && typeof e === "object" && (e as { code?: string }).code === "aborted") return null;
      const why = e instanceof Error ? e.message : String(e);
      this.deps.onError?.(`完成校验失败：${why}`);
      return { verdict: "uncertain", reason: `完成校验没能做完（${why}），请你确认`, by: "rules" };
    }
  }

  /** 写回目标；失败返回 null（目标已删除或状态不允许），并把原因交给界面 */
  async #apply(id: string, change: GoalChange): Promise<Goal | null> {
    const proof=this.#sessions.get(id)?.publication??this.#freeProof.get(id);
    if(change.op==="transition"&&(change.to==="paused"||change.to==="failed")&&this.deps.read(id)?.quota&&!proof)return null;
    const r = await this.deps.apply(id, proof?{...change,quota_publication:proof}:change);
    if (typeof r === "string") {
      if(["quota_invalid_request","quota_denied","quota_storage_unknown","quota_outcome_unknown","quota_protocol_invalid"].includes(r))throw new GoalQuotaControlError(r as GoalQuotaErrorCode);
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

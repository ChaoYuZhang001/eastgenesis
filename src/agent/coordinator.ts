// 多 Agent 协同：先把目标拆成 2–4 个互不依赖的子任务，按角色交给子 Agent 并行执行（默认最多同时 2 个），最后合并成果。
// 每个子 Agent 是完整的 AgentRuntime：独立路由、规划、工具调用、反思和纠错。需要确认的操作排队，一次只请用户处理一个。
// 子 Agent 的事件包在 { type: "subagent" } 里转发，时间线和子 Agent 面板据此展示每个子 Agent 的模型与进度。
import { redact } from "../core/redact";
import { emittingLlm } from "./llm";
import { memoryBlock } from "./memory";
import { AGENT_SYSTEM, AgentRuntime, ONBOARDING_HINT, type AgentDeps, type RunOptions } from "./runtime";
import { parseSplit, SPLIT_SYSTEM } from "./split";
import { truncate, wrapUntrusted } from "./tools";
import type { AgentEvent, Budget, ConfirmRequest, LlmCall, RunResult, RunStatus, SubAgentSpec } from "./types";

export const SUBAGENT_CONCURRENCY = 2;
/** 每个子 Agent 的预算比单 Agent 小，总量受控 */
export const SUBAGENT_BUDGET: Partial<Budget> = { maxSteps: 6, maxReplans: 1, maxLlmCalls: 15 };
const STATUS_TEXT: Record<RunStatus, string> = { completed: "已完成", failed: "失败", aborted: "已停止", needs_user: "需要用户处理", budget_exceeded: "超出预算" };

export interface CoordinatorDeps extends AgentDeps {
  /** 同时执行的子 Agent 数，默认 2 */
  concurrency?: number;
}

let seq = 0;
const newId = () => `multi-${Date.now().toString(36)}-${(++seq).toString(36)}`;

export class Coordinator {
  constructor(private readonly deps: CoordinatorDeps) {}

  async run(goal: string, opts: RunOptions = {}): Promise<RunResult> {
    const d = this.deps;
    const { signal } = opts;
    const runId = (d.idGen ?? newId)();
    const events: AgentEvent[] = [];
    const emit = (e: AgentEvent) => {
      events.push(e);
      d.onEvent?.(e);
    };
    let specs: SubAgentSpec[] = [];
    let fallback = false;
    const results: (RunResult | null)[] = [];
    const finish = (status: RunStatus, summary: string): RunResult => {
      const s = redact(summary);
      emit({ type: "run_end", status, summary: s });
      const done = results.filter((r): r is RunResult => r != null);
      const steps = specs.map((a) => ({ id: a.id, goal: `${a.role}：${a.goal}`, tool: null }));
      return { runId, status, summary: s, plan: { steps, source: fallback ? "fallback" : "llm" }, steps: done.flatMap((r) => r.steps), replans: done.reduce((n, r) => n + r.replans, 0), events };
    };

    try {
      emit({ type: "run_start", runId, goal });
      const notes = d.memories ?? [];
      if (notes.length) emit({ type: "memory", items: notes.map(({ id, kind, text }) => ({ id, kind, text })) });
      if (signal?.aborted) return finish("aborted", "任务已取消");
      const { decision: route, meta } = await d.decision.routeTask({ ...opts.route, text: goal }, signal);
      emit({ type: "route", profileId: route.primary?.profileId ?? null, reasons: route.reasons, decision: route, meta });
      if (!route.primary) return finish("failed", route.reasons.at(-1) ?? "没有可用模型");
      const llm: LlmCall = emittingLlm(d.llm(route), emit);
      const system = (base: string) => [base, memoryBlock(notes)].filter(Boolean).join("\n\n");

      const split = await llm({ purpose: "split", messages: [{ role: "system", content: system(SPLIT_SYSTEM) }, { role: "user", content: `目标：${goal}` }] }, signal);
      const parsed = parseSplit(split.text);
      fallback = parsed === null;
      specs = parsed ?? [{ id: "a1", role: "通用智能体", goal }];
      emit({ type: "split", agents: specs, ...(fallback ? { note: "拆分结果无法解析，改为单个智能体执行" } : {}) });

      // 确认排队：一次只把一个请求交给用户；取消后排队中的请求直接视为不同意
      let queue: Promise<unknown> = Promise.resolve();
      const confirmFor = (role: string) =>
        d.confirm &&
        ((req: ConfirmRequest) => {
          const next = queue.then(() => (signal?.aborted ? false : d.confirm!({ ...req, agent: role })));
          queue = next.catch(() => false);
          return next;
        });

      let cursor = 0;
      const worker = async () => {
        while (cursor < specs.length) {
          const i = cursor++;
          const spec = specs[i];
          const sub = new AgentRuntime({
            ...d,
            skills: [],
            // 对齐称呼、风格只在合并后的最终成果里问一次，子 Agent 不问
            onboarding: false,
            budget: { ...SUBAGENT_BUDGET, ...d.budget },
            idGen: () => `${runId}-${spec.id}`,
            confirm: confirmFor(spec.role),
            onEvent: (event) => emit({ type: "subagent", agent: spec.id, event }),
          });
          try {
            results[i] = await sub.run(spec.goal, { signal, route: opts.route, history: opts.history, files: opts.files });
          } catch {
            results[i] = null;
          }
        }
      };
      const width = Math.max(1, Math.min(d.concurrency ?? SUBAGENT_CONCURRENCY, specs.length));
      await Promise.all(Array.from({ length: width }, () => worker()));
      if (signal?.aborted) return finish("aborted", "任务已取消");

      const outcome = specs.map((s, i) => ({ s, r: results[i] ?? null }));
      const label = (o: (typeof outcome)[number]) => `「${o.s.role}」${o.r ? STATUS_TEXT[o.r.status] : "运行出错"}`;
      if (outcome.length === 1) return finish(outcome[0].r?.status ?? "failed", outcome[0].r?.summary ?? "运行出错");
      const ok = outcome.filter((o) => o.r?.status === "completed");
      if (ok.length === 0) {
        const st = outcome.map((o) => o.r?.status);
        const status: RunStatus = st.includes("needs_user") ? "needs_user" : st.includes("budget_exceeded") ? "budget_exceeded" : "failed";
        return finish(status, `没有子 Agent 完成：${outcome.map(label).join("；")}`);
      }

      const body = outcome.map((o) => `### ${o.s.role}（${o.r ? STATUS_TEXT[o.r.status] : "运行出错"}）\n${wrapUntrusted("subagent", truncate(o.r?.summary ?? "", 4000))}`).join("\n\n");
      let summary: string;
      try {
        const m = await llm(
          {
            purpose: "merge",
            messages: [
              { role: "system", content: system(AGENT_SYSTEM) },
              {
                role: "user",
                content: `总目标：${goal}\n\n各子 Agent 的结果：\n${body}\n\n请把这些结果合并成最终成果，用简洁的中文直接给出；没完成的子任务要说明。${d.onboarding ? `\n\n${ONBOARDING_HINT}` : ""}`,
              },
            ],
          },
          signal,
        );
        summary = m.text.trim() || "（模型没有返回合并结果）";
      } catch {
        if (signal?.aborted) return finish("aborted", "任务已取消");
        // 合并失败时直接拼接各子 Agent 的成果，不丢掉已经做完的部分
        summary = ok.map((o) => `【${o.s.role}】\n${o.r!.summary}`).join("\n\n");
      }
      const missing = outcome.filter((o) => o.r?.status !== "completed");
      if (missing.length) summary += `\n\n未完成的子任务：${missing.map(label).join("；")}`;
      return finish("completed", summary);
    } catch (e) {
      if (signal?.aborted) return finish("aborted", "任务已取消");
      return finish("failed", `运行出错：${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

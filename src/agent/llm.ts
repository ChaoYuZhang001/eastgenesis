// 把路由结果变成运行时用的模型调用：每次调用都沿降级链执行（超时先重试一次，限流、出错时换下一个模型）。
import type { LLMProvider } from "../core/llm/types";
import type { HealthTracker } from "../decision/health";
import { modelName } from "../decision/profiles";
import { RouteExhaustedError, attemptText, executeWithFallback, type Attempt, type ChainEntry, type FallbackOptions, type RouteDecision } from "../decision/router";
import type { AgentEvent, LlmCall, LlmFallback, LlmPurpose, LlmReply } from "./types";

/** 模型调用的时间线事件；运行时和协调器共用，降级记录不会在其中一处漏掉 */
export function llmEvent(purpose: LlmPurpose, r: LlmReply): Extract<AgentEvent, { type: "llm" }> {
  const e = { type: "llm" as const, purpose, profileId: r.profileId, latencyMs: r.latencyMs, usage: r.usage };
  return {
    ...e,
    ...(r.fallbacks?.length ? { fallbacks: r.fallbacks } : {}),
    ...(r.retries ? { retries: r.retries } : {}),
    ...(r.reasoning ? { reasoning: r.reasoning } : {}),
  };
}

/** 一次没用上的尝试：中文原因 + 错误码（界面据此标「因超时降级」） */
const fallbackOf = (a: Attempt): LlmFallback => ({ profileId: a.profileId, reason: attemptText(a), ...(a.errorCode ? { code: a.errorCode } : {}) });

/** 整条降级链都失败时的事件；其他错误（用户取消等）返回 null，由调用方原样抛出 */
export function llmFailedEvent(purpose: LlmPurpose, err: unknown): Extract<AgentEvent, { type: "llm_failed" }> | null {
  if (!(err instanceof RouteExhaustedError)) return null;
  const retries = err.attempts.filter((a) => a.action === "retry").length;
  const attempts = err.attempts.filter((a) => a.action !== "retry").map(fallbackOf);
  return { type: "llm_failed", purpose, attempts, ...(retries ? { retries } : {}) };
}

/** 包一层：成功发 llm 事件，整条链失败发 llm_failed 事件后原样抛出 */
export function emittingLlm(call: LlmCall, emit: (e: AgentEvent) => void): LlmCall {
  return async (req, signal) => {
    try {
      const r = await call(req, signal);
      emit(llmEvent(req.purpose, r));
      return r;
    } catch (e) {
      const ev = llmFailedEvent(req.purpose, e);
      if (ev) emit(ev);
      throw e;
    }
  };
}

export function routedLlm(
  route: RouteDecision,
  providerFor: (e: ChainEntry) => Promise<LLMProvider>,
  health?: HealthTracker,
  opts: Pick<FallbackOptions, "sleep"> = {},
): LlmCall {
  return async (req, signal) => {
    const { result, entry, attempts } = await executeWithFallback(
      route.chain,
      async (e) => {
        const p = await providerFor(e);
        return p.chat({ model: modelName({ id: e.profileId, provider: e.provider }), messages: req.messages, maxTokens: req.maxTokens, signal });
      },
      { health, signal, sleep: opts.sleep },
    );
    const reply: LlmReply = {
      text: result.text,
      profileId: entry.profileId,
      latencyMs: result.latencyMs,
      usage: result.usage,
      ...(result.reasoning ? { reasoning: result.reasoning } : {}),
    };
    // 换过模型要让用户看到：先试了谁、为什么没用上。超时重试的中间记录不算换模型，单独计数
    const fallbacks = attempts.filter((a) => !a.ok && a.action !== "retry").map(fallbackOf);
    const retries = attempts.filter((a) => a.action === "retry").length;
    return { ...reply, ...(fallbacks.length ? { fallbacks } : {}), ...(retries ? { retries } : {}) };
  };
}

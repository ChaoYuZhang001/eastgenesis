import { isGoalQuotaControlError } from "../core/goal-quota";
// 把路由结果变成运行时用的模型调用：每次调用都沿降级链执行（超时先重试一次，限流、出错时换下一个模型）。
import { ProviderError } from "../core/llm/errors";
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

/**
 * 静态路由准入之外的最后一道运行时保险。旧的测试 Provider 可以不声明
 * recovery（按历史行为继续运行），但一旦声明，就不能只声明一半能力。
 */
function recoveryContractReady(p: LLMProvider): boolean {
  const c = p.capabilities?.recovery;
  if (!c) return true;
  return c.abortSignal && c.partialOutput && c.normalizedErrors && (!p.capabilities.streaming || c.streamTerminal !== false);
}

/** 调用失败或提前安全停止时的事件；用户取消等其他错误返回 null，由调用方原样抛出。 */
export function llmFailedEvent(purpose: LlmPurpose, err: unknown): Extract<AgentEvent, { type: "llm_failed" }> | null {
  if (!(err instanceof RouteExhaustedError)) return null;
  const retries = err.attempts.filter((a) => a.action === "retry").length;
  const attempts = err.attempts.filter((a) => a.action !== "retry").map(fallbackOf);
  return { type: "llm_failed", purpose, attempts, ...(retries ? { retries } : {}), ...(err.partialOutput ? { partialOutput: true } : {}) };
}

/** 包一层：成功发 llm 事件，失败或安全停止发 llm_failed 事件后原样抛出。 */
export function emittingLlm(call: LlmCall, emit: (e: AgentEvent) => void): LlmCall {
  return async (req, signal) => {
    // 只对最终回答和总结开启流式。规划、工具参数和反思仍然等完整 JSON，避免
    // 把结构化输出的半截内容暴露到用户界面。
    const streamable = req.purpose === "answer" || req.purpose === "summary";
    const request = streamable
      ? {
          ...req,
          onDelta: (delta: { text: string; profileId: string }) => {
            emit({ type: "llm_delta", purpose: req.purpose, profileId: delta.profileId, text: delta.text });
            req.onDelta?.(delta);
          },
        }
      : req;
    try {
      const r = await call(request, signal);
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
  opts: Pick<FallbackOptions, "sleep" | "stopOnUnknownOutcome"> = {},
): LlmCall {
  return async (req, signal) => {
    const { result, entry, attempts } = await executeWithFallback(
      route.chain,
      async (e) => {
        const p = await providerFor(e);
        if (!recoveryContractReady(p)) {
          throw new ProviderError("config", e.provider, { detail: "适配器缺少可恢复执行契约" });
        }
        const model = modelName({ id: e.profileId, provider: e.provider });
        // Provider 可以声明暂不支持 SSE；保持模型调用可用，退回完整响应而不是把能力缺口当成路由失败。
        if (!req.onDelta || p.capabilities?.streaming === false) return p.chat({ model, messages: req.messages, maxTokens: req.maxTokens, signal });

        let emitted = false;
        try {
          let response: Awaited<ReturnType<LLMProvider["chat"]>> | null = null;
          for await (const ev of p.stream({ model, messages: req.messages, maxTokens: req.maxTokens, signal })) {
            if (ev.type === "delta") {
              if (!ev.text) continue;
              emitted = true;
              req.onDelta({ text: ev.text, profileId: e.profileId });
            } else {
              response = ev.response;
            }
          }
          if (!response) throw new ProviderError("invalid_response", e.provider, { detail: "流式响应没有结束事件", partialOutput: emitted });
          return response;
        } catch (err) {
          if (isGoalQuotaControlError(err)) throw err;
          // 已经把正文交给 UI 后不能静默换模型，否则用户会看到两段不同模型的半截答案。
          // 仍然沿用统一错误码，但把 partialOutput 传给策略层让它停止降级链。
          if (!emitted) throw err;
          if (err instanceof ProviderError) {
            throw new ProviderError(err.code, e.provider, {
              ...(err.status !== null ? { status: err.status } : {}),
              ...(err.detail ? { detail: err.detail } : {}),
              message: err.message,
              partialOutput: true,
            });
          }
          throw new ProviderError("network", e.provider, { detail: String(err), partialOutput: true });
        }
      },
      { health, signal, sleep: opts.sleep, stopOnUnknownOutcome: opts.stopOnUnknownOutcome },
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

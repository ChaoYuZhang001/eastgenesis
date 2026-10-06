// Anthropic Messages API 适配器。system 消息单独放在顶层 system 字段；max_tokens 必填。
import { ProviderError } from "./errors";
import type { ProviderErrorCode } from "./errors";
import { DEFAULT_LLM_TIMEOUT_MS, postJson, readJson, readSse, type HttpOptions } from "./http";
import type { ChatRequest, ChatResponse, FetchLike, FinishReason, LLMProvider, StreamEvent, Usage } from "./types";

export const ANTHROPIC_BASE_URL = "https://api.anthropic.com/v1";
export const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MAX_TOKENS = 4096;

interface AnthropicBody {
  model?: string;
  content?: { type: string; text?: string }[];
  stop_reason?: string | null;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export interface AnthropicProviderInit {
  id?: string;
  label?: string;
  baseUrl?: string;
  apiKey: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  fetch?: FetchLike;
  now?: () => number;
}

export class AnthropicProvider implements LLMProvider {
  readonly id: string;
  readonly kind = "anthropic" as const;
  readonly label: string;
  readonly capabilities = {
    streaming: true,
    systemPrompt: true,
    recovery: {
      abortSignal: true,
      streamTerminal: "message_stop" as const,
      partialOutput: true,
      normalizedErrors: true,
    },
  };
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #headers: Record<string, string>;
  readonly #http: HttpOptions;
  readonly #now: () => number;

  constructor(init: AnthropicProviderInit) {
    this.id = init.id ?? "anthropic";
    this.label = init.label ?? "Anthropic";
    this.#apiKey = init.apiKey;
    this.#baseUrl = (init.baseUrl ?? ANTHROPIC_BASE_URL).replace(/\/+$/, "");
    this.#headers = init.headers ?? {};
    this.#now = init.now ?? Date.now;
    this.#http = {
      providerId: this.id,
      fetch: init.fetch ?? ((u, i) => fetch(u, i)),
      timeoutMs: init.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS,
      secrets: [init.apiKey],
    };
  }

  #auth() {
    return { ...this.#headers, "x-api-key": this.#apiKey, "anthropic-version": ANTHROPIC_VERSION };
  }

  #body(req: ChatRequest, stream: boolean) {
    const system = req.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
    const messages = req.messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role, content: m.content }));
    if (messages.length === 0) throw new ProviderError("bad_request", this.id, { detail: "至少需要一条 user 消息" });
    return {
      model: req.model,
      max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
      messages,
      ...(system && { system }),
      ...(req.temperature !== undefined && { temperature: req.temperature }),
      ...(stream && { stream: true }),
    };
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const t0 = this.#now();
    const res = await postJson(`${this.#baseUrl}/messages`, this.#auth(), this.#body(req, false), this.#http, req.signal);
    const body = await readJson<AnthropicBody>(res, this.id);
    if (!Array.isArray(body.content)) throw new ProviderError("invalid_response", this.id, { detail: "缺少 content" });
    return {
      providerId: this.id,
      model: body.model ?? req.model,
      text: body.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join(""),
      usage: body.usage ? { inputTokens: body.usage.input_tokens ?? 0, outputTokens: body.usage.output_tokens ?? 0 } : null,
      finishReason: toFinish(body.stop_reason),
      latencyMs: this.#now() - t0,
    };
  }

  async *stream(req: ChatRequest): AsyncGenerator<StreamEvent> {
    const t0 = this.#now();
    const res = await postJson(`${this.#baseUrl}/messages`, this.#auth(), this.#body(req, true), this.#http, req.signal);
    let text = "";
    let model = req.model;
    const usage: Usage = { inputTokens: 0, outputTokens: 0 };
    let sawUsage = false;
    let finish: FinishReason = "other";
    let sawMessageStop = false;
    try {
      for await (const ev of readSse(res, this.id)) {
        let data: any;
        try {
          data = JSON.parse(ev.data);
        } catch {
          throw new ProviderError("invalid_response", this.id, {
            detail: "SSE 数据不是合法 JSON",
            partialOutput: text.length > 0,
            secrets: [this.#apiKey],
          });
        }
        switch (data.type) {
          case "message_start":
            if (data.message?.model) model = data.message.model;
            if (data.message?.usage) {
              usage.inputTokens = data.message.usage.input_tokens ?? 0;
              usage.outputTokens = data.message.usage.output_tokens ?? 0;
              sawUsage = true;
            }
            break;
          case "content_block_delta":
            if (data.delta?.type === "text_delta" && data.delta.text) {
              text += data.delta.text;
              yield { type: "delta", text: data.delta.text };
            }
            break;
          case "message_delta":
            if (data.delta?.stop_reason) finish = toFinish(data.delta.stop_reason);
            if (data.usage?.output_tokens !== undefined) {
              usage.outputTokens = data.usage.output_tokens;
              sawUsage = true;
            }
            break;
          case "message_stop":
            sawMessageStop = true;
            break;
          case "error":
            throw new ProviderError(anthropicStreamErrorCode(data.error?.type), this.id, {
              detail: data.error?.message ?? "流中出现错误事件",
              partialOutput: text.length > 0,
              secrets: [this.#apiKey],
            });
        }
      }
    } catch (error) {
      if (error instanceof ProviderError && text.length > 0 && !error.partialOutput) {
        throw new ProviderError(error.code, this.id, {
          ...(error.status === null ? {} : { status: error.status }),
          ...(error.detail ? { detail: error.detail } : {}),
          partialOutput: true,
          secrets: [this.#apiKey],
        });
      }
      throw error;
    }
    if (!sawMessageStop) {
      throw new ProviderError("invalid_response", this.id, {
        detail: "Anthropic 流式响应缺少 message_stop 结束事件",
        partialOutput: text.length > 0,
        secrets: [this.#apiKey],
      });
    }
    yield {
      type: "done",
      response: { providerId: this.id, model, text, usage: sawUsage ? usage : null, finishReason: finish, latencyMs: this.#now() - t0 },
    };
  }
}

function anthropicStreamErrorCode(type: string | undefined): ProviderErrorCode {
  const value = (type ?? "").toLowerCase();
  if (value.includes("auth") || value.includes("permission")) return "auth";
  if (value.includes("billing")) return "billing";
  if (value.includes("rate_limit")) return "rate_limit";
  if (value.includes("overloaded") || value.includes("api_error")) return "server";
  if (value.includes("timeout")) return "timeout";
  if (value.includes("not_found")) return "not_found";
  if (value.includes("invalid_request") || value.includes("request_too_large") || value.includes("conflict")) return "bad_request";
  return "invalid_response";
}

function toFinish(r: string | null | undefined): FinishReason {
  if (r === "end_turn" || r === "stop_sequence") return "stop";
  if (r === "max_tokens") return "length";
  return "other";
}

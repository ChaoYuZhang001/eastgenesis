// OpenAI Chat Completions 适配器。openai-compatible（中转站、兼容端点）复用同一实现，只换 baseUrl 和 kind。
import { ProviderError } from "./errors";
import { DEFAULT_LLM_TIMEOUT_MS, postJson, readJson, readSse, type HttpOptions } from "./http";
import type { RequestQuirks } from "./official";
import { MAX_REASONING_CHARS } from "./types";
import type {
  ChatRequest,
  ChatResponse,
  FetchLike,
  FinishReason,
  LLMProvider,
  ProviderKind,
  StreamEvent,
  Usage,
} from "./types";

export const OPENAI_BASE_URL = "https://api.openai.com/v1";

/** 兼容端点的思考过程字段：DeepSeek 用 reasoning_content，部分中转站用 reasoning */
interface OpenAIMessagePart {
  content?: string | null;
  reasoning_content?: string | null;
  reasoning?: string | null;
}
interface OpenAIChoice {
  message?: OpenAIMessagePart;
  delta?: OpenAIMessagePart;
  finish_reason?: string | null;
}

const reasoningOf = (m: OpenAIMessagePart | undefined): string => {
  const r = m?.reasoning_content ?? m?.reasoning;
  return typeof r === "string" ? r : "";
};
/** 有思考过程才带 reasoning 字段；超长截断 */
const withReasoning = (r: string) => (r.trim() ? { reasoning: r.length > MAX_REASONING_CHARS ? `${r.slice(0, MAX_REASONING_CHARS)}…（已截断）` : r } : {});
interface OpenAIBody {
  model?: string;
  choices?: OpenAIChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
}

export interface OpenAIProviderInit {
  id: string;
  kind?: Extract<ProviderKind, "openai" | "openai-compatible">;
  label?: string;
  baseUrl?: string;
  apiKey: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  fetch?: FetchLike;
  now?: () => number;
  /** 各家兼容端点的差异，见 official.ts */
  quirks?: RequestQuirks;
}

export class OpenAIProvider implements LLMProvider {
  readonly id: string;
  readonly kind: Extract<ProviderKind, "openai" | "openai-compatible">;
  readonly label: string;
  readonly capabilities = { streaming: true, systemPrompt: true };
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #headers: Record<string, string>;
  readonly #http: HttpOptions;
  readonly #now: () => number;
  readonly #quirks: RequestQuirks;

  constructor(init: OpenAIProviderInit) {
    this.id = init.id;
    this.kind = init.kind ?? "openai";
    this.label = init.label ?? (this.kind === "openai" ? "OpenAI" : init.id);
    this.#apiKey = init.apiKey;
    this.#baseUrl = (init.baseUrl ?? OPENAI_BASE_URL).replace(/\/+$/, "");
    this.#headers = init.headers ?? {};
    this.#quirks = init.quirks ?? {};
    this.#now = init.now ?? Date.now;
    this.#http = {
      providerId: init.id,
      fetch: init.fetch ?? ((u, i) => fetch(u, i)),
      timeoutMs: init.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS,
      secrets: [init.apiKey],
    };
  }

  #body(req: ChatRequest, stream: boolean) {
    const q = this.#quirks;
    return {
      model: req.model,
      messages: req.messages,
      ...(req.temperature !== undefined && !q.omitTemperature && { temperature: req.temperature }),
      ...(req.maxTokens !== undefined && { [q.maxTokensParam ?? "max_tokens"]: req.maxTokens }),
      ...(stream && { stream: true, ...(q.streamUsage !== false && { stream_options: { include_usage: true } }) }),
    };
  }

  /** Key 为空（本机 Ollama）时不发鉴权头 */
  #auth(): Record<string, string> {
    return this.#apiKey ? { ...this.#headers, authorization: `Bearer ${this.#apiKey}` } : { ...this.#headers };
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const t0 = this.#now();
    const res = await postJson(`${this.#baseUrl}/chat/completions`, this.#auth(), this.#body(req, false), this.#http, req.signal);
    const body = await readJson<OpenAIBody>(res, this.id);
    const choice = body.choices?.[0];
    if (!choice) throw new ProviderError("invalid_response", this.id, { detail: "choices 为空" });
    return {
      providerId: this.id,
      model: body.model ?? req.model,
      text: choice.message?.content ?? "",
      usage: toUsage(body.usage),
      finishReason: toFinish(choice.finish_reason),
      latencyMs: this.#now() - t0,
      ...withReasoning(reasoningOf(choice.message)),
    };
  }

  async *stream(req: ChatRequest): AsyncGenerator<StreamEvent> {
    const t0 = this.#now();
    const res = await postJson(`${this.#baseUrl}/chat/completions`, this.#auth(), this.#body(req, true), this.#http, req.signal);
    let text = "";
    // 思考过程只累积到最终响应里，不作为增量推给调用方：增量只有正文
    let reasoning = "";
    let model = req.model;
    let usage: Usage | null = null;
    let finish: FinishReason = "other";
    for await (const ev of readSse(res, this.id)) {
      if (ev.data === "[DONE]") break;
      let chunk: OpenAIBody;
      try {
        chunk = JSON.parse(ev.data) as OpenAIBody;
      } catch {
        throw new ProviderError("invalid_response", this.id, { detail: "SSE 数据不是合法 JSON" });
      }
      if (chunk.model) model = chunk.model;
      if (chunk.usage) usage = toUsage(chunk.usage);
      const c = chunk.choices?.[0];
      if (c?.finish_reason) finish = toFinish(c.finish_reason);
      if (reasoning.length <= MAX_REASONING_CHARS) reasoning += reasoningOf(c?.delta);
      const delta = c?.delta?.content;
      if (delta) {
        text += delta;
        yield { type: "delta", text: delta };
      }
    }
    yield {
      type: "done",
      response: { providerId: this.id, model, text, usage, finishReason: finish, latencyMs: this.#now() - t0, ...withReasoning(reasoning) },
    };
  }
}

function toUsage(u: OpenAIBody["usage"]): Usage | null {
  if (!u) return null;
  return { inputTokens: u.prompt_tokens ?? 0, outputTokens: u.completion_tokens ?? 0 };
}

function toFinish(r: string | null | undefined): FinishReason {
  if (r === "stop") return "stop";
  if (r === "length") return "length";
  return "other";
}

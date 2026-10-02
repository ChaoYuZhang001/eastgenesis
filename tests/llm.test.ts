// @vitest-environment node
import { AnthropicProvider, DEFAULT_LLM_TIMEOUT_MS, OpenAIProvider, ProviderError, createProvider, validateBaseUrl, validateHeaders } from "@/core/llm";
import { MAX_REASONING_CHARS } from "@/core/llm/types";
import type { FetchLike } from "@/core/llm";
import { EnvSecretSource, parseSecretRef } from "@/core/secrets";
import { redact } from "@/core/redact";

const KEY = "sk-test-0123456789abcdefghij";

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: any;
}

/** 假 fetch：记录请求，返回给定响应 */
function fakeFetch(make: () => Response): { fetch: FetchLike; calls: Captured[] } {
  const calls: Captured[] = [];
  const f: FetchLike = async (url, init) => {
    calls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    return make();
  };
  return { fetch: f, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** 把 SSE 文本切成任意大小的块，验证跨块解析 */
function sse(text: string, chunk = 7): Response {
  const bytes = new TextEncoder().encode(text);
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < bytes.length; i += chunk) c.enqueue(bytes.slice(i, i + chunk));
      c.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

let tick = 0;
const now = () => (tick += 100);

describe("OpenAIProvider", () => {
  it("chat：请求格式、鉴权头与响应映射", async () => {
    const { fetch, calls } = fakeFetch(() =>
      json({ model: "gpt-4o-mini-2024", choices: [{ message: { content: "你好" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2 } }),
    );
    const p = new OpenAIProvider({ id: "openai", apiKey: KEY, fetch, now });
    const r = await p.chat({ model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }], maxTokens: 10 });
    expect(calls[0].url).toBe("https://api.openai.com/v1/chat/completions");
    expect(calls[0].headers.authorization).toBe(`Bearer ${KEY}`);
    expect(calls[0].body).toEqual({ model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }], max_tokens: 10 });
    expect(r).toMatchObject({ providerId: "openai", model: "gpt-4o-mini-2024", text: "你好", finishReason: "stop", usage: { inputTokens: 5, outputTokens: 2 } });
    expect(r.latencyMs).toBe(100);
  });

  it("思考过程：reasoning_content / reasoning 单独放进 reasoning，不混进正文；没有时不带字段", async () => {
    const reply = (message: Record<string, unknown>) => fakeFetch(() => json({ choices: [{ message, finish_reason: "stop" }] })).fetch;
    const ask = (fetch: FetchLike) => new OpenAIProvider({ id: "openai", apiKey: KEY, fetch, now }).chat({ model: "m", messages: [{ role: "user", content: "hi" }] });
    const r1 = await ask(reply({ content: "答案", reasoning_content: "先想" }));
    expect(r1).toMatchObject({ text: "答案", reasoning: "先想" });
    expect((await ask(reply({ content: "答案", reasoning: "另一种字段" }))).reasoning).toBe("另一种字段");
    expect(await ask(reply({ content: "答案" }))).not.toHaveProperty("reasoning");
    expect(await ask(reply({ content: "答案", reasoning_content: "  " }))).not.toHaveProperty("reasoning");
    const long = await ask(reply({ content: "答案", reasoning_content: "长".repeat(MAX_REASONING_CHARS + 5) }));
    expect(long.reasoning).toBe(`${"长".repeat(MAX_REASONING_CHARS)}…（已截断）`);
  });

  it("stream：思考过程的增量只汇总进 reasoning，不作为正文增量发出", async () => {
    const body =
      'data: {"choices":[{"delta":{"reasoning_content":"想"}}]}\n\n' +
      'data: {"choices":[{"delta":{"reasoning_content":"一想"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"好"},"finish_reason":"stop"}]}\n\n' +
      "data: [DONE]\n\n";
    const { fetch } = fakeFetch(() => sse(body, 9));
    const p = new OpenAIProvider({ id: "openai", apiKey: KEY, fetch, now });
    const deltas: string[] = [];
    let done;
    for await (const ev of p.stream({ model: "m", messages: [{ role: "user", content: "hi" }] })) {
      if (ev.type === "delta") deltas.push(ev.text);
      else done = ev.response;
    }
    expect(deltas).toEqual(["好"]);
    expect(done).toMatchObject({ text: "好", reasoning: "想一想" });
  });

  it("默认超时 90 秒", () => {
    expect(DEFAULT_LLM_TIMEOUT_MS).toBe(90_000);
  });

  it("stream：跨块解析 SSE，汇总文本与用量", async () => {
    const body =
      'data: {"model":"m1","choices":[{"delta":{"content":"你"}}]}\n\n' +
      ": keep-alive\n\n" +
      'data: {"choices":[{"delta":{"content":"好"},"finish_reason":"stop"}]}\r\n\r\n' +
      'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n' +
      "data: [DONE]\n\n";
    const { fetch, calls } = fakeFetch(() => sse(body, 5));
    const p = new OpenAIProvider({ id: "openai", apiKey: KEY, fetch, now });
    const deltas: string[] = [];
    let done;
    for await (const ev of p.stream({ model: "m", messages: [{ role: "user", content: "hi" }] })) {
      if (ev.type === "delta") deltas.push(ev.text);
      else done = ev.response;
    }
    expect(calls[0].body.stream).toBe(true);
    expect(calls[0].body.stream_options).toEqual({ include_usage: true });
    expect(deltas).toEqual(["你", "好"]);
    expect(done).toMatchObject({ text: "你好", model: "m1", finishReason: "stop", usage: { inputTokens: 3, outputTokens: 2 } });
  });
});

describe("AnthropicProvider", () => {
  it("chat：system 提到顶层、默认 max_tokens、版本头", async () => {
    const { fetch, calls } = fakeFetch(() =>
      json({ model: "claude-x", content: [{ type: "text", text: "好的" }], stop_reason: "end_turn", usage: { input_tokens: 9, output_tokens: 1 } }),
    );
    const p = new AnthropicProvider({ apiKey: KEY, fetch, now });
    const r = await p.chat({
      model: "claude-x",
      messages: [
        { role: "system", content: "简洁" },
        { role: "user", content: "hi" },
      ],
    });
    expect(calls[0].url).toBe("https://api.anthropic.com/v1/messages");
    expect(calls[0].headers["x-api-key"]).toBe(KEY);
    expect(calls[0].headers["anthropic-version"]).toBe("2023-06-01");
    expect(calls[0].headers.authorization).toBeUndefined();
    expect(calls[0].body).toEqual({ model: "claude-x", max_tokens: 4096, system: "简洁", messages: [{ role: "user", content: "hi" }] });
    expect(r).toMatchObject({ text: "好的", finishReason: "stop", usage: { inputTokens: 9, outputTokens: 1 } });
  });

  it("stream：处理 message_start / content_block_delta / message_delta", async () => {
    const ev = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify({ type, ...(data as object) })}\n\n`;
    const body =
      ev("message_start", { message: { model: "claude-y", usage: { input_tokens: 4, output_tokens: 1 } } }) +
      ev("content_block_start", { index: 0 }) +
      ev("content_block_delta", { delta: { type: "text_delta", text: "Hel" } }) +
      ev("ping", {}) +
      ev("content_block_delta", { delta: { type: "text_delta", text: "lo" } }) +
      ev("message_delta", { delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 6 } }) +
      ev("message_stop", {});
    const { fetch } = fakeFetch(() => sse(body, 11));
    const p = new AnthropicProvider({ apiKey: KEY, fetch, now });
    let text = "";
    let done;
    for await (const e of p.stream({ model: "c", messages: [{ role: "user", content: "hi" }] })) {
      if (e.type === "delta") text += e.text;
      else done = e.response;
    }
    expect(text).toBe("Hello");
    expect(done).toMatchObject({ model: "claude-y", finishReason: "length", usage: { inputTokens: 4, outputTokens: 6 } });
  });

  it("没有 user 消息时报 bad_request，不发请求", async () => {
    const { fetch, calls } = fakeFetch(() => json({}));
    const p = new AnthropicProvider({ apiKey: KEY, fetch });
    await expect(p.chat({ model: "c", messages: [{ role: "system", content: "x" }] })).rejects.toMatchObject({ code: "bad_request" });
    expect(calls).toHaveLength(0);
  });
});

describe("错误映射与脱敏", () => {
  it.each([
    [401, "auth", false],
    [403, "auth", false],
    [404, "not_found", false],
    [429, "rate_limit", true],
    [500, "server", true],
    [400, "bad_request", false],
  ] as const)("HTTP %i → %s（retryable=%s）", async (status, code, retryable) => {
    const { fetch } = fakeFetch(() => json({ error: { message: "x" } }, status));
    const p = new OpenAIProvider({ id: "openai", apiKey: KEY, fetch });
    const e = await p.chat({ model: "m", messages: [{ role: "user", content: "hi" }] }).catch((x) => x);
    expect(e).toBeInstanceOf(ProviderError);
    expect(e.code).toBe(code);
    expect(e.retryable).toBe(retryable);
    expect(e.status).toBe(status);
  });

  it("服务端回显 Key 时，错误细节里不出现 Key", async () => {
    const { fetch } = fakeFetch(() => json({ error: { message: `Incorrect API key provided: ${KEY}` } }, 401));
    const p = new OpenAIProvider({ id: "openai", apiKey: KEY, fetch });
    const e: ProviderError = await p.chat({ model: "m", messages: [{ role: "user", content: "hi" }] }).catch((x) => x);
    expect(e.detail).not.toContain(KEY);
    expect(JSON.stringify(e.toAppError())).not.toContain(KEY);
    expect(e.toAppError().code).toBe("provider_auth");
  });

  it("超时映射为 timeout", async () => {
    const hang: FetchLike = (_u, init) =>
      new Promise((_r, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    const p = new OpenAIProvider({ id: "openai", apiKey: KEY, fetch: hang, timeoutMs: 20 });
    await expect(p.chat({ model: "m", messages: [{ role: "user", content: "hi" }] })).rejects.toMatchObject({ code: "timeout", retryable: true });
  });

  it("调用方取消映射为 aborted", async () => {
    const hang: FetchLike = (_u, init) =>
      new Promise((_r, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    const p = new OpenAIProvider({ id: "openai", apiKey: KEY, fetch: hang });
    const ctrl = new AbortController();
    const pending = p.chat({ model: "m", messages: [{ role: "user", content: "hi" }], signal: ctrl.signal });
    ctrl.abort();
    await expect(pending).rejects.toMatchObject({ code: "aborted" });
  });

  it("redact 覆盖常见格式", () => {
    expect(redact("Authorization: Bearer abc.def")).toBe("Authorization: Bearer [REDACTED]");
    expect(redact(`key ${KEY}`)).toBe("key [REDACTED]");
    expect(redact('{"api_key":"abc123"}')).toBe('{"api_key":"[REDACTED]"}');
    expect(redact("x-api-key: zzz")).toBe("x-api-key: [REDACTED]");
    expect(redact("model gpt-4o-mini 超时")).toBe("model gpt-4o-mini 超时");
  });
});

describe("registry 与自定义 Provider", () => {
  const env = new EnvSecretSource({ OPENAI_API_KEY: KEY, RELAY_KEY: "relay-secret-value" });

  it("openai-compatible：使用自定义 baseUrl 和附加头", async () => {
    const { fetch, calls } = fakeFetch(() => json({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }));
    const p = await createProvider(
      { id: "custom:relay", kind: "openai-compatible", baseUrl: "https://relay.example.com/v1/", apiKeyRef: "env:RELAY_KEY", headers: { "X-Org": "eg" } },
      env,
      { fetch },
    );
    expect(p.kind).toBe("openai-compatible");
    await p.chat({ model: "m", messages: [{ role: "user", content: "hi" }] });
    expect(calls[0].url).toBe("https://relay.example.com/v1/chat/completions");
    expect(calls[0].headers["x-org"]).toBe("eg");
    expect(calls[0].headers.authorization).toBe("Bearer relay-secret-value");
  });

  it("缺少 Key 时提示环境变量名，不泄露其他信息", async () => {
    const e = await createProvider({ id: "anthropic", kind: "anthropic", apiKeyRef: "env:ANTHROPIC_API_KEY" }, env).catch((x) => x);
    expect(e).toMatchObject({ code: "auth" });
    expect(e.message).toContain("ANTHROPIC_API_KEY");
  });

  it("兼容端点必须填 baseUrl", async () => {
    await expect(createProvider({ id: "custom:x", kind: "openai-compatible", apiKeyRef: "env:RELAY_KEY" }, env)).rejects.toMatchObject({ code: "config" });
  });

  it("非法 Provider ID 被拒绝", async () => {
    await expect(createProvider({ id: "Evil ID", kind: "openai", apiKeyRef: "env:OPENAI_API_KEY" }, env)).rejects.toMatchObject({ code: "config" });
  });

  it("baseUrl 校验：https、本机 http、禁止账号密码和查询参数", () => {
    expect(validateBaseUrl("https://relay.example.com/v1/", "t")).toBe("https://relay.example.com/v1");
    expect(validateBaseUrl("http://localhost:11434/v1", "t")).toBe("http://localhost:11434/v1");
    expect(() => validateBaseUrl("http://relay.example.com/v1", "t")).toThrow(/https/);
    expect(() => validateBaseUrl("https://u:p@relay.example.com", "t")).toThrow(/账号/);
    expect(() => validateBaseUrl("https://relay.example.com/v1?key=1", "t")).toThrow(/查询/);
    expect(() => validateBaseUrl("not a url", "t")).toThrow(/合法/);
  });

  it("附加头不能覆盖鉴权头，不能含换行", () => {
    expect(() => validateHeaders({ Authorization: "x" }, "t")).toThrow(/覆盖/);
    expect(() => validateHeaders({ "x-api-key": "x" }, "t")).toThrow(/覆盖/);
    expect(() => validateHeaders({ "x-a": "a\r\nb" }, "t")).toThrow(/换行/);
    expect(validateHeaders({ "X-Org": "eg" }, "t")).toEqual({ "x-org": "eg" });
  });

  it("密钥引用：env 与 keychain 分命名空间，错误信息不回显输入", () => {
    expect(parseSecretRef("env:OPENAI_API_KEY")).toEqual({ scheme: "env", name: "OPENAI_API_KEY" });
    expect(parseSecretRef("keychain:provider/openai")).toEqual({ scheme: "keychain", account: "provider/openai" });
    expect(parseSecretRef("keychain:jev")).toEqual({ scheme: "keychain", account: "jev" });
    expect(() => parseSecretRef("keychain:other")).toThrow();
    let msg = "";
    try {
      parseSecretRef(KEY);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).not.toContain(KEY);
  });
});

// @vitest-environment node
// 本地回环服务：验证真实 fetch/HTTP 链路与 Anthropic Messages 协议的恢复语义。
// 这不是供应商 SLA 测试，也不使用任何真实凭据。
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AnthropicProvider } from "@/core/llm/anthropic";
import { ProviderError } from "@/core/llm/errors";
import type { ChatResponse } from "@/core/llm/types";
import { RouteExhaustedError, type ChainEntry, type RouteDecision } from "@/decision/router";
import { routedLlm } from "@/agent/llm";

const MESSAGES = [
  { role: "system" as const, content: "简洁" },
  { role: "user" as const, content: "回环测试" },
];
const KEY = "sk-anthropic-loopback-test";

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => (body += chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(body) as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

function event(type: string, payload: Record<string, unknown> = {}): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
}

function sendSse(res: ServerResponse, chunks: string[], delayMs = 5): void {
  let index = 0;
  const next = () => {
    if (index >= chunks.length) {
      res.end();
      return;
    }
    res.write(chunks[index++]);
    setTimeout(next, delayMs);
  };
  next();
}

let server: Server;
let baseUrl = "";
let lastRequest: { body: Record<string, unknown>; headers: { apiKey?: string | string[]; version?: string | string[] } } | null = null;

beforeAll(async () => {
  server = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/messages") {
      sendJson(res, 404, { error: { message: "path not found" } });
      return;
    }
    const body = await readBody(req);
    lastRequest = {
      body,
      headers: { apiKey: req.headers["x-api-key"], version: req.headers["anthropic-version"] },
    };
    const model = typeof body.model === "string" ? body.model : "";
    if (model === "auth") return sendJson(res, 401, { error: { message: `invalid key ${KEY}` } });
    if (model === "rate") return sendJson(res, 429, { error: { message: "slow down" } });
    if (model === "server") return sendJson(res, 503, { error: { message: "temporarily unavailable" } });
    if (model === "chat") {
      return sendJson(res, 200, {
        model: "claude-loopback",
        content: [{ type: "text", text: "好的" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 4, output_tokens: 1 },
      });
    }
    if (model === "stream") {
      res.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
      sendSse(res, [
        event("message_start", { message: { model: "claude-loopback", usage: { input_tokens: 4, output_tokens: 1 } } }),
        event("content_block_start", { index: 0 }),
        event("content_block_delta", { delta: { type: "text_delta", text: "你" } }),
        event("content_block_delta", { delta: { type: "text_delta", text: "好" } }),
        event("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }),
        event("message_stop"),
      ]);
      return;
    }
    if (model === "truncated") {
      res.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
      sendSse(res, [
        event("message_start", { message: { model: "claude-loopback" } }),
        event("content_block_delta", { delta: { type: "text_delta", text: "半截" } }),
      ]);
      return;
    }
    if (model === "stream-error") {
      res.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
      sendSse(res, [
        event("message_start", { message: { model: "claude-loopback" } }),
        event("content_block_delta", { delta: { type: "text_delta", text: "已输出" } }),
        event("error", { error: { type: "overloaded_error", message: `provider key ${KEY}` } }),
      ]);
      return;
    }
    sendJson(res, 400, { error: { message: "unknown model" } });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

const provider = (id = "anthropic") => new AnthropicProvider({ id, baseUrl, apiKey: KEY, timeoutMs: 500 });

const chainEntry = (profileId: string, stage: ChainEntry["stage"]): ChainEntry => ({
  profileId,
  provider: profileId.split("/")[0]!,
  stage,
  score: 1,
  breakdown: { capability: 1, quality: 1, cost: 1, latency: 1, availability: 1, total: 1 },
  reason: "回环恢复测试",
});

describe("Anthropic Provider 本地回环 HTTP 证据", () => {
  it("真实 fetch 发送 Messages 请求，保留 system 顶层字段并解析完整响应", async () => {
    const response = await provider().chat({ model: "chat", messages: MESSAGES });
    expect(response).toMatchObject<Partial<ChatResponse>>({
      providerId: "anthropic",
      model: "claude-loopback",
      text: "好的",
      usage: { inputTokens: 4, outputTokens: 1 },
      finishReason: "stop",
    });
    expect(lastRequest?.headers).toEqual({ apiKey: KEY, version: "2023-06-01" });
    expect(lastRequest?.body).toMatchObject({
      model: "chat",
      max_tokens: 4096,
      system: "简洁",
      messages: [{ role: "user", content: "回环测试" }],
    });
  });

  it.each([
    ["auth", "auth", 401],
    ["rate", "rate_limit", 429],
    ["server", "server", 503],
  ] as const)("HTTP %s 映射成 %s，并脱敏响应中的密钥", async (model, code, status) => {
    const error: ProviderError = await provider().chat({ model, messages: MESSAGES }).catch((value) => value);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.code).toBe(code);
    expect(error.status).toBe(status);
    expect(error.detail).not.toContain(KEY);
  });

  it("真实 HTTP SSE 分块经 message_stop 正常结束，并产出增量和完整响应", async () => {
    const deltas: string[] = [];
    let done: ChatResponse | null = null;
    for await (const streamEvent of provider().stream({ model: "stream", messages: MESSAGES })) {
      if (streamEvent.type === "delta") deltas.push(streamEvent.text);
      else done = streamEvent.response;
    }
    expect(deltas).toEqual(["你", "好"]);
    expect(done).toMatchObject({
      providerId: "anthropic",
      model: "claude-loopback",
      text: "你好",
      usage: { inputTokens: 4, outputTokens: 2 },
      finishReason: "stop",
    });
  });

  it("真实 HTTP SSE 缺少 message_stop 时判定为截断，并保留部分输出标记", async () => {
    const iterator = provider().stream({ model: "truncated", messages: MESSAGES })[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: "delta", text: "半截" }, done: false });
    await expect(iterator.next()).rejects.toMatchObject({ code: "invalid_response", partialOutput: true });
  });

  it("真实 HTTP SSE 中途错误归一化为可恢复错误，并保留部分输出但不泄漏密钥", async () => {
    const iterator = provider().stream({ model: "stream-error", messages: MESSAGES })[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: "delta", text: "已输出" }, done: false });
    const error: ProviderError = await iterator.next().catch((value) => value);
    expect(error).toMatchObject({ code: "server", partialOutput: true });
    expect(error.detail).not.toContain(KEY);
  });

  it("生产 routedLlm 遇到 Anthropic 部分输出时停止链路，不拼接第二个模型", async () => {
    const first = chainEntry("anthropic/stream-error", "primary");
    const second = chainEntry("anthropic/stream", "fallback");
    const route = {
      classification: { type: "qa", capabilities: [], lang: "zh", estTokens: 1, confidence: 1, signals: [], surface: "chat", surfaceReason: "回环" },
      primary: first,
      chain: [first, second],
      weights: { capability: 1, quality: 1, cost: 1, latency: 1 },
      reasons: [],
      excluded: [],
    } as RouteDecision;
    const calls: string[] = [];
    const deltas: string[] = [];
    const call = routedLlm(
      route,
      async (entry) => {
        calls.push(entry.profileId);
        return provider(entry.profileId === first.profileId ? "anthropic-first" : "anthropic-second");
      },
      undefined,
      { sleep: async () => {} },
    );
    const error: RouteExhaustedError = await call({ purpose: "answer", messages: MESSAGES, onDelta: (delta) => deltas.push(delta.text) }).catch((value) => value);
    expect(error).toBeInstanceOf(RouteExhaustedError);
    expect(error.partialOutput).toBe(true);
    expect(calls).toEqual([first.profileId]);
    expect(deltas).toEqual(["已输出"]);
    expect(error.attempts).toMatchObject([{ profileId: first.profileId, action: "stop", partialOutput: true }]);
  });
});

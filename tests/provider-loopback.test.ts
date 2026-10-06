// @vitest-environment node
// 本地回环服务：验证真实 fetch/HTTP 链路与 ProviderError、降级执行器的边界。
// 这不是供应商 SLA 测试，也不使用任何真实凭据。
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ProviderError } from "@/core/llm/errors";
import { OpenAIProvider } from "@/core/llm/openai";
import type { ChatResponse } from "@/core/llm/types";
import { executeWithFallback, type ChainEntry } from "@/decision/router";

const MESSAGES = [{ role: "user" as const, content: "回环测试" }];
const KEY = "sk-loopback-test";

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => (body += chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(body) as Record<string, unknown>);
      } catch (e) {
        reject(e);
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

let server: Server;
let baseUrl = "";
const seenModels: string[] = [];

beforeAll(async () => {
  server = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      sendJson(res, 404, { error: { message: "path not found" } });
      return;
    }
    const body = await readBody(req);
    const model = typeof body.model === "string" ? body.model : "";
    seenModels.push(model);
    if (body.stream === true && model === "stream") {
      res.writeHead(200, { "content-type": "text/event-stream", connection: "keep-alive" });
      const chunks = [
        'data: {"model":"stream","choices":[{"delta":{"content":"你"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"好"},"finish_reason":"stop"}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":2,"completion_tokens":2}}\n\n',
        "data: [DONE]\n\n",
      ];
      let i = 0;
      const sendNext = () => {
        if (i >= chunks.length) {
          res.end();
          return;
        }
        res.write(chunks[i++]);
        setTimeout(sendNext, 5);
      };
      sendNext();
      return;
    }
    if (model === "auth") return sendJson(res, 401, { error: { message: `invalid key ${KEY}` } });
    if (model === "missing") return sendJson(res, 404, { error: { message: "model not found" } });
    if (model === "rate") return sendJson(res, 429, { error: { message: "slow down" } });
    if (model === "server") return sendJson(res, 503, { error: { message: "temporarily unavailable" } });
    if (model === "bad") return sendJson(res, 400, { error: { message: "invalid request" } });
    if (model === "invalid-json") {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end("not-json");
      return;
    }
    if (model === "slow") {
      setTimeout(() => {
        if (!res.destroyed) sendJson(res, 200, { model, choices: [{ message: { content: "慢响应" }, finish_reason: "stop" }] });
      }, 80);
      return;
    }
    sendJson(res, 200, { model, choices: [{ message: { content: `ok:${model}` }, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 1 } });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

const provider = (id: string, timeoutMs = 500) => new OpenAIProvider({ id, baseUrl, apiKey: KEY, timeoutMs });
const entry = (id: string): ChainEntry => {
  const [providerId, model] = id.split("/");
  return {
    profileId: id,
    provider: providerId,
    stage: "fallback",
    score: 0,
    breakdown: { capability: 0, quality: 0, cost: 0, latency: 0, availability: 1, total: 0 },
    reason: model,
  };
};

describe("Provider 本地回环 HTTP 证据", () => {
  it.each([
    ["auth", "auth", 401],
    ["missing", "not_found", 404],
    ["rate", "rate_limit", 429],
    ["server", "server", 503],
    ["bad", "bad_request", 400],
  ] as const)("HTTP %s 映射成 %s，并保留状态码", async (model, code, status) => {
    const error: ProviderError = await provider("loopback").chat({ model, messages: MESSAGES }).catch((e) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.code).toBe(code);
    expect(error.status).toBe(status);
    expect(error.detail).not.toContain(KEY);
  });

  it("真实 fetch 超时映射成 timeout，调用方取消映射成 aborted", async () => {
    const timeout: ProviderError = await provider("loopback", 15).chat({ model: "slow", messages: MESSAGES }).catch((e) => e);
    expect(timeout).toMatchObject({ code: "timeout", retryable: true });

    const ctrl = new AbortController();
    const pending = provider("loopback", 500).chat({ model: "slow", messages: MESSAGES, signal: ctrl.signal });
    ctrl.abort();
    await expect(pending).rejects.toMatchObject({ code: "aborted" });
  });

  it("合法 HTTP 200 但响应不是 JSON，映射成 invalid_response", async () => {
    await expect(provider("loopback").chat({ model: "invalid-json", messages: MESSAGES })).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("真实 HTTP 限流后换 Provider，并保留调用顺序", async () => {
    seenModels.length = 0;
    const providers = new Map([
      ["a", provider("a")],
      ["b", provider("b")],
    ]);
    const result = await executeWithFallback(
      [entry("a/rate"), entry("b/ok")],
      async (e) => (await providers.get(e.provider)!.chat({ model: e.profileId.split("/")[1]!, messages: MESSAGES })).text,
      { sleep: async () => {} },
    );
    expect(result.result).toBe("ok:ok");
    expect(result.attempts.map((a) => a.action)).toEqual(["next", "done"]);
    expect(seenModels.slice(-2)).toEqual(["rate", "ok"]);
  });

  it("真实 HTTP SSE 分块经 OpenAI 适配器产出增量和完整响应", async () => {
    const deltas: string[] = [];
    let done: ChatResponse | null = null;
    for await (const event of provider("loopback").stream({ model: "stream", messages: MESSAGES })) {
      if (event.type === "delta") deltas.push(event.text);
      else done = event.response;
    }
    expect(deltas).toEqual(["你", "好"]);
    expect(done).toMatchObject({ model: "stream", text: "你好", usage: { inputTokens: 2, outputTokens: 2 }, finishReason: "stop" });
  });

  it("鉴权失败后跳过同 Provider 的后续模型，再尝试其他 Provider", async () => {
    seenModels.length = 0;
    const providers = new Map([
      ["a", provider("a")],
      ["b", provider("b")],
    ]);
    const result = await executeWithFallback(
      [entry("a/auth"), entry("a/after-auth"), entry("b/ok")],
      async (e) => (await providers.get(e.provider)!.chat({ model: e.profileId.split("/")[1]!, messages: MESSAGES })).text,
    );
    expect(result.result).toBe("ok:ok");
    expect(result.attempts.map((a) => a.action)).toEqual(["skip_provider", "skipped", "done"]);
    expect(seenModels.slice(-2)).toEqual(["auth", "ok"]);
  });
});

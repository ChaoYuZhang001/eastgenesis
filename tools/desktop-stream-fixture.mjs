#!/usr/bin/env node
// 本地桌面流式验收夹具：不读取凭据、不访问外网，只模拟几个可重复的
// OpenAI-compatible HTTP 响应。把自定义 Provider base URL 指向
// http://127.0.0.1:<port>/<scenario>/v1 即可。
import { createServer } from "node:http";

const host = "127.0.0.1";
const port = Number(process.env.EG_FIXTURE_PORT ?? 17891);
const chunkDelay = Math.max(1, Number(process.env.EG_FIXTURE_CHUNK_DELAY_MS ?? 40));
const scenarios = new Set(["staged", "slow-first-token", "truncated", "no-terminal", "error", "idle", "auth", "rate-limit", "billing", "not-found", "bad-request"]);

const json = (value) => JSON.stringify(value);
const sse = (text) => `data: ${json({ choices: [{ delta: { content: text } }] })}\n\n`;
const done = "data: [DONE]\n\n";
const anthropicEvent = (type, payload = {}) => `event: ${type}\ndata: ${json({ type, ...payload })}\n\n`;
const headers = { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" };

function sendModels(res) {
  const body = json({ data: [{ id: "fixture-model" }] });
  res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

function sendError(res, status = 503, message = "fixture upstream unavailable", type = "server_error") {
  const body = json({ error: { message, type } });
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

const failure = {
  auth: [401, "fixture authentication failed", "invalid_api_key"],
  "rate-limit": [429, "fixture rate limit", "rate_limit_error"],
  billing: [402, "fixture billing unavailable", "billing_error"],
  "not-found": [404, "fixture model not found", "model_not_found"],
  "bad-request": [400, "fixture bad request", "invalid_request_error"],
};

function sendTruncated(res) {
  const body = sse("已经收到一部分");
  res.writeHead(200, { ...headers, "content-length": Buffer.byteLength(body) + 64 });
  res.end(body);
}

function sendNoTerminal(res) {
  // 正常 EOF，但不发送 OpenAI [DONE]；用于区别协议终态缺失和传输层半截。
  res.writeHead(200, headers);
  res.end(sse("已经收到一部分"));
}

function sendIdle(res) {
  res.writeHead(200, headers);
  res.flushHeaders?.();
  const timer = setTimeout(() => {
    res.write(sse("等待结束"));
    res.end(done);
  }, 120_000);
  res.on("close", () => clearTimeout(timer));
}

function sendStaged(res, initialDelay) {
  res.writeHead(200, headers);
  res.flushHeaders?.();
  const chunks = [sse("第一段"), sse("第二段"), done];
  let i = 0;
  let timer;
  const sendNext = () => {
    if (i >= chunks.length || res.destroyed) {
      if (!res.destroyed) res.end();
      return;
    }
    res.write(chunks[i++]);
    timer = setTimeout(sendNext, chunkDelay);
  };
  timer = setTimeout(sendNext, initialDelay);
  res.on("close", () => clearTimeout(timer));
}

function sendAnthropicStaged(res, initialDelay) {
  res.writeHead(200, headers);
  res.flushHeaders?.();
  const chunks = [
    anthropicEvent("message_start", { message: { model: "fixture-model", usage: { input_tokens: 2, output_tokens: 0 } } }),
    anthropicEvent("content_block_delta", { delta: { type: "text_delta", text: "第一段" } }),
    anthropicEvent("content_block_delta", { delta: { type: "text_delta", text: "第二段" } }),
    anthropicEvent("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }),
    anthropicEvent("message_stop"),
  ];
  let i = 0;
  let timer;
  const sendNext = () => {
    if (i >= chunks.length || res.destroyed) {
      if (!res.destroyed) res.end();
      return;
    }
    res.write(chunks[i++]);
    timer = setTimeout(sendNext, chunkDelay);
  };
  timer = setTimeout(sendNext, initialDelay);
  res.on("close", () => clearTimeout(timer));
}

function sendAnthropicTruncated(res) {
  const body =
    anthropicEvent("message_start", { message: { model: "fixture-model" } }) +
    anthropicEvent("content_block_delta", { delta: { type: "text_delta", text: "已经收到一部分" } });
  res.writeHead(200, { ...headers, "content-length": Buffer.byteLength(body) + 64 });
  res.end(body);
}

function sendAnthropicNoTerminal(res) {
  const body =
    anthropicEvent("message_start", { message: { model: "fixture-model" } }) +
    anthropicEvent("content_block_delta", { delta: { type: "text_delta", text: "已经收到一部分" } });
  res.writeHead(200, headers);
  res.end(body);
}

function sendAnthropicIdle(res) {
  res.writeHead(200, headers);
  res.flushHeaders?.();
  const timer = setTimeout(() => {
    res.write(anthropicEvent("content_block_delta", { delta: { type: "text_delta", text: "等待结束" } }));
    res.end(anthropicEvent("message_stop"));
  }, 120_000);
  res.on("close", () => clearTimeout(timer));
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${host}:${port}`);
  const match = url.pathname.match(/^\/([^/]+)\/v1(?:\/models|\/chat\/completions|\/messages)$/);
  if (!match || !scenarios.has(match[1])) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(json({ error: { message: "unknown fixture path" } }));
    return;
  }
  const scenario = match[1];
  req.resume();
  req.once("end", () => {
    if (url.pathname.endsWith("/models")) return sendModels(res);
    if (url.pathname.endsWith("/messages")) {
      if (scenario === "error") return sendError(res);
      if (failure[scenario]) return sendError(res, ...failure[scenario]);
      if (scenario === "truncated") return sendAnthropicTruncated(res);
      if (scenario === "no-terminal") return sendAnthropicNoTerminal(res);
      if (scenario === "idle") return sendAnthropicIdle(res);
      return sendAnthropicStaged(res, scenario === "slow-first-token" ? 300 : 40);
    }
    if (scenario === "error") return sendError(res);
    if (failure[scenario]) return sendError(res, ...failure[scenario]);
    if (scenario === "truncated") return sendTruncated(res);
    if (scenario === "no-terminal") return sendNoTerminal(res);
    if (scenario === "idle") return sendIdle(res);
    sendStaged(res, scenario === "slow-first-token" ? 300 : 40);
  });
});

server.listen(port, host, () => {
  console.log(`desktop-stream-fixture listening on http://${host}:${port}`);
  console.log(`scenarios: ${[...scenarios].map((s) => `/${s}/v1`).join(" ")}`);
});

const close = () => server.close(() => process.exit(0));
process.on("SIGINT", close);
process.on("SIGTERM", close);

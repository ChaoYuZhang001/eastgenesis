#!/usr/bin/env node
// 本地流式夹具的无凭据烟测。它只验证 HTTP 场景是否按约定返回，
// 不启动 Tauri，也不把结果当成真实供应商或 webview 证据。
import { spawn } from "node:child_process";

const jsonOutput = process.argv.includes("--json");
const port = 18_000 + Math.floor(Math.random() * 1_000);
const base = `http://127.0.0.1:${port}`;
const fixture = spawn(process.execPath, ["tools/desktop-stream-fixture.mjs"], {
  env: { ...process.env, EG_FIXTURE_PORT: String(port) },
  stdio: ["ignore", "pipe", "inherit"],
});

let output = "";
fixture.stdout.setEncoding("utf8");
fixture.stdout.on("data", (chunk) => { output += chunk; });

const waitForFixture = async () => {
  const deadline = Date.now() + 5_000;
  while (!output.includes("desktop-stream-fixture listening")) {
    if (fixture.exitCode !== null) throw new Error(`fixture exited with ${fixture.exitCode}`);
    if (Date.now() >= deadline) throw new Error("fixture did not start within 5 seconds");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

const read = async (scenario, signal, endpoint = "chat/completions") => {
  const startedAt = performance.now();
  const response = await fetch(`${base}/${scenario}/v1/${endpoint}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ stream: true, model: "fixture-model" }),
    signal,
  });
  const headersAt = performance.now();
  const reader = response.body?.getReader();
  const chunks = [];
  let error = null;
  if (reader) {
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        chunks.push(Buffer.from(next.value));
      }
    } catch (cause) {
      error = cause;
    } finally {
      reader.releaseLock();
    }
  }
  return {
    status: response.status,
    body: Buffer.concat(chunks).toString("utf8"),
    error,
    headersMs: Math.round((headersAt - startedAt) * 100) / 100,
    durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
  };
};

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

try {
  await waitForFixture();
  const evidence = [];
  const check = (protocol, scenario, endpoint, result, assertions) => {
    const passed = Object.values(assertions).every(Boolean);
    evidence.push({
      protocol,
      scenario,
      endpoint,
      status: result.status,
      headersMs: result.headersMs,
      durationMs: result.durationMs,
      bodyBytes: Buffer.byteLength(result.body),
      errorName: result.error?.name ?? null,
      assertions,
      passed,
    });
    assert(passed, `${protocol} ${scenario} assertion failed: ${Object.entries(assertions).filter(([, ok]) => !ok).map(([name]) => name).join(", ")}`);
  };

  const staged = await read("staged");
  check("openai", "staged", "/chat/completions", staged, {
    status200: staged.status === 200,
    firstChunk: staged.body.includes("第一段"),
    secondChunk: staged.body.includes("第二段"),
    terminal: staged.body.includes("[DONE]"),
  });

  const slow = await read("slow-first-token");
  check("openai", "slow-first-token", "/chat/completions", slow, {
    status200: slow.status === 200,
    firstChunk: slow.body.includes("第一段"),
    delayedHeadersToBody: slow.durationMs >= 250,
  });

  const truncated = await read("truncated");
  check("openai", "truncated", "/chat/completions", truncated, {
    status200: truncated.status === 200,
    partialChunk: truncated.body.includes("已经收到一部分"),
    missingTerminal: !truncated.body.includes("[DONE]"),
  });

  const anthropicStaged = await read("staged", undefined, "messages");
  check("anthropic", "staged", "/messages", anthropicStaged, {
    status200: anthropicStaged.status === 200,
    firstChunk: anthropicStaged.body.includes("第一段"),
    secondChunk: anthropicStaged.body.includes("第二段"),
    terminal: anthropicStaged.body.includes("message_stop"),
  });

  const anthropicTruncated = await read("truncated", undefined, "messages");
  check("anthropic", "truncated", "/messages", anthropicTruncated, {
    status200: anthropicTruncated.status === 200,
    partialChunk: anthropicTruncated.body.includes("已经收到一部分"),
    missingTerminal: !anthropicTruncated.body.includes("message_stop"),
  });

  const failed = await read("error");
  check("openai", "error", "/chat/completions", failed, {
    status503: failed.status === 503,
    errorBody: failed.body.includes("fixture upstream unavailable"),
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 150);
  try {
    const idle = await read("idle", controller.signal);
    check("openai", "idle", "/chat/completions", idle, {
      status200: idle.status === 200,
      cancelled: idle.error?.name === "AbortError",
    });
  } finally {
    clearTimeout(timer);
  }

  if (jsonOutput) {
    console.log(JSON.stringify({ schemaVersion: 1, fixture: "desktop-stream-fixture", base, generatedAt: new Date().toISOString(), scenarios: evidence }, null, 2));
  } else {
    console.log("desktop stream fixture smoke passed: OpenAI staged/slow/truncated/503/idle + Anthropic staged/truncated");
  }
} finally {
  fixture.kill("SIGTERM");
  await new Promise((resolve) => fixture.once("exit", resolve));
}

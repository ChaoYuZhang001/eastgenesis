// @vitest-environment node
// --real execution is exercised only against an owned synthetic loopback server.
// These checks prove client budgets, never real Provider availability or billing.
import { execFile, type ExecFileException } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import type { Socket } from "node:net";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const primaryKey = "synthetic-budget-primary-key";
const fallbackKey = "synthetic-budget-fallback-key";
const model = "synthetic-budget-private-model";
const bodyMarker = "synthetic-budget-private-response-body";

interface CapturedRequest {
  path: string;
  body: Record<string, unknown>;
}

async function endpoint(handler?: (request: IncomingMessage, response: ServerResponse, captured: CapturedRequest[]) => void) {
  const captured: CapturedRequest[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      captured.push({ path: request.url ?? "", body: JSON.parse(body) });
      if (handler) { handler(request, response, captured); return; }
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (request.url?.endsWith("/messages")) {
        response.end([
          `data: ${JSON.stringify({ type: "message_start", message: { model } })}\n\n`,
          `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: bodyMarker } })}\n\n`,
          `data: ${JSON.stringify({ type: "message_stop" })}\n\n`,
        ].join(""));
      } else {
        response.end(`data: ${JSON.stringify({ model, choices: [{ delta: { content: bodyMarker } }] })}\n\ndata: [DONE]\n\n`);
      }
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolveReady) => server.listen(0, "127.0.0.1", resolveReady));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("loopback fixture missing address");
  return {
    base: `http://127.0.0.1:${address.port}`,
    captured,
    close: async () => {
      // Stop accepting first. Undici can open a replacement idle connection
      // after aborting a response; it may not yet be an HTTP request when
      // closeAllConnections is called. Destroy only this fixture's sockets.
      const closed = new Promise<void>((resolveClosed, reject) => {
        const timer = setTimeout(() => reject(new Error("loopback_fixture_cleanup_timeout")), 2000);
        server.close(() => { clearTimeout(timer); resolveClosed(); });
      });
      server.closeAllConnections();
      for (const socket of sockets) socket.destroy();
      await closed;
    },
  };
}

function environment(base: string, fallbackProtocol?: "openai" | "anthropic"): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("EG_MATRIX_")));
  Object.assign(env, {
    EG_MATRIX_PROTOCOL: "openai", EG_MATRIX_BASE_URL: `${base}/primary`,
    EG_MATRIX_API_KEY: primaryKey, EG_MATRIX_MODEL: model,
  });
  if (fallbackProtocol) Object.assign(env, {
    EG_MATRIX_FALLBACK_PROTOCOL: fallbackProtocol, EG_MATRIX_FALLBACK_BASE_URL: `${base}/fallback`,
    EG_MATRIX_FALLBACK_API_KEY: fallbackKey, EG_MATRIX_FALLBACK_MODEL: model,
  });
  return env;
}

const diagnosticPhases = new Set([
  "main_started", "real_configured", "real_stream_started", "real_stream_finished",
  "request_started", "request_headers", "request_failed", "request_aborted", "request_blocked",
  "fixture_starting", "fixture_ready", "fixture_stopping", "fixture_stopped",
  "recovery_fallback_started", "recovery_fallback_finished", "recovery_partial_started", "recovery_partial_finished",
  "report_ready", "report_written", "setup_failed",
]);

async function matrix(args: string[], env: NodeJS.ProcessEnv, timeoutMs = 20_000, fixtureState?: () => { capturedRequests: number; responseBodyClosed: boolean; responseBodyCloseElapsedMs?: number | null }, diagnostics = false, gcPressure = false) {
  const startedAt = Date.now();
  const matrixEnv = { ...env };
  delete matrixEnv.EG_MATRIX_DIAGNOSTICS;
  if (diagnostics) matrixEnv.EG_MATRIX_DIAGNOSTICS = "1";
  const childArgs = gcPressure
    ? ["--expose-gc", "--import", "tsx", "--input-type=module", "--eval", "process.argv.splice(1, 0, 'tools/provider-matrix.ts'); setInterval(() => global.gc(), 35).unref(); await import('./tools/provider-matrix.ts');", "--", "--json", ...args]
    : [resolve("node_modules/tsx/dist/cli.mjs"), "tools/provider-matrix.ts", "--json", ...args];
  const result = await execFileAsync(process.execPath, childArgs, {
    env: matrixEnv, maxBuffer: 2 * 1024 * 1024, timeout: timeoutMs,
  }).then((value) => ({ ...value, code: 0 as number | string | undefined, killed: false, signal: null as string | null })).catch((error: ExecFileException & { stdout: string; stderr: string }) => ({
    stdout: error.stdout ?? "", stderr: error.stderr ?? "", code: error.code, killed: error.killed === true, signal: error.signal ?? null,
  }));
  const phases: { phase: string; elapsedMs: number; requestsStarted: number; requestsBlocked: number }[] = [];
  const remainingStderr = result.stderr.split(/\r?\n/).filter((line) => {
    if (!line) return false;
    const match = /^matrix-phase:([a-z_]+):(\d+):(\d+):(\d+)$/.exec(line);
    if (!match || !diagnosticPhases.has(match[1])) return true;
    phases.push({ phase: match[1], elapsedMs: Number(match[2]), requestsStarted: Number(match[3]), requestsBlocked: Number(match[4]) });
    return false;
  });
  const failure = (reason: "empty_stdout" | "invalid_json" | "unexpected_stderr" | "killed") => new Error(`matrix_subprocess_failed:${JSON.stringify({
    reason, code: typeof result.code === "number" ? result.code : ["ENOENT", "EACCES", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"].includes(result.code ?? "") ? result.code : "unknown",
    killed: result.killed, signal: ["SIGTERM", "SIGKILL", "SIGINT"].includes(result.signal ?? "") ? result.signal : null,
    stdoutBytes: Buffer.byteLength(result.stdout), stderrBytes: Buffer.byteLength(result.stderr), deadlineMs: timeoutMs, elapsedMs: Date.now() - startedAt,
    phases, ...fixtureState?.(),
  })}`);
  // The ordinary harness must exercise the uninstrumented fetch/abort path.
  // Do not silently accept phase output when diagnostics were disabled.
  if (remainingStderr.length || (!diagnostics && result.stderr.length)) throw failure("unexpected_stderr");
  if (result.killed) throw failure("killed");
  if (!result.stdout.trim()) throw failure("empty_stdout");
  for (const sensitive of [primaryKey, fallbackKey, model, bodyMarker, env.EG_MATRIX_BASE_URL, env.EG_MATRIX_FALLBACK_BASE_URL]) {
    if (sensitive) {
      expect(result.stdout).not.toContain(sensitive);
      expect(result.stderr).not.toContain(sensitive);
    }
  }
  let report;
  try { report = JSON.parse(result.stdout); }
  catch { throw failure("invalid_json"); }
  return { code: result.code, report };
}

describe("opt-in Provider matrix client budgets using synthetic loopback only", () => {
  it("defaults to three shared requests and 128 requested tokens across both protocols and recovery", async () => {
    const fixture = await endpoint();
    try {
      const { code, report } = await matrix(["--real"], environment(fixture.base, "anthropic"));
      expect(code).toBe(0);
      expect(report).toMatchObject({
        mode: "real_opt_in", executionTarget: "loopback_only", passed: true, recoveryStatus: "partial",
        budget: { requestLimit: 3, maxOutputTokensPerRequest: 128, requestTimeoutMs: 10000, requestsStarted: 3, requestsBlocked: 0, requestsRemaining: 0, outputTokenLimitEnforcement: "request_parameter", includesRoutedRetries: true, redirectsAllowed: false },
      });
      expect(fixture.captured).toHaveLength(3);
      expect(fixture.captured.map((entry) => entry.body.max_tokens)).toEqual([128, 128, 128]);
      expect(fixture.captured.map((entry) => entry.path)).toEqual(["/primary/chat/completions", "/fallback/messages", "/fallback/messages"]);
      expect(report.evidenceBoundary.excluded).toContain("executionTarget 为 loopback_only 时不包含任何真实 Provider 证据");
    } finally { await fixture.close(); }
  }, 20_000);

  it("refuses the next request before dispatch when a smaller budget is exhausted", async () => {
    const fixture = await endpoint();
    try {
      const { code, report } = await matrix(["--real", "--real-request-budget", "1", "--real-max-output-tokens", "19"], environment(fixture.base, "openai"));
      expect(code).toBe(1);
      expect(report).toMatchObject({ passed: false, budget: { requestLimit: 1, requestsStarted: 1, requestsRemaining: 0 } });
      expect(report.budget.requestsBlocked).toBeGreaterThan(0);
      expect(report.scenarios[1].actual.code).toBe("request_budget_exhausted");
      expect(fixture.captured).toHaveLength(1);
      expect(fixture.captured[0].body.max_tokens).toBe(19);
    } finally { await fixture.close(); }
  }, 20_000);

  it.each([["disabled", false], ["enabled", false], ["disabled with forced GC", true]] as const)("counts routed timeout retries against the same budget and aborts the response body (diagnostics %s)", async (diagnostics, gcPressure) => {
    let responseBodyClosed = false;
    let responseBodyCloseElapsedMs: number | null = null;
    const fixture = await endpoint((_request, response, captured) => {
      if (captured.length >= 3) {
        // Send headers and keep a body open. Timeout must cover body reading,
        // and a router retry must be refused before a fourth request arrives.
        response.writeHead(200, { "content-type": "text/event-stream" });
        const bodyStartedAt = Date.now();
        response.once("close", () => { responseBodyClosed = true; responseBodyCloseElapsedMs = Date.now() - bodyStartedAt; });
        response.flushHeaders();
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n');
    });
    try {
      const { code, report } = await matrix(["--real", "--real-request-budget", "3", "--real-max-output-tokens", "23", "--real-timeout-ms", "250"], environment(fixture.base, "openai"), 8000, () => ({ capturedRequests: fixture.captured.length, responseBodyClosed, responseBodyCloseElapsedMs }), diagnostics === "enabled", gcPressure);
      expect(code).toBe(1);
      expect(report).toMatchObject({ passed: false, budget: { requestLimit: 3, requestTimeoutMs: 250, requestsStarted: 3, requestsBlocked: 1 } });
      expect(fixture.captured).toHaveLength(3);
      expect(fixture.captured.map((entry) => entry.body.max_tokens)).toEqual([23, 23, 23]);
      expect(report.recovery[0]).toMatchObject({ passed: false, calls: 3 });
      expect(responseBodyClosed).toBe(true);
      expect(typeof responseBodyCloseElapsedMs).toBe("number");
      expect(responseBodyCloseElapsedMs).toBeLessThan(4000);
    } finally { await fixture.close(); }
  }, 20_000);

  it("does not follow an HTTP redirect outside the request counter", async () => {
    const fixture = await endpoint((_request, response) => {
      response.writeHead(307, { location: "/redirect-target" });
      response.end();
    });
    try {
      const { code, report } = await matrix(["--real", "--real-request-budget", "1"], environment(fixture.base));
      expect(code).toBe(1);
      expect(report).toMatchObject({ passed: false, budget: { requestsStarted: 1, redirectsAllowed: false } });
      expect(fixture.captured).toHaveLength(1);
      expect(fixture.captured[0].path).toBe("/primary/chat/completions");
    } finally { await fixture.close(); }
  }, 20_000);

  it("retains the output cap with the explicitly configured modern OpenAI parameter", async () => {
    const fixture = await endpoint();
    try {
      const env = environment(fixture.base);
      env.EG_MATRIX_MAX_TOKENS_PARAM = "max_completion_tokens";
      const { code } = await matrix(["--real", "--real-max-output-tokens", "31"], env);
      expect(code).toBe(0);
      expect(fixture.captured[0].body.max_completion_tokens).toBe(31);
      expect(fixture.captured[0].body).not.toHaveProperty("max_tokens");
    } finally { await fixture.close(); }
  }, 20_000);

  it.each([
    ["--real-request-budget", "0"], ["--real-request-budget", "9"],
    ["--real-request-budget", "1.5"], ["--real-max-output-tokens", "1025"],
    ["--real-timeout-ms", "30001"], ["--real-request-budget", "private-invalid-value"],
  ])("rejects unsafe budget %s before any dispatch", async (name, value) => {
    const fixture = await endpoint();
    try {
      const { code, report } = await matrix(["--real", name, value], environment(fixture.base));
      expect(code).toBe(1);
      expect(report).toMatchObject({ passed: false, errors: ["real_budget_argument_invalid"] });
      expect(fixture.captured).toHaveLength(0);
      expect(JSON.stringify(report)).not.toContain(value);
    } finally { await fixture.close(); }
  }, 20_000);

  it("keeps the ordinary local matrix at 15 scenarios and four recovery contracts", async () => {
    const { code, report } = await matrix([], environment("http://127.0.0.1:1"), 55_000);
    expect(code).toBe(0);
    expect(report).toMatchObject({ mode: "local_fixture", passed: true, recoveryStatus: "passed" });
    expect(report.scenarios).toHaveLength(15);
    expect(report.recovery).toHaveLength(4);
    expect(report).not.toHaveProperty("budget");
    expect(report).not.toHaveProperty("executionTarget");
  }, 60_000);
});

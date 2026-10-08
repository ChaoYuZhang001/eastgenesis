#!/usr/bin/env node
// Provider 恢复矩阵：默认只跑本地故障夹具，显式 --real 才读取临时环境变量。
// 输出只保留错误类别、HTTP 状态、部分输出边界和通过/失败，不输出 URL、模型名、Key 或正文。
import { spawn, type ChildProcess } from "node:child_process";
import { ProviderError, AnthropicProvider, OpenAIProvider, type LLMProvider } from "../src/core/llm";
import type { ChatRequest, FetchLike } from "../src/core/llm/types";
import { routedLlm } from "../src/agent/llm";
import { RouteExhaustedError, type ChainEntry, type RouteDecision } from "../src/decision/router";

type Protocol = "openai" | "anthropic";
type CaseMode = "chat" | "stream";

interface MatrixCase {
  name: string;
  protocol: Protocol;
  scenario: string;
  mode: CaseMode;
  expectedCode?: string;
  expectedStatus?: number;
  expectedPartial?: boolean;
  expectedDone?: boolean;
}

interface MatrixResult {
  name: string;
  protocol: Protocol;
  mode: CaseMode;
  expected: Record<string, unknown>;
  actual: {
    code: string | null;
    status: number | null;
    partialOutput: boolean;
    done: boolean;
    textChars: number;
    latencyMs: number | null;
  };
  passed: boolean;
}

interface RecoveryResult {
  name:
    | "fallback_without_partial"
    | "stop_after_partial"
    | "anthropic_to_openai_fallback"
    | "anthropic_partial_stops_chain"
    | "real_fallback_without_partial"
    | "real_stop_after_partial";
  passed: boolean;
  fallbackUsed: boolean;
  partialStopped: boolean;
  calls: number;
  deltaChars: number;
}

interface RealProviderConfig {
  label: "primary" | "fallback";
  protocol: Protocol;
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokensParam?: "max_tokens" | "max_completion_tokens";
}

interface RealLimits {
  requestBudget: number;
  maxOutputTokens: number;
  timeoutMs: number;
}

class RealRequestBudgetError extends ProviderError {
  constructor(providerId: string) {
    super("config", providerId, { detail: "real_request_budget_exhausted" });
  }
}

function abortableBody(response: Response, signal: AbortSignal | null | undefined): Response {
  if (!response.body || !signal) return response;
  const reader = response.body.getReader();
  let finished = false;
  let pulling = false;
  let sourceClosed = false;
  let sourceFailed = false;
  let sourceError: unknown;
  let bodyController: ReadableStreamDefaultController<Uint8Array>;
  let onAbort: () => void;
  const finish = () => {
    finished = true;
    signal.removeEventListener("abort", onAbort);
  };
  const cancelReader = (reason: unknown) => reader.cancel(reason).finally(() => reader.releaseLock());
  const settleSource = () => {
    if (finished || pulling || !sourceClosed) return;
    finish();
    reader.releaseLock();
    if (sourceFailed) bodyController.error(sourceError);
    else bodyController.close();
  };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      bodyController = controller;
      onAbort = () => {
        if (finished) return;
        finish();
        // Own the body reader until EOF/cancel. Native fetch follows the source
        // signal through a weakly held Request controller in some Node builds;
        // cancelling the body directly also closes that transport after GC.
        const reason = signal.reason ?? new DOMException("request aborted", "AbortError");
        controller.error(reason);
        void cancelReader(reason).catch(() => {});
      };
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
      void reader.closed.then(() => {
        sourceClosed = true;
        settleSource();
      }, (error) => {
        sourceClosed = true; sourceFailed = true; sourceError = error;
        settleSource();
      });
    },
    async pull(controller) {
      if (finished) return;
      pulling = true;
      try {
        const { value, done } = await reader.read();
        if (finished) return;
        if (done) sourceClosed = true;
        else controller.enqueue(value);
      } catch (error) {
        if (!finished) { sourceClosed = true; sourceFailed = true; sourceError = error; }
      } finally {
        pulling = false;
        settleSource();
      }
    },
    cancel(reason) {
      if (finished) return;
      finish();
      return cancelReader(reason);
    },
  }, { highWaterMark: 0 });
  const wrapped = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  // Preserve fetch metadata and the native headers guard. clone() must carry
  // the same metadata while retaining the standard body-used/tee semantics.
  const metadata = (value: Response): Response => {
    Object.defineProperties(value, {
      headers: { value: response.headers }, url: { value: response.url },
      type: { value: response.type }, redirected: { value: response.redirected },
      clone: { value(this: Response) { return metadata(Response.prototype.clone.call(this)); } },
    });
    return value;
  };
  return metadata(wrapped);
}

class RealRequestBudget {
  requestsStarted = 0;
  requestsBlocked = 0;
  constructor(readonly limits: RealLimits) {}

  async fetch(input: string, init: RequestInit, providerId: string): Promise<Response> {
    if (this.requestsStarted >= this.limits.requestBudget) {
      this.requestsBlocked++;
      diagnostic("request_blocked", this);
      throw new RealRequestBudgetError(providerId);
    }
    // Each adapter request (including routed retries) shares this counter.
    // Redirects must not dispatch hidden extra HTTP requests under one count.
    this.requestsStarted++;
    diagnostic("request_started", this);
    if (process.env.EG_MATRIX_DIAGNOSTICS === "1") {
      init.signal?.addEventListener("abort", () => diagnostic("request_aborted", this), { once: true });
    }
    try {
      const response = await fetch(input, { ...init, redirect: "error" });
      diagnostic("request_headers", this);
      return abortableBody(response, init.signal);
    } catch (error) {
      diagnostic("request_failed", this);
      throw error;
    }
  }

  report() {
    return {
      requestLimit: this.limits.requestBudget,
      maxOutputTokensPerRequest: this.limits.maxOutputTokens,
      requestTimeoutMs: this.limits.timeoutMs,
      requestsStarted: this.requestsStarted,
      requestsBlocked: this.requestsBlocked,
      requestsRemaining: Math.max(0, this.limits.requestBudget - this.requestsStarted),
      outputTokenLimitEnforcement: "request_parameter",
      redirectsAllowed: false,
      includesRoutedRetries: true,
    };
  }
}

type RecoveryStatus = "passed" | "failed" | "partial" | "not_run";

interface EvidenceBoundary {
  proven: string[];
  excluded: string[];
}

interface MatrixRun {
  mode: "local_fixture" | "real_opt_in";
  results: MatrixResult[];
  recovery: RecoveryResult[];
  recoveryStatus: RecoveryStatus;
  evidenceBoundary: EvidenceBoundary;
  budget?: ReturnType<RealRequestBudget["report"]>;
  executionTarget?: "loopback_only" | "external_or_mixed";
}

const jsonOutput = process.argv.includes("--json");
const realMode = process.argv.includes("--real");
const messages = [{ role: "user" as const, content: "provider matrix synthetic request" }];

type DiagnosticPhase =
  | "main_started" | "real_configured" | "real_stream_started" | "real_stream_finished"
  | "request_started" | "request_headers" | "request_failed" | "request_aborted" | "request_blocked"
  | "fixture_starting" | "fixture_ready" | "fixture_stopping" | "fixture_stopped"
  | "recovery_fallback_started" | "recovery_fallback_finished"
  | "recovery_partial_started" | "recovery_partial_finished"
  | "report_ready" | "report_written" | "setup_failed";
const diagnosticStartedAt = Date.now();

function diagnostic(phase: DiagnosticPhase, budget?: RealRequestBudget): void {
  if (process.env.EG_MATRIX_DIAGNOSTICS !== "1") return;
  // Fixed phases, durations and counters only. Never include native errors,
  // addresses, provider configuration, models, credentials or response text.
  process.stderr.write(`matrix-phase:${phase}:${Date.now() - diagnosticStartedAt}:${budget?.requestsStarted ?? 0}:${budget?.requestsBlocked ?? 0}\n`);
}

const localCases: MatrixCase[] = [
  { name: "auth", protocol: "openai", scenario: "auth", mode: "chat", expectedCode: "auth", expectedStatus: 401 },
  { name: "rate_limit", protocol: "openai", scenario: "rate-limit", mode: "chat", expectedCode: "rate_limit", expectedStatus: 429 },
  { name: "billing", protocol: "anthropic", scenario: "billing", mode: "chat", expectedCode: "billing", expectedStatus: 402 },
  { name: "not_found", protocol: "anthropic", scenario: "not-found", mode: "chat", expectedCode: "not_found", expectedStatus: 404 },
  { name: "bad_request", protocol: "openai", scenario: "bad-request", mode: "chat", expectedCode: "bad_request", expectedStatus: 400 },
  { name: "server", protocol: "openai", scenario: "error", mode: "chat", expectedCode: "server", expectedStatus: 503 },
  { name: "network", protocol: "openai", scenario: "network", mode: "chat", expectedCode: "network" },
  { name: "timeout", protocol: "openai", scenario: "idle", mode: "stream", expectedCode: "timeout" },
  { name: "cancel", protocol: "anthropic", scenario: "idle", mode: "stream", expectedCode: "aborted" },
  // content-length 截断由 fetch/readSse 归一化为 network；正常 EOF 缺 [DONE] 是 invalid_response。
  { name: "partial_transport", protocol: "openai", scenario: "truncated", mode: "stream", expectedCode: "network", expectedPartial: true },
  { name: "missing_terminal", protocol: "openai", scenario: "no-terminal", mode: "stream", expectedCode: "invalid_response", expectedPartial: true },
  { name: "anthropic_partial_transport", protocol: "anthropic", scenario: "truncated", mode: "stream", expectedCode: "network", expectedPartial: true },
  { name: "anthropic_missing_terminal", protocol: "anthropic", scenario: "no-terminal", mode: "stream", expectedCode: "invalid_response", expectedPartial: true },
  { name: "openai_stream_success", protocol: "openai", scenario: "staged", mode: "stream", expectedDone: true },
  { name: "anthropic_stream_success", protocol: "anthropic", scenario: "staged", mode: "stream", expectedDone: true },
];

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function stopFixture(child: ChildProcess): Promise<void> {
  diagnostic("fixture_stopping");
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    if (exited()) { diagnostic("fixture_stopped"); return; }
    child.kill(signal);
    const deadline = Date.now() + 2_000;
    while (!exited() && Date.now() < deadline) await sleep(25);
  }
  if (!exited()) throw new Error("fixture_cleanup_failed");
  diagnostic("fixture_stopped");
}

async function startFixture(): Promise<{ child: ChildProcess; base: string }> {
  diagnostic("fixture_starting");
  const child = spawn(process.execPath, ["tools/desktop-stream-fixture.mjs"], {
    env: { ...process.env, EG_FIXTURE_PORT: "0" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { output += chunk; });
  const deadline = Date.now() + 5_000;
  try {
    while (!output.includes("desktop-stream-fixture listening")) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error("fixture_start_failed");
      if (Date.now() >= deadline) throw new Error("fixture_start_timeout");
      await sleep(25);
    }
    const match = output.match(/desktop-stream-fixture listening on (http:\/\/127\.0\.0\.1:\d+)/);
    if (!match) throw new Error("fixture_address_missing");
    diagnostic("fixture_ready");
    return { child, base: match[1] };
  } catch (error) {
    await stopFixture(child);
    throw error;
  }
}

function makeProvider(protocol: Protocol, baseUrl: string, timeoutMs: number): LLMProvider {
  const common = { baseUrl, apiKey: "synthetic-provider-matrix-key", timeoutMs };
  if (protocol === "anthropic") return new AnthropicProvider({ id: "matrix-anthropic", ...common });
  return new OpenAIProvider({ id: "matrix-openai", kind: "openai-compatible", ...common });
}

function emptyActual(): MatrixResult["actual"] {
  return { code: null, status: null, partialOutput: false, done: false, textChars: 0, latencyMs: null };
}

function recoveryEntry(profileId: string, provider: string, stage: ChainEntry["stage"]): ChainEntry {
  return {
    profileId,
    provider,
    stage,
    score: 0,
    breakdown: { capability: 0, quality: 0, cost: 0, latency: 0, availability: 1, total: 0 },
    reason: "provider-matrix",
  };
}

function recoveryRoute(chain: readonly ChainEntry[]): RouteDecision {
  return { chain } as unknown as RouteDecision;
}

async function runProviderCase(provider: LLMProvider, c: MatrixCase, model: string, signal?: AbortSignal): Promise<MatrixResult["actual"]> {
  const actual = emptyActual();
  const startedAt = Date.now();
  try {
    if (c.mode === "chat") {
      const response = await provider.chat({ model, messages, signal });
      actual.done = true;
      actual.textChars = Array.from(response.text).length;
    } else {
      for await (const event of provider.stream({ model, messages, signal })) {
        if (event.type === "delta") actual.textChars += Array.from(event.text).length;
        else actual.done = true;
      }
    }
  } catch (error) {
    if (error instanceof ProviderError) {
      actual.code = error instanceof RealRequestBudgetError ? "request_budget_exhausted" : error.code;
      actual.status = error.status;
      actual.partialOutput = error.partialOutput;
    } else {
      actual.code = "unknown";
    }
  } finally {
    actual.latencyMs = Math.max(0, Date.now() - startedAt);
  }
  return actual;
}

async function runRecoveryMatrix(base: string): Promise<RecoveryResult[]> {
  const primary = recoveryEntry("matrix-a/fixture-model", "matrix-a", "primary");
  const fallback = recoveryEntry("matrix-b/fixture-model", "matrix-b", "fallback");
  const messagesForRecovery = [{ role: "user" as const, content: "provider recovery synthetic request" }];

  const fallbackCalls: string[] = [];
  const fallbackDeltas: string[] = [];
  const fallbackLlm = routedLlm(
    recoveryRoute([primary, fallback]),
    async (entry) => {
      fallbackCalls.push(entry.provider);
      return new OpenAIProvider({
        id: entry.provider,
        kind: "openai-compatible",
        baseUrl: base + "/" + (entry.provider === primary.provider ? "error" : "staged") + "/v1",
        apiKey: "synthetic-provider-matrix-key",
        timeoutMs: 2_000,
      });
    },
    undefined,
    { sleep: async () => {} },
  );
  const fallbackReply = await fallbackLlm({
    purpose: "answer",
    messages: messagesForRecovery,
    onDelta: (delta) => fallbackDeltas.push(delta.text),
  });
  const fallbackUsed = fallbackReply.profileId === fallback.profileId && (fallbackReply.fallbacks?.length ?? 0) === 1;

  const partialCalls: string[] = [];
  const partialDeltas: string[] = [];
  const partialLlm = routedLlm(
    recoveryRoute([primary, fallback]),
    async (entry) => {
      partialCalls.push(entry.provider);
      return new OpenAIProvider({
        id: entry.provider,
        kind: "openai-compatible",
        baseUrl: base + "/" + (entry.provider === primary.provider ? "no-terminal" : "staged") + "/v1",
        apiKey: "synthetic-provider-matrix-key",
        timeoutMs: 2_000,
      });
    },
    undefined,
    { sleep: async () => {} },
  );
  const partialError = await partialLlm({
    purpose: "answer",
    messages: messagesForRecovery,
    onDelta: (delta) => partialDeltas.push(delta.text),
  }).catch((error) => error);
  const partialStopped = partialError instanceof RouteExhaustedError
    && partialError.partialOutput
    && partialCalls.length === 1
    && partialError.attempts.some((attempt) => attempt.action === "stop" && attempt.partialOutput === true);

  const anthropicPrimary = recoveryEntry("matrix-anthropic-a/fixture-model", "matrix-anthropic-a", "primary");
  const openAiFallback = recoveryEntry("matrix-openai-b/fixture-model", "matrix-openai-b", "fallback");
  const crossCalls: string[] = [];
  const crossDeltas: string[] = [];
  const crossLlm = routedLlm(
    recoveryRoute([anthropicPrimary, openAiFallback]),
    async (entry) => {
      crossCalls.push(entry.provider);
      const isAnthropic = entry.provider === anthropicPrimary.provider;
      const Provider = isAnthropic ? AnthropicProvider : OpenAIProvider;
      return new Provider({
        id: entry.provider,
        ...(isAnthropic ? {} : { kind: "openai-compatible" as const }),
        baseUrl: base + "/" + (isAnthropic ? "error" : "staged") + "/v1",
        apiKey: "synthetic-provider-matrix-key",
        timeoutMs: 2_000,
      });
    },
    undefined,
    { sleep: async () => {} },
  );
  const crossReply = await crossLlm({
    purpose: "answer",
    messages: messagesForRecovery,
    onDelta: (delta) => crossDeltas.push(delta.text),
  });
  const crossFallbackUsed = crossReply.profileId === openAiFallback.profileId && (crossReply.fallbacks?.length ?? 0) === 1;

  const anthropicPartialCalls: string[] = [];
  const anthropicPartialDeltas: string[] = [];
  const anthropicPartialLlm = routedLlm(
    recoveryRoute([anthropicPrimary, openAiFallback]),
    async (entry) => {
      anthropicPartialCalls.push(entry.provider);
      const isAnthropic = entry.provider === anthropicPrimary.provider;
      const Provider = isAnthropic ? AnthropicProvider : OpenAIProvider;
      return new Provider({
        id: entry.provider,
        ...(isAnthropic ? {} : { kind: "openai-compatible" as const }),
        baseUrl: base + "/" + (isAnthropic ? "no-terminal" : "staged") + "/v1",
        apiKey: "synthetic-provider-matrix-key",
        timeoutMs: 2_000,
      });
    },
    undefined,
    { sleep: async () => {} },
  );
  const anthropicPartialError = await anthropicPartialLlm({
    purpose: "answer",
    messages: messagesForRecovery,
    onDelta: (delta) => anthropicPartialDeltas.push(delta.text),
  }).catch((error) => error);
  const anthropicPartialStopped = anthropicPartialError instanceof RouteExhaustedError
    && anthropicPartialError.partialOutput
    && anthropicPartialCalls.length === 1
    && anthropicPartialError.attempts.some((attempt) => attempt.action === "stop" && attempt.partialOutput === true);

  return [
    {
      name: "fallback_without_partial",
      passed: fallbackUsed && fallbackCalls.length === 2 && fallbackDeltas.length > 0,
      fallbackUsed,
      partialStopped: false,
      calls: fallbackCalls.length,
      deltaChars: Array.from(fallbackDeltas.join("")).length,
    },
    {
      name: "stop_after_partial",
      passed: partialStopped && partialDeltas.length > 0,
      fallbackUsed: false,
      partialStopped,
      calls: partialCalls.length,
      deltaChars: Array.from(partialDeltas.join("")).length,
    },
    {
      name: "anthropic_to_openai_fallback",
      passed: crossFallbackUsed && crossCalls.length === 2 && crossDeltas.length > 0,
      fallbackUsed: crossFallbackUsed,
      partialStopped: false,
      calls: crossCalls.length,
      deltaChars: Array.from(crossDeltas.join("")).length,
    },
    {
      name: "anthropic_partial_stops_chain",
      passed: anthropicPartialStopped && anthropicPartialDeltas.length > 0,
      fallbackUsed: false,
      partialStopped: anthropicPartialStopped,
      calls: anthropicPartialCalls.length,
      deltaChars: Array.from(anthropicPartialDeltas.join("")).length,
    },
  ];
}

function evaluate(c: MatrixCase, actual: MatrixResult["actual"]): boolean {
  if (c.expectedCode && actual.code !== c.expectedCode) return false;
  if (c.expectedStatus !== undefined && actual.status !== c.expectedStatus) return false;
  if (c.expectedPartial !== undefined && actual.partialOutput !== c.expectedPartial) return false;
  if (c.expectedDone !== undefined && actual.done !== c.expectedDone) return false;
  if (c.name.includes("partial_transport") || c.name.includes("missing_terminal")) {
    if (actual.textChars <= 0) return false;
  }
  return true;
}

async function runLocal(): Promise<MatrixRun> {
  const { child, base } = await startFixture();
  try {
    const results: MatrixResult[] = [];
    for (const c of localCases) {
      const timeoutMs = c.name === "timeout" ? 80 : c.name === "cancel" ? 5_000 : c.name.includes("partial_transport") ? 15_000 : 2_000;
      const scenarioBase = c.name === "network" ? `http://127.0.0.1:${19_000 + Math.floor(Math.random() * 500)}/${c.scenario}/v1` : `${base}/${c.scenario}/v1`;
      const provider = makeProvider(c.protocol, scenarioBase, timeoutMs);
      const controller = new AbortController();
      const timer = c.name === "cancel" ? setTimeout(() => controller.abort(), 80) : undefined;
      try {
        const actual = await runProviderCase(provider, c, "fixture-model", controller.signal);
        results.push({ name: c.name, protocol: c.protocol, mode: c.mode, expected: { code: c.expectedCode ?? null, status: c.expectedStatus ?? null, partialOutput: c.expectedPartial ?? false, done: c.expectedDone ?? false }, actual, passed: evaluate(c, actual) });
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    const recovery = await runRecoveryMatrix(base);
    return {
      mode: "local_fixture",
      results,
      recovery,
      recoveryStatus: recovery.every((result) => result.passed) ? "passed" : "failed",
      evidenceBoundary: {
        proven: [
          "本地可控 HTTP 夹具下的 OpenAI-compatible / Anthropic 适配器错误归一化",
          "取消、超时、传输中断、协议终态和部分输出契约",
          "无部分输出时的 Provider fallback 与有部分输出时停止链路",
        ],
        excluded: [
          "真实 Provider 的可用性、额度、SLA 和故障行为",
          "真实桌面 WebView、跨平台安装升级和签名公证",
        ],
      },
    };
  } finally {
    await stopFixture(child);
  }
}

function protocolFromEnv(value: string | undefined, name: string): Protocol {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === "openai") return "openai";
  if (normalized === "anthropic") return "anthropic";
  throw new Error(`${name} 仅支持 openai 或 anthropic`);
}

function requiredRealValue(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`--real 需要 ${name}；凭据只从进程环境读取`);
  return value;
}

function realProviderConfigs(env: NodeJS.ProcessEnv = process.env): RealProviderConfig[] {
  const primary: RealProviderConfig = {
    label: "primary",
    protocol: protocolFromEnv(env.EG_MATRIX_PROTOCOL, "EG_MATRIX_PROTOCOL"),
    baseUrl: requiredRealValue(env, "EG_MATRIX_BASE_URL"),
    apiKey: requiredRealValue(env, "EG_MATRIX_API_KEY"),
    model: requiredRealValue(env, "EG_MATRIX_MODEL"),
    maxTokensParam: realMaxTokensParam(env.EG_MATRIX_MAX_TOKENS_PARAM),
  };

  const fallbackNames = [
    "EG_MATRIX_FALLBACK_PROTOCOL",
    "EG_MATRIX_FALLBACK_BASE_URL",
    "EG_MATRIX_FALLBACK_API_KEY",
    "EG_MATRIX_FALLBACK_MODEL",
  ] as const;
  const fallbackPresent = fallbackNames.some((name) => Boolean(env[name]?.trim()));
  if (!fallbackPresent) return [primary];
  const missingFallback = fallbackNames.filter((name) => !env[name]?.trim());
  if (missingFallback.length > 0) {
    throw new Error(`--real 的 fallback 配置不完整，需要同时提供 ${fallbackNames.join("、")}`);
  }
  return [
    primary,
    {
      label: "fallback",
      protocol: protocolFromEnv(env.EG_MATRIX_FALLBACK_PROTOCOL, "EG_MATRIX_FALLBACK_PROTOCOL"),
      baseUrl: env.EG_MATRIX_FALLBACK_BASE_URL!.trim(),
      apiKey: env.EG_MATRIX_FALLBACK_API_KEY!.trim(),
      model: env.EG_MATRIX_FALLBACK_MODEL!.trim(),
      maxTokensParam: realMaxTokensParam(env.EG_MATRIX_FALLBACK_MAX_TOKENS_PARAM),
    },
  ];
}

function realMaxTokensParam(value: string | undefined): RealProviderConfig["maxTokensParam"] {
  if (!value?.trim() || value.trim() === "max_tokens") return "max_tokens";
  if (value.trim() === "max_completion_tokens") return "max_completion_tokens";
  throw new Error("real_token_parameter_invalid");
}

function realLimits(args = process.argv.slice(2)): RealLimits {
  const options = {
    "--real-request-budget": { fallback: 3, max: 8 },
    "--real-max-output-tokens": { fallback: 128, max: 1024 },
    "--real-timeout-ms": { fallback: 10_000, max: 30_000 },
  };
  const values = new Map<string, number>();
  for (let index = 0; index < args.length; index++) {
    const name = args[index];
    if (!name.startsWith("--real-") || name === "--real") continue;
    if (!Object.prototype.hasOwnProperty.call(options, name) || values.has(name)) throw new Error("real_budget_argument_invalid");
    const value = args[++index];
    const option = options[name as keyof typeof options];
    if (!value || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > option.max) throw new Error("real_budget_argument_invalid");
    values.set(name, Number(value));
  }
  return {
    requestBudget: values.get("--real-request-budget") ?? options["--real-request-budget"].fallback,
    maxOutputTokens: values.get("--real-max-output-tokens") ?? options["--real-max-output-tokens"].fallback,
    timeoutMs: values.get("--real-timeout-ms") ?? options["--real-timeout-ms"].fallback,
  };
}

function realProvider(config: RealProviderConfig, budget: RealRequestBudget): LLMProvider {
  const id = `real-${config.label}`;
  const nativeProvider = (boundedFetch?: FetchLike): LLMProvider => {
    const common = { id, baseUrl: config.baseUrl, apiKey: config.apiKey, timeoutMs: budget.limits.timeoutMs, fetch: boundedFetch };
    if (config.protocol === "anthropic") return new AnthropicProvider(common);
    return new OpenAIProvider({ ...common, kind: "openai-compatible", quirks: { maxTokensParam: config.maxTokensParam } });
  };
  // The adapter's HTTP normalization wraps fetch errors. Keep a call-local
  // marker so budget refusal becomes a non-retryable config failure again.
  const boundedAttempt = () => {
    let denied = false;
    const provider = nativeProvider(async (input, init) => {
      try { return await budget.fetch(input, init, id); }
      catch (error) {
        if (error instanceof RealRequestBudgetError) denied = true;
        throw error;
      }
    });
    return { provider, denied: () => denied };
  };
  const metadata = nativeProvider();
  const boundedRequest = (request: ChatRequest): ChatRequest => ({ ...request, maxTokens: budget.limits.maxOutputTokens });
  return {
    id, kind: metadata.kind, label: metadata.label, capabilities: metadata.capabilities,
    async chat(request) {
      const attempt = boundedAttempt();
      try { return await attempt.provider.chat(boundedRequest(request)); }
      catch (error) { if (attempt.denied()) throw new RealRequestBudgetError(id); throw error; }
    },
    async *stream(request) {
      const attempt = boundedAttempt();
      try { yield* attempt.provider.stream(boundedRequest(request)); }
      catch (error) { if (attempt.denied()) throw new RealRequestBudgetError(id); throw error; }
    },
  };
}

async function runControlledRealRecovery(base: string, fallbackConfig: RealProviderConfig, budget: RealRequestBudget): Promise<RecoveryResult[]> {
  const primary = recoveryEntry("real-controlled-primary/fixture-model", "real-controlled-primary", "primary");
  const fallback = recoveryEntry(`real-${fallbackConfig.label}/${fallbackConfig.model}`, `real-${fallbackConfig.label}`, "fallback");
  const messagesForRecovery = [{ role: "user" as const, content: "provider recovery controlled request" }];

  const run = async (primaryScenario: "error" | "no-terminal") => {
    const calls: string[] = [];
    const deltas: string[] = [];
    const fallbackProvider = realProvider(fallbackConfig, budget);
    const call = routedLlm(
      recoveryRoute([primary, fallback]),
      async (entry) => {
        calls.push(entry.provider);
        if (entry.provider === primary.provider) {
          return new OpenAIProvider({
            id: primary.provider,
            kind: "openai-compatible",
            baseUrl: `${base}/${primaryScenario}/v1`,
            apiKey: "synthetic-provider-matrix-key",
            timeoutMs: 2_000,
          });
        }
        return fallbackProvider;
      },
      undefined,
      { sleep: async () => {} },
    );
    const result = await call({
      purpose: "answer",
      messages: messagesForRecovery,
      onDelta: (delta) => deltas.push(delta.text),
    }).catch((error) => error);
    return { calls, deltas, result, fallback };
  };

  diagnostic("recovery_fallback_started", budget);
  const fallbackRun = await run("error");
  diagnostic("recovery_fallback_finished", budget);
  const fallbackUsed = fallbackRun.result?.profileId === fallback.profileId
    && (fallbackRun.result?.fallbacks?.length ?? 0) === 1;
  const fallbackPassed = fallbackUsed
    && fallbackRun.calls.length === 2
    && fallbackRun.deltas.length > 0;

  diagnostic("recovery_partial_started", budget);
  const partialRun = await run("no-terminal");
  diagnostic("recovery_partial_finished", budget);
  const partialStopped = partialRun.result instanceof RouteExhaustedError
    && partialRun.result.partialOutput
    && partialRun.calls.length === 1
    && partialRun.deltas.length > 0
    && partialRun.result.attempts.some((attempt) => attempt.action === "stop" && attempt.partialOutput === true);

  return [
    {
      name: "real_fallback_without_partial",
      passed: fallbackPassed,
      fallbackUsed,
      partialStopped: false,
      calls: fallbackRun.calls.length,
      deltaChars: Array.from(fallbackRun.deltas.join("")).length,
    },
    {
      name: "real_stop_after_partial",
      passed: partialStopped,
      fallbackUsed: false,
      partialStopped,
      calls: partialRun.calls.length,
      deltaChars: Array.from(partialRun.deltas.join("")).length,
    },
  ];
}

async function runReal(): Promise<MatrixRun> {
  // Validate the complete budget before reading credentials or dispatching.
  const budget = new RealRequestBudget(realLimits());
  const configs = realProviderConfigs();
  diagnostic("real_configured", budget);
  const results: MatrixResult[] = [];
  for (const config of configs) {
    const provider = realProvider(config, budget);
    diagnostic("real_stream_started", budget);
    const actual = await runProviderCase(provider, { name: `real_${config.label}_stream`, protocol: config.protocol, scenario: "", mode: "stream", expectedDone: true }, config.model);
    diagnostic("real_stream_finished", budget);
    results.push({
      name: `real_${config.label}_stream`,
      protocol: config.protocol,
      mode: "stream",
      expected: { done: true },
      actual,
      passed: actual.done && actual.textChars > 0,
    });
  }
  let recovery: RecoveryResult[] = [];
  let recoveryStatus: RecoveryStatus = "not_run";
  let controlledRecoveryBoundary: string[] = [];
  if (configs.length === 2) {
    const { child, base } = await startFixture();
    try {
      recovery = await runControlledRealRecovery(base, configs[1], budget);
      recoveryStatus = recovery.every((result) => result.passed) ? "partial" : "failed";
      controlledRecoveryBoundary = [
        ...(recovery[0]?.passed ? ["受控本地 primary 故障后由已配置 fallback 端点完成生产 routedLlm 调用"] : []),
        ...(recovery[1]?.passed ? ["受控本地 primary 部分输出后停止链路且不调用 fallback 端点"] : []),
      ];
    } finally {
      await stopFixture(child);
    }
  }
  return {
    mode: "real_opt_in",
    budget: budget.report(),
    executionTarget: configs.every((config) => {
      try { return ["127.0.0.1", "localhost", "[::1]"].includes(new URL(config.baseUrl).hostname); }
      catch { return false; }
    }) ? "loopback_only" : "external_or_mixed",
    results,
    recovery,
    recoveryStatus,
    evidenceBoundary: {
      proven: [
        ...(results.some((result) => result.passed) ? [
          "显式临时环境配置下已通过场景的端点流式连通性",
          "通过场景的统一流式终态、输出字符数和单次耗时记录",
        ] : []),
        "客户端共享请求计数预算、每次请求超时和强制发送的输出 token 参数",
        ...controlledRecoveryBoundary,
      ],
      excluded: [
        "真实 primary 上游故障的注入与自动切换（受控恢复使用本地 primary 故障）",
        "真实 Provider 之间的自动故障切换、取消、超时和部分输出恢复",
        "真实错误矩阵、SLA、额度、成本和生产回答质量",
        "上游是否遵守输出 token 参数、隐藏推理 token 和实际计费总额",
        "executionTarget 为 loopback_only 时不包含任何真实 Provider 证据",
        "真实桌面 WebView、跨平台安装升级和签名公证",
      ],
    },
  };
}

async function main(): Promise<void> {
  diagnostic("main_started");
  let report: MatrixRun;
  try {
    report = realMode ? await runReal() : await runLocal();
  } catch (error) {
    diagnostic("setup_failed");
    // Configuration failures and fixture setup errors must not print native
    // stack traces, URL/model values, credentials or provider response bodies.
    const safeError = error instanceof Error && ["real_budget_argument_invalid", "real_token_parameter_invalid"].includes(error.message) ? error.message : "matrix_setup_failed";
    if (jsonOutput) console.log(JSON.stringify({ schemaVersion: 1, matrix: "provider-recovery", mode: realMode ? "real_opt_in" : "local_fixture", passed: false, errors: [safeError], scenarios: [], recovery: [], recoveryStatus: "not_run", evidenceBoundary: { proven: [], excluded: ["Provider request or recovery success"] } }, null, 2));
    else console.log("provider matrix setup failed");
    process.exitCode = 1;
    diagnostic("report_written");
    return;
  }
  const failed = report.results.filter((result) => !result.passed);
  const failedRecovery = report.recovery.filter((result) => !result.passed);
  const recoveryFailed = report.recoveryStatus === "failed" || failedRecovery.length > 0;
  diagnostic("report_ready");
  if (jsonOutput) {
    console.log(JSON.stringify({
      schemaVersion: 1,
      matrix: "provider-recovery",
      mode: report.mode,
      passed: failed.length === 0 && !recoveryFailed,
      scenarios: report.results,
      recovery: report.recovery,
      recoveryStatus: report.recoveryStatus,
      evidenceBoundary: report.evidenceBoundary,
      ...(report.budget ? { budget: report.budget, executionTarget: report.executionTarget } : {}),
    }, null, 2));
  } else {
    console.log(`provider matrix ${report.mode}: ${report.results.length - failed.length}/${report.results.length} passed`);
    for (const result of report.results) console.log(`${result.passed ? "PASS" : "FAIL"} ${result.name} (${result.protocol}/${result.mode}) → ${result.actual.code ?? (result.actual.done ? "done" : "unknown")}${result.actual.partialOutput ? " partial" : ""} (${result.actual.latencyMs ?? "n/a"} ms)`);
    console.log(`recovery execution: ${report.recoveryStatus === "not_run" ? "not run" : `${report.recovery.length - failedRecovery.length}/${report.recovery.length} ${report.recoveryStatus}`}`);
    for (const result of report.recovery) console.log(`${result.passed ? "PASS" : "FAIL"} ${result.name} (${result.calls} calls, ${result.deltaChars} chars)`);
    if (report.budget) console.log(`real request budget: ${report.budget.requestsStarted}/${report.budget.requestLimit}, blocked=${report.budget.requestsBlocked}, output token parameter=${report.budget.maxOutputTokensPerRequest}, request timeout=${report.budget.requestTimeoutMs}ms`);
  }
  if (failed.length || recoveryFailed) process.exitCode = 1;
  diagnostic("report_written");
}

await main();

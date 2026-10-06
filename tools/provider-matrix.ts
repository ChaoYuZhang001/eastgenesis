#!/usr/bin/env node
// Provider 恢复矩阵：默认只跑本地故障夹具，显式 --real 才读取临时环境变量。
// 输出只保留错误类别、HTTP 状态、部分输出边界和通过/失败，不输出 URL、模型名、Key 或正文。
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { ProviderError, AnthropicProvider, OpenAIProvider, type LLMProvider } from "../src/core/llm";
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
  actual: { code: string | null; status: number | null; partialOutput: boolean; done: boolean; textChars: number };
  passed: boolean;
}

interface RecoveryResult {
  name: "fallback_without_partial" | "stop_after_partial" | "anthropic_to_openai_fallback" | "anthropic_partial_stops_chain";
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
}

const jsonOutput = process.argv.includes("--json");
const realMode = process.argv.includes("--real");
const messages = [{ role: "user" as const, content: "provider matrix synthetic request" }];

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

async function startFixture(): Promise<{ child: ChildProcessWithoutNullStreams; base: string }> {
  const port = 18_000 + Math.floor(Math.random() * 1_000);
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["tools/desktop-stream-fixture.mjs"], {
    env: { ...process.env, EG_FIXTURE_PORT: String(port) },
    stdio: ["ignore", "pipe", "inherit"],
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { output += chunk; });
  const deadline = Date.now() + 5_000;
  while (!output.includes("desktop-stream-fixture listening")) {
    if (child.exitCode !== null) throw new Error(`fixture exited with ${child.exitCode}`);
    if (Date.now() >= deadline) throw new Error("fixture did not start within 5 seconds");
    await sleep(25);
  }
  return { child, base };
}

function makeProvider(protocol: Protocol, baseUrl: string, timeoutMs: number): LLMProvider {
  const common = { baseUrl, apiKey: "synthetic-provider-matrix-key", timeoutMs };
  if (protocol === "anthropic") return new AnthropicProvider({ id: "matrix-anthropic", ...common });
  return new OpenAIProvider({ id: "matrix-openai", kind: "openai-compatible", ...common });
}

function emptyActual() {
  return { code: null, status: null, partialOutput: false, done: false, textChars: 0 };
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
  try {
    if (c.mode === "chat") {
      const response = await provider.chat({ model, messages, signal });
      actual.done = true;
      actual.textChars = Array.from(response.text).length;
      return actual;
    }
    for await (const event of provider.stream({ model, messages, signal })) {
      if (event.type === "delta") actual.textChars += Array.from(event.text).length;
      else actual.done = true;
    }
    return actual;
  } catch (error) {
    if (error instanceof ProviderError) {
      actual.code = error.code;
      actual.status = error.status;
      actual.partialOutput = error.partialOutput;
      return actual;
    }
    actual.code = "unknown";
    return actual;
  }
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

async function runLocal(): Promise<{ mode: "local_fixture"; results: MatrixResult[]; recovery: RecoveryResult[] }> {
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
    return { mode: "local_fixture", results, recovery: await runRecoveryMatrix(base) };
  } finally {
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
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
    },
  ];
}

function realProvider(config: RealProviderConfig): LLMProvider {
  if (config.protocol === "anthropic") {
    return new AnthropicProvider({ id: `real-${config.label}`, baseUrl: config.baseUrl, apiKey: config.apiKey, timeoutMs: 30_000 });
  }
  return new OpenAIProvider({ id: `real-${config.label}`, kind: "openai-compatible", baseUrl: config.baseUrl, apiKey: config.apiKey, timeoutMs: 30_000 });
}

async function runReal(): Promise<{ mode: "real_opt_in"; results: MatrixResult[]; recovery: RecoveryResult[] }> {
  const configs = realProviderConfigs();
  const results: MatrixResult[] = [];
  for (const config of configs) {
    const provider = realProvider(config);
    const actual = await runProviderCase(provider, { name: `real_${config.label}_stream`, protocol: config.protocol, scenario: "", mode: "stream", expectedDone: true }, config.model);
    results.push({
      name: `real_${config.label}_stream`,
      protocol: config.protocol,
      mode: "stream",
      expected: { done: true },
      actual,
      passed: actual.done && actual.textChars > 0,
    });
  }
  return {
    mode: "real_opt_in",
    results,
    recovery: [],
  };
}

const report = realMode ? await runReal() : await runLocal();
const failed = report.results.filter((result) => !result.passed);
const failedRecovery = report.recovery.filter((result) => !result.passed);
if (jsonOutput) {
  console.log(JSON.stringify({
    schemaVersion: 1,
    matrix: "provider-recovery",
    mode: report.mode,
    passed: failed.length === 0 && failedRecovery.length === 0,
    scenarios: report.results,
    recovery: report.recovery,
  }, null, 2));
} else {
  console.log(`provider matrix ${report.mode}: ${report.results.length - failed.length}/${report.results.length} passed`);
  for (const result of report.results) console.log(`${result.passed ? "PASS" : "FAIL"} ${result.name} (${result.protocol}/${result.mode}) → ${result.actual.code ?? (result.actual.done ? "done" : "unknown")}${result.actual.partialOutput ? " partial" : ""}`);
  console.log(`recovery execution: ${report.recovery.length - failedRecovery.length}/${report.recovery.length} passed`);
  for (const result of report.recovery) console.log(`${result.passed ? "PASS" : "FAIL"} ${result.name} (${result.calls} calls, ${result.deltaChars} chars)`);
}
if (failed.length || failedRecovery.length) process.exitCode = 1;

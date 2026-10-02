// 真实 API 测试：只由 tools/real-api-test.sh --real 调用，凭据从环境变量读取。
// 输出只有脱敏摘要（状态码、耗时、token 数、错误码），不打印 Key、Base URL 和模型回复原文。
// 连续 5 项失败就停止，不无限重试。
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { routedLlm, type AgentEvent, type Tool } from "@/agent";
import { mcpTools } from "@/agent/mcp/client";
import { connectStdioServer } from "@/agent/mcp/stdio";
import { OpenAIProvider, ProviderError, type LLMProvider, type Usage } from "@/core/llm";
import { HealthTracker, RouteExhaustedError, type ChainEntry, type ChainStage, type RouteDecision } from "@/decision";
import { parseModels } from "@/lib/discover";
import { createEngine } from "@/lib/engine";
import { displayModel, routeLineText, routeSummary } from "@/lib/route-summary";
import { lastRoute } from "@/lib/timeline";
import { createMockBackend, type Backend, type CustomProvider } from "@/platform";

const env = process.env;
const BASE = (env.EG_TEST_BASE_URL ?? "").replace(/\/+$/, "");
const KEY = env.EG_TEST_API_KEY ?? "";
const MODEL = env.EG_TEST_MODEL ?? "";
const ALT = env.EG_TEST_ALT_MODEL ?? "";
/** 明显无效的 Key，用来测鉴权失败 */
const BAD_KEY = ["sk", "eg", "invalid", "000000000000"].join("-");
const MAX_STREAK = 5;
const RESULT_FILE = "/tmp/eg-real-results.json";

/** 兜底脱敏：Key 只留前 3 位；Base URL 换成占位 */
const mask = (s: string) => {
  let out = s;
  if (KEY) out = out.split(KEY).join(`${KEY.slice(0, 3)}***`);
  if (BASE) out = out.split(BASE).join("<中转站>").split(new URL(BASE).host).join("<中转站>");
  return out;
};

interface Row {
  id: string;
  name: string;
  ok: boolean;
  status?: number | string;
  ms: number;
  tokens?: number;
  note: string;
}
type Outcome = Omit<Row, "id" | "name" | "ms"> & { ms?: number };

const rows: Row[] = [];
let streak = 0;

const describe = (e: unknown): string => {
  if (e instanceof ProviderError) return `${e.code}${e.status ? `（HTTP ${e.status}）` : ""}`;
  if (e instanceof Error) return `${e.name}：${e.message.slice(0, 300)}`;
  return String(e).slice(0, 300);
};

/** EG_REAL_ONLY=R01,R02 只跑指定项（分批运行时用），结果按 id 合并进 RESULT_FILE */
const ONLY = new Set((env.EG_REAL_ONLY ?? "").split(",").map((s) => s.trim()).filter(Boolean));

async function check(id: string, name: string, fn: () => Promise<Outcome>): Promise<void> {
  if (ONLY.size && !ONLY.has(id)) return;
  if (streak >= MAX_STREAK) {
    rows.push({ id, name, ok: false, ms: 0, status: "未运行", note: `已停止：连续 ${MAX_STREAK} 项失败` });
    console.log(`跳过  ${id} ${name}（连续 ${MAX_STREAK} 项失败，已停止）`);
    return;
  }
  const t0 = Date.now();
  let r: Row;
  try {
    const out = await fn();
    r = { id, name, ...out, ms: out.ms ?? Date.now() - t0 };
  } catch (e) {
    r = { id, name, ok: false, ms: Date.now() - t0, note: `意外错误：${describe(e)}` };
  }
  r.note = mask(r.note);
  streak = r.ok ? 0 : streak + 1;
  rows.push(r);
  const tk = r.tokens !== undefined ? ` · ${r.tokens} tokens` : "";
  console.log(`${r.ok ? "通过" : "失败"}  ${id} ${name} · ${r.status ?? "-"} · ${r.ms} ms${tk} · ${r.note}`);
}

// ---- 适配器与测试替身 ----

const tokensOf = (u: Usage | null) => (u ? u.inputTokens + u.outputTokens : undefined);
const relay = (timeoutMs = 60_000, apiKey = KEY, baseUrl = BASE, id = "custom:relay"): LLMProvider =>
  new OpenAIProvider({ id, kind: "openai-compatible", baseUrl, apiKey, timeoutMs });
const ask = (text: string) => [{ role: "user" as const, content: text }];

/** 本机假服务：按路径返回 429 / 500 / 401，或者一直不响应（测超时） */
async function localServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    const p = req.url ?? "";
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (p.startsWith("/r429/")) send(429, { error: { message: "rate limited" } });
    else if (p.startsWith("/r500/")) send(500, { error: { message: "internal" } });
    else if (p.startsWith("/r502/")) send(502, { error: { message: "bad gateway" } });
    else if (p.startsWith("/slow/")) setTimeout(() => send(200, {}), 30_000).unref();
    else send(404, { error: { message: "not found" } });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((r) => (server.closeAllConnections(), server.close(() => r()))),
  };
}

/**
 * 代替 Rust 代理的后端：内存存储沿用 mock，自定义 Provider 的请求真实发出，Key 在这里注入。
 * 与桌面端一致：适配器只拿到占位 Key，Key 按 Provider 保存在「后端」闭包里。
 */
function realBackend(keys: Record<string, string>): Backend {
  const base = createMockBackend({ configured: [] });
  const custom = new Map<string, CustomProvider>();
  return {
    ...base,
    async saveCustomProvider(p, apiKey) {
      const r = await base.saveCustomProvider(p, apiKey);
      custom.set(r.provider.id, r.provider);
      return r;
    },
    async providerRequest(req) {
      const c = custom.get(req.target);
      if (!c) return base.providerRequest(req);
      if (!req.url.startsWith(`${c.base_url}/`)) throw { code: "proxy_url_not_allowed", message: "请求地址不在该 Provider 的允许列表内", detail: null };
      const key = keys[c.id];
      const res = await fetch(req.url, {
        method: req.method,
        headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
        body: req.body ?? undefined,
        signal: AbortSignal.timeout(180_000),
      });
      return { status: res.status, body: await res.text() };
    },
  };
}

const entry = (profileId: string, stage: ChainStage = "fallback"): ChainEntry => ({
  profileId,
  // profile id 是 <provider>/<model>：第一个 / 之前是 Provider（模型名本身可以含 /）
  provider: profileId.slice(0, profileId.indexOf("/")),
  stage,
  score: 0,
  breakdown: { capability: 0, quality: 0, cost: 0, latency: 0, availability: 1, total: 0 },
  reason: "测试链",
});
const RELAY: CustomProvider = { id: "custom:relay", label: "中转站", base_url: BASE, default_model: MODEL, models: [MODEL, ALT], headers: {} };
const configured = (id: string) => ({ id, configured: true, source: "keychain" as const, needs_key: true });

/** 用应用自己的引擎（决策层 + Agent 运行时）跑一个任务，模型请求经 realBackend 真实发出 */
async function runTask(goal: string, o: { lock?: string; tools?: Tool[] } = {}) {
  const backend = realBackend({ [RELAY.id]: KEY });
  await backend.saveCustomProvider(RELAY);
  const events: AgentEvent[] = [];
  const { runtime } = createEngine({
    backend,
    statuses: [configured(RELAY.id)],
    jev: null,
    custom: [RELAY],
    permission: "confirm",
    timeoutMs: 60_000,
    tools: o.tools,
    confirm: async () => true,
    onEvent: (e) => {
      events.push(e);
      // 进度只打模型、用途、耗时，不打内容
      if (e.type === "llm") console.log(`      · ${e.purpose} ${displayModel(e.profileId)} ${e.latencyMs} ms${e.fallbacks?.length ? ` 降级 ${e.fallbacks.length} 次` : ""}`);
      if (e.type === "llm_failed") console.log(`      · ${e.purpose} 失败 ${e.attempts.map((a) => displayModel(a.profileId)).join("、")}`);
    },
  });
  const r = await runtime.run(goal, o.lock ? { route: { lock: o.lock } } : {});
  const summary = routeSummary(lastRoute(events), events);
  return { r, events, summary };
}

const errOutcome = (e: unknown, expect: string, status?: number): Outcome => {
  const ok = e instanceof ProviderError && e.code === expect && (status === undefined || e.status === status);
  const st = e instanceof ProviderError ? (e.status ?? e.code) : "异常";
  return { ok, status: st, note: ok ? `按预期得到 ${expect}：${(e as ProviderError).message}` : `期望 ${expect}，实际 ${describe(e)}` };
};

async function main() {
  if (!BASE || !KEY || !MODEL || !ALT) {
    console.error("缺少 EG_TEST_* 环境变量，请通过 tools/real-api-test.sh --real 运行");
    process.exitCode = 2;
    return;
  }
  console.log(`真实 API 测试：中转站（OpenAI 兼容）· 主模型 ${MODEL} · 备用模型 ${ALT} · Key ${KEY.slice(0, 3)}***`);
  const local = await localServer();

  try {
    await check("R01", "GET /models 读取模型列表", async () => {
      const t0 = Date.now();
      const res = await fetch(`${BASE}/models`, { headers: { authorization: `Bearer ${KEY}` }, signal: AbortSignal.timeout(30_000) });
      const ms = Date.now() - t0;
      const models = parseModels(await res.text());
      writeFileSync("/tmp/eg-real-models.txt", `${models.join("\n")}\n`, { mode: 0o600 });
      const has = models.includes(MODEL) && models.includes(ALT);
      return { ok: res.status === 200 && has, status: res.status, ms, note: `${models.length} 个模型；主模型、备用模型${has ? "都在列表里" : "不全在列表里"}` };
    });

    for (const [id, m] of [["R02", MODEL], ["R03", ALT]] as const) {
      await check(id, `非流式对话 · ${m}`, async () => {
        const r = await relay().chat({ model: m, messages: ask("用一句话回答：1+1 等于几？"), maxTokens: 200 });
        return { ok: r.text.trim().length > 0, status: 200, ms: r.latencyMs, tokens: tokensOf(r.usage), note: `回复 ${r.text.length} 字符，finish=${r.finishReason}` };
      });
    }

    for (const [id, m] of [["R04", MODEL], ["R05", ALT]] as const) {
      await check(id, `流式对话（SSE） · ${m}`, async () => {
        const t0 = Date.now();
        let deltas = 0;
        let first = 0;
        let done: { text: string; usage: Usage | null; finishReason: string } | null = null;
        // 推理模型首字节可能超过默认 60 秒，流式项放宽到 120 秒
        for await (const ev of relay(120_000).stream({ model: m, messages: ask("从 1 数到 10，用逗号分隔。"), maxTokens: 200 })) {
          if (ev.type === "delta") {
            if (!deltas) first = Date.now() - t0;
            deltas++;
          } else done = ev.response;
        }
        const ok = !!done && deltas > 0 && done.text.length > 0;
        return { ok, status: 200, tokens: done ? tokensOf(done.usage) : undefined, note: `${deltas} 个增量，首个增量 ${first} ms，${done?.usage ? "带 usage" : "没有返回 usage"}，finish=${done?.finishReason ?? "-"}` };
      });
    }

    await check("R06", "错误 Key → 鉴权失败（401/403）", async () => {
      try {
        await relay(30_000, BAD_KEY).chat({ model: MODEL, messages: ask("ping"), maxTokens: 10 });
        return { ok: false, status: 200, note: "错误 Key 居然成功了" };
      } catch (e) {
        return errOutcome(e, "auth");
      }
    });

    await check("R07", "错误 Base URL（路径不对）→ 明确报错", async () => {
      const wrong = `${new URL(BASE).origin}/eg-wrong-path/v1`;
      try {
        await relay(30_000, KEY, wrong).chat({ model: MODEL, messages: ask("ping"), maxTokens: 10 });
        return { ok: false, status: 200, note: "错误地址居然成功了" };
      } catch (e) {
        const ok = e instanceof ProviderError && e.code !== "aborted";
        return { ok, status: e instanceof ProviderError ? (e.status ?? e.code) : "异常", note: `得到 ${describe(e)}` };
      }
    });

    await check("R08", "错误 Base URL（域名不存在）→ 网络错误", async () => {
      try {
        await relay(15_000, KEY, "https://eg-nonexistent.invalid/v1").chat({ model: MODEL, messages: ask("ping"), maxTokens: 10 });
        return { ok: false, status: 200, note: "不存在的域名居然成功了" };
      } catch (e) {
        return errOutcome(e, "network");
      }
    });

    await check("R09", "不存在的模型（gpt-5.5，列表里有但调用 404）", async () => {
      try {
        await relay().chat({ model: "gpt-5.5", messages: ask("ping"), maxTokens: 10 });
        return { ok: true, status: 200, note: "这次调用成功了（中转站已修复该型号）" };
      } catch (e) {
        const ok = e instanceof ProviderError && (e.code === "not_found" || e.code === "bad_request");
        return { ok, status: e instanceof ProviderError ? (e.status ?? e.code) : "异常", note: `得到 ${describe(e)}，路由会换下一个模型` };
      }
    });

    await check("R10", "本机假服务 429 → rate_limit（可重试）", async () => {
      try {
        await relay(10_000, "", `${local.url}/r429/v1`).chat({ model: "x", messages: ask("ping") });
        return { ok: false, status: 200, note: "应当失败" };
      } catch (e) {
        return errOutcome(e, "rate_limit", 429);
      }
    });

    await check("R11", "本机假服务 500 → server（可重试）", async () => {
      try {
        await relay(10_000, "", `${local.url}/r500/v1`).chat({ model: "x", messages: ask("ping") });
        return { ok: false, status: 200, note: "应当失败" };
      } catch (e) {
        return errOutcome(e, "server", 500);
      }
    });

    await check("R12", "本机假服务不响应 → 1 秒超时", async () => {
      try {
        await relay(1_000, "", `${local.url}/slow/v1`).chat({ model: "x", messages: ask("ping") });
        return { ok: false, status: 200, note: "应当超时" };
      } catch (e) {
        return errOutcome(e, "timeout");
      }
    });

    // ---- 降级链：每一步的失败原因都记下来，最后落到具体模型 ----
    const providers: Record<string, LLMProvider> = {
      "custom:badkey": relay(30_000, BAD_KEY, BASE, "custom:badkey"),
      "custom:r429": relay(10_000, "", `${local.url}/r429/v1`, "custom:r429"),
      "custom:r502": relay(10_000, "", `${local.url}/r502/v1`, "custom:r502"),
      "custom:slow": relay(1_000, "", `${local.url}/slow/v1`, "custom:slow"),
      "custom:relay": relay(),
    };
    const chainRoute = (ids: string[]): RouteDecision =>
      ({ primary: entry(ids[0]!, "primary"), chain: ids.map((id, i) => entry(id, i ? "fallback" : "primary")), reasons: [], excluded: [] }) as unknown as RouteDecision;
    const viaChain = async (ids: string[]) => {
      const call = routedLlm(chainRoute(ids), async (e) => providers[e.provider]!, new HealthTracker());
      return call({ purpose: "answer", messages: ask("用一句话回答：天空为什么是蓝色的？"), maxTokens: 200 });
    };
    const chainNote = (r: Awaited<ReturnType<typeof viaChain>>) =>
      [...(r.fallbacks ?? []).map((f) => `${displayModel(f.profileId)} 失败：${f.reason}`), `降级到 ${displayModel(r.profileId)}`].join(" → ");

    await check("R13", "降级：错误 Key → 429 → 502 → 中转站主模型", async () => {
      const r = await viaChain(["custom:badkey/" + MODEL, "custom:r429/x", "custom:r502/x", `custom:relay/${MODEL}`]);
      const ok = r.profileId === `custom:relay/${MODEL}` && r.fallbacks?.length === 3;
      return { ok, status: 200, ms: r.latencyMs, tokens: tokensOf(r.usage), note: chainNote(r) };
    });

    await check("R14", "降级：超时 → 2 秒后重试一次 → 仍超时 → 中转站备用模型", async () => {
      const t0 = Date.now();
      const r = await viaChain(["custom:slow/x", `custom:relay/${ALT}`]);
      const ms = Date.now() - t0;
      // retries 统计整次调用：慢节点必定重试 1 次；中转站本身偶尔也会超时再重试，所以只要求 ≥ 1
      const slowRetried = r.fallbacks?.[0]?.reason.includes("已重试 1 次") ?? false;
      const ok = r.profileId === `custom:relay/${ALT}` && slowRetried && (r.retries ?? 0) >= 1 && ms >= 4_000;
      return { ok, status: 200, ms, tokens: tokensOf(r.usage), note: `${chainNote(r)}；本次调用共重试 ${r.retries ?? 0} 次` };
    });

    await check("R15", "降级：gpt-5.5 返回 404 → 中转站备用模型", async () => {
      const r = await viaChain(["custom:relay/gpt-5.5", `custom:relay/${ALT}`]);
      return { ok: r.profileId === `custom:relay/${ALT}` && r.fallbacks?.length === 1, status: 200, ms: r.latencyMs, tokens: tokensOf(r.usage), note: chainNote(r) };
    });

    await check("R16", "整条链都失败 → 逐个写明原因", async () => {
      try {
        await viaChain(["custom:r429/x", "custom:r502/x"]);
        return { ok: false, status: 200, note: "应当失败" };
      } catch (e) {
        const ok = e instanceof RouteExhaustedError && e.attempts.length === 2;
        return { ok, status: "route_exhausted", note: e instanceof RouteExhaustedError ? e.message : describe(e) };
      }
    });

    // ---- 应用引擎：路由在中转站模型里选，Agent 运行时跑完整任务 ----
    await check("R17", "自动路由：只有中转站可用时选中中转站模型并完成任务", async () => {
      const { r, summary } = await runTask("用两三句话介绍一下什么是 TCP 三次握手。");
      const used = summary?.used ?? "";
      const ok = r.status === "completed" && used.startsWith("custom:relay/") && r.summary.length > 0;
      const line = summary ? routeLineText(summary, null) : "无路由记录";
      return { ok, status: r.status, tokens: summary?.tokens, note: `${line}；候选 ${summary?.candidates.map((c) => displayModel(c.profileId)).join("、") ?? "-"}` };
    });

    // 锁定自动路由不会首选的主模型，才能看出锁定生效
    await check("R18", `锁定模型：输入框锁定 ${MODEL}，跳过路由`, async () => {
      const { r, summary } = await runTask("用一句话说明 HTTP 和 HTTPS 的区别。", { lock: `custom:relay/${MODEL}` });
      const ok = r.status === "completed" && !!summary?.locked && summary.used === `custom:relay/${MODEL}` && summary.candidates.length === 1;
      return { ok, status: r.status, tokens: summary?.tokens, note: summary ? routeLineText(summary, null) : "无路由记录" };
    });

    await check("R19", "MCP：本机 stdio 服务器 + 白名单，真实模型规划并调用工具", async () => {
      const server = fileURLToPath(new URL("../tests/fixtures/fake-mcp-server.mjs", import.meta.url));
      const { client, transport } = await connectStdioServer({ command: process.execPath, args: [server] }, { timeoutMs: 10_000 });
      try {
        const infos = await client.listTools();
        const { tools, skipped } = mcpTools(client, infos, { server: "fake", allowTools: ["echo"], trustAnnotations: true });
        const { r, events, summary } = await runTask("请调用 mcp__fake__echo 工具，参数 text 设为 eg-ping-42，然后告诉我工具返回了什么。", { tools });
        const results = events.filter((e): e is Extract<AgentEvent, { type: "tool_result" }> => e.type === "tool_result");
        const echoed = results.some((e) => e.step.tool === "mcp__fake__echo" && e.ok && e.content.includes("eg-ping-42"));
        const ok = r.status === "completed" && echoed && skipped.some((s) => s.name === "env_probe");
        return {
          ok,
          status: r.status,
          tokens: summary?.tokens,
          note: `工具 ${infos.length} 个，白名单外跳过 ${skipped.map((s) => s.name).join("、")}；工具调用 ${results.length} 次，回显${echoed ? "正确" : "不正确"}；${summary ? routeLineText(summary, null) : ""}`,
        };
      } finally {
        await transport.close();
      }
    });
  } finally {
    await local.close();
  }

  const prev: Row[] = ONLY.size && existsSync(RESULT_FILE) ? (JSON.parse(readFileSync(RESULT_FILE, "utf8")) as Row[]) : [];
  const merged = [...prev.filter((p) => !rows.some((r) => r.id === p.id)), ...rows].sort((a, b) => a.id.localeCompare(b.id));
  writeFileSync(RESULT_FILE, JSON.stringify(merged, null, 2), { mode: 0o600 });
  const failed = rows.filter((r) => !r.ok).length;
  console.log(`\n合计 ${rows.length} 项：通过 ${rows.length - failed}，失败 ${failed}`);
  process.exitCode = failed ? 1 : 0;
}

void main();

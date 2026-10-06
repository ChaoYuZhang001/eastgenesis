// CLI 原型：直接调用 LLMProvider，验证适配器。Key 只从环境变量读取，不打印、不落盘。
//   pnpm --silent eg providers
//   pnpm --silent eg chat -p anthropic "你好"
//   pnpm --silent eg chat -p custom:relay --base-url https://relay.example.com/v1 --key-env RELAY_API_KEY -m gpt-4o-mini --stream "你好"
// 使用 --silent 是为了让 `eg route --json` 可以直接重定向为合法 JSON 文件。
import { parseArgs } from "node:util";
import {
  BUILTIN_PROVIDERS,
  ProviderError,
  adapterRecoveryContract,
  createProvider,
  type ChatMessage,
  type ChatResponse,
  type FetchLike,
  type ProviderConfig,
} from "../core/llm";
import { EnvSecretSource } from "../core/secrets";
import { redact } from "../core/redact";
import { readFileSync } from "node:fs";
import { DecisionLayer } from "../decision/decision-layer";
import { BENCH_SCENARIOS, formatBench, runBench } from "../decision/bench";
import { evaluate, formatReport, type RoutingCase } from "../decision/eval";
import { defaultAvailability, replayRouteDecision, routeTraceText, type LatencyPref, type Preference, type RouteDecision } from "../decision/router";

export interface CliIO {
  env: Record<string, string | undefined>;
  fetch?: FetchLike;
  out: (s: string) => void;
  err: (s: string) => void;
}

const USAGE = `用法:
  eg providers                         列出内置 Provider 及 Key 是否就绪
  eg providers --json                  输出脱敏的 Provider / 恢复契约清单
  eg chat [选项] <消息>                 发送一次对话
  eg route [选项] <任务描述>            显示任务分类、路由决策和降级链（不调用模型）
  eg route-replay <json>                用当前能力矩阵回放一条脱敏路由记录
  eg eval-routing [--holdout] [--failures] [--json] 评估标注样例的路由准确率
  eg bench [--json]                    内部基准：智能路由对比固定模型（Markdown 表格，不调用模型）
选项:
  -p, --provider <id>      openai | anthropic | google | deepseek | qwen | kimi | ollama | custom:<名称>（默认 openai）
  -m, --model <name>       模型名（默认取 Provider 的 defaultModel）
  -s, --system <text>      system 提示
      --stream             流式输出
      --base-url <url>     自定义端点（custom:* 必填；qwen / kimi 国际站也用它指定）
      --key-env <NAME>     custom:* 读取 Key 的环境变量名
      --protocol <p>       custom:* 的协议：openai（默认）| anthropic
      --json               chat：以 JSON 输出完整响应；route：以 JSON 输出路由决策
      --pref <p>           route：economy | balanced | best（默认 balanced）
      --latency <l>        route：fast | normal | patient（默认 normal）
      --max-cost <n>       route：成本上限 1–5
      --failures           eval-routing：列出失败样例
      --holdout            eval-routing：使用独立 hold-out 样例集
`;

export async function runCli(argv: string[], io: CliIO): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        provider: { type: "string", short: "p", default: "openai" },
        model: { type: "string", short: "m" },
        system: { type: "string", short: "s" },
        stream: { type: "boolean", default: false },
        "base-url": { type: "string" },
        "key-env": { type: "string" },
        protocol: { type: "string" },
        json: { type: "boolean", default: false },
        pref: { type: "string" },
        latency: { type: "string" },
        "max-cost": { type: "string" },
        failures: { type: "boolean", default: false },
        holdout: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (e) {
    io.err(`${(e as Error).message}\n\n${USAGE}`);
    return 2;
  }
  const { values: v, positionals } = parsed;
  const [cmd, ...rest] = positionals;
  if (v.help || !cmd) {
    io.out(USAGE);
    return cmd || v.help ? 0 : 2;
  }

  const secrets = new EnvSecretSource(io.env);

  if (cmd === "providers") {
    if (v.json) {
      const rows = BUILTIN_PROVIDERS.map((p) => {
        const envName = p.apiKeyRef?.slice(4) ?? null;
        const configured = envName ? Boolean(io.env[envName]?.trim()) : true;
        return {
          id: p.id,
          kind: p.kind,
          keyEnv: envName,
          configured,
          readiness: envName ? (configured ? "ready" : "missing_key") : "local",
          defaultModel: p.defaultModel,
          recovery: adapterRecoveryContract(p.id),
        };
      });
      io.out(`${JSON.stringify(rows, null, 2)}\n`);
      return 0;
    }
    for (const p of BUILTIN_PROVIDERS) {
      // 只打印环境变量名和是否存在，不打印值
      const envName = p.apiKeyRef?.slice(4) ?? "-";
      const ready = !p.apiKeyRef ? "本机服务，不需要 Key" : io.env[envName]?.trim() ? "已配置" : "未配置";
      io.out(`${p.id.padEnd(10)} ${p.kind.padEnd(18)} ${envName.padEnd(18)} ${ready}  默认模型 ${p.defaultModel}\n`);
    }
    return 0;
  }

  if (cmd === "eval-routing" || cmd === "bench") {
    const fixtureName = cmd === "eval-routing" && v.holdout ? "routing_cases_holdout.json" : "routing_cases.json";
    const raw = JSON.parse(readFileSync(new URL(`../../tests/fixtures/${fixtureName}`, import.meta.url), "utf8"));
    const cases = raw.cases as RoutingCase[];
    if (v.json) {
      if (cmd === "eval-routing") {
        io.out(`${JSON.stringify({ schemaVersion: 1, kind: "routing-eval", dataset: v.holdout ? "holdout" : "primary", report: evaluate(cases) }, null, 2)}\n`);
      } else {
        io.out(`${JSON.stringify({
          schemaVersion: 1,
          kind: "routing-bench",
          caseCount: cases.length,
          scenarios: BENCH_SCENARIOS.map((s) => ({ ...s, providers: [...s.providers], rows: runBench(cases, s) })),
        }, null, 2)}\n`);
      }
      return 0;
    }
    io.out(`${cmd === "bench" ? formatBench(cases) : formatReport(evaluate(cases), { failures: v.failures })}\n`);
    return 0;
  }

  if (cmd === "route") {
    const text = rest.join(" ").trim();
    if (!text) {
      io.err("缺少任务描述\n");
      return 2;
    }
    const pref = v.pref ?? "balanced";
    const latency = v.latency ?? "normal";
    if (!["economy", "balanced", "best"].includes(pref) || !["fast", "normal", "patient"].includes(latency)) {
      io.err("--pref 只能是 economy | balanced | best，--latency 只能是 fast | normal | patient\n");
      return 2;
    }
    const maxCost = v["max-cost"] === undefined ? undefined : Number(v["max-cost"]);
    if (maxCost !== undefined && !(Number.isInteger(maxCost) && maxCost >= 1 && maxCost <= 5)) {
      io.err("--max-cost 应为 1–5 的整数\n");
      return 2;
    }
    // 配置了 TYPESAFE_API_KEY 时第 1 级会调用 Jev；否则全部由规则决策
    const { decision } = await DecisionLayer.fromEnv(io.env).routeTask({
      text,
      preference: pref as Preference,
      latency: latency as LatencyPref,
      maxCostTier: maxCost,
    });
    if (v.json) {
      // RouteDecision 只含分类、模型档案和脱敏 trace，不包含任务正文或凭据；
      // 结构化输出供 CI 回放与策略版本比较使用。
      io.out(`${JSON.stringify(decision, null, 2)}\n`);
      return decision.primary ? 0 : 1;
    }
    if (decision.trace) {
      io.out(`路由策略：${decision.trace.policyVersion}\n`);
      io.out(`输入摘要：${routeTraceText(decision.trace)}\n`);
    }
    for (const r of decision.reasons) io.out(`${r}\n`);
    return decision.primary ? 0 : 1;
  }

  if (cmd === "route-replay") {
    const file = rest[0];
    if (!file || rest.length !== 1) {
      io.err("route-replay 需要一个路由 JSON 文件路径\n");
      return 2;
    }
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
      const source = parsed && typeof parsed === "object" && "decision" in parsed ? (parsed as { decision: unknown }).decision : parsed;
      if (!source || typeof source !== "object" || !("classification" in source) || !("chain" in source) || !("trace" in source)) {
        io.err("路由 JSON 缺少 classification、chain 或 trace\n");
        return 2;
      }
      const result = replayRouteDecision(source as RouteDecision, { availability: defaultAvailability(io.env) });
      io.out(`${JSON.stringify(result, null, 2)}\n`);
      return 0;
    } catch (e) {
      io.err(`无法回放路由：${redact(String(e))}\n`);
      return 2;
    }
  }

  if (cmd !== "chat") {
    io.err(`未知命令：${cmd}\n\n${USAGE}`);
    return 2;
  }
  const prompt = rest.join(" ").trim();
  if (!prompt) {
    io.err("缺少消息内容\n");
    return 2;
  }

  let cfg: ProviderConfig | undefined = BUILTIN_PROVIDERS.find((p) => p.id === v.provider);
  if (v.provider!.startsWith("custom:")) {
    if (!v["base-url"] || !v["key-env"]) {
      io.err("custom:* 需要同时提供 --base-url 和 --key-env\n");
      return 2;
    }
    const protocol = v.protocol ?? "openai";
    if (protocol !== "openai" && protocol !== "anthropic") {
      io.err("--protocol 只能是 openai 或 anthropic\n");
      return 2;
    }
    const kind = protocol === "anthropic" ? "anthropic" : "openai-compatible";
    cfg = { id: v.provider!, kind, baseUrl: v["base-url"], apiKeyRef: `env:${v["key-env"]}` };
  } else if (cfg && v["base-url"]) {
    cfg = { ...cfg, baseUrl: v["base-url"] };
  }
  if (!cfg) {
    io.err(`未知 Provider：${v.provider}\n`);
    return 2;
  }
  const model = v.model ?? cfg.defaultModel;
  if (!model) {
    io.err("请用 --model 指定模型\n");
    return 2;
  }

  const messages: ChatMessage[] = [];
  if (v.system) messages.push({ role: "system", content: v.system });
  messages.push({ role: "user", content: prompt });

  try {
    const provider = await createProvider(cfg, secrets, { fetch: io.fetch });
    let resp: ChatResponse | undefined;
    if (v.stream) {
      for await (const ev of provider.stream({ model, messages })) {
        if (ev.type === "delta") io.out(ev.text);
        else resp = ev.response;
      }
      io.out("\n");
    } else {
      resp = await provider.chat({ model, messages });
      if (!v.json) io.out(`${resp.text}\n`);
    }
    if (resp && v.json) io.out(`${JSON.stringify(resp, null, 2)}\n`);
    // 透明度优先：每次调用都说明走了哪个 Provider、哪个模型、花了多少
    if (resp) io.err(`— ${formatMeta(resp)}\n`);
    return 0;
  } catch (e) {
    if (e instanceof ProviderError) {
      io.err(`错误 [${e.providerId}] ${e.code}：${e.message}${e.detail ? `\n  ${e.detail}` : ""}\n`);
      return e.code === "config" || e.code === "auth" ? 2 : 1;
    }
    io.err(`错误：${redact(String(e))}\n`);
    return 1;
  }
}

export function formatMeta(r: ChatResponse): string {
  const tokens = r.usage ? `${r.usage.inputTokens} → ${r.usage.outputTokens} tokens` : "tokens 未知";
  return `${r.providerId} · ${r.model} · ${r.latencyMs}ms · ${tokens} · ${r.finishReason}`;
}

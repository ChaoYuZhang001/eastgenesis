// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "@/cli/eg";
import type { FetchLike } from "@/core/llm";

const KEY = "sk-cli-0123456789abcdefghij";

function io(env: Record<string, string>, fetch?: FetchLike) {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { env, fetch, out: (s: string) => out.push(s), err: (s: string) => err.push(s) }, out, err };
}

const okFetch: FetchLike = async () =>
  new Response(JSON.stringify({ model: "gpt-4o-mini", choices: [{ message: { content: "你好！" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2 } }), { status: 200 });

describe("CLI 原型", () => {
  it("chat 输出回复，并在 stderr 给出 Provider、模型、耗时和用量", async () => {
    const t = io({ OPENAI_API_KEY: KEY }, okFetch);
    const code = await runCli(["chat", "你好"], t.io);
    expect(code).toBe(0);
    expect(t.out.join("")).toBe("你好！\n");
    expect(t.err.join("")).toMatch(/openai · gpt-4o-mini · \d+ms · 3 → 2 tokens · stop/);
  });

  it("任何输出都不包含 Key", async () => {
    const leaky: FetchLike = async () => new Response(JSON.stringify({ error: `bad key ${KEY}` }), { status: 401 });
    const t = io({ OPENAI_API_KEY: KEY }, leaky);
    const code = await runCli(["chat", "hi"], t.io);
    expect(code).toBe(2);
    expect(t.err.join("")).toContain("auth");
    expect([...t.out, ...t.err].join("")).not.toContain(KEY);
  });

  it("providers 只显示是否配置，不显示 Key", async () => {
    const t = io({ OPENAI_API_KEY: KEY });
    expect(await runCli(["providers"], t.io)).toBe(0);
    const s = t.out.join("");
    expect(s).toMatch(/openai .*已配置/);
    expect(s).toMatch(/anthropic .*未配置/);
    expect(s).toMatch(/qwen .*DASHSCOPE_API_KEY .*未配置/);
    expect(s).toMatch(/ollama .*本机服务，不需要 Key/);
    expect(s.trim().split("\n")).toHaveLength(7);
    expect(s).not.toContain(KEY);
  });

  it("providers --json 输出脱敏的协议、就绪状态和恢复契约", async () => {
    const t = io({ OPENAI_API_KEY: KEY });
    expect(await runCli(["providers", "--json"], t.io)).toBe(0);
    const rows = JSON.parse(t.out.join("")) as Array<{
      id: string;
      kind: string;
      keyEnv: string | null;
      configured: boolean;
      readiness: string;
      recovery?: { abortSignal?: boolean; streamTerminal?: string; partialOutput?: boolean; normalizedErrors?: boolean };
    }>;
    expect(rows).toHaveLength(7);
    expect(rows.find((row) => row.id === "openai")).toMatchObject({
      kind: "openai",
      keyEnv: "OPENAI_API_KEY",
      configured: true,
      readiness: "ready",
      recovery: { abortSignal: true, streamTerminal: "sse_done", partialOutput: true, normalizedErrors: true },
    });
    expect(rows.find((row) => row.id === "anthropic")).toMatchObject({
      kind: "anthropic",
      keyEnv: "ANTHROPIC_API_KEY",
      configured: false,
      readiness: "missing_key",
      recovery: { abortSignal: true, streamTerminal: "message_stop", partialOutput: true, normalizedErrors: true },
    });
    expect(rows.find((row) => row.id === "ollama")).toMatchObject({ keyEnv: null, configured: true, readiness: "local" });
    expect(t.out.join("")).not.toContain(KEY);
  });

  it("custom:* 缺少 --base-url 或 --key-env 时退出码 2", async () => {
    const t = io({});
    expect(await runCli(["chat", "-p", "custom:relay", "hi"], t.io)).toBe(2);
  });

  it("custom:* 走兼容端点", async () => {
    let url = "";
    const f: FetchLike = async (u, i) => {
      url = u;
      return okFetch(u, i);
    };
    const t = io({ RELAY_KEY: "relay-secret-value" }, f);
    const code = await runCli(["chat", "-p", "custom:relay", "--base-url", "https://relay.example.com/v1", "--key-env", "RELAY_KEY", "-m", "gpt-4o-mini", "hi"], t.io);
    expect(code).toBe(0);
    expect(url).toBe("https://relay.example.com/v1/chat/completions");
  });

  it("custom:* 用 --protocol anthropic 走 Messages 接口和 x-api-key", async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const f: FetchLike = async (u, i) => {
      seen.push({ url: u, headers: i.headers as Record<string, string> });
      return new Response(JSON.stringify({ model: "claude-x", content: [{ type: "text", text: "好" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 });
    };
    const t = io({ RELAY_KEY: "relay-secret-value" }, f);
    const args = ["chat", "-p", "custom:relay", "--protocol", "anthropic", "--base-url", "https://relay.example.com/v1", "--key-env", "RELAY_KEY", "-m", "claude-x", "hi"];
    expect(await runCli(args, t.io)).toBe(0);
    expect(t.out.join("")).toBe("好\n");
    expect(seen[0].url).toBe("https://relay.example.com/v1/messages");
    expect(seen[0].headers["x-api-key"]).toBe("relay-secret-value");
    expect(seen[0].headers).not.toHaveProperty("authorization");
    expect(await runCli(["chat", "-p", "custom:relay", "--protocol", "grpc", "--base-url", "https://x.com/v1", "--key-env", "RELAY_KEY", "hi"], io({}).io)).toBe(2);
  });

  it("route 显示决策来源、任务类型和降级链，不输出 Key", async () => {
    const t = io({ OPENAI_API_KEY: KEY });
    expect(await runCli(["route", "--pref", "economy", "What's", "the", "weather", "today?"], t.io)).toBe(0);
    const s = t.out.join("");
    expect(s).toMatch(/决策来源：rules（第 3 级/);
    expect(s).toMatch(/任务类型：工具调用/);
    expect(s).toMatch(/工作能力：/);
    expect(s).toMatch(/路由策略：m22\.4/);
    expect(s).toMatch(/输入摘要：正文 \d+ 字/);
    expect(s).toMatch(/主模型 openai\//);
    expect(s).not.toContain(KEY);
  });

  it("route --json 输出脱敏追踪信息，不包含任务正文或 Key", async () => {
    const t = io({ OPENAI_API_KEY: KEY });
    expect(await runCli(["route", "--json", "这是一段私密任务"], t.io)).toBe(0);
    const s = t.out.join("");
    const parsed = JSON.parse(s) as { trace?: { policyVersion?: string; input?: { textChars?: number } } };
    expect(parsed.trace?.policyVersion).toBe("m22.4");
    expect(parsed.trace?.input?.textChars).toBe(8);
    expect(s).not.toContain("这是一段私密任务");
    expect(s).not.toContain(KEY);
  });

  it("route-replay 使用脱敏 JSON 回放当前路由，不读取原始正文", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eg-route-replay-"));
    const file = join(dir, "route.json");
    const source = io({ OPENAI_API_KEY: KEY });
    expect(await runCli(["route", "--json", "一段不会写入回放文件的任务"], source.io)).toBe(0);
    writeFileSync(file, source.out.join(""), "utf8");
    try {
      const replay = io({ OPENAI_API_KEY: KEY });
      expect(await runCli(["route-replay", file], replay.io)).toBe(0);
      const output = JSON.parse(replay.out.join("")) as {
        changed?: boolean;
        sourceSnapshotAvailable?: boolean;
        sourceSnapshotConsistent?: boolean;
        sourceTrace?: { input?: { textChars?: number }; snapshot?: { profileSetId?: string } };
      };
      expect(output.changed).toBe(false);
      expect(output.sourceSnapshotAvailable).toBe(true);
      expect(output.sourceSnapshotConsistent).toBe(true);
      expect(output.sourceTrace?.input?.textChars).toBe(13);
      expect(output.sourceTrace?.snapshot?.profileSetId).toMatch(/^[0-9a-f]{8}$/);
      expect(replay.out.join("")).not.toContain("一段不会写入回放文件的任务");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("route 没有可用模型时退出码 1；参数非法时退出码 2", async () => {
    expect(await runCli(["route", "hi"], io({}).io)).toBe(1);
    expect(await runCli(["route", "--pref", "cheap", "hi"], io({}).io)).toBe(2);
    expect(await runCli(["route", "--max-cost", "9", "hi"], io({}).io)).toBe(2);
  });

  it("eval-routing 输出准确率", async () => {
    const t = io({});
    expect(await runCli(["eval-routing"], t.io)).toBe(0);
    expect(t.out.join("")).toMatch(/路由准确率（主类型 \+ 硬性能力）：\d+\.\d%/);
  });

  it("eval-routing --json 输出可供门禁消费的脱敏聚合报告", async () => {
    const t = io({});
    expect(await runCli(["eval-routing", "--json"], t.io)).toBe(0);
    const report = JSON.parse(t.out.join("")) as { schemaVersion: number; kind: string; report: { total: number; routingAccuracy: number; failures: unknown[] } };
    expect(report).toMatchObject({ schemaVersion: 1, kind: "routing-eval", dataset: "primary" });
    expect(report.report.total).toBe(50);
    expect(report.report.routingAccuracy).toBeGreaterThanOrEqual(0.7);
    expect(report.report.failures.every((failure) => !JSON.stringify(failure).includes("把"))).toBe(true);
  });

  it("eval-routing --holdout 使用独立样例集并输出数据集标记", async () => {
    const t = io({});
    expect(await runCli(["eval-routing", "--holdout", "--json"], t.io)).toBe(0);
    const report = JSON.parse(t.out.join("")) as { dataset: string; report: { total: number; routingAccuracy: number } };
    expect(report.dataset).toBe("holdout");
    expect(report.report.total).toBe(54);
    expect(report.report.routingAccuracy).toBeGreaterThanOrEqual(0.7);
  });

  it("bench 输出两个场景的对比表", async () => {
    const t = io({});
    expect(await runCli(["bench"], t.io)).toBe(0);
    const out = t.out.join("");
    expect(out).toContain("场景 A");
    expect(out).toContain("场景 B");
    expect(out).toContain("智能路由（平衡）");
    expect(out).toContain("智能路由（省钱）");
    expect(out).toContain("固定旗舰");
    expect(out).toContain("固定最便宜");
  });

  it("bench --json 输出两个 Provider 配置场景和智能路由聚合行", async () => {
    const t = io({});
    expect(await runCli(["bench", "--json"], t.io)).toBe(0);
    const report = JSON.parse(t.out.join("")) as { schemaVersion: number; kind: string; scenarios: Array<{ id: string; rows: Array<{ model: string | null }> }> };
    expect(report).toMatchObject({ schemaVersion: 1, kind: "routing-bench" });
    expect(report.scenarios.map((scenario) => scenario.id)).toEqual(["A", "B"]);
    expect(report.scenarios.every((scenario) => scenario.rows.some((row) => row.model === null))).toBe(true);
  });

  it("未知命令退出码 2", async () => {
    expect(await runCli(["nope"], io({}).io)).toBe(2);
  });
});

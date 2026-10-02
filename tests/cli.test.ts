// @vitest-environment node
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
    expect(s).toMatch(/主模型 openai\//);
    expect(s).not.toContain(KEY);
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

  it("未知命令退出码 2", async () => {
    expect(await runCli(["nope"], io({}).io)).toBe(2);
  });
});

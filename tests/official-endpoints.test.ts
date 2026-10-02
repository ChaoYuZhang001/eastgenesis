// @vitest-environment node
// 官方端点表：TS 与 Rust 白名单一致；各家请求差异；本机服务不带 Key。
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { BUILTIN_PROVIDERS, OFFICIAL_ENDPOINTS, OFFICIAL_IDS, createProvider, type FetchLike, type ProviderConfig } from "@/core/llm";
import { EnvSecretSource } from "@/core/secrets";
import { MODEL_PROFILES } from "@/decision";

const KEY = "sk-official-0123456789abcdef";
const root = resolve(__dirname, "..");

/** 从 providers.rs 读出 OFFICIAL_BASES，避免两边各改各的 */
function rustBases(): Array<[string, string[]]> {
  const src = readFileSync(join(root, "crates/eg-core/src/providers.rs"), "utf8");
  const block = src.match(/pub const OFFICIAL_BASES[^=]*=\s*&\[([\s\S]*?)\n\];/)?.[1];
  if (!block) throw new Error("providers.rs 里没有找到 OFFICIAL_BASES");
  return [...block.matchAll(/\("([a-z]+)",\s*&\[([^\]]*)\]\)/g)].map((m) => [m[1], [...m[2].matchAll(/"([^"]+)"/g)].map((x) => x[1])]);
}

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function capture(make: () => Response): { fetch: FetchLike; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    return make();
  };
  return { fetch, calls };
}

const reply = () =>
  new Response(JSON.stringify({ choices: [{ message: { content: "好" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const builtin = (id: string): ProviderConfig => BUILTIN_PROVIDERS.find((p) => p.id === id)!;
const MESSAGES = [{ role: "user" as const, content: "hi" }];

describe("官方端点表", () => {
  it("与 Rust 侧 OFFICIAL_BASES 完全一致（ID、顺序、每个地域的地址）", () => {
    const rust = rustBases();
    expect(rust.map(([id]) => id)).toEqual([...OFFICIAL_IDS]);
    for (const [id, bases] of rust) {
      expect(OFFICIAL_ENDPOINTS.find((e) => e.id === id)!.regions.map((r) => r.baseUrl)).toEqual(bases);
    }
  });

  it("内置配置：7 家都有，只有 Ollama 不需要 Key；默认型号在能力矩阵里且已启用", () => {
    expect(BUILTIN_PROVIDERS.map((p) => p.id)).toEqual([...OFFICIAL_IDS]);
    expect(BUILTIN_PROVIDERS.filter((p) => !p.apiKeyRef).map((p) => p.id)).toEqual(["ollama"]);
    for (const p of BUILTIN_PROVIDERS) {
      const profile = MODEL_PROFILES.find((m) => m.id === `${p.id}/${p.defaultModel}`);
      expect(profile?.enabled, `${p.id}/${p.defaultModel}`).toBe(true);
    }
  });
});

describe("各家请求差异", () => {
  const cases: Array<{ id: string; env: string; url: string; extra: Record<string, unknown> }> = [
    { id: "openai", env: "OPENAI_API_KEY", url: "https://api.openai.com/v1", extra: { max_completion_tokens: 64, temperature: 0.2 } },
    { id: "google", env: "GEMINI_API_KEY", url: "https://generativelanguage.googleapis.com/v1beta/openai", extra: { max_tokens: 64 } },
    { id: "deepseek", env: "DEEPSEEK_API_KEY", url: "https://api.deepseek.com", extra: { max_tokens: 64, temperature: 0.2 } },
    { id: "qwen", env: "DASHSCOPE_API_KEY", url: "https://dashscope.aliyuncs.com/compatible-mode/v1", extra: { max_tokens: 64, temperature: 0.2 } },
    { id: "kimi", env: "MOONSHOT_API_KEY", url: "https://api.moonshot.cn/v1", extra: { max_completion_tokens: 64 } },
  ];

  it.each(cases)("$id：地址、鉴权头和参数名", async ({ id, env, url, extra }) => {
    const { fetch, calls } = capture(reply);
    const p = await createProvider(builtin(id), new EnvSecretSource({ [env]: KEY }), { fetch });
    await p.chat({ model: "m", messages: MESSAGES, maxTokens: 64, temperature: 0.2 });
    expect(calls[0].url).toBe(`${url}/chat/completions`);
    expect(calls[0].headers.authorization).toBe(`Bearer ${KEY}`);
    expect(calls[0].body).toEqual({ model: "m", messages: MESSAGES, ...extra });
  });

  it("Gemini 流式请求不带 stream_options；没有用量时 usage 为 null", async () => {
    const sse = 'data: {"choices":[{"delta":{"content":"好"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
    const { fetch, calls } = capture(() => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }));
    const p = await createProvider(builtin("google"), new EnvSecretSource({ GEMINI_API_KEY: KEY }), { fetch });
    let done;
    for await (const ev of p.stream({ model: "m", messages: MESSAGES })) if (ev.type === "done") done = ev.response;
    expect(calls[0].body).toEqual({ model: "m", messages: MESSAGES, stream: true });
    expect(done).toMatchObject({ text: "好", usage: null, finishReason: "stop" });
  });
});

describe("本机服务", () => {
  it("Ollama 不需要 Key，请求不带 authorization", async () => {
    const { fetch, calls } = capture(reply);
    const p = await createProvider(builtin("ollama"), new EnvSecretSource({}), { fetch });
    const r = await p.chat({ model: "qwen3:8b", messages: MESSAGES });
    expect(r.text).toBe("好");
    expect(calls[0].url).toBe("http://127.0.0.1:11434/v1/chat/completions");
    expect(calls[0].headers).not.toHaveProperty("authorization");
  });

  it("不配 Key 只允许本机地址", async () => {
    const env = new EnvSecretSource({});
    await expect(createProvider({ ...builtin("ollama"), baseUrl: "https://ollama.example.com/v1" }, env)).rejects.toMatchObject({ code: "config" });
    await expect(createProvider({ id: "custom:relay", kind: "openai-compatible", baseUrl: "https://relay.example.com/v1" }, env)).rejects.toMatchObject({ code: "config" });
    await expect(createProvider({ id: "custom:lm", kind: "openai-compatible", baseUrl: "http://localhost:1234/v1" }, env)).resolves.toMatchObject({ id: "custom:lm" });
  });
});

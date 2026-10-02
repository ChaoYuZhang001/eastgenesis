import { createMockBackend, connectBackendServer, proxiedFetch, ProxyError, PROXY_PLACEHOLDER_KEY, mockOptionsFromQuery } from "@/platform";
import { validateBaseUrl, validateCustom } from "@/platform/mock-rules";
import { mockReply } from "@/platform/mock-llm";
import { OpenAIProvider, AnthropicProvider } from "@/core/llm";

const KEY = "sk-test-0123456789abcdef";
const custom = { id: "custom:relay", label: "中转站", base_url: "https://relay.example.com/v1", default_model: "gpt-x", headers: {} };

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return (e as { code: string }).code;
  }
  return "ok";
}

describe("mock 后端：密钥状态", () => {
  it("只返回是否已配置，任何返回值都不含 Key", async () => {
    const b = createMockBackend({ configured: [] });
    const s = await b.setProviderKey("google", `  ${KEY}  `);
    expect(s).toEqual({ id: "google", configured: true, source: "keychain", needs_key: true });
    const all = await b.providerStatus();
    expect(JSON.stringify(all)).not.toContain(KEY);
    expect(all.map((x) => x.id)).toEqual(["openai", "anthropic", "google", "deepseek", "qwen", "kimi", "ollama"]);
    expect((await b.deleteProviderKey("google")).configured).toBe(false);
  });

  it("校验 Provider 和 Key，错误信息不回显输入", async () => {
    const b = createMockBackend();
    expect(await code(b.setProviderKey("jev", KEY))).toBe("invalid_provider");
    expect(await code(b.setProviderKey("ollama", KEY))).toBe("key_not_needed");
    expect(await code(b.setProviderKey("openai", "short"))).toBe("invalid_key");
    try {
      await b.setProviderKey("openai", "has space inside");
    } catch (e) {
      expect(JSON.stringify(e)).not.toContain("has space");
    }
  });

  it("Jev 的 Key 与 Provider 分开管理", async () => {
    const b = createMockBackend();
    expect((await b.jevStatus()).configured).toBe(false);
    await b.setJevKey(KEY);
    expect((await b.jevStatus()).configured).toBe(true);
    expect((await b.providerStatus()).some((s) => s.id === "jev")).toBe(false);
  });
});

describe("mock 后端：自定义 Provider", () => {
  it("保存、列出、base URL 变更且没给新 Key 时清除 Key", async () => {
    const b = createMockBackend();
    const first = await b.saveCustomProvider(custom, KEY);
    expect(first.key.configured).toBe(true);
    expect((await b.providerStatus()).map((s) => s.id)).toContain("custom:relay");
    const same = await b.saveCustomProvider({ ...custom, label: "改名" });
    expect(same.key_cleared).toBe(false);
    expect(same.key.configured).toBe(true);
    const moved = await b.saveCustomProvider({ ...custom, base_url: "https://other.example.com/v1" });
    expect(moved.key_cleared).toBe(true);
    expect(moved.key.configured).toBe(false);
    await b.deleteCustomProvider("custom:relay");
    expect(await b.listCustomProviders()).toEqual([]);
  });

  it("规整 base URL，拒绝不安全的地址", () => {
    expect(validateBaseUrl("https://Relay.Example.com:443/v1/")).toBe("https://relay.example.com/v1");
    expect(validateBaseUrl("http://localhost:11434/v1")).toBe("http://localhost:11434/v1");
    for (const bad of ["http://relay.example.com/v1", "https://u:p@x.com", "https://x.com/v1?k=1", "https://x.com/a/../b", "https://x.com//v1", "https://x.com/%2e", "relay.example.com"]) {
      expect(() => validateBaseUrl(bad), bad).toThrow();
    }
  });

  it("拒绝像凭据的附加请求头和保留请求头", () => {
    expect(() => validateCustom({ ...custom, headers: { "x-api-token": "abc" } })).toThrow(/凭据/);
    expect(() => validateCustom({ ...custom, headers: { Authorization: "Bearer x" } })).toThrow(/保留/);
    expect(validateCustom({ ...custom, headers: { "X-Org": " team " } }).headers).toEqual({ "x-org": "team" });
  });
});

describe("mock 后端：代理请求", () => {
  it("只允许白名单地址，未配置 Key 时拒绝", async () => {
    const b = createMockBackend({ configured: ["openai"] });
    const req = (target: string, url: string, method: "GET" | "POST" = "POST") => b.providerRequest({ target, method, url, body: method === "POST" ? "{}" : null });
    expect(await code(req("openai", "https://evil.example.com/v1/chat/completions"))).toBe("proxy_url_not_allowed");
    expect(await code(req("openai", "https://api.openai.com/v1/files"))).toBe("proxy_url_not_allowed");
    expect(await code(req("anthropic", "https://api.anthropic.com/v1/messages"))).toBe("provider_not_configured");
    expect(await code(req("google", "https://example.com"))).toBe("proxy_url_not_allowed");
    expect(await code(req("mistral", "https://api.mistral.ai/v1/models", "GET"))).toBe("proxy_unsupported");
    expect(await code(req("constructor", "https://x.com/models", "GET"))).toBe("proxy_unsupported");
    expect(await code(b.providerRequest({ target: "openai", method: "GET", url: "https://api.openai.com/v1/models", body: "x" }))).toBe("proxy_body");
    expect((await req("openai", "https://api.openai.com/v1/models", "GET")).status).toBe(200);
  });

  it("M6 官方目标：按地域放行官方域名，Ollama 不需要 Key", async () => {
    const b = createMockBackend({ configured: ["qwen", "kimi"] });
    const get = (target: string, url: string) => b.providerRequest({ target, method: "GET", url });
    expect((await get("qwen", "https://dashscope.aliyuncs.com/compatible-mode/v1/models")).status).toBe(200);
    expect((await get("qwen", "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models")).status).toBe(200);
    expect((await get("kimi", "https://api.moonshot.ai/v1/models")).status).toBe(200);
    expect(await code(get("qwen", "https://api.moonshot.cn/v1/models"))).toBe("proxy_url_not_allowed");
    expect(await code(get("deepseek", "https://api.deepseek.com/models"))).toBe("provider_not_configured");
    expect((await get("ollama", "http://127.0.0.1:11434/v1/models")).status).toBe(200);
    expect(await code(get("ollama", "http://localhost:11434/v1/models"))).toBe("proxy_url_not_allowed");
  });

  it("本机自定义端点不需要 Key；Jev 在模拟环境返回 503", async () => {
    const b = createMockBackend({ jevConfigured: true });
    await b.saveCustomProvider({ ...custom, id: "custom:local", base_url: "http://127.0.0.1:8080/v1" });
    const r = await b.providerRequest({ target: "custom:local", method: "GET", url: "http://127.0.0.1:8080/v1/models" });
    expect(r.status).toBe(200);
    const j = await b.providerRequest({ target: "jev", method: "POST", url: "https://api.typesafe.ai/v1/systemone", body: "{}" });
    expect(j.status).toBe(503);
  });

  it("查询参数控制演示状态", () => {
    expect(mockOptionsFromQuery("?mock=fail-init,jev")).toEqual({ failInit: 1, jevConfigured: true });
    expect(mockOptionsFromQuery("")).toEqual({});
  });
});

describe("proxiedFetch", () => {
  it("丢弃请求头，Key 不出 webview；适配器照常解析响应", async () => {
    const b = createMockBackend();
    const seen: unknown[] = [];
    const spy = { ...b, providerRequest: (r: Parameters<typeof b.providerRequest>[0]) => (seen.push(r), b.providerRequest(r)) };
    const openai = new OpenAIProvider({ id: "openai", apiKey: PROXY_PLACEHOLDER_KEY, fetch: proxiedFetch(spy, "openai") });
    const r = await openai.chat({ model: "gpt-x", messages: [{ role: "user", content: "你好" }] });
    expect(r.text).toContain("（模拟回复）你好");
    expect(r.usage?.outputTokens).toBeGreaterThan(0);
    expect(JSON.stringify(seen)).not.toContain(PROXY_PLACEHOLDER_KEY);
    expect(Object.keys(seen[0] as object).sort()).toEqual(["body", "method", "target", "url"]);

    const claude = new AnthropicProvider({ id: "anthropic", apiKey: PROXY_PLACEHOLDER_KEY, fetch: proxiedFetch(b, "anthropic") });
    expect((await claude.chat({ model: "c", messages: [{ role: "system", content: "s" }, { role: "user", content: "hi" }] })).text).toContain("hi");
  });

  it("后端错误转成 TypeError，HTTP 错误保留状态码", async () => {
    const f = proxiedFetch(createMockBackend({ configured: [] }), "openai");
    await expect(f("https://api.openai.com/v1/chat/completions", { method: "POST", body: "{}" })).rejects.toBeInstanceOf(ProxyError);
    await expect(f("https://api.openai.com/v1/models", { method: "DELETE" })).rejects.toBeInstanceOf(TypeError);
    const down = proxiedFetch(createMockBackend({ failRequests: true }), "openai");
    const res = await down("https://api.openai.com/v1/chat/completions", { method: "POST", body: "{}" });
    expect(res.status).toBe(503);
    expect(res.headers.get("content-type")).toBe("application/json");
  });

  it("支持取消", async () => {
    const slow = { ...createMockBackend(), providerRequest: () => new Promise<never>(() => {}) };
    const ctrl = new AbortController();
    const p = proxiedFetch(slow, "openai")("https://api.openai.com/v1/models", { signal: ctrl.signal });
    ctrl.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("模拟模型回复", () => {
  it("规划提示返回 JSON 计划，写入类目标包含需要确认的步骤", () => {
    const sys = "你是 EastGenesis 的任务规划器。\n可用工具：\n- demo_search：检索\n- demo_write_file：保存";
    const plan = JSON.parse(mockReply([{ role: "system", content: sys }, { role: "user", content: "目标：整理周报并保存" }]));
    expect(plan.steps.map((s: { tool: string | null }) => s.tool)).toEqual([null, "demo_search", "demo_write_file", null]);
    expect(mockReply([{ role: "user", content: "总目标：x\n\n当前子目标：分析需求" }])).toContain("分析需求");
  });
});

describe("MCP 走后端", () => {
  it("只能按 ID 启动登记过的服务器，经 BackendTransport 握手、列工具、调用和关闭", async () => {
    const b = createMockBackend();
    expect(await code(b.mcpStart("not_listed"))).toBe("mcp_not_registered");
    const { client, transport } = await connectBackendServer(b, "echo");
    expect(transport.config?.allow_tools).toEqual(["echo"]);
    expect((await client.listTools()).map((t) => t.name)).toEqual(["echo", "shout"]);
    expect((await client.callTool("echo", { text: "你好" })).content).toBe("你好");
    await transport.close();
    expect(await code(b.mcpSend("echo", "{}"))).toBe("mcp_not_running");
  });

  it("发出的消息按启动时的白名单再查一遍", async () => {
    const b = createMockBackend();
    await b.mcpStart("echo");
    const call = (name: string) => JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name } });
    expect(await code(b.mcpSend("echo", call("shout")))).toBe("mcp_tool_not_allowed");
    expect(await code(b.mcpSend("echo", JSON.stringify({ jsonrpc: "2.0", id: 1, method: "resources/read" })))).toBe("mcp_method_not_allowed");
    expect(await code(b.mcpSend("echo", "[]"))).toBe("invalid_message");
    expect(await code(b.mcpSend("echo", "not json"))).toBe("invalid_message");
    await b.mcpStop("echo");
  });

  it("登记表只读；密钥只能写 mcp.json 引用了的条目，写入后才能启动", async () => {
    const b = createMockBackend();
    const reg = await b.mcpList();
    expect(reg.servers.map((s) => s.id)).toEqual(["echo", "notes"]);
    expect(reg.errors.map((e) => e.id)).toEqual(["remote"]);
    expect(reg.servers[1].refs).toEqual([{ source: "keychain", name: "NOTES_TOKEN", configured: false }]);
    expect(await code(b.mcpStart("notes"))).toBe("mcp_secret_missing");
    expect(await code(b.setMcpSecret("notes", "OTHER", "value-1"))).toBe("mcp_secret_not_referenced");
    expect(await code(b.setMcpSecret("notes", "NOTES_TOKEN", "a\nb"))).toBe("invalid_mcp_secret_value");
    await b.setMcpSecret("notes", "NOTES_TOKEN", "value-1");
    const after = await b.mcpList();
    expect(after.servers[1].refs[0].configured).toBe(true);
    expect(JSON.stringify(after)).not.toContain("value-1");
    expect((await b.mcpStart("notes")).running).toBe(true);
    await b.mcpStop("notes");
    await b.deleteMcpSecret("notes", "NOTES_TOKEN");
    expect((await b.mcpList()).servers[1].refs[0].configured).toBe(false);
  });
});

// @vitest-environment node
import { fileURLToPath } from "node:url";
import { DecisionLayer } from "@/decision/decision-layer";
import { McpClient, mcpTools, sideEffectFor, type McpToolInfo } from "@/agent/mcp/client";
import { McpError, type JsonRpcMessage, type Transport } from "@/agent/mcp/jsonrpc";
import { childEnv, connectStdioServer } from "@/agent/mcp/stdio";
import { AgentRuntime } from "@/agent/runtime";
import { ToolRegistry } from "@/agent/tools";

class MemoryTransport implements Transport {
  sent: JsonRpcMessage[] = [];
  #msg: ((m: unknown) => void)[] = [];
  #close: ((r?: string) => void)[] = [];
  constructor(private readonly server: (m: JsonRpcMessage, t: MemoryTransport) => void) {}
  send(m: JsonRpcMessage) {
    this.sent.push(m);
    queueMicrotask(() => this.server(m, this));
  }
  push(m: unknown) {
    for (const cb of this.#msg) cb(m);
  }
  onMessage(cb: (m: unknown) => void) {
    this.#msg.push(cb);
  }
  onClose(cb: (r?: string) => void) {
    this.#close.push(cb);
  }
  drop(reason: string) {
    for (const cb of this.#close) cb(reason);
  }
  async close() {}
}

function fakeServer(version = "2025-06-18") {
  return (m: JsonRpcMessage, t: MemoryTransport) => {
    if (m.id === undefined || !m.method) return;
    const ok = (result: unknown) => t.push({ jsonrpc: "2.0", id: m.id, result });
    const p = (m.params ?? {}) as { cursor?: string; name?: string };
    if (m.method === "initialize") ok({ protocolVersion: version, serverInfo: { name: "mem", version: "1" }, capabilities: {} });
    else if (m.method === "tools/list") {
      ok(p.cursor ? { tools: [{ name: "b", annotations: { destructiveHint: true } }] } : { tools: [{ name: "a", description: "tool a", inputSchema: { type: "object" } }], nextCursor: "p2" });
    } else if (m.method === "tools/call") {
      if (p.name === "hang") return;
      if (p.name === "bad") t.push({ jsonrpc: "2.0", id: m.id, error: { code: -32602, message: "bad args" } });
      else ok({ content: [{ type: "text", text: `called ${p.name}` }, { type: "image", data: "..." }], isError: p.name === "fails" });
    }
  };
}

describe("MCP 客户端", () => {
  it("initialize、分页列出工具、调用工具", async () => {
    const t = new MemoryTransport(fakeServer());
    const c = new McpClient(t);
    expect(await c.initialize()).toMatchObject({ protocolVersion: "2025-06-18", serverInfo: { name: "mem" } });
    expect(t.sent.some((m) => m.method === "notifications/initialized")).toBe(true);
    expect((await c.listTools()).map((x) => x.name)).toEqual(["a", "b"]);
    expect(await c.callTool("a", { x: 1 }, undefined, "eg-test-key")).toEqual({ ok: true, content: "called a\n[图片]" });
    expect(t.sent.find((m) => m.method === "tools/call")?.params).toMatchObject({ _meta: { "com.eastgenesis/idempotencyKey": "eg-test-key" } });
    const before = t.sent.filter((m) => m.method === "tools/call").length;
    await Promise.all([c.callTool("a", {}, undefined, "eg-same-call"), c.callTool("a", {}, undefined, "eg-same-call")]);
    expect(t.sent.filter((m) => m.method === "tools/call").length).toBe(before + 1);
    expect((await c.callTool("fails", {})).ok).toBe(false);
    await expect(c.callTool("bad", {})).rejects.toMatchObject({ code: "rpc", rpcCode: -32602 });
  });

  it("拒绝不支持的协议版本", async () => {
    await expect(new McpClient(new MemoryTransport(fakeServer("1999-01-01"))).initialize()).rejects.toMatchObject({ code: "unsupported_protocol" });
  });

  it("响应服务器的 ping，拒绝 sampling 等服务器请求", async () => {
    const t = new MemoryTransport(fakeServer());
    await new McpClient(t).initialize();
    t.push({ jsonrpc: "2.0", id: 99, method: "ping" });
    t.push({ jsonrpc: "2.0", id: 100, method: "sampling/createMessage", params: {} });
    expect(t.sent.find((m) => m.id === 99)).toEqual({ jsonrpc: "2.0", id: 99, result: {} });
    expect(t.sent.find((m) => m.id === 100)?.error?.code).toBe(-32601);
  });

  it("超时后发送取消通知；连接断开时挂起的请求失败", async () => {
    const t = new MemoryTransport(fakeServer());
    const c = new McpClient(t, { timeoutMs: 30 });
    await c.initialize();
    const e = await c.callTool("hang", {}).catch((x) => x);
    expect(e).toBeInstanceOf(McpError);
    expect(e.code).toBe("timeout");
    expect(t.sent.some((m) => m.method === "notifications/cancelled")).toBe(true);

    const t2 = new MemoryTransport(fakeServer());
    const c2 = new McpClient(t2);
    await c2.initialize();
    const pending = c2.callTool("hang", {});
    t2.drop("服务器已退出");
    await expect(pending).rejects.toMatchObject({ code: "closed" });
    await expect(c2.callTool("a", {})).rejects.toMatchObject({ code: "closed" });
  });
});

describe("mcpTools 白名单与信任策略", () => {
  const infos: McpToolInfo[] = [
    { name: "read", description: "Read\nfile", annotations: { readOnlyHint: true } },
    { name: "Delete-All", annotations: { readOnlyHint: true, destructiveHint: true } },
    { name: "secret" },
  ];
  const client = { callTool: async (name: string) => ({ ok: true, content: `ran ${name}` }) };

  it("只注册白名单内的工具，名称加命名空间", () => {
    const { tools, skipped } = mcpTools(client, infos, { server: "fs", allowTools: ["read", "Delete-All"] });
    expect(tools.map((t) => t.name)).toEqual(["mcp__fs__read", "mcp__fs__delete_all"]);
    expect(skipped).toEqual([{ name: "secret", reason: "不在白名单" }]);
    expect(tools[0].description).toBe("[MCP:fs] Read file");
  });

  it("默认不信任只读标注；破坏性标注总是采纳", () => {
    expect(mcpTools(client, infos, { server: "fs", allowTools: "*" }).tools.map((t) => t.sideEffect)).toEqual(["external", "destructive", "external"]);
    expect(mcpTools(client, infos, { server: "fs", allowTools: "*", trustAnnotations: true }).tools.map((t) => t.sideEffect)).toEqual(["none", "destructive", "external"]);
    expect(sideEffectFor({ destructiveHint: false, openWorldHint: false }, true)).toBe("local_write");
  });

  it("服务器 ID 必须合法", () => {
    expect(() => mcpTools(client, infos, { server: "Bad Server", allowTools: "*" })).toThrow(/服务器 ID/);
  });

  it("内置 files 工具为可恢复写入提供状态探测", async () => {
    const calls: { name: string; args: Record<string, unknown>; key?: string }[] = [];
    const fsClient = {
      callTool: async (name: string, args: Record<string, unknown>, _signal?: AbortSignal, key?: string) => {
        calls.push({ name, args, ...(key ? { key } : {}) });
        return name === "read_file" ? { ok: true, content: "", data: { path: args.path, size: 2, content: "完成", truncated: false } } : { ok: false, content: "路径不存在（not_found）" };
      },
    };
    const { tools } = mcpTools(fsClient, [
      { name: "read_file", annotations: { readOnlyHint: true } },
      { name: "write_file", annotations: { destructiveHint: true, idempotentHint: false } },
      { name: "get_file_info", annotations: { readOnlyHint: true } },
    ], { server: "files", allowTools: "*", trustAnnotations: true });
    const write = tools.find((tool) => tool.name === "mcp__files__write_file");
    expect(write?.probe).toBeTypeOf("function");
    const result = await write!.probe!({ path: "~/Downloads/report.md", content: "完成" }, { signal: new AbortController().signal });
    expect(result).toMatchObject({ state: "applied", artifacts: [{ action: "modify", path: "~/Downloads/report.md", ok: true }] });
    await expect(write!.probe!({ path: "~/Downloads/report.md", content: "其他内容" }, { signal: new AbortController().signal })).resolves.toMatchObject({ state: "conflict" });
    expect(calls[0]).toMatchObject({ name: "read_file", args: { path: "~/Downloads/report.md" } });
  });
});

const SERVER = fileURLToPath(new URL("./fixtures/fake-mcp-server.mjs", import.meta.url));

describe("MCP stdio（真实子进程）", () => {
  it("子进程不继承父进程的 API Key，只拿到显式配置的变量", async () => {
    const { client, transport } = await connectStdioServer(
      { command: process.execPath, args: [SERVER], env: { FAKE_FLAG: "on" } },
      { parentEnv: { ...process.env, OPENAI_API_KEY: "sk-parent-secret-0123456789" } },
    );
    try {
      expect(client.serverInfo?.name).toBe("fake");
      expect(JSON.parse((await client.callTool("env_probe", {})).content)).toEqual({ hasOpenAI: false, flag: "on" });
    } finally {
      await transport.close();
    }
  });

  it("端到端：MCP 工具注册进运行时并被调用", async () => {
    const { client, transport } = await connectStdioServer({ command: process.execPath, args: [SERVER] });
    try {
      const { tools } = mcpTools(client, await client.listTools(), { server: "fake", allowTools: ["echo"], trustAnnotations: true });
      const registry = new ToolRegistry(tools);
      const decision = DecisionLayer.fromEnv({ OPENAI_API_KEY: "x" }, { tools: registry.defs() });
      const plan = JSON.stringify({ steps: [{ goal: "回显 你好世界", tool: "mcp__fake__echo", args: { text: "回显 你好世界" } }] });
      const llm = async (req: { purpose: string }) => ({ text: req.purpose === "plan" ? plan : "完成", profileId: "openai/fake", latencyMs: 1, usage: null });
      const r = await new AgentRuntime({ decision, tools: registry, llm: () => llm }).run("回显你好世界");
      expect(r.status).toBe("completed");
      expect(r.steps[0]).toMatchObject({ status: "done", output: "回显 你好世界" });
    } finally {
      await transport.close();
    }
  });

  it("命令不存在时初始化失败，不会让进程崩溃", async () => {
    await expect(connectStdioServer({ command: "/nonexistent/eg-mcp-server" }, { timeoutMs: 2000 })).rejects.toBeInstanceOf(McpError);
  });

  it("childEnv 只保留白名单变量和显式配置", () => {
    expect(childEnv({ PATH: "/bin", OPENAI_API_KEY: "x", TYPESAFE_API_KEY: "y" }, { A: "1" })).toEqual({ PATH: "/bin", A: "1" });
  });
});

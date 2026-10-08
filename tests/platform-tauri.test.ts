// 桌面端后端：只验证命令名和参数形状与 src-tauri/src/lib.rs 一致（真实调用在 Mac 上验证）
const invoke = vi.fn();
const listeners = new Map<string, (e: { payload: unknown }) => void>();
const unlisten = vi.fn();

class MockChannel<T = unknown> {
  onmessage: (message: T) => void;
  constructor(onmessage: (message: T) => void = () => {}) {
    this.onmessage = onmessage;
  }
}

vi.mock("@tauri-apps/api/core", () => ({ Channel: MockChannel, invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (event: string, cb: (e: { payload: unknown }) => void) => {
    listeners.set(event, cb);
    return unlisten;
  },
}));

import { AnthropicProvider } from "@/core/llm/anthropic";
import { PROXY_PLACEHOLDER_KEY, proxiedFetch } from "@/platform";
import { createTauriBackend } from "@/platform/tauri-backend";

describe("Tauri 后端命令映射", () => {
  beforeEach(() => {
    invoke.mockReset().mockResolvedValue(undefined);
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  });
  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  });

  it("命令名为 snake_case，参数与 Rust 签名对应", async () => {
    const b = createTauriBackend();
    await b.providerStatus();
    await b.setProviderKey("openai", "sk-xxxxxxxx");
    await b.deleteProviderKey("openai");
    await b.setJevKey("jev-xxxxxxxx");
    await b.saveCustomProvider({ id: "custom:a", label: "A", base_url: "https://a.example.com/v1", default_model: "m", headers: {} }, "  ");
    await b.providerRequest({ target: "openai", method: "GET", url: "https://api.openai.com/v1/models" });
    await b.mcpList();
    await b.mcpStart("fs");
    await b.mcpSend("fs", "{}");
    await b.setMcpSecret("fs", "TOKEN", "value-1");
    await b.deleteMcpSecret("fs", "TOKEN");
    await b.pickDirectory!("/tmp");
    await b.qaFaultPoint!();
    await b.qaFaultExit!("after_tool_before_ledger_commit");
    expect(invoke.mock.calls).toEqual([
      ["get_provider_status", undefined],
      ["set_provider_key", { provider: "openai", key: "sk-xxxxxxxx" }],
      ["delete_provider_key", { provider: "openai" }],
      ["set_jev_key", { key: "jev-xxxxxxxx" }],
      ["save_custom_provider", { provider: { id: "custom:a", label: "A", base_url: "https://a.example.com/v1", default_model: "m", headers: {} }, apiKey: null }],
      ["provider_request", { req: { target: "openai", method: "GET", url: "https://api.openai.com/v1/models", body: null } }],
      ["mcp_list", undefined],
      ["mcp_start", { server: "fs" }],
      ["mcp_send", { server: "fs", line: "{}" }],
      ["set_mcp_secret", { server: "fs", name: "TOKEN", value: "value-1" }],
      ["delete_mcp_secret", { server: "fs", name: "TOKEN" }],
      ["pick_directory", { defaultPath: "/tmp" }],
      ["qa_fault_point", undefined],
      ["qa_fault_exit", { point: "after_tool_before_ledger_commit" }],
    ]);
  });

  it("Rust 返回的 AppError 原样传给 UI", async () => {
    invoke.mockRejectedValueOnce({ code: "keychain_error", message: "写入系统钥匙串失败", detail: null });
    await expect(createTauriBackend().setJevKey("jev-xxxxxxxx")).rejects.toEqual({ code: "keychain_error", message: "写入系统钥匙串失败", detail: null });
  });

  it("流式 Provider 走 Channel，不等完整响应才把 SSE 字节交给适配器", async () => {
    invoke.mockImplementation(async (cmd: string, args?: { channel?: MockChannel<{ type: string; status?: number; data?: number[] }> }) => {
      if (cmd === "provider_stream") {
        args?.channel?.onmessage({ type: "headers", status: 200 });
        args?.channel?.onmessage({ type: "chunk", data: [...new TextEncoder().encode("data: {}\\n\\n")] });
        args?.channel?.onmessage({ type: "done" });
      }
      return undefined;
    });
    const response = await createTauriBackend().providerStream!({ target: "openai", method: "POST", url: "https://api.openai.com/v1/chat/completions", body: '{"stream":true}' });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("data: {}\\n\\n");
    expect(invoke).toHaveBeenCalledWith("provider_stream", expect.objectContaining({ streamId: expect.stringMatching(/^provider-stream-/) }));
  });

  it("Anthropic Messages 适配器通过同一 Channel 解析 message_stop", async () => {
    invoke.mockImplementation(async (cmd: string, args?: { channel?: MockChannel<{ type: string; status?: number; data?: number[] }> }) => {
      if (cmd === "provider_stream") {
        const chunks = [
          `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { model: "claude-channel" } })}\n\n`,
          `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "跨" } })}\n\n`,
          `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "协议" } })}\n\n`,
          `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
        ];
        args?.channel?.onmessage({ type: "headers", status: 200 });
        for (const chunk of chunks) args?.channel?.onmessage({ type: "chunk", data: [...new TextEncoder().encode(chunk)] });
        args?.channel?.onmessage({ type: "done" });
      }
      return undefined;
    });
    const backend = createTauriBackend();
    const provider = new AnthropicProvider({ id: "anthropic", apiKey: PROXY_PLACEHOLDER_KEY, fetch: proxiedFetch(backend, "anthropic") });
    const deltas: string[] = [];
    let model = "";
    for await (const event of provider.stream({ model: "claude", messages: [{ role: "user", content: "hi" }] })) {
      if (event.type === "delta") deltas.push(event.text);
      else model = event.response.model;
    }
    expect(deltas).toEqual(["跨", "协议"]);
    expect(model).toBe("claude-channel");
    expect(invoke).toHaveBeenCalledWith("provider_stream", expect.objectContaining({ streamId: expect.stringMatching(/^provider-stream-/), req: expect.objectContaining({ target: "anthropic" }) }));
  });

  it("响应头到达前取消会立即结束前端等待并通知 Rust", async () => {
    invoke.mockImplementation((cmd: string) => cmd === "provider_stream" ? new Promise(() => {}) : Promise.resolve(undefined));
    const controller = new AbortController();
    const pending = createTauriBackend().providerStream!({
      target: "openai",
      method: "POST",
      url: "https://api.openai.com/v1/chat/completions",
      body: '{"stream":true}',
    }, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(invoke).toHaveBeenCalledWith("provider_stream_cancel", expect.objectContaining({ streamId: expect.stringMatching(/^provider-stream-/) }));
  });

  it("部分正文后收到 Channel 错误时保留已读 chunk", async () => {
    invoke.mockImplementation(async (cmd: string, args?: { channel?: MockChannel<{ type: string; status?: number; data?: number[]; error?: unknown }> }) => {
      if (cmd === "provider_stream") {
        args?.channel?.onmessage({ type: "headers", status: 200 });
        args?.channel?.onmessage({ type: "chunk", data: [...new TextEncoder().encode("data: partial\\n\\n")] });
        args?.channel?.onmessage({ type: "error", error: { code: "network", message: "连接中断", detail: null } });
      }
      return undefined;
    });
    const response = await createTauriBackend().providerStream!({ target: "openai", method: "POST", url: "https://api.openai.com/v1/chat/completions", body: '{"stream":true}' });
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(new TextDecoder().decode(first.value)).toBe("data: partial\\n\\n");
    await expect(reader.read()).rejects.toMatchObject({ code: "network", message: "连接中断" });
  });

  it.each(["error", "done"] as const)("等待下一段正文时异步收到 %s 会立即结束读取", async (terminal) => {
    let channel!: MockChannel<{ type: string; status?: number; data?: number[]; error?: unknown }>;
    invoke.mockImplementation(async (cmd: string, args?: { channel?: typeof channel }) => {
      if (cmd === "provider_stream") {
        channel = args!.channel!;
        channel.onmessage({ type: "headers", status: 200 });
        channel.onmessage({ type: "chunk", data: [...new TextEncoder().encode("partial")] });
      }
      return undefined;
    });
    const response = await createTauriBackend().providerStream!({ target: "openai", method: "POST", url: "https://api.openai.com/v1/chat/completions" });
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("partial");
    let outcome: unknown = "pending";
    const pendingRead = reader.read().then((value) => { outcome = value; }, (error) => { outcome = error; });
    // Let the underlying stream enter its pending pull before the IPC terminal
    // arrives; synchronous chunk+terminal mocks did not cover this ordering.
    await new Promise((resolve) => setTimeout(resolve, 0));
    channel.onmessage(terminal === "error"
      ? { type: "error", error: { code: "network", message: "连接中断" } }
      : { type: "done" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(outcome).not.toBe("pending");
    if (terminal === "error") expect(outcome).toMatchObject({ code: "network" });
    else expect(outcome).toEqual({ done: true, value: undefined });
    await pendingRead;
  });

  it("首段正文后取消会保留已读 chunk，并中断后续读取", async () => {
    let releaseProvider: (() => void) | undefined;
    invoke.mockImplementation(async (cmd: string, args?: { channel?: MockChannel<{ type: string; status?: number; data?: number[] }> }) => {
      if (cmd === "provider_stream") {
        args?.channel?.onmessage({ type: "headers", status: 200 });
        args?.channel?.onmessage({ type: "chunk", data: [...new TextEncoder().encode("data: partial\n\n")] });
        await new Promise<void>((resolve) => { releaseProvider = resolve; });
      }
      return undefined;
    });
    const controller = new AbortController();
    const response = await createTauriBackend().providerStream!({
      target: "openai",
      method: "POST",
      url: "https://api.openai.com/v1/chat/completions",
      body: '{"stream":true}',
    }, controller.signal);
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(new TextDecoder().decode(first.value)).toBe("data: partial\n\n");
    controller.abort();
    await expect(reader.read()).rejects.toMatchObject({ name: "AbortError" });
    expect(invoke).toHaveBeenCalledWith("provider_stream_cancel", expect.objectContaining({ streamId: expect.stringMatching(/^provider-stream-/) }));
    releaseProvider?.();
  });

  it("MCP 事件按服务器过滤，取消时移除两个监听", async () => {
    const lines: string[] = [];
    const exits: string[] = [];
    const off = await createTauriBackend().onMcp("fs", { onLine: (l) => lines.push(l), onExit: (r) => exits.push(r) });
    listeners.get("mcp-message")!({ payload: { server: "other", line: "x" } });
    listeners.get("mcp-message")!({ payload: { server: "fs", line: "{}" } });
    listeners.get("mcp-exit")!({ payload: { server: "fs", reason: "eof" } });
    expect(lines).toEqual(["{}"]);
    expect(exits).toEqual(["eof"]);
    off();
    expect(unlisten).toHaveBeenCalledTimes(2);
  });
});

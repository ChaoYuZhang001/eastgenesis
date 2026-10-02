// 桌面端后端：只验证命令名和参数形状与 src-tauri/src/lib.rs 一致（真实调用在 Mac 上验证）
const invoke = vi.fn();
const listeners = new Map<string, (e: { payload: unknown }) => void>();
const unlisten = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (event: string, cb: (e: { payload: unknown }) => void) => {
    listeners.set(event, cb);
    return unlisten;
  },
}));

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
    ]);
  });

  it("Rust 返回的 AppError 原样传给 UI", async () => {
    invoke.mockRejectedValueOnce({ code: "keychain_error", message: "写入系统钥匙串失败", detail: null });
    await expect(createTauriBackend().setJevKey("jev-xxxxxxxx")).rejects.toEqual({ code: "keychain_error", message: "写入系统钥匙串失败", detail: null });
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

// Exercise the actual IPC bridge, proxy and both adapters with synthetic native
// events. This proves error/partial-output handling, not a real Rust invocation.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    constructor(public onmessage: (event: unknown) => void) {}
  },
  invoke,
}));

import { AnthropicProvider, OpenAIProvider, ProviderError } from "@/core/llm";
import { createTauriBackend } from "@/platform/tauri-backend";
import { PROXY_PLACEHOLDER_KEY, proxiedFetch } from "@/platform/proxy-fetch";

const request = { model: "fixture-model", messages: [{ role: "user" as const, content: "hi" }] };
const nativeError = (code: string) => ({ code, message: "untrusted-response-message", detail: "untrusted-response-detail" });
const first = {
  openai: 'data: {"choices":[{"delta":{"content":"已收到"}}]}\n\n',
  anthropic: 'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"已收到"}}\n\n',
};

function provider(protocol: "openai" | "anthropic") {
  const options = { id: protocol, apiKey: PROXY_PLACEHOLDER_KEY, fetch: proxiedFetch(createTauriBackend(), protocol) };
  return protocol === "openai" ? new OpenAIProvider(options) : new AnthropicProvider(options);
}

describe("native response integrity through the IPC bridge", () => {
  beforeEach(() => {
    invoke.mockReset();
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  });
  afterEach(() => { delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__; });

  it.each(["openai", "anthropic"] as const)("%s: JSON rejects oversized native data without retryable network fallback", async (protocol) => {
    invoke.mockRejectedValue(nativeError("response_too_large"));
    const error = await provider(protocol).chat(request).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ code: "response_too_large", retryable: false, partialOutput: false });
    expect((error as ProviderError).message).toContain("安全读取上限");
    expect(JSON.stringify((error as ProviderError).toAppError())).not.toContain("untrusted-response");
  });

  it.each(["openai", "anthropic"] as const)("%s: an invalid native response before headers stays nonretryable", async (protocol) => {
    invoke.mockRejectedValue(nativeError("invalid_response"));
    const iterator = provider(protocol).stream(request)[Symbol.asyncIterator]();
    const error = await iterator.next().catch((error: unknown) => error);
    expect(error).toMatchObject({ code: "invalid_response", retryable: false, partialOutput: false });
    expect(JSON.stringify((error as ProviderError).toAppError())).not.toContain("untrusted-response");
  });

  it.each([
    ["openai", "invalid_response"],
    ["openai", "response_too_large"],
    ["anthropic", "invalid_response"],
    ["anthropic", "response_too_large"],
  ] as const)("%s: valid partial output is drained before native %s", async (protocol, code) => {
    invoke.mockImplementation(async (command: string, args: { channel: { onmessage: (event: unknown) => void } }) => {
      expect(command).toBe("provider_stream");
      args.channel.onmessage({ type: "headers", status: 200 });
      args.channel.onmessage({ type: "chunk", data: Array.from(new TextEncoder().encode(first[protocol])) });
      args.channel.onmessage({ type: "error", error: nativeError(code) });
    });
    const iterator = provider(protocol).stream(request)[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ done: false, value: { type: "delta", text: "已收到" } });
    const error = await iterator.next().catch((error: unknown) => error);
    expect(error).toMatchObject({ code, retryable: false, partialOutput: true });
    expect(JSON.stringify((error as ProviderError).toAppError())).not.toContain("untrusted-response");
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("native timeouts retain their recovery policy without response-derived details", async () => {
    invoke.mockRejectedValue(nativeError("timeout"));
    const error = await provider("openai").chat(request).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: "timeout", retryable: true });
    expect(JSON.stringify((error as ProviderError).toAppError())).not.toContain("untrusted-response");
  });

  it.each(["openai", "anthropic"] as const)("%s: protocol completion cancels the native body without waiting for HTTP EOF", async (protocol) => {
    const terminal = protocol === "openai"
      ? "data: [DONE]\n\n"
      : 'event: message_stop\ndata: {"type":"message_stop"}\n\n';
    invoke.mockImplementation(async (command: string, args: { channel: { onmessage: (event: unknown) => void } }) => {
      if (command === "provider_stream_cancel") return;
      expect(command).toBe("provider_stream");
      args.channel.onmessage({ type: "headers", status: 200 });
      args.channel.onmessage({ type: "chunk", data: Array.from(new TextEncoder().encode(first[protocol] + terminal)) });
      // No HTTP done/error: the model protocol ends while the connection is idle.
    });
    const events = [];
    for await (const event of provider(protocol).stream(request)) events.push(event);
    expect(events).toMatchObject([{ type: "delta", text: "已收到" }, { type: "done", response: { text: "已收到" } }]);
    expect(invoke.mock.calls.map(([command]) => command)).toEqual(["provider_stream", "provider_stream_cancel"]);
  });
});

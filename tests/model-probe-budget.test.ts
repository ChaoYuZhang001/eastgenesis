// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_PROBED, PROBE_BATCH_TIMEOUT_MS, PROBE_CONCURRENCY, PROBE_TIMEOUT_MS, probeModel, probeModels } from "@/lib/discover";
import type { Backend, CustomProvider, ProxyRequest } from "@/platform";

const provider: Pick<CustomProvider, "id" | "base_url" | "protocol"> = { id: "custom:synthetic-probe", base_url: "https://probe.example.invalid/v1", protocol: "openai" };
const models = (count: number) => Array.from({ length: count }, (_, i) => `model-${i}`);
const backend = (over: Partial<Backend>): Backend => ({ kind: "mock", providerRequest: vi.fn(async () => ({ status: 200, body: "{}" })), ...over }) as Backend;
// Deadline fixtures exercise the Backend response contract rather than Node's
// Response/ReadableStream internals, which must run with a real timer clock.
const jsonResponse = (body = "{}", status = 200): Response => ({ status, text: async () => body }) as Response;
const heldStreams = (headers: boolean) => {
  const signals: AbortSignal[] = [];
  const request = vi.fn((_req: ProxyRequest, signal?: AbortSignal): Promise<Response> => {
    if (!signal) throw new Error("missing_test_signal");
    signals.push(signal);
    if (!headers) return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true }));
    return Promise.resolve({ status: 200, text: () => new Promise<string>((_resolve, reject) => {
      if (signal.aborted) reject(new DOMException("cancelled", "AbortError"));
      else signal.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true });
    }) } as Response);
  });
  return { request, signals, value: backend({ providerStream: request }) };
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe("bounded explicit model connection checks", () => {
  it("uses the cancellable raw channel for ordinary JSON without requesting SSE", async () => {
    vi.useRealTimers();
    const stream = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    const value = backend({ providerStream: stream });
    expect(await probeModel(value, provider, "model-one")).toBe("ok");
    expect(value.providerRequest).not.toHaveBeenCalled();
    const [request, signal] = stream.mock.calls[0] as unknown as [ProxyRequest, AbortSignal];
    expect(request).toMatchObject({ target: provider.id, method: "POST", url: `${provider.base_url}/chat/completions` });
    expect(JSON.parse(request.body ?? "")).toEqual({ model: "model-one", max_tokens: 1, messages: [{ role: "user", content: "hi" }] });
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it("keeps Anthropic URL and explicit missing-model classification", async () => {
    vi.useRealTimers();
    const stream = vi.fn(async () => new Response('{"error":{"code":"model_not_found"}}', { status: 400 }));
    expect(await probeModel(backend({ providerStream: stream }), { ...provider, protocol: "anthropic" }, "absent")).toBe("missing");
    expect((stream.mock.calls[0] as unknown as [ProxyRequest])[0].url).toBe(`${provider.base_url}/messages`);
  });

  it.each([false, true])("stops the batch and aborts all started streams on timeout, headers=%s", async (headers) => {
    const held = heldStreams(headers);
    const job = probeModels(held.value, provider, models(12), { timeoutMs: 10 });
    await vi.advanceTimersByTimeAsync(10);
    expect(await job).toEqual({ unavailable: [], probed: 4, suspicious: false, total: 12, ok: 0, missing: 0, unknown: 4, notProbed: 8, stopReason: "timeout" });
    expect(held.request).toHaveBeenCalledTimes(4);
    expect(held.signals.every((signal) => signal.aborted)).toBe(true);
    await vi.advanceTimersByTimeAsync(60000);
    expect(held.request).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("user cancellation stops queued models and cancels the active raw responses", async () => {
    const held = heldStreams(true), controller = new AbortController();
    const job = probeModels(held.value, provider, models(10), { signal: controller.signal });
    controller.abort();
    expect(await job).toMatchObject({ probed: 4, unknown: 4, notProbed: 6, ok: 0, stopReason: "cancelled" });
    expect(held.request).toHaveBeenCalledTimes(4);
    expect(held.signals.every((signal) => signal.aborted)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not invoke a transport when the batch is already cancelled", async () => {
    const controller = new AbortController(), value = backend({});
    controller.abort();
    expect(await probeModels(value, provider, models(3), { signal: controller.signal })).toEqual({ unavailable: [], probed: 0, suspicious: false, total: 3, ok: 0, missing: 0, unknown: 0, notProbed: 3, stopReason: "cancelled" });
    expect(value.providerRequest).not.toHaveBeenCalled();
  });

  it("applies the total batch deadline while each request remains below its own deadline", async () => {
    const held = heldStreams(false);
    const job = probeModels(held.value, provider, models(9), { timeoutMs: 50, batchTimeoutMs: 10 });
    await vi.advanceTimersByTimeAsync(10);
    expect(await job).toMatchObject({ probed: 4, unknown: 4, notProbed: 5, stopReason: "budget" });
    expect(held.request).toHaveBeenCalledTimes(4);
    expect(held.signals.every((signal) => signal.aborted)).toBe(true);
  });

  it("bounds the legacy buffered path without pretending that a timeout aborted it", async () => {
    const pending: ((value: { status: number; body: string }) => void)[] = [];
    const request = vi.fn(() => new Promise<{ status: number; body: string }>((resolve) => pending.push(resolve)));
    const job = probeModels(backend({ providerRequest: request }), provider, models(100), { timeoutMs: 10 });
    await vi.advanceTimersByTimeAsync(10);
    expect(await job).toMatchObject({ probed: 4, unknown: 4, notProbed: 96, stopReason: "timeout" });
    expect(pending).toHaveLength(4);
    for (const resolve of pending) resolve({ status: 200, body: "{}" });
    await vi.advanceTimersByTimeAsync(100);
    expect(request).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains prior completed success while later timeout leaves the queued models unstarted", async () => {
    const signals: AbortSignal[] = [];
    const stream = vi.fn(async (request: ProxyRequest, signal?: AbortSignal) => {
      if (JSON.parse(request.body ?? "{}").model === "model-0") return jsonResponse();
      if (!signal) throw new Error("missing_test_signal");
      signals.push(signal);
      return new Promise<Response>((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true }));
    });
    const job = probeModels(backend({ providerStream: stream }), provider, models(8), { concurrency: 1, timeoutMs: 10 });
    await vi.advanceTimersByTimeAsync(10);
    expect(await job).toMatchObject({ probed: 2, ok: 1, unknown: 1, notProbed: 6, stopReason: "timeout" });
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  it("separates successful, explicitly missing, and unknown responses", async () => {
    const value = backend({ providerRequest: async (request) => {
      const model = JSON.parse(request.body ?? "{}").model;
      if (model === "missing") return { status: 404, body: "{}" };
      if (model === "unavailable") return { status: 503, body: "{}" };
      if (model === "error") throw new Error("synthetic_transport_failure");
      return { status: 200, body: "{}" };
    } });
    expect(await probeModels(value, provider, ["ok-a", "missing", "unavailable", "ok-b", "error"])).toEqual({ unavailable: ["missing"], probed: 5, suspicious: false, total: 5, ok: 2, missing: 1, unknown: 2, notProbed: 0, stopReason: null });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps all-404 suspicious results without converting them to successful checks", async () => {
    expect(await probeModels(backend({ providerRequest: async () => ({ status: 404, body: "{}" }) }), provider, models(3))).toEqual({ unavailable: [], probed: 3, suspicious: true, total: 3, ok: 0, missing: 3, unknown: 0, notProbed: 0, stopReason: null });
  });

  it("enforces the four-worker and hundred-model ceilings even when options request more", async () => {
    let active = 0, peak = 0;
    const request = vi.fn(async () => { active++; peak = Math.max(peak, active); await new Promise((resolve) => setTimeout(resolve, 1)); active--; return { status: 200, body: "{}" }; });
    const job = probeModels(backend({ providerRequest: request }), provider, models(120), { concurrency: 100, max: 1000 });
    await vi.advanceTimersByTimeAsync(100);
    expect(await job).toMatchObject({ total: 120, probed: MAX_PROBED, ok: MAX_PROBED, notProbed: 20, stopReason: null });
    expect(request).toHaveBeenCalledTimes(MAX_PROBED);
    expect(peak).toBe(PROBE_CONCURRENCY);
  });

  it("clamps overlarge timeout options to the fixed single and batch budgets", async () => {
    const first = heldStreams(false);
    const timed = probeModels(first.value, provider, ["one"], { timeoutMs: 100000, batchTimeoutMs: 100000 });
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS - 1);
    expect(first.signals[0].aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await timed).toMatchObject({ stopReason: "timeout" });
    const stream = vi.fn((_req: ProxyRequest, signal?: AbortSignal) => new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => { signal?.removeEventListener("abort", cancel); resolve(jsonResponse()); }, 19000);
      const cancel = () => { clearTimeout(timer); reject(new DOMException("cancelled", "AbortError")); };
      signal?.addEventListener("abort", cancel, { once: true });
    }));
    const budgeted = probeModels(backend({ providerStream: stream }), provider, models(20), { timeoutMs: PROBE_TIMEOUT_MS, batchTimeoutMs: PROBE_BATCH_TIMEOUT_MS + 1 });
    await vi.advanceTimersByTimeAsync(PROBE_BATCH_TIMEOUT_MS - 1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await budgeted).toMatchObject({ probed: 16, ok: 12, unknown: 4, notProbed: 4, stopReason: "budget" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects invalid limits before starting a transport and reports zero-work selections", async () => {
    const value = backend({});
    for (const options of [{ concurrency: 0 }, { concurrency: NaN }, { timeoutMs: -1 }, { batchTimeoutMs: Infinity }, { max: -1 }, { max: 1.5 }]) await expect(probeModels(value, provider, models(3), options)).rejects.toThrow("probe_options_invalid");
    expect(value.providerRequest).not.toHaveBeenCalled();
    expect(await probeModels(value, provider, models(3), { max: 0 })).toMatchObject({ probed: 0, notProbed: 3, ok: 0, unknown: 0, stopReason: null });
    expect(await probeModels(value, provider, [])).toMatchObject({ total: 0, probed: 0, notProbed: 0, stopReason: null });
  });
});

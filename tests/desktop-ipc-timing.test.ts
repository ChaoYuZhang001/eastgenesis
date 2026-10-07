import { Channel } from "@tauri-apps/api/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installProviderIpcTimingObserver, normalizeProviderIpcTiming, sanitizeReportedProviderIpcTiming } from "../tools/desktop-ipc-timing.mjs";

const key = "__EASTGENESIS_QA_IPC_TIMING__";
function runtime() {
  const callbacks = new Map<number, (value: unknown) => unknown>();
  let id = 0;
  const internals = { callbacks, transformCallback: (callback: (value: unknown) => unknown) => { callbacks.set(++id, callback); return id; }, unregisterCallback: (callbackId: number) => callbacks.delete(callbackId) };
  Object.defineProperty(window, "__TAURI_INTERNALS__", { value: internals, configurable: true });
  return internals;
}
afterEach(() => {
  (window as any)[key]?.stop();
  delete (window as any)[key]; delete (window as any).__TAURI_INTERNALS__;
  vi.restoreAllMocks();
});

describe("owned WebView IPC timing observer", () => {
  it("observes the actual installed Channel API without retaining bodies or changing dispatch", () => {
    const internals = runtime();
    installProviderIpcTimingObserver(window);
    const receive = vi.fn();
    const channel = new Channel(receive);
    const callback = internals.callbacks.get(channel.id)!;
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(1020); callback({ index: 0, message: { type: "headers", status: 200 } });
    now.mockReturnValue(1080); callback({ index: 1, message: { type: "chunk", data: [115, 101, 99, 114, 101, 116] } });
    now.mockReturnValue(1100); callback({ index: 2, message: { type: "done" } });
    const snapshot = (window as any)[key].snapshot();
    expect(receive).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(snapshot)).not.toMatch(/secret|data|callbackId/);
    expect(normalizeProviderIpcTiming(snapshot, 1000, 1200)).toMatchObject({ status: "verified", performanceBaseline: false, channels: [{ ordinal: 1, headersLatencyMs: 20, firstBodyBytesLatencyMs: 80, transportTerminalLatencyMs: 100, transportTerminalKind: "done" }] });
    (window as any)[key].stop();
    expect((window as any)[key].stop().status).toBe("stopped");
    expect(Object.prototype.hasOwnProperty.call(internals.callbacks, "set")).toBe(false);
    callback({ index: 3, message: { type: "chunk", data: [1] } });
    expect(receive).toHaveBeenCalledTimes(4);
    expect((window as any)[key].snapshot().channels).toEqual(snapshot.channels);
  });

  it("preserves callback errors and excludes non-channel replies", () => {
    const internals = runtime(); installProviderIpcTimingObserver(window);
    internals.callbacks.set(1, () => { throw new Error("original_callback_error"); });
    expect(() => internals.callbacks.get(1)!({ privatePayload: "not-retained" })).toThrow("original_callback_error");
    expect((window as any)[key].snapshot().channels).toEqual([]);
  });

  it("keeps the real Channel ordering while marking out-of-order raw arrivals unverified", () => {
    const internals = runtime(); installProviderIpcTimingObserver(window);
    const received: string[] = []; const channel = new Channel<any>((message) => received.push(message.type));
    const callback = internals.callbacks.get(channel.id)!; const now = vi.spyOn(Date, "now");
    now.mockReturnValue(1020); callback({ index: 1, message: { type: "chunk", data: [1] } });
    now.mockReturnValue(1040); callback({ index: 0, message: { type: "headers", status: 200 } });
    expect(received).toEqual(["headers", "chunk"]);
    expect(normalizeProviderIpcTiming((window as any)[key].snapshot(), 1000, 1200)).toMatchObject({ status: "unverified", reason: "callback_arrival_order", channels: [] });
  });

  it("does not invent missing body/terminal times or accept timestamps outside the observation", () => {
    const sample = { schemaVersion: 1, source: "tauri_debug_callback_map_arrival", status: "recording", channels: [{ ordinal: 1, headersAtEpochMs: 1020, firstBodyBytesAtEpochMs: null, terminalAtEpochMs: null, terminalKind: null }] };
    expect(normalizeProviderIpcTiming(sample, 1000, 1200)).toMatchObject({ status: "verified", channels: [{ headersLatencyMs: 20, firstBodyBytesLatencyMs: null, transportTerminalLatencyMs: null }] });
    expect(normalizeProviderIpcTiming(sample, 1100, 1200)).toMatchObject({ status: "unverified", reason: "timestamp_outside_observation" });
    expect(normalizeProviderIpcTiming(sample, 1000, 1010)).toMatchObject({ status: "unverified", reason: "timestamp_outside_observation" });
    expect(normalizeProviderIpcTiming(null, 1000, 1200)).toMatchObject({ status: "not_recorded", reason: "observer_missing" });
    expect(normalizeProviderIpcTiming(sample, 1000.5, 1200)).toMatchObject({ status: "unverified", reason: "invalid_clock" });
  });

  it("rejects reversed raw arrivals even when they share one millisecond timestamp", () => {
    const internals = runtime(); installProviderIpcTimingObserver(window);
    const received: string[] = []; const channel = new Channel<any>((message) => received.push(message.type));
    const callback = internals.callbacks.get(channel.id)!;
    vi.spyOn(Date, "now").mockReturnValue(1020);
    callback({ index: 1, message: { type: "chunk", data: [1] } });
    callback({ index: 0, message: { type: "headers", status: 200 } });
    expect(received).toEqual(["headers", "chunk"]);
    expect(normalizeProviderIpcTiming((window as any)[key].snapshot(), 1000, 1200)).toMatchObject({ status: "unverified", reason: "callback_arrival_order", channels: [] });
  });

  it("fails closed at bounded channel counts and restores the hook without deleting another owner", () => {
    const internals = runtime(); installProviderIpcTimingObserver(window);
    for (let index = 0; index < 17; index++) {
      internals.callbacks.set(index, () => {});
      internals.callbacks.get(index)!({ index: 0, message: { type: "headers", status: 200 } });
    }
    expect((window as any)[key].snapshot()).toMatchObject({ status: "unverified", reason: "channel_limit" });
    const replacement = Map.prototype.set; Object.defineProperty(internals.callbacks, "set", { value: replacement, configurable: true });
    expect(normalizeProviderIpcTiming((window as any)[key].snapshot(), Date.now() - 1000, Date.now())).toMatchObject({ status: "unverified", reason: "observer_ownership_changed" });
    expect((window as any)[key].stop()).toMatchObject({ status: "unverified", reason: "observer_ownership_changed" });
    expect(internals.callbacks.set).toBe(replacement);
  });

  it("publishes only fixed metadata and valid durations, keeping historical observers missing", () => {
    const sample = { source: "tauri_debug_callback_map_arrival", origin: "before_webdriver_click_command", performanceBaseline: false, status: "verified", privatePayload: "never-forward", channels: [{ ordinal: 1, status: "verified", headersLatencyMs: 20, firstBodyBytesLatencyMs: 80, transportTerminalLatencyMs: 100, transportTerminalKind: "done", privateUrl: "never-forward" }] };
    expect(sanitizeReportedProviderIpcTiming(sample)).toMatchObject({ status: "verified", channels: [{ headersLatencyMs: 20, firstBodyBytesLatencyMs: 80 }] });
    expect(JSON.stringify(sanitizeReportedProviderIpcTiming(sample))).not.toContain("never-forward");
    for (const patch of [{ headersLatencyMs: -1 }, { firstBodyBytesLatencyMs: 19 }, { transportTerminalLatencyMs: 79 }, { transportTerminalKind: "secret" }, { ordinal: 2 }]) {
      expect(sanitizeReportedProviderIpcTiming({ ...sample, channels: [{ ...sample.channels[0], ...patch }] })).toMatchObject({ status: "unverified", reason: "measurement_metadata", channels: [] });
    }
    expect(sanitizeReportedProviderIpcTiming(undefined)).toMatchObject({ status: "not_recorded", reason: "observer_missing" });
  });
});

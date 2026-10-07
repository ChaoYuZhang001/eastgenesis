// QA-only observer. This function is self-contained so WebDriver can serialize
// it into the owned WebView. No payloads, callback IDs or Provider names survive.
// Tauri 2.12.0's debug callback Map is mutable; its API functions are readonly.
export function installProviderIpcTimingObserver(scope = globalThis) {
  const key = "__EASTGENESIS_QA_IPC_TIMING__";
  const source = "tauri_debug_callback_map_arrival";
  const unavailable = (reason) => ({ schemaVersion: 1, source, status: "unverified", reason, channels: [] });
  if (scope[key]) return unavailable("observer_already_installed");
  const map = scope.__TAURI_INTERNALS__?.callbacks;
  if (!(map instanceof Map) || typeof map.set !== "function") return unavailable("callback_map_unavailable");
  const original = map.set;
  const descriptor = Object.getOwnPropertyDescriptor(map, "set");
  const channels = [];
  let active = true;
  let failure = null;
  let events = 0;
  function observe(state, raw) {
    if (!active || failure || !raw || !Number.isSafeInteger(raw.index) || raw.index < 0 || !raw.message || typeof raw.message !== "object") return;
    const message = raw.message;
    const kind = message.type;
    if (!(kind === "headers" && raw.index === 0 && Number.isInteger(message.status) && message.status >= 100 && message.status <= 599)
      && !(kind === "chunk" && Array.isArray(message.data) && message.data.length > 0)
      && kind !== "done" && !(kind === "error" && message.error && typeof message.error === "object")) return;
    if (++events > 4096) { failure = "event_limit"; return; }
    if (!state.record) {
      if (channels.length >= 16) { failure = "channel_limit"; return; }
      state.record = { ordinal: channels.length + 1, headersAtEpochMs: null, firstBodyBytesAtEpochMs: null, terminalAtEpochMs: null, terminalKind: null };
      channels.push(state.record);
    }
    const at = Date.now();
    if (!Number.isSafeInteger(at) || at <= 0) { failure = "invalid_clock"; return; }
    const record = state.record;
    // Millisecond timestamps alone cannot detect two reversed callbacks that
    // arrive in the same tick. Validate observed phase order independently.
    if (kind !== "headers" && (record.headersAtEpochMs === null || record.terminalAtEpochMs !== null)
      || kind === "headers" && (record.firstBodyBytesAtEpochMs !== null || record.terminalAtEpochMs !== null)) {
      failure = "callback_arrival_order";
      return;
    }
    if (kind === "headers" && record.headersAtEpochMs === null) record.headersAtEpochMs = at;
    if (kind === "chunk" && record.firstBodyBytesAtEpochMs === null) record.firstBodyBytesAtEpochMs = at;
    if ((kind === "done" || kind === "error") && record.terminalAtEpochMs === null) {
      record.terminalAtEpochMs = at; record.terminalKind = kind;
    }
  }
  function wrappedSet(id, callback) {
    if (this !== map || typeof callback !== "function") return original.call(this, id, callback);
    const state = { record: null };
    return original.call(this, id, function (raw) {
      try { observe(state, raw); } catch { failure = "observer_error"; }
      return callback(raw);
    });
  }
  const snapshot = () => {
    if (active && map.set !== wrappedSet) failure = "observer_ownership_changed";
    return {
      schemaVersion: 1, source, status: failure ? "unverified" : active ? "recording" : "stopped",
      ...(failure ? { reason: failure } : {}),
      channels: channels.map((record) => ({ ...record })),
    };
  };
  const stop = () => {
    if (!active) return snapshot();
    active = false;
    if (map.set === wrappedSet) {
      if (descriptor) Object.defineProperty(map, "set", descriptor);
      else delete map.set;
    } else failure = "observer_ownership_changed";
    return snapshot();
  };
  try {
    Object.defineProperty(map, "set", { value: wrappedSet, configurable: true, writable: true });
    Object.defineProperty(scope, key, { value: { snapshot, stop }, configurable: true });
  } catch {
    if (map.set === wrappedSet) {
      if (descriptor) Object.defineProperty(map, "set", descriptor);
      else delete map.set;
    }
    return unavailable("observer_hook_unavailable");
  }
  return snapshot();
}

const SOURCE = "tauri_debug_callback_map_arrival";
const ORIGIN = "before_webdriver_click_command";
const reasons = new Set(["observer_already_installed", "callback_map_unavailable", "observer_hook_unavailable", "event_limit", "channel_limit", "invalid_clock", "observer_error", "observer_ownership_changed", "callback_arrival_order"]);
const timestamp = (value) => Number.isSafeInteger(value) && value > 0;

export function normalizeProviderIpcTiming(raw, submittedAt, observedAt) {
  const base = { source: SOURCE, origin: ORIGIN, interpretation: "native IPC callback arrival at the WebView; body bytes can include SSE metadata; not model first token or first paint", performanceBaseline: false };
  const unverified = (reason) => ({ ...base, status: "unverified", reason, channels: [] });
  if (!timestamp(submittedAt) || !timestamp(observedAt) || observedAt < submittedAt) return unverified("invalid_clock");
  if (!raw) return { ...base, status: "not_recorded", reason: "observer_missing", channels: [] };
  if (raw.schemaVersion !== 1 || raw.source !== SOURCE || !Array.isArray(raw.channels) || raw.channels.length > 16) return unverified("measurement_metadata");
  if (raw.status === "unverified") return unverified(reasons.has(raw.reason) ? raw.reason : "measurement_metadata");
  if (raw.status !== "recording" && raw.status !== "stopped") return unverified("measurement_metadata");
  const channels = [];
  for (const [index, record] of raw.channels.entries()) {
    if (!record || record.ordinal !== index + 1) return unverified("measurement_metadata");
    const times = [record.headersAtEpochMs, record.firstBodyBytesAtEpochMs, record.terminalAtEpochMs];
    if (times.some((at) => at !== null && (!timestamp(at) || at < submittedAt || at > observedAt))) return unverified("timestamp_outside_observation");
    if (record.terminalAtEpochMs === null ? record.terminalKind !== null : !["done", "error"].includes(record.terminalKind)) return unverified("measurement_metadata");
    if (record.headersAtEpochMs === null) {
      channels.push({ ordinal: record.ordinal, status: "unverified", reason: "headers_missing" });
      continue;
    }
    if (record.firstBodyBytesAtEpochMs !== null && record.firstBodyBytesAtEpochMs < record.headersAtEpochMs
      || record.terminalAtEpochMs !== null && record.terminalAtEpochMs < (record.firstBodyBytesAtEpochMs ?? record.headersAtEpochMs)) return unverified("callback_arrival_order");
    channels.push({
      ordinal: record.ordinal, status: "verified", headersLatencyMs: record.headersAtEpochMs - submittedAt,
      firstBodyBytesLatencyMs: record.firstBodyBytesAtEpochMs === null ? null : record.firstBodyBytesAtEpochMs - submittedAt,
      transportTerminalLatencyMs: record.terminalAtEpochMs === null ? null : record.terminalAtEpochMs - submittedAt,
      transportTerminalKind: record.terminalKind,
    });
  }
  return { ...base, status: channels.length ? channels.every((channel) => channel.status === "verified") ? "verified" : "unverified" : "not_recorded", ...(channels.length ? {} : { reason: "stream_missing" }), channels };
}

// Summaries accept only fixed metadata and numeric durations. A historical
// record with no observer result stays missing; arbitrary input is not copied.
export function sanitizeReportedProviderIpcTiming(value) {
  const base = { source: SOURCE, origin: ORIGIN, performanceBaseline: false };
  const invalid = () => ({ ...base, status: "unverified", reason: "measurement_metadata", channels: [] });
  if (value == null) return { ...base, status: "not_recorded", reason: "observer_missing", channels: [] };
  if (value.source !== SOURCE || value.origin !== ORIGIN || value.performanceBaseline !== false || !Array.isArray(value.channels) || value.channels.length > 16) return invalid();
  if (value.status === "unverified") {
    const allowed = reasons.has(value.reason) || ["measurement_metadata", "timestamp_outside_observation", "callback_arrival_order"].includes(value.reason);
    return { ...base, status: "unverified", reason: allowed ? value.reason : "measurement_metadata", channels: [] };
  }
  if (value.status === "not_recorded" && ["observer_missing", "stream_missing"].includes(value.reason) && value.channels.length === 0) return { ...base, status: "not_recorded", reason: value.reason, channels: [] };
  if (value.status !== "verified" || value.channels.length === 0) return invalid();
  const duration = (value) => Number.isSafeInteger(value) && value >= 0;
  const channels = [];
  for (const [index, channel] of value.channels.entries()) {
    if (!channel || channel.ordinal !== index + 1 || channel.status !== "verified" || !duration(channel.headersLatencyMs)
      || channel.firstBodyBytesLatencyMs !== null && (!duration(channel.firstBodyBytesLatencyMs) || channel.firstBodyBytesLatencyMs < channel.headersLatencyMs)
      || channel.transportTerminalLatencyMs !== null && (!duration(channel.transportTerminalLatencyMs) || channel.transportTerminalLatencyMs < (channel.firstBodyBytesLatencyMs ?? channel.headersLatencyMs))
      || (channel.transportTerminalLatencyMs === null ? channel.transportTerminalKind !== null : !["done", "error"].includes(channel.transportTerminalKind))) return invalid();
    channels.push({ ordinal: channel.ordinal, status: "verified", headersLatencyMs: channel.headersLatencyMs, firstBodyBytesLatencyMs: channel.firstBodyBytesLatencyMs, transportTerminalLatencyMs: channel.transportTerminalLatencyMs, transportTerminalKind: channel.transportTerminalKind });
  }
  return { ...base, status: "verified", channels };
}

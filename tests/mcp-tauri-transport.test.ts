import { BackendTransport, connectBackendServer } from "@/platform/mcp-transport";
import { createTauriBackend } from "@/platform/tauri-backend";
import type { Backend, McpServerView } from "@/platform/types";

type EventHandler = (event: { payload: unknown }) => void;
type InvokeArgs = { server: string; connectionId?: string; line?: string };
const invoke = vi.fn();
const listeners = new Map<string, Set<EventHandler>>();

vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (event: string, handler: EventHandler) => {
    const handlers = listeners.get(event) ?? new Set<EventHandler>();
    handlers.add(handler);
    listeners.set(event, handlers);
    return () => handlers.delete(handler);
  },
}));

function emit(event: string, payload: unknown) {
  for (const handler of [...(listeners.get(event) ?? [])]) handler({ payload });
}

const config: McpServerView = {
  id: "files", command: "EastGenesis", args: [], env: {}, cwd: null,
  allow_tools: ["read_file"], trust_annotations: true, refs: [],
  running: true, stderr_tail: null, builtin: true,
};

describe("Tauri MCP connection event ownership", () => {
  let connectionIds: string[];
  let currentId: string;

  beforeEach(() => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    listeners.clear();
    connectionIds = [];
    currentId = "";
    invoke.mockReset().mockImplementation(async (command: string, args: InvokeArgs) => {
      if (command === "mcp_start") {
        expect(listeners.get("mcp-message")?.size).toBe(1);
        expect(listeners.get("mcp-exit")?.size).toBe(1);
        currentId = args.connectionId!;
        connectionIds.push(currentId);
        return config;
      }
      if (command === "mcp_send") {
        expect(args.connectionId).toBe(currentId);
        const message = JSON.parse(args.line!);
        if (message.id !== undefined) {
          const result = message.method === "initialize"
            ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "owned-files", version: "1" } }
            : message.method === "tools/list" ? { tools: [] } : {};
          emit("mcp-message", { server: args.server, connection_id: currentId, line: JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) });
        }
      }
      // A successful roots save has already removed the old process in Rust.
      if (command === "mcp_stop") {
        expect(args.connectionId).toBe(currentId);
        return false;
      }
      return undefined;
    });
  });

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    vi.unstubAllGlobals();
  });

  it("subscribes before start and rejects prior or untagged lines/exits while startup is pending", async () => {
    const backend = createTauriBackend();
    const deliveredLines: string[] = [];
    const deliveredExits: string[] = [];
    const onMcp = backend.onMcp;
    backend.onMcp = (server, handlers) => onMcp(server, {
      ...handlers,
      onLine: (line) => { deliveredLines.push(line); handlers.onLine(line); },
      onExit: (reason) => { deliveredExits.push(reason); handlers.onExit(reason); },
    });
    const defaultInvoke = invoke.getMockImplementation()!;
    let releaseStart!: () => void;
    let enteredStart!: () => void;
    const entered = new Promise<void>((resolve) => { enteredStart = resolve; });
    invoke.mockImplementation(async (command: string, args: InvokeArgs) => {
      const result = await defaultInvoke(command, args);
      if (command === "mcp_start") {
        enteredStart();
        await new Promise<void>((resolve) => { releaseStart = resolve; });
      }
      return result;
    });
    const pending = connectBackendServer(backend, "files", 1_000);
    await entered;
    for (const oldId of ["prior-connection", undefined, null]) {
      emit("mcp-message", { server: "files", connection_id: oldId, line: "old line" });
      emit("mcp-exit", { server: "files", connection_id: oldId, reason: "prior process exited" });
    }
    expect(deliveredLines).toEqual([]);
    expect(deliveredExits).toEqual([]);
    expect(currentId).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
    releaseStart();
    const { transport, client } = await pending;
    expect(client.serverInfo?.name).toBe("owned-files");
    expect(deliveredLines).toHaveLength(1);
    await transport.close();
  });

  it("keeps the new connection alive after roots save when old lines/exits arrive, and accepts its own events", async () => {
    const backend = createTauriBackend();
    const first = await connectBackendServer(backend, "files", 1_000);
    const oldId = currentId;
    await first.transport.close();
    const second = await connectBackendServer(backend, "files", 1_000);
    expect(currentId).not.toBe(oldId);
    expect(connectionIds).toHaveLength(2);
    const messages: unknown[] = [];
    const exits: (string | undefined)[] = [];
    second.transport.onMessage((message) => messages.push(message));
    second.transport.onClose((reason) => exits.push(reason));
    const line = JSON.stringify({ jsonrpc: "2.0", id: 999, result: { owned: true } });
    for (const oldConnection of [oldId, undefined, null]) {
      emit("mcp-message", { server: "files", connection_id: oldConnection, line });
      emit("mcp-exit", { server: "files", connection_id: oldConnection, reason: "late old exit" });
    }
    emit("mcp-exit", { server: "another", connection_id: currentId, reason: "another server" });
    expect(messages).toEqual([]);
    expect(exits).toEqual([]);
    await expect(second.client.listTools()).resolves.toEqual([]);
    messages.length = 0;
    emit("mcp-message", { server: "files", connection_id: currentId, line });
    expect(messages).toEqual([JSON.parse(line)]);
    emit("mcp-exit", { server: "files", connection_id: currentId, reason: "current process exited" });
    expect(exits).toEqual(["MCP 服务器已退出（current process exited）"]);
    expect(() => second.transport.send({ jsonrpc: "2.0", id: 1, method: "ping" })).toThrow("current process exited");
    expect(listeners.get("mcp-message")?.size).toBe(0);
    expect(listeners.get("mcp-exit")?.size).toBe(0);
  });

  it("accepts the current process exit during start and rejects initialization", async () => {
    const defaultInvoke = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (command: string, args: InvokeArgs) => {
      const result = await defaultInvoke(command, args);
      if (command === "mcp_start") emit("mcp-exit", { server: "files", connection_id: currentId, reason: "startup failed" });
      return result;
    });
    await expect(connectBackendServer(createTauriBackend(), "files", 1_000)).rejects.toThrow("startup failed");
    expect(listeners.get("mcp-exit")?.size).toBe(0);
  });

  it("tags delayed sends and closes from an old transport with its original ID", async () => {
    const acceptedSends: string[] = [];
    let rejectOldSend!: (reason: unknown) => void;
    let enteredOldSend!: () => void;
    let enteredNewSend!: () => void;
    const oldSendEntered = new Promise<void>((resolve) => { enteredOldSend = resolve; });
    const newSendEntered = new Promise<void>((resolve) => { enteredNewSend = resolve; });
    invoke.mockImplementation(async (command: string, args: InvokeArgs) => {
      if (command === "mcp_start") {
        currentId = args.connectionId!;
        connectionIds.push(currentId);
        return config;
      }
      if (command === "mcp_send") {
        if (args.connectionId !== currentId) {
          await new Promise<void>((_, reject) => { rejectOldSend = reject; enteredOldSend(); });
          return;
        }
        acceptedSends.push(args.connectionId);
        enteredNewSend();
      }
      if (command === "mcp_stop") return false;
      return undefined;
    });
    const backend = createTauriBackend();
    const old = await BackendTransport.start(backend, "files");
    const oldId = currentId;
    // The root save stopped the process before the UI disposed this transport.
    const next = await BackendTransport.start(backend, "files");
    const nextId = currentId;
    const exits: (string | undefined)[] = [];
    next.onClose((reason) => exits.push(reason));
    const message = { jsonrpc: "2.0" as const, id: 1, method: "ping" };
    old.send(message);
    await oldSendEntered;
    await old.close();
    expect(invoke).toHaveBeenCalledWith("mcp_send", { server: "files", line: JSON.stringify(message), connectionId: oldId });
    expect(invoke).toHaveBeenCalledWith("mcp_stop", { server: "files", connectionId: oldId });
    expect(acceptedSends).toEqual([]);
    expect(exits).toEqual([]);
    rejectOldSend({ code: "stale_connection", message: "旧连接不能操作新进程" });
    next.send(message);
    await newSendEntered;
    expect(acceptedSends).toEqual([nextId]);
    emit("mcp-exit", { server: "files", connection_id: nextId, reason: "owned exit" });
  });

  it("retains untagged server listeners for detached-process cleanup and forwards optional start IDs", async () => {
    const backend = createTauriBackend();
    const lines: string[] = [];
    const exits: string[] = [];
    const off = await backend.onMcp("files", { onLine: (line) => lines.push(line), onExit: (reason) => exits.push(reason) });
    for (const id of [undefined, "tagged-process"]) {
      emit("mcp-message", { server: "files", connection_id: id, line: "{}" });
      emit("mcp-exit", { server: "files", connection_id: id, reason: "exited" });
    }
    emit("mcp-exit", { server: "another", reason: "ignore" });
    expect(lines).toEqual(["{}", "{}"]);
    expect(exits).toEqual(["exited", "exited"]);
    invoke.mockResolvedValue(config);
    await backend.mcpStart("files");
    await backend.mcpStart("files", "owned-connection");
    await backend.mcpSend("files", "{}");
    await backend.mcpSend("files", "{}", "owned-connection");
    await backend.mcpStop("files");
    await backend.mcpStop("files", "owned-connection");
    expect(invoke.mock.calls.slice(-6)).toEqual([
      ["mcp_start", { server: "files" }],
      ["mcp_start", { server: "files", connectionId: "owned-connection" }],
      ["mcp_send", { server: "files", line: "{}" }],
      ["mcp_send", { server: "files", line: "{}", connectionId: "owned-connection" }],
      ["mcp_stop", { server: "files" }],
      ["mcp_stop", { server: "files", connectionId: "owned-connection" }],
    ]);
    off();
  });

  it("uses cryptographic random bytes when randomUUID is unavailable", async () => {
    let batch = 0;
    const getRandomValues = vi.fn((bytes: Uint8Array) => { bytes.fill(++batch); return bytes; });
    vi.stubGlobal("crypto", { getRandomValues });
    const backend: Backend = createTauriBackend();
    const first = await BackendTransport.start(backend, "files");
    await first.close();
    const second = await BackendTransport.start(backend, "files");
    expect(connectionIds).toEqual(["01".repeat(16), "02".repeat(16)]);
    expect(getRandomValues).toHaveBeenCalledTimes(2);
    await second.close();
  });
});

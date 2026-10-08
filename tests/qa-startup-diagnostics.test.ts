import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

const mocks = vi.hoisted(() => ({ load: vi.fn(), call: vi.fn() }));
vi.mock("@tauri-apps/plugin-sql", () => ({ default: { load: mocks.load } }));
vi.mock("@/lib/ipc", async (importOriginal) => ({ ...await importOriginal<typeof import("@/lib/ipc")>(), call: mocks.call }));

type QaWindow = Window & { __EG_QA_STARTUP_RECORD__?: (stage: string) => void };
const qaWindow = window as QaWindow;
let stages: string[];

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  stages = [];
  delete qaWindow.__EG_QA_STARTUP_RECORD__;
});
afterEach(() => { delete qaWindow.__EG_QA_STARTUP_RECORD__; });

function installRecorder() { qaWindow.__EG_QA_STARTUP_RECORD__ = (stage) => { stages.push(stage); }; }

it("ordinary frontend has no recorder or diagnostic IPC and optional recorder failures cannot break startup", async () => {
  const { recordQaStartup } = await import("@/lib/qa-startup");
  expect(() => recordQaStartup("frontend_entry")).not.toThrow();
  expect(mocks.call).not.toHaveBeenCalled();
  qaWindow.__EG_QA_STARTUP_RECORD__ = () => { throw new Error("synthetic private error"); };
  const { useAppStore } = await import("@/stores/app");
  const { createMockBackend } = await import("@/platform");
  await useAppStore.getState().bootstrap(createMockBackend());
  expect(useAppStore.getState().phase).toBe("ready");
});

it("SQL load observations share the real single connection promise while preserving the unresolved load", async () => {
  installRecorder();
  let finish!: (value: unknown) => void;
  mocks.load.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
  const { database } = await import("@/lib/db");
  const first = database();
  const second = database();
  expect(second).toBe(first);
  await vi.waitFor(() => expect(mocks.load).toHaveBeenCalledTimes(1));
  expect(stages).toEqual(["sql_import_started", "sql_import_resolved", "db_load_called"]);
  const db = { select: vi.fn(), execute: vi.fn() };
  finish(db);
  expect(await first).toBe(db);
  expect(stages.at(-1)).toBe("db_load_resolved");
});

it("failed SQL loads keep error identity and permit a subsequent load without diagnostic text", async () => {
  installRecorder();
  const error = { code: "db_open_failed", message: "synthetic confidential message", detail: "synthetic SQL/path" };
  mocks.load.mockRejectedValueOnce(error).mockResolvedValueOnce({ select: vi.fn(), execute: vi.fn() });
  const { database } = await import("@/lib/db");
  await expect(database()).rejects.toEqual(error);
  expect(stages).toContain("db_load_failed");
  await database();
  expect(mocks.load).toHaveBeenCalledTimes(2);
  expect(stages.filter((stage) => stage === "sql_import_started")).toHaveLength(2);
  expect(JSON.stringify(stages)).not.toMatch(/confidential|SQL\/path/);
});

it("backend still runs app info and database concurrently while a diagnostic return never becomes a dependency", async () => {
  qaWindow.__EG_QA_STARTUP_RECORD__ = (stage) => { stages.push(stage); return new Promise(() => {}) as unknown as void; };
  let infoFinish!: (value: unknown) => void;
  mocks.call.mockImplementation((name) => {
    if (name !== "get_app_info") throw new Error("unexpected command");
    return new Promise((resolve) => { infoFinish = resolve; });
  });
  const db = { select: vi.fn().mockResolvedValue([{ value: "7" }]), execute: vi.fn() };
  mocks.load.mockResolvedValue(db);
  const { createTauriBackend } = await import("@/platform/tauri-backend");
  const pending = createTauriBackend().init();
  await vi.waitFor(() => expect(stages).toContain("db_load_resolved"));
  expect(db.select).not.toHaveBeenCalled();
  infoFinish({ name: "QA", version: "0.1.0", db_path_hint: "fixed" });
  const result = await pending;
  expect(result.schemaVersion).toBe(7);
  expect(stages).toContain("app_info_resolved");
  expect(stages.slice(-3)).toEqual(["schema_read_started", "schema_read_resolved", "backend_init_resolved"]);
});

it("schema and app-info failures have distinct fixed observations and preserve original errors", async () => {
  installRecorder();
  const schemaError = new Error("synthetic private schema details");
  mocks.call.mockResolvedValueOnce({ name: "QA", version: "0.1.0", db_path_hint: "fixed" });
  mocks.load.mockResolvedValue({ select: vi.fn().mockRejectedValue(schemaError), execute: vi.fn() });
  let { createTauriBackend } = await import("@/platform/tauri-backend");
  await expect(createTauriBackend().init()).rejects.toBe(schemaError);
  expect(stages.slice(-2)).toEqual(["schema_read_failed", "backend_init_failed"]);
  vi.resetModules(); stages = [];
  const infoError = new Error("synthetic private info details");
  mocks.call.mockRejectedValueOnce(infoError);
  mocks.load.mockResolvedValue({ select: vi.fn(), execute: vi.fn() });
  ({ createTauriBackend } = await import("@/platform/tauri-backend"));
  await expect(createTauriBackend().init()).rejects.toBe(infoError);
  expect(stages).toContain("app_info_failed");
  expect(stages).not.toContain("schema_read_started");
  // Promise.all rejects without cancelling the independent database branch.
  expect(stages).toContain("backend_init_failed");
  expect(JSON.stringify(stages)).not.toContain("private");
});

it("native QA init script uses fixed payloads, bounds renderer traffic and filters other frames", async () => {
  const native = await readFile("src-tauri/src/qa_startup_diagnostics.rs", "utf8");
  const script = native.match(/const INIT_SCRIPT: &str = r#"([\s\S]*?)"#;/)?.[1];
  expect(script).toBeTruthy();
  const listeners: Record<string, (event?: unknown) => void> = {};
  const invoke = vi.fn().mockResolvedValue(undefined);
  const fake: Record<string, any> = { __TAURI_INTERNALS__: { metadata: { currentWebview: { label: "main" } }, invoke },
    addEventListener: (name: string, listener: (event?: unknown) => void) => { listeners[name] = listener; } };
  fake.top = fake;
  runInNewContext(script!, { window: fake });
  expect(invoke).toHaveBeenCalledWith("qa_startup_record", { stage: "document_start", frontendSeq: 1 });
  listeners.error({ message: "private", filename: "private-path", error: new Error("private") });
  listeners.unhandledrejection({ reason: "private-provider" });
  expect(invoke.mock.calls.slice(1).map((call) => call[1])).toEqual([
    { stage: "document_error", frontendSeq: 2 }, { stage: "document_unhandled_rejection", frontendSeq: 3 },
  ]);
  fake.__EG_QA_STARTUP_RECORD__("private-stage");
  for (let index = 0; index < 100; index++) fake.__EG_QA_STARTUP_RECORD__("bootstrap_started");
  expect(invoke).toHaveBeenCalledTimes(64);
  expect(JSON.stringify(invoke.mock.calls)).not.toContain("private");
  for (const other of [
    { top: {}, __TAURI_INTERNALS__: fake.__TAURI_INTERNALS__ },
    { __TAURI_INTERNALS__: { metadata: { currentWebview: { label: "other" } } } },
    {},
  ] as Record<string, any>[]) {
    other.top ??= other;
    runInNewContext(script!, { window: other });
    expect(other.__EG_QA_STARTUP_RECORD__).toBeUndefined();
  }
});

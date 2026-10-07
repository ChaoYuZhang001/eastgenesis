import { asDb, loadSqlite, migratedDb, readMigrations, type RawDb } from "./sqlite-helper";

const mocks = vi.hoisted(() => ({ load: vi.fn(), call: vi.fn() }));
vi.mock("@tauri-apps/plugin-sql", () => ({ default: { load: mocks.load } }));
vi.mock("@/lib/ipc", async (importOriginal) => ({ ...await importOriginal<typeof import("@/lib/ipc")>(), call: mocks.call }));

const sqlite = await loadSqlite();
const info = { name: "QA", version: "0.1.0", db_path_hint: "eastgenesis.db" };
let raw: (RawDb & { close?: () => void }) | undefined;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.call.mockImplementation((command) => {
    if (command !== "get_app_info") throw new Error("unexpected bootstrap command");
    return Promise.resolve(info);
  });
});
afterEach(() => { raw?.close?.(); raw = undefined; });

describe.skipIf(!sqlite)("desktop schema compatibility at bootstrap", () => {
  it("refuses a real schema 6 database and preserves an unresolved invocation on repeated retry", async () => {
    raw = migratedDb(sqlite!, 6);
    raw.exec("INSERT INTO tool_invocations (idempotency_key,task_id,step_id,invocation_id,tool,args_digest,attempt,state,artifacts,detail,created_at,updated_at) VALUES ('qa-legacy-key','qa-task','qa-step','qa-invocation','write_file','qa-digest',1,'unknown','[]','',1,1)");
    const before = raw.prepare("SELECT * FROM tool_invocations").all({});
    const db = asDb(() => raw!);
    const select = vi.spyOn(db, "select");
    const execute = vi.spyOn(db, "execute");
    mocks.load.mockResolvedValue(db);
    const { createTauriBackend } = await import("@/platform/tauri-backend");
    const { useAppStore } = await import("@/stores/app");
    const backend = createTauriBackend();
    for (let attempt = 0; attempt < 2; attempt++) {
      await useAppStore.getState().bootstrap(backend);
      expect(useAppStore.getState()).toMatchObject({ phase: "error", init: null, error: { code: "db_schema_not_ready" } });
    }
    expect(select).toHaveBeenCalledTimes(2);
    expect(execute).not.toHaveBeenCalled();
    expect(mocks.load).toHaveBeenCalledTimes(1);
    expect(raw.prepare("SELECT * FROM tool_invocations").all({})).toEqual(before);
    expect(raw.prepare("SELECT value FROM app_meta WHERE key='schema_version'").get({})).toEqual({ value: "6" });
    expect(mocks.call.mock.calls.every(([command]) => command === "get_app_info")).toBe(true);
  });

  it("refuses newer schema metadata without writing or downgrading existing data", async () => {
    raw = migratedDb(sqlite!);
    raw.exec("UPDATE app_meta SET value='8' WHERE key='schema_version'");
    const db = asDb(() => raw!);
    const execute = vi.spyOn(db, "execute");
    mocks.load.mockResolvedValue(db);
    const { createTauriBackend } = await import("@/platform/tauri-backend");
    const { useAppStore } = await import("@/stores/app");
    await useAppStore.getState().bootstrap(createTauriBackend());
    expect(useAppStore.getState()).toMatchObject({ phase: "error", init: null, error: { code: "db_schema_newer" } });
    expect(execute).not.toHaveBeenCalled();
    expect(raw.prepare("SELECT value FROM app_meta WHERE key='schema_version'").get({})).toEqual({ value: "8" });
  });

  it("refuses absent schema metadata instead of presenting a ready workspace", async () => {
    raw = migratedDb(sqlite!);
    raw.exec("DELETE FROM app_meta WHERE key='schema_version'");
    mocks.load.mockResolvedValue(asDb(() => raw!));
    const { createTauriBackend } = await import("@/platform/tauri-backend");
    const { useAppStore } = await import("@/stores/app");
    await useAppStore.getState().bootstrap(createTauriBackend());
    expect(useAppStore.getState()).toMatchObject({ phase: "error", init: null, error: { code: "db_schema_invalid" } });
    expect(raw.prepare("SELECT value FROM app_meta WHERE key='schema_version'").all({})).toEqual([]);
  });

  it("accepts current schema while retaining a pre-existing active lease", async () => {
    raw = migratedDb(sqlite!);
    raw.exec("INSERT INTO tool_invocations (idempotency_key,task_id,step_id,invocation_id,tool,args_digest,attempt,state,artifacts,detail,created_at,updated_at,lease_owner,lease_expires_at) VALUES ('qa-current-key','qa-task','qa-step','qa-invocation','write_file','qa-digest',1,'started','[]','',1,1,'qa-owner',9999999999999)");
    const before = raw.prepare("SELECT * FROM tool_invocations").all({});
    mocks.load.mockResolvedValue(asDb(() => raw!));
    const { createTauriBackend } = await import("@/platform/tauri-backend");
    const { useAppStore } = await import("@/stores/app");
    await useAppStore.getState().bootstrap(createTauriBackend());
    expect(useAppStore.getState()).toMatchObject({ phase: "ready", error: null, init: { schemaVersion: 7 } });
    expect(raw.prepare("SELECT * FROM tool_invocations").all({})).toEqual(before);
  });

  it.each(["not-a-version", "0", "-1", "7.5"])("refuses malformed schema metadata %s", async (value) => {
    raw = migratedDb(sqlite!);
    raw.prepare("UPDATE app_meta SET value=$value WHERE key='schema_version'").run({ $value: value });
    const db = asDb(() => raw!);
    const execute = vi.spyOn(db, "execute");
    mocks.load.mockResolvedValue(db);
    const { createTauriBackend } = await import("@/platform/tauri-backend");
    const { useAppStore } = await import("@/stores/app");
    await useAppStore.getState().bootstrap(createTauriBackend());
    expect(useAppStore.getState()).toMatchObject({ phase: "error", init: null, error: { code: "db_schema_invalid" } });
    expect(execute).not.toHaveBeenCalled();
    expect(raw.prepare("SELECT value FROM app_meta WHERE key='schema_version'").get({})).toEqual({ value });
  });

  it("rechecks compatibility on retry and only becomes ready after the schema has advanced", async () => {
    raw = migratedDb(sqlite!, 6);
    mocks.load.mockResolvedValue(asDb(() => raw!));
    const { createTauriBackend } = await import("@/platform/tauri-backend");
    const { useAppStore } = await import("@/stores/app");
    const backend = createTauriBackend();
    await useAppStore.getState().bootstrap(backend);
    expect(useAppStore.getState().phase).toBe("error");
    // Fixture preparation only: production migrations are run by the native plugin.
    raw.exec(readMigrations().find((migration) => migration.version === 7)!.sql);
    await useAppStore.getState().bootstrap(backend);
    expect(useAppStore.getState()).toMatchObject({ phase: "ready", error: null, init: { schemaVersion: 7 } });
    expect(mocks.load).toHaveBeenCalledTimes(1);
  });
});

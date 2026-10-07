const mocks = vi.hoisted(() => ({ load: vi.fn(), call: vi.fn(), install: vi.fn() }));
vi.mock("@tauri-apps/plugin-sql", () => ({ default: { load: mocks.load } }));
vi.mock("@/lib/ipc", async (original) => ({ ...await original<typeof import("@/lib/ipc")>(), call: mocks.call }));
vi.mock("@/lib/qa-goal-snapshot", () => ({ installQaGoalObserver: mocks.install }));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  mocks.call.mockResolvedValue({ name: "QA", version: "0.1.0", db_path_hint: "fixed" });
  mocks.install.mockResolvedValue(undefined);
});
afterEach(() => { vi.unstubAllEnvs(); });

it("ordinary backend startup does not import or invoke the QA observer", async () => {
  const db = { select: vi.fn().mockResolvedValue([{ value: "7" }]), execute: vi.fn() };
  mocks.load.mockResolvedValue(db);
  const { createTauriBackend } = await import("@/platform/tauri-backend");
  expect((await createTauriBackend().init()).schemaVersion).toBe(7);
  expect(mocks.install).not.toHaveBeenCalled();
  expect(mocks.call.mock.calls.map((call) => call[0])).toEqual(["get_app_info"]);
  expect(db.select).toHaveBeenCalledTimes(1);
  expect(db.execute).not.toHaveBeenCalled();
});

it("QA installation waits for validated schema and receives only the actual select handle", async () => {
  vi.stubEnv("VITE_QA_GOAL_OBSERVER", "1");
  let finish!: (rows: unknown) => void;
  const db = { select: vi.fn().mockReturnValue(new Promise((resolve) => { finish = resolve; })), execute: vi.fn() };
  mocks.load.mockResolvedValue(db);
  const { createTauriBackend } = await import("@/platform/tauri-backend");
  const pending = createTauriBackend().init();
  await vi.waitFor(() => expect(db.select).toHaveBeenCalledTimes(1));
  expect(mocks.install).not.toHaveBeenCalled();
  finish([{ value: "7" }]);
  expect((await pending).schemaVersion).toBe(7);
  await vi.waitFor(() => expect(mocks.install).toHaveBeenCalledTimes(1));
  const [selectOnly, request] = mocks.install.mock.calls[0];
  expect(Object.keys(selectOnly)).toEqual(["select"]);
  db.select.mockResolvedValueOnce([]);
  await selectOnly.select("synthetic explicitly requested observation", ["goal-a"]);
  expect(db.select).toHaveBeenLastCalledWith("synthetic explicitly requested observation", ["goal-a"]);
  await request("qa_goal_snapshot_capability");
  expect(mocks.call).toHaveBeenLastCalledWith("qa_goal_snapshot_capability", undefined);
  expect(db.execute).not.toHaveBeenCalled();
});

it("a failed schema cannot install the observer even in a QA frontend", async () => {
  vi.stubEnv("VITE_QA_GOAL_OBSERVER", "1");
  mocks.load.mockResolvedValue({ select: vi.fn().mockResolvedValue([{ value: "999" }]), execute: vi.fn() });
  const { createTauriBackend } = await import("@/platform/tauri-backend");
  await expect(createTauriBackend().init()).rejects.toBeTruthy();
  expect(mocks.install).not.toHaveBeenCalled();
  expect(mocks.call.mock.calls.map((call) => call[0])).toEqual(["get_app_info"]);
});

it("observer rejection or unresolved installation never becomes a startup dependency", async () => {
  vi.stubEnv("VITE_QA_GOAL_OBSERVER", "1");
  mocks.load.mockResolvedValue({ select: vi.fn().mockResolvedValue([{ value: "7" }]), execute: vi.fn() });
  mocks.install.mockReturnValueOnce(new Promise(() => {}));
  const { createTauriBackend } = await import("@/platform/tauri-backend");
  expect((await createTauriBackend().init()).schemaVersion).toBe(7);
  await vi.waitFor(() => expect(mocks.install).toHaveBeenCalledTimes(1));
  mocks.install.mockRejectedValueOnce(new Error("synthetic private observation error"));
  expect((await createTauriBackend().init()).schemaVersion).toBe(7);
  await vi.waitFor(() => expect(mocks.install).toHaveBeenCalledTimes(2));
});

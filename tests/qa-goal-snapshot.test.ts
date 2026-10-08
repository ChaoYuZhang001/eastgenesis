import { fireEvent, screen, waitFor } from "@testing-library/react";
import type { Db } from "@/lib/db";
import type { QaGoalObserverRequest } from "@/lib/qa-goal-snapshot";
import { normalizeTurn } from "@/decision/session";
import { emptyEvidence } from "@/decision/evidence";
import { GOAL_QUOTA_PROTOCOL } from "@/core/goal-quota";

const plugin = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("@tauri-apps/plugin-sql", () => ({ default: { load: plugin.load } }));
const runId = "01234567-89ab-4cde-8fab-0123456789ab", goalId = "goal-alpha", taskId = "task-alpha";
const capability = () => ({ protocol: "canonical-goal-observer-v1", runId, isolated: true });
let frame: Window;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  document.body.replaceChildren();
  const fake: Record<string, unknown> = { document, __TAURI_INTERNALS__: { metadata: { currentWebview: { label: "main" } } } };
  fake.top = fake;
  frame = fake as unknown as Window;
  vi.stubGlobal("window", frame);
});
afterEach(() => { document.body.replaceChildren(); vi.unstubAllGlobals(); });

function selectedRow() {
  const checkpoint = normalizeTurn({ id: taskId, seq: 1, goal: "SYNTHETIC_PRIVATE_PROMPT", status: "running", summary: null,
    events: [{ type: "run_start", runId: "run-alpha", goal: "SYNTHETIC_PRIVATE_PROMPT", model: "SYNTHETIC_PRIVATE_MODEL" }],
    lock: "SYNTHETIC_PRIVATE_MODEL", permission: "confirm", files: ["/SYNTHETIC_PRIVATE_PATH"], multi: false, startedAt: 1000, endedAt: null,
    goalId, mode: "quick", preference: "balanced", preferenceSource: "global", recovery_accounting: { version: 1, task_id: taskId, run_id: "run-alpha", llm_calls: 1, final: false } });
  const round = { index: 1, title: "SYNTHETIC_PRIVATE_PROMPT", items: [], status: "running", evidence: emptyEvidence(), verdict: null,
    task_id: taskId, task_checkpoint: checkpoint, llm_settlements: [], started_at: 1000, finished_at: null };
  const execution = { owner_id: "owner-alpha", fence: 1, task_id: taskId, execution_id: "exec-alpha" };
  const envelope = { protocol: GOAL_QUOTA_PROTOCOL, goal_id: goalId, enrollment_id: "enroll-alpha", revision: 1, rounds: [round], execution };
  const authority = { protocol: GOAL_QUOTA_PROTOCOL, goal_id: goalId, enrollment_id: "enroll-alpha", state: "enrolled", limit: 3, consumed: 1,
    owner: "owner-alpha", fence: 1, active: true, lease_until: 301000, permits: [{ id: "permit-alpha", task_id: taskId, execution_id: "exec-alpha",
      owner: "owner-alpha", fence: 1, kind: "main", purpose: "answer", state: "pending", admitted_at: 1000, finished_at: null }] };
  const ledger = [{ idempotency_key: "synthetic-invocation", task_id: taskId, step_id: "s1", invocation_id: "synthetic-invocation", tool: "SYNTHETIC_PRIVATE_TOOL",
    args_digest: "SYNTHETIC_PRIVATE_ARGS", attempt: 1, state: "started", artifacts: JSON.stringify([{ path: "/SYNTHETIC_PRIVATE_ARTIFACT" }]),
    detail: "SYNTHETIC_PRIVATE_DETAIL", lease_owner: "synthetic-ledger-owner", lease_expires_at: 31000, created_at: 1000, updated_at: 1000 }];
  return { id: goalId, status: "running", rounds: JSON.stringify(envelope), authority: JSON.stringify(authority), schema_version: "7", lease_index: 1, tool_ledger: JSON.stringify(ledger) };
}

async function fixture() {
  const select = vi.fn().mockImplementation(async () => [selectedRow()]), execute = vi.fn();
  const db = { select, execute } as unknown as Db;
  plugin.load.mockResolvedValue(db);
  const actualHandle = await (await import("@/lib/db")).database();
  let pinned: unknown = null;
  const request = vi.fn<QaGoalObserverRequest>().mockImplementation(async (command, args) => {
    if (command === "qa_goal_snapshot_capability") return capability();
    if (args?.runId !== runId || pinned !== null && args?.goalId !== pinned) throw Error("SYNTHETIC_NATIVE_PRIVATE_DETAIL");
    pinned = args?.goalId;
    return { runId, goalId: args?.goalId };
  });
  const install = (await import("@/lib/qa-goal-snapshot")).installQaGoalObserver;
  return { db: actualHandle, select, execute, request, install };
}

test("uninstalled and pending capability never query SQL or expose the API", async () => {
  const f = await fixture();
  expect(frame.__EG_QA_GOAL_SNAPSHOT__).toBeUndefined();
  expect(f.select).not.toHaveBeenCalled();
  let resolve!: (value: unknown) => void;
  f.request.mockImplementation(() => new Promise((done) => { resolve = done; }));
  const installation = f.install(f.db, f.request);
  expect(frame.__EG_QA_GOAL_SNAPSHOT__).toBeUndefined();
  expect(f.select).not.toHaveBeenCalled();
  resolve(capability()); await installation;
  expect(typeof frame.__EG_QA_GOAL_SNAPSHOT__).toBe("function");
  expect(f.select).not.toHaveBeenCalled();
});

test.each(["missing", "other", "child"])("non-main/native top-frame rejects installation (%s)", async (kind) => {
  const f = await fixture(), record = frame as unknown as Record<string, unknown>;
  if (kind === "missing") delete record.__TAURI_INTERNALS__;
  if (kind === "other") record.__TAURI_INTERNALS__ = { metadata: { currentWebview: { label: "other" } } };
  if (kind === "child") record.top = {};
  await expect(f.install(f.db, f.request)).resolves.toBeUndefined();
  expect(f.request).not.toHaveBeenCalled(); expect(f.select).not.toHaveBeenCalled();
  expect(frame.__EG_QA_GOAL_SNAPSHOT__).toBeUndefined(); expect(screen.queryByRole("button", { name: "QA Goal snapshot" })).toBeNull();
});

test.each([undefined, { ...capability(), isolated: false }, { ...capability(), runId: runId.toUpperCase() }, { ...capability(), protocol: "foreign" }, { ...capability(), extra: "SYNTHETIC_PRIVATE" }])("missing or malformed capability cannot install (%j)", async (cap) => {
  const f = await fixture();f.request.mockResolvedValue(cap);
  await expect(f.install(f.db, f.request)).resolves.toBeUndefined();
  expect(frame.__EG_QA_GOAL_SNAPSHOT__).toBeUndefined();expect(f.select).not.toHaveBeenCalled();
});

test("capability rejection is optional startup behavior, with no raw exception or controls", async () => {
  const f = await fixture();f.request.mockRejectedValue(new Error("SYNTHETIC_PRIVATE_CAPABILITY_PATH"));
  await expect(f.install(f.db, f.request)).resolves.toBeUndefined();
  expect(frame.__EG_QA_GOAL_SNAPSHOT__).toBeUndefined();expect(document.body.textContent).not.toContain("SYNTHETIC_PRIVATE");
});

test("native-approved explicit ID uses the real reader on one plugin SELECT and zero writes", async () => {
  const f = await fixture();await f.install(f.db, f.request);
  expect(f.select).not.toHaveBeenCalled();
  const result = await frame.__EG_QA_GOAL_SNAPSHOT__!(goalId);
  expect(result.ok).toBe(true);
  expect(f.request).toHaveBeenLastCalledWith("qa_goal_snapshot_request", { runId, goalId });
  expect(f.select).toHaveBeenCalledTimes(1);
  expect(f.select.mock.calls[0][0]).toBe((await import("@/lib/goal-snapshot")).CANONICAL_GOAL_SNAPSHOT_SQL);
  expect(f.select.mock.calls[0][1]).toEqual([goalId]);expect(f.execute).not.toHaveBeenCalled();expect(plugin.load).toHaveBeenCalledTimes(1);
  if (result.ok) { expect(result.snapshot.authorizesResume).toBe(false);expect(result.snapshot.authority.pending).toBe(1);expect(result.snapshot.mainReceipt.state).toBe("incomplete"); }
});

test("invalid IDs and a foreign Goal after first pin cause no native approval or SQL", async () => {
  const f = await fixture();await f.install(f.db, f.request);
  for (const id of [undefined, "../goal-alpha", " goal-alpha", "goal-alpha/path", "goal-"])
    expect(await frame.__EG_QA_GOAL_SNAPSHOT__!(id as string)).toEqual({ ok: false, code: "qa_snapshot_not_allowed" });
  expect(f.request).toHaveBeenCalledTimes(1);expect(f.select).not.toHaveBeenCalled();
  await frame.__EG_QA_GOAL_SNAPSHOT__!(goalId);
  expect(await frame.__EG_QA_GOAL_SNAPSHOT__!("goal-foreign")).toEqual({ ok: false, code: "qa_snapshot_not_allowed" });
  expect(f.request).toHaveBeenCalledTimes(2);expect(f.select).toHaveBeenCalledTimes(1);
});

test.each([{ runId: "ffffffff-ffff-ffff-ffff-ffffffffffff", goalId }, { runId, goalId: "goal-foreign" }, { runId, goalId, extra: "SYNTHETIC_PRIVATE" }, null])("native request must exactly echo this run and Goal (%j)", async (reply) => {
  const f = await fixture();await f.install(f.db, f.request);f.request.mockResolvedValue(reply);
  expect(await frame.__EG_QA_GOAL_SNAPSHOT__!(goalId)).toEqual({ ok: false, code: "qa_snapshot_not_allowed" });expect(f.select).not.toHaveBeenCalled();
});

test("lost native ACK keeps the first Goal pinned and exposes a fixed error only", async () => {
  const f = await fixture();await f.install(f.db, f.request);f.request.mockRejectedValue(new Error("SYNTHETIC_NATIVE_SECRET"));
  expect(await frame.__EG_QA_GOAL_SNAPSHOT__!(goalId)).toEqual({ ok: false, code: "qa_snapshot_not_allowed" });
  expect(await frame.__EG_QA_GOAL_SNAPSHOT__!("goal-foreign")).toEqual({ ok: false, code: "qa_snapshot_not_allowed" });
  expect(f.request).toHaveBeenCalledTimes(2);expect(f.select).not.toHaveBeenCalled();
});

test("sixteen reads occupy the observer bound and the seventeenth never reaches native or SQL", async () => {
  const f = await fixture();await f.install(f.db, f.request);
  for (let i = 0; i < 16; i++) expect((await frame.__EG_QA_GOAL_SNAPSHOT__!(goalId)).ok).toBe(true);
  expect(await frame.__EG_QA_GOAL_SNAPSHOT__!(goalId)).toEqual({ ok: false, code: "qa_snapshot_limit" });
  expect(f.request).toHaveBeenCalledTimes(17);expect(f.select).toHaveBeenCalledTimes(16);expect(f.execute).not.toHaveBeenCalled();
});

test("a pending native approval cannot race another read or install another observer", async () => {
  const f = await fixture();await f.install(f.db, f.request);
  let finish!: (value: unknown) => void;f.request.mockImplementation(() => new Promise((done) => { finish = done; }));
  const first = frame.__EG_QA_GOAL_SNAPSHOT__!(goalId);
  expect(await frame.__EG_QA_GOAL_SNAPSHOT__!(goalId)).toEqual({ ok: false, code: "qa_snapshot_busy" });
  await f.install(f.db, f.request);expect(f.request).toHaveBeenCalledTimes(2);expect(f.select).not.toHaveBeenCalled();
  finish({ runId, goalId });expect((await first).ok).toBe(true);expect(f.select).toHaveBeenCalledTimes(1);
});

test("native frame changes while an approval is pending stop before SQL", async () => {
  const f = await fixture();await f.install(f.db, f.request);let finish!: (value: unknown) => void;
  f.request.mockImplementation(() => new Promise((done) => { finish = done; }));const first = frame.__EG_QA_GOAL_SNAPSHOT__!(goalId);
  (frame as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = { metadata: { currentWebview: { label: "other" } } };
  finish({ runId, goalId });expect(await first).toEqual({ ok: false, code: "qa_snapshot_not_allowed" });expect(f.select).not.toHaveBeenCalled();
});

test("SQL and protocol errors are fixed results and never repair or expose raw errors", async () => {
  const f = await fixture();await f.install(f.db, f.request);
  f.select.mockRejectedValueOnce(new Error("SYNTHETIC_PRIVATE_SQL_PATH"));
  expect(await frame.__EG_QA_GOAL_SNAPSHOT__!(goalId)).toEqual({ ok: false, code: "quota_storage_unknown" });
  f.select.mockResolvedValueOnce([{ ...selectedRow(), rounds: "[]" }]);
  expect(await frame.__EG_QA_GOAL_SNAPSHOT__!(goalId)).toEqual({ ok: false, code: "quota_protocol_invalid" });
  expect(f.execute).not.toHaveBeenCalled();
});

test("lazy QA controls display only synthetic projection and never query on expand or input", async () => {
  const f = await fixture();await f.install(f.db, f.request);
  expect(screen.queryByLabelText("QA Goal ID")).toBeNull();expect(f.select).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "QA Goal snapshot" }));
  fireEvent.change(screen.getByLabelText("QA Goal ID"), { target: { value: goalId } });expect(f.select).not.toHaveBeenCalled();
  const readButton = screen.getByRole("button", { name: "Read QA Goal snapshot" });fireEvent.click(readButton);
  const result = screen.getByLabelText("QA Goal snapshot result") as HTMLTextAreaElement;
  await waitFor(() => expect(result.value).toContain('"authorizesResume": false'));
  expect(result.readOnly).toBe(true);expect(result.value).not.toContain("SYNTHETIC_PRIVATE");expect(result.value).not.toContain('"events"');
  expect(JSON.parse(result.value).snapshot.currentExecutionPermits.mainPending).toBe(1);expect(f.select).toHaveBeenCalledTimes(1);expect(f.execute).not.toHaveBeenCalled();
});

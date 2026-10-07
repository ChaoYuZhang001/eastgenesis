// @vitest-environment node
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Db } from "@/lib/db";
import { asDb, loadSqlite, migratedDb, type RawDb, type SqliteModule } from "./sqlite-helper";

const host = vi.hoisted(() => ({ db: null as Db | null }));
vi.mock("@/lib/db", () => ({
  SCHEMA_VERSION: 7,
  withDb: async <T>(fn: (db: Db) => Promise<T>) => {
    try { return await fn(host.db!); }
    catch (error) {
      // Match the production IPC boundary, which serializes Error identity.
      if (error && typeof error === "object" && "code" in error) {
        const value = error as { code: string; message?: string };
        throw { code: value.code, message: value.message };
      }
      throw error;
    }
  },
}));

import { saveGoal, updateGoal, listGoals } from "@/lib/db-goal";
import { getToolInvocation, saveToolInvocation, claimToolInvocation, renewToolInvocation, releaseToolInvocation } from "@/lib/db-invocation";
import { acquireGoalExecution, type GoalExecutionSession } from "@/lib/goal-execution";
import * as execution from "@/lib/goal-execution";
import { createGoalQuotaAuthority } from "@/lib/db-goal-quota";
import { prepareGoalContinuation } from "@/lib/goal-continuation";
import { goalRunner } from "@/lib/goal-run";
import * as engine from "@/lib/engine";
import { recoveryCheckpoint } from "@/lib/recovery";
import { createMockBackend, setBackend, type ProxyResponse } from "@/platform";
import { useGoals } from "@/stores/goals";
import { useTasks } from "@/stores/tasks";
import { useSettings } from "@/stores/settings";
import { useMcp } from "@/stores/mcp";
import { hydrateGoalCheckpoints } from "@/stores/history";

const GOAL = "读取项目文件，写入 result.ts，再分析项目并给出结论，最后汇总所有成果";
const BODY = "export const canonicalFinalRecovery = true;\n";
const CHAT = "SYNTHETIC_CANONICAL_FINAL_ANALYSIS";
const KNOWN_FAILED_WIRE = ["plan", "answer", "summary", "summary"] as const;
const UNKNOWN_WIRE = ["plan", "answer", "summary"] as const;
let sqlite: SqliteModule;
let raw: RawDb;
let directory: string;
let sourcePath: string;
let resultPath: string;
let allowSummary: boolean;
let unknownSummary: boolean;
let reads: number;
let writes: number;
let requests: Array<"plan" | "answer" | "summary">;
let extraSessions: GoalExecutionSession[];
const originalSettings = useSettings.getState();
const originalMcp = useMcp.getState();

function response(text: string, stream: boolean): ProxyResponse {
  if (!stream) return {
    status: 200,
    body: JSON.stringify({ model: "synthetic", choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
  };
  return {
    status: 200,
    body: `data: ${JSON.stringify({ id: "synthetic", model: "synthetic", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "synthetic", model: "synthetic", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`,
  };
}

beforeAll(async () => { sqlite = (await loadSqlite())!; expect(sqlite).not.toBeNull(); });
beforeEach(async () => {
  raw = migratedDb(sqlite); host.db = asDb(() => raw);
  directory = await mkdtemp(join(tmpdir(), "eg-canonical-final-recovery-"));
  sourcePath = join(directory, "source.txt"); resultPath = join(directory, "result.ts");
  await writeFile(sourcePath, "synthetic public project input");
  allowSummary = false; unknownSummary = false; reads = 0; writes = 0; requests = []; extraSessions = [];
  // Use the production engine, HTTP adapter, AgentRuntime, SQLite permissions
  // and physical synthetic tool ledger. Only the backend transport is faked.
  const backend = createMockBackend({ configured: ["openai"], jevConfigured: false });
  setBackend({
    ...backend, kind: "tauri", saveGoal, updateGoal, listGoals,
    getToolInvocation, saveToolInvocation, claimToolInvocation, renewToolInvocation, releaseToolInvocation,
    providerRequest: async request => {
      expect(request.target).toBe("openai");
      const body = JSON.parse(request.body!) as { messages: Array<{ role: string; content: string }>; stream?: boolean };
      const system = body.messages[0]?.content ?? "";
      const user = body.messages.at(-1)?.content ?? "";
      if (system.includes("任务规划器")) {
        requests.push("plan");
        return response(JSON.stringify({ steps: [
          { goal: "读取项目文件", tool: "mcp__files__read_file", args: { path: sourcePath } },
          { goal: "修改 result.ts", tool: "mcp__files__write_file", args: { path: resultPath, content: BODY } },
          { goal: "分析项目并给出结论", tool: null },
        ] }), Boolean(body.stream));
      }
      if (user.includes("各步骤结果：")) {
        requests.push("summary");
        if (!allowSummary) {
          if (unknownSummary) throw Error("synthetic summary connection outcome unknown");
          // Complete HTTP 400 is positively terminal through the real adapter.
          // No partial SSE output or hand-written terminal provenance is used.
          return { status: 400, body: JSON.stringify({ error: { message: "synthetic known terminal summary refusal", type: "invalid_request_error" } }) };
        }
        expect(user).toContain(CHAT);
        return response("result.ts 已修改，读取与项目分析全部完成。", Boolean(body.stream));
      }
      requests.push("answer");
      return response(`分析项目并给出结论：${CHAT}；result.ts 修改已完成。`, Boolean(body.stream));
    },
  });
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => { throw Error("real network forbidden in canonical recovery fixture"); });
  useSettings.setState({
    statuses: await backend.providerStatus(), jev: await backend.jevStatus(), custom: [], overrides: {},
    defaultPermission: "full", timeoutS: 1,
    providerPrefs: { regions: {}, ollama: false, localJev: null },
  });
  useMcp.setState({ conns: { files: {
    status: "running", config: null, infos: [], skipped: [], serverInfo: null, error: null,
    tools: [
      { name: "mcp__files__read_file", description: "读取项目文件", sideEffect: "none", run: async () => {
        reads++; return { ok: true, content: await readFile(sourcePath, "utf8"), data: {} };
      } },
      { name: "mcp__files__write_file", description: "修改本地代码文件", sideEffect: "local_write", run: async () => {
        writes++; await writeFile(resultPath, BODY); return { ok: true, content: "result.ts 修改完成", data: {} };
      } },
    ],
  } } });
  useGoals.setState({ items: [], loaded: true, error: null });
  useTasks.setState({ tasks: [], activeId: null });
});
afterEach(async () => {
  for (const goal of useGoals.getState().items) goalRunner.stop(goal.id);
  for (const session of extraSessions) await session.release().catch(() => {});
  vi.restoreAllMocks(); setBackend(null);
  useSettings.setState(originalSettings); useMcp.setState(originalMcp);
  (raw as RawDb & { close(): void }).close();
  await rm(directory, { recursive: true, force: true });
});

async function failedThenReload(unknown = false) {
  unknownSummary = unknown;
  const saved = await useGoals.getState().save({ description: GOAL, max_llm_calls: 8 });
  if (typeof saved === "string") throw Error(saved);
  expect(await useGoals.getState().start(saved.id)).toBeNull();
  await goalRunner.run(saved.id);
  const before = (await listGoals())[0];
  const task = before.rounds[0].task_checkpoint!;
  expect(before.status).toBe("paused");
  expect(before.rounds).toHaveLength(1);
  expect(before.rounds[0].status).toBe("interrupted");
  expect(task.status).toBe(unknown ? "needs_user" : "failed");
  expect(task.recovery_accounting).toMatchObject({ final: !unknown, llm_calls: unknown ? 2 : 3 });
  expect(recoveryCheckpoint(task.events as Parameters<typeof recoveryCheckpoint>[0])?.nextStepIndex).toBe(3);
  // The two terminal-failed Summary chain entries are wire attempts inside one
  // logical permit. An unknown call emits no final llm_failed receipt event.
  expect(requests).toEqual(unknown ? UNKNOWN_WIRE : KNOWN_FAILED_WIRE);
  expect([reads, writes]).toEqual([1, 1]);
  expect(before.quota).toMatchObject({ active: false, consumed: 3, pending: 0, unknown: unknown ? 1 : 0 });
  if (!unknown) expect(before.rounds[0].llm_settlements).toEqual([{ run_id: task.recovery_accounting!.run_id, llm_calls: 3 }]);
  useTasks.setState({ tasks: [], activeId: null });
  await useGoals.getState().load(); hydrateGoalCheckpoints();
  const card = useTasks.getState().tasks[0];
  expect(card.id).toBe(task.id);
  expect(card.recovery_accounting).toEqual(task.recovery_accounting);
  if (!unknown) expect(await useGoals.getState().start(saved.id)).toBeNull();
  return { id: saved.id, taskId: task.id, oldReceipt: task.recovery_accounting!, oldExecutionId: before.quota!.execution!.executionId, before };
}

async function persisted(id: string) {
  const goal = await host.db!.select<{ status: string; rounds: string; used_llm_calls: number }[]>("SELECT status,rounds,used_llm_calls FROM goals WHERE id=$1", [id]);
  const quota = await host.db!.select<{ value: string }[]>("SELECT value FROM app_meta WHERE key=$1", [`goal-quota:v1:${id}`]);
  return { goal, quota };
}

/** Observe actual Db.execute, not a mocked permission decision. */
function observeWrites() {
  const db = host.db!;
  const execute = vi.fn((sql: string, args?: unknown[]) => db.execute(sql, args));
  host.db = { select: db.select, execute };
  return execute;
}

describe("canonical known-final failed Task recovery through actual stores and SQLite", () => {
  test("preclaim is read-only; reload resumes only Summary in the same Task with a new owner and no duplicate receipt or tool effect", async () => {
    const f = await failedThenReload();
    const before = await persisted(f.id);
    const beforeLedger = await host.db!.select<Array<Record<string, unknown>>>("SELECT * FROM tool_invocations ORDER BY idempotency_key");
    expect(beforeLedger).toHaveLength(2);
    expect(beforeLedger.every(row => row.state === "applied" && row.task_id === f.taskId)).toBe(true);
    const artifact = await stat(resultPath, { bigint: true });
    const contents = await readFile(resultPath, "utf8");
    const execute = observeWrites();
    const preparation = await useTasks.getState().prepareGoalRecovery(f.taskId, f.id);
    expect(execute.mock.calls.length).toBe(0);
    expect(await persisted(f.id)).toEqual(before);
    expect(preparation.accounting).toEqual(f.oldReceipt);
    expect(preparation.completed).toBeNull();
    expect(preparation.continuation).toBeDefined();

    allowSummary = true;
    const starts = vi.spyOn(useTasks.getState(), "runGoalRound");
    const resumes = vi.spyOn(useTasks.getState(), "resumeGoalRound");
    await goalRunner.run(f.id);
    const after = (await listGoals())[0];
    expect(after.status, useGoals.getState().error ?? "").toBe("completed");
    expect(after.rounds).toHaveLength(1);
    expect(after.rounds[0]).toMatchObject({ task_id: f.taskId, status: "done", task_checkpoint: { id: f.taskId, status: "completed" } });
    expect(starts).not.toHaveBeenCalled(); expect(resumes).toHaveBeenCalledOnce();
    expect(requests).toEqual([...KNOWN_FAILED_WIRE, "summary"]);
    expect([reads, writes]).toEqual([1, 1]);
    expect(after.rounds[0].llm_settlements).toHaveLength(2);
    expect(after.rounds[0].llm_settlements?.filter(r => r.run_id === f.oldReceipt.run_id)).toEqual([{ run_id: f.oldReceipt.run_id, llm_calls: 3 }]);
    expect(after.rounds[0].llm_settlements?.[1]).toMatchObject({ llm_calls: 1 });
    expect(after.quota).toMatchObject({ consumed: 4, pending: 0, unknown: 0, active: false });
    expect(after.quota!.execution!.executionId).not.toBe(f.oldExecutionId);
    const authority = await createGoalQuotaAuthority(host.db!).snapshot({ goalId: f.id, enrollmentId: after.quota!.enrollmentId });
    expect(authority.permits.map(p => [p.purpose, p.state])).toEqual([["plan", "succeeded"], ["answer", "succeeded"], ["summary", "failed"], ["summary", "succeeded"]]);
    expect(authority.permits.slice(0, 3).every(p => p.execution_id === f.oldExecutionId)).toBe(true);
    expect(authority.permits[3]).toMatchObject({ task_id: f.taskId, execution_id: after.quota!.execution!.executionId });
    const ledger = await host.db!.select<Array<Record<string, unknown>>>("SELECT * FROM tool_invocations ORDER BY idempotency_key");
    expect(ledger).toEqual(beforeLedger);
    const currentArtifact = await stat(resultPath, { bigint: true });
    expect([currentArtifact.ino, currentArtifact.mtimeNs, await readFile(resultPath, "utf8")]).toEqual([artifact.ino, artifact.mtimeNs, contents]);
  });

  test.each(["run", "count", "task_goal", "terminal"] as const)("a hydrated memory-only %s edit cannot authorize or overwrite the persisted final recovery", async field => {
    const f = await failedThenReload();
    const before = await persisted(f.id);
    useTasks.setState(state => ({ tasks: state.tasks.map(task => {
      if (task.id !== f.taskId) return task;
      if (field === "task_goal") return { ...task, goal: `${task.goal} redirected` };
      if (field === "terminal") return { ...task, events: task.events.map(event => event.type === "run_end" ? { ...event, status: "completed" as const } : event) };
      return { ...task, recovery_accounting: { ...task.recovery_accounting!, ...(field === "run" ? { run_id: "run-forged" } : { llm_calls: 0 }) } };
    }) }));
    const execute = observeWrites();
    const result = await Promise.allSettled([useTasks.getState().prepareGoalRecovery(f.taskId, f.id)]);
    expect(execute.mock.calls.length).toBe(0);
    expect(await persisted(f.id)).toEqual(before);
    if (result[0].status === "fulfilled") {
      expect(result[0].value.accounting).toBeNull();
      expect(result[0].value.completed).toBeNull();
      expect(result[0].value.continuation).toBeUndefined();
    }
    expect(requests).toEqual(KNOWN_FAILED_WIRE);
  });

  test("unknown Summary remains occupied and grants no continuation, final receipt or new model call", async () => {
    const f = await failedThenReload(true);
    expect(await useGoals.getState().start(f.id)).toBe("quota_outcome_unknown");
    const before = await persisted(f.id), execute = observeWrites();
    const preparation = await useTasks.getState().prepareGoalRecovery(f.taskId, f.id);
    expect(preparation).toMatchObject({ accounting: null, completed: null });
    expect(preparation.continuation).toBeUndefined();
    expect(execute.mock.calls.length).toBe(0);
    await goalRunner.run(f.id);
    expect(await persisted(f.id)).toEqual(before);
    expect(requests).toEqual(UNKNOWN_WIRE);
    expect([reads, writes]).toEqual([1, 1]);
  });

  test("a persisted settlement count mismatch for the same run cannot authorize final recovery or repair the canonical record", async () => {
    const f = await failedThenReload();
    const saved = await persisted(f.id);
    const envelope = JSON.parse(saved.goal[0].rounds);
    expect(envelope.rounds[0].llm_settlements[0]).toEqual({ run_id: f.oldReceipt.run_id, llm_calls: 3 });
    // Deliberately corrupt only this fixture's in-memory SQLite preimage.
    // Keep the same run identity, receipt and occupied permits; do not refund.
    envelope.rounds[0].llm_settlements[0].llm_calls = 2;
    await host.db!.execute("UPDATE goals SET rounds=$1 WHERE id=$2", [JSON.stringify(envelope), f.id]);
    const before = await persisted(f.id), execute = observeWrites();
    const result = await Promise.allSettled([useTasks.getState().prepareGoalRecovery(f.taskId, f.id)]);
    expect(execute.mock.calls.length).toBe(0);
    expect(await persisted(f.id)).toEqual(before);
    if (result[0].status === "fulfilled") {
      expect(result[0].value.accounting).toBeNull();
      expect(result[0].value.completed).toBeNull();
      expect(result[0].value.continuation).toBeUndefined();
    }
    expect(requests).toEqual(KNOWN_FAILED_WIRE);
    expect([reads, writes]).toEqual([1, 1]);
  });

  test("a competing live owner blocks store recovery without pausing its lease or dispatching", async () => {
    const f = await failedThenReload();
    const continuation = await prepareGoalContinuation(f.id, f.taskId);
    const session = (await acquireGoalExecution(f.id, f.taskId, Date.now, continuation ?? undefined))!;
    extraSessions.push(session);
    // A second renderer shares the DB, but does not share this renderer's
    // process-local session registry. Keep all SQLite ownership checks real.
    vi.spyOn(execution, "goalExecutionForTask").mockReturnValue(null);
    await useGoals.getState().refresh(f.id);
    const before = await persisted(f.id), execute = observeWrites();
    const result = await Promise.allSettled([useTasks.getState().prepareGoalRecovery(f.taskId, f.id)]);
    expect(execute.mock.calls.length).toBe(0);
    if (result[0].status === "fulfilled") expect(result[0].value.continuation).toBeUndefined();
    await goalRunner.run(f.id);
    expect(await persisted(f.id)).toEqual(before);
    expect((await listGoals())[0].quota).toMatchObject({ active: true, ownerId: session.publication.ownerId, fence: session.publication.fence });
    expect(requests).toEqual(KNOWN_FAILED_WIRE);
  });

  test("persisted final failed Task cannot use a memory-edited plan through direct store or claim without a continuation", async () => {
    const f = await failedThenReload();
    const before = await persisted(f.id);
    useTasks.setState(state => ({ tasks: state.tasks.map(task => task.id !== f.taskId ? task : {
      ...task,
      events: task.events.map(event => event.type !== "plan" ? event : {
        ...event, plan: { ...event.plan, steps: event.plan.steps.map((step, index) => index === 0 ? { ...step, goal: "synthetic redirected memory-only step" } : step) },
      }),
    }) }));
    const execute = observeWrites(), createEngine = vi.spyOn(engine, "createEngine");
    const handle = useTasks.getState().resumeGoalRound(GOAL, { mode: "goal", goalId: f.id, taskId: f.taskId });
    expect(handle).toBeNull();
    await expect(acquireGoalExecution(f.id, f.taskId)).rejects.toMatchObject({ code: "quota_denied" });
    expect(execute.mock.calls.length).toBe(0);
    expect(createEngine).not.toHaveBeenCalled();
    expect(await persisted(f.id)).toEqual(before);
    expect(requests).toEqual(KNOWN_FAILED_WIRE);
    expect([reads, writes]).toEqual([1, 1]);
  });
});

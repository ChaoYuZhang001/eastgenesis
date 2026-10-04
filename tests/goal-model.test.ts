// 目标状态机、轮次生命周期、失败条件、编辑与存储共用的读回
import {
  DEFAULT_MAX_LLM_CALLS,
  FAIL_STREAK,
  MAX_ROUNDS,
  applyGoalChange,
  appendEvidence,
  canTransition,
  editGoal,
  failCause,
  failRound,
  failStreak,
  finishRound,
  goalPhase,
  newGoal,
  normalizeGoal,
  parseRounds,
  recordLlmCalls,
  resolveUncertain,
  startRound,
  transitionGoal,
  updateItem,
  type Goal,
  type GoalRound,
  type GoalStatus,
} from "@/decision/goal";
import { CLAIM_ONLY_REASON } from "@/decision/evidence";

const err = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return e as { code: string; message: string };
  }
  throw new Error("没有抛错");
};
const T = 1_000;
const mk = (over: Partial<Goal> = {}): Goal => ({ ...newGoal(normalizeGoal({ description: "整理下载文件夹" }), T, "goal-t"), ...over });
const running = (over: Partial<Goal> = {}) => transitionGoal(mk(over), "running", T + 1);
const notDone = { verdict: "not_done" as const, reason: "还差一步", by: "rules" as const };
const done = { verdict: "done" as const, reason: "已产出 a.md", by: "rules" as const };
const uncertain = { verdict: "uncertain" as const, reason: CLAIM_ONLY_REASON, by: "rules" as const };
/** 跑一轮：开始 → 记一次调用 → 用给定结论结束 */
const round = (g: Goal, verdict: typeof notDone | typeof done | typeof uncertain, now = T + 10) => finishRound(recordLlmCalls(startRound(g, { items: ["做事"] }, now), 1, now), verdict, now);

describe("状态机：合法转换", () => {
  const legal: [GoalStatus, GoalStatus][] = [
    ["idle", "running"],
    ["running", "paused"],
    ["paused", "running"],
    ["running", "completed"],
    ["running", "failed"],
    ["running", "abandoned"],
    ["paused", "abandoned"],
  ];
  it("规定的转换都允许，任意状态都能删除", () => {
    for (const [a, b] of legal) expect(canTransition(a, b), `${a} → ${b}`).toBe(true);
    for (const s of ["idle", "running", "paused", "completed", "failed", "abandoned"] as GoalStatus[]) expect(canTransition(s, "deleted"), s).toBe(true);
  });

  it("其他转换都是非法的，transitionGoal 抛 invalid_goal_transition", () => {
    const all: GoalStatus[] = ["idle", "running", "paused", "completed", "failed", "abandoned", "deleted"];
    const allowed = new Set([...legal.map(([a, b]) => `${a}>${b}`), ...all.filter((s) => s !== "deleted").map((s) => `${s}>deleted`)]);
    let illegal = 0;
    for (const from of all)
      for (const to of all) {
        if (allowed.has(`${from}>${to}`) || (from === "deleted" && to === "deleted")) continue;
        illegal++;
        expect(canTransition(from, to), `${from} → ${to}`).toBe(false);
        expect(err(() => transitionGoal(mk({ status: from }), to, T)).code, `${from} → ${to}`).toBe("invalid_goal_transition");
      }
    expect(illegal).toBe(49 - legal.length - 6 - 1);
    expect(err(() => transitionGoal(mk({ status: "completed" }), "running", T)).message).toBe("目标已完成，不能改为「进行中」");
  });
  it("completed 要求最后一轮校验通过；failed 要求到了失败条件；删除幂等；暂停打断正在跑的一轮", () => {
    expect(err(() => transitionGoal(running(), "completed", T)).code).toBe("invalid_goal_transition");
    expect(err(() => transitionGoal(running(), "failed", T)).code).toBe("invalid_goal_transition");
    const deleted = transitionGoal(mk(), "deleted", T);
    expect(transitionGoal(deleted, "deleted", T + 5)).toBe(deleted);
    const g = updateItem(startRound(running(), { items: ["列出文件", "移动"] }, T + 2), "r1-1", "running", T + 3);
    const p = transitionGoal(g, "paused", T + 4);
    expect(p.rounds[0]).toMatchObject({ status: "interrupted", finished_at: T + 4 });
    expect(p.rounds[0].items[0].status).toBe("pending");
    expect(goalPhase(transitionGoal(p, "running", T + 5))).toBe("ready");
    expect(err(() => transitionGoal(mk(), "bogus" as GoalStatus, T)).code).toBe("invalid_goal");
  });
});

describe("轮次生命周期", () => {
  it("not_done → 可以开下一轮；done → 目标完成", () => {
    const g = round(running(), notDone);
    expect(goalPhase(g)).toBe("ready");
    expect(g.rounds[0]).toMatchObject({ index: 1, status: "not_done", verdict: notDone });
    expect(startRound(g, {}, T + 20).rounds[1]).toMatchObject({ index: 2, title: "第 2 轮", status: "running" });
    const c = round(g, done);
    expect(c.status).toBe("completed");
    expect(c.rounds[1].status).toBe("done");
    expect(c.used_llm_calls).toBe(2);
  });

  it("uncertain：停下等你确认，不自动开下一轮也不自动结束；确认完成后目标完成", () => {
    const g = round(running(), uncertain);
    expect(g.status).toBe("running");
    expect(goalPhase(g)).toBe("awaiting_user");
    expect(err(() => startRound(g, {}, T)).message).toMatch(/等你确认/);
    const c = resolveUncertain(g, "done", T + 30);
    expect(c.status).toBe("completed");
    expect(c.rounds[0].verdict).toMatchObject({ verdict: "done", by: "user" });
    expect(c.rounds[0].verdict?.reason).toContain(CLAIM_ONLY_REASON);
    expect(err(() => resolveUncertain(round(running(), notDone), "done", T)).code).toBe("invalid_goal_round");
  });

  it("没在跑的一轮时不能结束、改步骤、记失败；目标不在进行中时不能开新一轮", () => {
    expect(err(() => finishRound(running(), done, T)).code).toBe("invalid_goal_round");
    expect(err(() => failRound(running(), "x", T)).code).toBe("invalid_goal_round");
    expect(err(() => startRound(mk(), {}, T)).message).toMatch(/未开始/);
    const g = startRound(running(), { items: ["a"] }, T);
    expect(err(() => startRound(g, {}, T)).message).toMatch(/还没结束/);
    expect(err(() => updateItem(g, "r9-9", "done", T)).message).toMatch(/没有这个步骤/);
    expect(err(() => updateItem(g, "r1-1", "bogus" as never, T)).code).toBe("invalid_goal_round");
    expect(updateItem(g, "r1-1", "done", T).rounds[0].items[0].status).toBe("done");
  });
});

describe("失败条件：超过 max_llm_calls 或校验连续失败 3 次", () => {
  it(`连续 ${FAIL_STREAK} 轮 not_done → failed（streak）；你选「继续」的那一轮中断计数`, () => {
    // 规格写死的值：校验连续失败 3 次
    expect(FAIL_STREAK).toBe(3);
    let g = running();
    for (let i = 0; i < FAIL_STREAK - 1; i++) g = round(g, notDone);
    expect(g.status).toBe("running");
    expect(failStreak(g)).toBe(FAIL_STREAK - 1);
    expect(round(g, notDone)).toMatchObject({ status: "failed" });
    expect(failCause(round(g, notDone))).toBe("streak");
    let h = resolveUncertain(round(round(round(running(), notDone), notDone), uncertain), "continue", T);
    expect(h.rounds[2].verdict?.by).toBe("user");
    h = round(round(h, notDone), notDone);
    expect(failStreak(h)).toBe(2);
    expect(h.status).toBe("running");
  });

  it("调用次数用完：not_done → failed（budget）；uncertain 仍然等你确认，选继续才失败；调低上限后开新一轮抛 goal_exhausted", () => {
    const b = running({ max_llm_calls: 1 });
    const f = round(b, notDone);
    expect(f.status).toBe("failed");
    expect(failCause(f)).toBe("budget");
    const u = round(b, uncertain);
    expect(goalPhase(u)).toBe("awaiting_user");
    expect(resolveUncertain(u, "continue", T).status).toBe("failed");
    expect(resolveUncertain(u, "done", T).status).toBe("completed");
    const lowered = editGoal(running({ used_llm_calls: 10 }), { max_llm_calls: 10 }, T);
    expect(err(() => startRound(lowered, {}, T)).code).toBe("goal_exhausted");
    expect(transitionGoal(lowered, "failed", T).status).toBe("failed");
  });

  it("执行出错也计入连续失败；进行中的步骤标为失败；错误信息脱敏", () => {
    let g = updateItem(startRound(running(), { items: ["调用模型"] }, T), "r1-1", "running", T);
    g = failRound(g, "provider 返回 401，api_key=abcd1234efgh5678", T);
    expect(g.rounds[0]).toMatchObject({ status: "failed", verdict: { verdict: "not_done", by: "runtime" } });
    expect(g.rounds[0].items[0].status).toBe("failed");
    expect(JSON.stringify(g)).not.toContain("abcd1234efgh5678");
    for (let i = 1; i < FAIL_STREAK; i++) g = failRound(startRound(g, {}, T), "超时", T);
    expect(g.status).toBe("failed");
  });

  it(`轮数达到 ${MAX_ROUNDS} 也停（手动「继续」不花调用时的兜底）；被打断的轮次中断连续失败计数`, () => {
    const r = (i: number): GoalRound => ({ index: i + 1, title: "", items: [], status: "interrupted", evidence: { tool_calls: [], file_changes: [], command_outputs: [] }, verdict: null, task_id: null, started_at: T, finished_at: T });
    const g = running({ rounds: Array.from({ length: MAX_ROUNDS }, (_, i) => r(i)) });
    expect(failStreak(g)).toBe(0);
    expect(failCause(g)).toBe("rounds");
    expect(err(() => startRound(g, {}, T)).code).toBe("goal_exhausted");
  });
});
describe("计划和实据来自模型：规整、脱敏、截断", () => {
  it("计划标题和步骤规整、脱敏，空步骤去掉；实据每类有上限", () => {
    const g = startRound(running(), { title: "x".repeat(300), items: ["读取 token: sk-abcdefghijklmnop1234", "  ", "移动\n文件"] }, T);
    const r = g.rounds[0];
    expect(r.title.length).toBe(100);
    expect(r.items.map((i) => i.id)).toEqual(["r1-1", "r1-2"]);
    expect(r.items[0].text).not.toContain("sk-abcdefghijklmnop1234");
    expect(r.items[1].text).toBe("移动 文件");
    let e = g;
    for (let i = 0; i < 20; i++) e = appendEvidence(e, { command_outputs: [{ command: `echo ${i}`, exit_code: 0, output: "ok" }] }, T);
    expect(e.rounds[0].evidence.command_outputs).toHaveLength(15);
    expect(e.rounds[0].evidence.command_outputs[14].command).toBe("echo 19");
  });

  it("暂停后才返回的工具结果仍记到被打断的那一轮；结束或删除后不再记", () => {
    const p = transitionGoal(startRound(running(), {}, T), "paused", T + 1);
    const late = appendEvidence(p, { file_changes: [{ path: "/d/a.pdf", action: "moved", to: "/d/PDF/a.pdf" }] }, T + 2);
    expect(late.rounds[0].evidence.file_changes).toHaveLength(1);
    expect(err(() => appendEvidence(transitionGoal(p, "deleted", T), {}, T)).code).toBe("invalid_goal_round");
    expect(err(() => appendEvidence(round(running(), done), {}, T)).code).toBe("invalid_goal_round");
  });

  it("模型调用次数：暂停或结束后返回的也记上；已删除的不记；次数必须是正整数", () => {
    const p = transitionGoal(running(), "paused", T);
    expect(recordLlmCalls(p, 2, T).used_llm_calls).toBe(2);
    expect(err(() => recordLlmCalls(transitionGoal(p, "deleted", T), 1, T)).code).toBe("goal_not_found");
    for (const n of [0, -1, 1.5, Number.NaN]) expect(err(() => recordLlmCalls(p, n, T)).code).toBe("invalid_goal_round");
  });
});

describe("新建与编辑", () => {
  it("新建：默认 idle、上限 50、不属于项目、偏好不覆盖", () => {
    expect(mk()).toMatchObject({ status: "idle", max_llm_calls: DEFAULT_MAX_LLM_CALLS, used_llm_calls: 0, project_id: null, routing_preference: null, rounds: [] });
    expect(DEFAULT_MAX_LLM_CALLS).toBe(50);
    expect(newGoal(normalizeGoal({ description: "a" }), T).id).toMatch(/^goal-[a-z0-9-]+$/);
  });

  it("拒绝：空描述、像密钥的内容、上限越界、项目 ID 格式不对", () => {
    expect(err(() => normalizeGoal({ description: "  " })).code).toBe("invalid_goal");
    expect(err(() => normalizeGoal({ description: "用 api_key=abcd1234efgh5678 调接口" })).message).not.toContain("abcd1234");
    for (const n of [0, 501, 2.5]) expect(err(() => normalizeGoal({ description: "a", max_llm_calls: n })).code).toBe("invalid_goal");
    expect(err(() => normalizeGoal({ description: "a", project_id: "../x" })).code).toBe("invalid_project_id");
  });

  it("编辑：没给的字段保持原值；不能换项目；上限不能低于已用次数；结束后不能改", () => {
    const g = mk({ project_id: "prj-a", max_llm_calls: 200, used_llm_calls: 10, routing_preference: "best" });
    const e = editGoal(g, { description: "整理下载和桌面" }, T + 9);
    expect(e).toMatchObject({ description: "整理下载和桌面", max_llm_calls: 200, routing_preference: "best", project_id: "prj-a", updated_at: T + 9 });
    expect(editGoal(g, { routing_preference: null }, T).routing_preference).toBeNull();
    expect(err(() => editGoal(g, { project_id: "prj-b" }, T)).message).toMatch(/不能换/);
    expect(err(() => editGoal(g, { max_llm_calls: 9 }, T)).message).toMatch(/已经用了 10 次/);
    expect(err(() => editGoal(round(running(), done), { description: "x" }, T)).code).toBe("goal_locked");
  });
});

describe("存储共用", () => {
  it("applyGoalChange 分发到对应操作；未知操作抛错", () => {
    let g = applyGoalChange(running(), { op: "start_round", plan: { items: ["a"] } }, T);
    g = applyGoalChange(g, { op: "record_llm_calls", count: 3 }, T);
    g = applyGoalChange(g, { op: "finish_round", result: done }, T);
    expect(g).toMatchObject({ status: "completed", used_llm_calls: 3 });
    expect(err(() => applyGoalChange(g, { op: "bogus" } as never, T)).code).toBe("invalid_goal");
  });

  it("rounds 写入再读回不变；内容损坏时返回 null", () => {
    const g = round(round(running(), notDone), uncertain);
    const withEvidence = appendEvidence(startRound(resolveUncertain(g, "continue", T), { items: ["x"] }, T), { command_outputs: [{ command: "ls", exit_code: 0, output: "a" }], claim: "做完了" }, T);
    expect(parseRounds(JSON.stringify(withEvidence.rounds))).toEqual(withEvidence.rounds);
    for (const bad of ["", "{", "{}", '[{"index":0}]', '[{"index":1,"status":"weird","items":[],"started_at":1,"finished_at":null}]', null])
      expect(parseRounds(bad), String(bad)).toBeNull();
    expect(parseRounds("[]")).toEqual([]);
  });
});

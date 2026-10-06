import { goalPhase, newGoal, normalizeGoal } from "@/decision/goal";
import { createMockBackend, getBackend, setBackend, type Backend, type Goal } from "@/platform";
import { goalsOfProject, useGoals } from "@/stores/goals";

beforeEach(() => {
  setBackend(createMockBackend());
  useGoals.setState({ loaded: false, items: [], error: null });
});

const goal = (id: string) => useGoals.getState().items.find((g) => g.id === id);
async function create(description: string, project_id: string | null = null): Promise<Goal> {
  const r = await useGoals.getState().save({ description, project_id });
  if (typeof r === "string") throw new Error(r);
  return r;
}
const claimOnly = { tool_calls: [], file_changes: [], command_outputs: [], claim: "都做完了" };

describe("目标 store", () => {
  it("新建为未开始；开始、暂停、继续都写进数据库，store 与数据库一致", async () => {
    const g = await create("把 docs 里的周报合并成一份");
    expect(goal(g.id)?.status).toBe("idle");
    expect(await useGoals.getState().start(g.id)).toBeNull();
    expect(await useGoals.getState().pause(g.id)).toBeNull();
    expect(goal(g.id)?.status).toBe("paused");
    expect(await useGoals.getState().start(g.id)).toBeNull();
    expect(goal(g.id)?.status).toBe("running");
    expect(useGoals.getState().items).toEqual(await getBackend().listGoals());
  });

  it("启动读回时把没有终态的目标轮次安全暂停，避免没有任务卡的永久进行中", async () => {
    const g = await create("重启后继续整理文件");
    await useGoals.getState().start(g.id);
    await useGoals.getState().apply(g.id, { op: "start_round", plan: { title: "第一轮", items: ["读取文件"] } });

    // 模拟窗口进程退出后重新初始化前端 store；数据库里的目标仍是 running/running。
    useGoals.setState({ loaded: false, items: [], error: null });
    await useGoals.getState().load();

    const recovered = useGoals.getState().items.find((x) => x.id === g.id)!;
    expect(recovered.status).toBe("paused");
    expect(recovered.rounds[0]).toMatchObject({
      status: "interrupted",
      interruption_reason: "应用在目标执行期间退出，上一轮已暂停；继续前会重新检查未完成步骤",
    });
    expect((await getBackend().listGoals()).find((x) => x.id === g.id)).toMatchObject({ status: "paused" });
  });

  it("非法转换返回状态机的说明，store 和数据库都不变", async () => {
    const g = await create("整理下载文件夹");
    expect(await useGoals.getState().pause(g.id)).toBe("目标未开始，不能改为「已暂停」");
    expect(goal(g.id)?.status).toBe("idle");
    expect((await getBackend().listGoals())[0].status).toBe("idle");
  });

  it("AI 只声称完成时停下等用户：用户选继续开下一轮，选完成才收尾", async () => {
    const g = await create("写一份发布说明");
    await useGoals.getState().start(g.id);
    const s = useGoals.getState();
    expect(typeof (await s.apply(g.id, { op: "start_round", plan: { title: "第一轮", items: ["起草"] } }))).toBe("object");
    await s.apply(g.id, { op: "finish_round", result: { verdict: "uncertain", reason: "AI 声称完成，但无实据", by: "rules" }, evidence: claimOnly });
    expect(goalPhase(goal(g.id)!)).toBe("awaiting_user");
    // 等用户时不能自动开下一轮
    expect(await s.apply(g.id, { op: "start_round", plan: {} })).toMatch(/等你确认/);

    expect(await s.resolve(g.id, "continue")).toBeNull();
    expect(goal(g.id)?.status).toBe("running");
    expect(goal(g.id)?.rounds[0].verdict?.by).toBe("user");
    await s.apply(g.id, { op: "start_round", plan: { title: "第二轮" } });
    await s.apply(g.id, { op: "finish_round", result: { verdict: "uncertain", reason: "AI 声称完成，但无实据", by: "rules" } });
    expect(await s.resolve(g.id, "done")).toBeNull();
    expect(goal(g.id)?.status).toBe("completed");
    // 结束后不能再编辑
    expect(await s.save({ id: g.id, description: "改一下" })).toBe("目标已完成，不能再编辑");
  });

  it("放弃保留轮次；删除后列表里没有，重复删除当作成功", async () => {
    const g = await create("迁移旧配置");
    await useGoals.getState().start(g.id);
    await useGoals.getState().apply(g.id, { op: "start_round", plan: { title: "第一轮" } });
    expect(await useGoals.getState().abandon(g.id)).toBeNull();
    expect(goal(g.id)?.status).toBe("abandoned");
    expect(goal(g.id)?.rounds).toHaveLength(1);
    expect(goal(g.id)?.rounds[0].status).toBe("interrupted");

    expect(await useGoals.getState().remove(g.id)).toBeNull();
    expect(goal(g.id)).toBeUndefined();
    expect(await getBackend().listGoals()).toEqual([]);
    expect(await useGoals.getState().remove(g.id)).toBeNull();
    expect(await useGoals.getState().start(g.id)).toBe("没有找到这个目标");
  });

  it("目标在别处被删掉时，下一次操作把它从列表里去掉", async () => {
    const g = await create("清理日志");
    await getBackend().updateGoal(g.id, { op: "transition", to: "deleted" });
    expect(goal(g.id)).toBeDefined();
    expect(await useGoals.getState().start(g.id)).toBe("没有找到这个目标");
    expect(goal(g.id)).toBeUndefined();
  });

  it("按项目筛选；不属于项目的目标单独一组；项目不存在时新建失败", async () => {
    const p = await getBackend().saveProject({ name: "发布" });
    const a = await create("写更新日志", p.id);
    const b = await create("随手查个问题");
    await useGoals.getState().load();
    expect(goalsOfProject(useGoals.getState().items, p.id).map((g) => g.id)).toEqual([a.id]);
    expect(goalsOfProject(useGoals.getState().items, null).map((g) => g.id)).toEqual([b.id]);
    expect(await useGoals.getState().save({ description: "x", project_id: "prj-missing" })).toBe("没有找到这个项目");
    expect(useGoals.getState().items).toHaveLength(2);
  });

  it("单条更新后按最近更新重新排序，不整表重读；加载失败时记下错误", async () => {
    const at = (id: string, t: number) => newGoal(normalizeGoal({ description: id }), t, id);
    const listed = [at("goal-b", 2), at("goal-a", 1)];
    const calls: string[] = [];
    const base = createMockBackend();
    const stub: Backend = {
      ...base,
      listGoals: async () => (calls.push("list"), listed),
      updateGoal: async (id) => (calls.push(`update ${id}`), { ...at(id, 5), status: "running" }),
    };
    setBackend(stub);
    await useGoals.getState().load();
    expect(useGoals.getState().items.map((g) => g.id)).toEqual(["goal-b", "goal-a"]);
    await useGoals.getState().start("goal-a");
    expect(useGoals.getState().items.map((g) => g.id)).toEqual(["goal-a", "goal-b"]);
    expect(calls).toEqual(["list", "update goal-a"]);

    setBackend({ ...base, listGoals: async () => Promise.reject({ code: "db_query_failed", message: "数据库查询失败" }) });
    await useGoals.getState().load();
    expect(useGoals.getState()).toMatchObject({ loaded: true, error: "数据库查询失败" });
    // 加载失败不清空已有列表
    expect(useGoals.getState().items).toHaveLength(2);
  });
});

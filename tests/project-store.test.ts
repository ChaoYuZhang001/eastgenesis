import { createMockBackend, getBackend, setBackend, type Project, type ProjectUsage } from "@/platform";
import { useGoals } from "@/stores/goals";
import { useMemory } from "@/stores/memory";
import { useProjects } from "@/stores/projects";

beforeEach(() => {
  setBackend(createMockBackend());
  useProjects.setState({ loaded: false, items: [], error: null, pendingDelete: null });
  useGoals.setState({ loaded: false, items: [], error: null });
  useMemory.setState({ loaded: false, items: [], error: null });
});

async function create(name: string): Promise<Project> {
  const r = await useProjects.getState().save({ name });
  if (typeof r === "string") throw new Error(r);
  return r;
}
const names = () => useProjects.getState().items.map((p) => p.name);

describe("项目 store", () => {
  it("新建、只改部分字段、归档和取消归档；校验失败返回说明且不回显内容", async () => {
    const p = await create("发布 v2");
    expect(p).toMatchObject({ name: "发布 v2", archived: false, routing_preference: null, context_folders: [] });
    const r = await useProjects.getState().save({ id: p.id, instructions: "提交说明用中文", routing_preference: "economy" });
    expect(r).toMatchObject({ name: "发布 v2", instructions: "提交说明用中文", routing_preference: "economy" });
    // 表单里「沿用上级」是空串：改回不覆盖
    expect(await useProjects.getState().save({ id: p.id, routing_preference: "" as never })).toMatchObject({ routing_preference: null });

    expect(await useProjects.getState().archive(p.id)).toBeNull();
    expect(useProjects.getState().items[0].archived).toBe(true);
    expect(await useProjects.getState().unarchive(p.id)).toBeNull();
    expect(useProjects.getState().items[0].archived).toBe(false);

    expect(await useProjects.getState().save({ name: "  " })).toBe("项目名称应为 1–60 个字符");
    const secret = await useProjects.getState().save({ name: "x", instructions: "token 是 sk-abcdefghijklmnop1234" });
    expect(secret).toBe("内容看起来包含密钥或令牌，不能保存");
    expect(await useProjects.getState().archive("prj-missing")).toBe("没有找到这个项目");
    expect(names()).toEqual(["发布 v2"]);
  });

  it("删除分两步：先显示连带数量，确认后项目、目标和记忆一起消失；其他项目和全局记忆不受影响", async () => {
    const a = await create("A");
    const b = await create("B");
    await useGoals.getState().load();
    for (const d of ["写更新日志", "补测试"]) await useGoals.getState().save({ description: d, project_id: a.id });
    await useGoals.getState().save({ description: "B 的目标", project_id: b.id });
    await useMemory.getState().save({ kind: "fact", text: "A 用 pnpm", project_id: a.id });
    await useMemory.getState().save({ kind: "fact", text: "B 用 cargo", project_id: b.id });
    await useMemory.getState().save({ kind: "preference", text: "用简体中文回答" });

    expect(await useProjects.getState().requestDelete(a.id)).toBeNull();
    expect(useProjects.getState().pendingDelete).toEqual({ id: a.id, name: "A", usage: { goals: 2, memories: 1, sessions: 0 } });
    // 还没确认：什么都没删
    expect(await getBackend().listGoals(a.id)).toHaveLength(2);

    expect(await useProjects.getState().confirmDelete()).toEqual({ goals: 2, memories: 1, sessions: 0 });
    expect(useProjects.getState().pendingDelete).toBeNull();
    expect(names()).toEqual(["B"]);
    expect(useGoals.getState().items.map((g) => g.description)).toEqual(["B 的目标"]);
    expect(useMemory.getState().items.map((m) => m.text).sort()).toEqual(["B 用 cargo", "用简体中文回答"]);
    expect(await useGoals.getState().save({ description: "x", project_id: a.id })).toBe("没有找到这个项目");
  });

  it("取消后不删除；没有待确认的删除时确认无效；目标没加载过就不去读", async () => {
    const p = await create("A");
    await useProjects.getState().requestDelete(p.id);
    useProjects.getState().cancelDelete();
    expect(useProjects.getState().pendingDelete).toBeNull();
    expect(await useProjects.getState().confirmDelete()).toBe("没有待确认的删除");
    expect(names()).toEqual(["A"]);

    const listGoals = vi.spyOn(getBackend(), "listGoals");
    await useProjects.getState().requestDelete(p.id);
    expect(await useProjects.getState().confirmDelete()).toEqual({ goals: 0, memories: 0, sessions: 0 });
    expect(listGoals).not.toHaveBeenCalled();
    expect(useGoals.getState().loaded).toBe(false);
  });

  it("确认前项目已在别处删除：返回说明，列表以数据库为准刷新", async () => {
    const p = await create("A");
    await useProjects.getState().requestDelete(p.id);
    await getBackend().deleteProject(p.id);
    expect(await useProjects.getState().confirmDelete()).toBe("没有找到这个项目");
    expect(names()).toEqual([]);
    expect(await useProjects.getState().requestDelete(p.id)).toBe("没有找到这个项目");
    expect(useProjects.getState().pendingDelete).toBeNull();
  });

  it("连续点两个项目的删除：只保留最后一次；取消后迟到的结果不再弹出确认框", async () => {
    const a = await create("A");
    const b = await create("B");
    const waits = new Map<string, (u: ProjectUsage) => void>();
    const backend = getBackend();
    setBackend({ ...backend, projectUsage: (id) => new Promise((resolve) => waits.set(id, resolve)) });
    const first = useProjects.getState().requestDelete(a.id);
    const second = useProjects.getState().requestDelete(b.id);
    waits.get(b.id)!({ goals: 0, memories: 0, sessions: 0 });
    await second;
    waits.get(a.id)!({ goals: 9, memories: 9, sessions: 0 });
    await first;
    expect(useProjects.getState().pendingDelete?.id).toBe(b.id);

    const third = useProjects.getState().requestDelete(a.id);
    useProjects.getState().cancelDelete();
    waits.get(a.id)!({ goals: 0, memories: 0, sessions: 0 });
    await third;
    expect(useProjects.getState().pendingDelete).toBeNull();
  });
});

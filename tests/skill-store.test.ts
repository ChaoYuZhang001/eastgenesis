import { stepsFromEvents } from "@/lib/skill";
import { createMockBackend, setBackend, type Backend } from "@/platform";
import { useMemory } from "@/stores/memory";
import { DEFAULT_ROUTING, useSettings } from "@/stores/settings";
import { useSkills } from "@/stores/skills";
import { useTasks } from "@/stores/tasks";

let b: Backend;
beforeEach(async () => {
  b = createMockBackend();
  setBackend(b);
  useSettings.setState({ loaded: false, statuses: [], jev: null, custom: [], routing: DEFAULT_ROUTING, overrides: {}, error: null });
  useTasks.setState({ tasks: [], activeId: null });
  useMemory.setState({ loaded: false, items: [], error: null });
  useSkills.setState({ loaded: false, items: [], error: null });
  await useSettings.getState().load();
});

const task = (id: string) => useTasks.getState().tasks.find((t) => t.id === id)!;

describe("技能库与任务", () => {
  it("相关的技能进入规划提示并记在时间线上，参考过的计数加 1", async () => {
    const bodies: string[] = [];
    setBackend({ ...b, providerRequest: (r) => (bodies.push(r.body ?? ""), b.providerRequest(r)) });
    await useSkills.getState().save({ name: "整理周报", description: "汇总本周进展，写成周报", steps: [{ goal: "汇总本周进展", tool: "demo_search" }, { goal: "按模板写成周报", tool: null }] });
    await useSkills.getState().save({ name: "排序算法讲解", description: "", steps: [{ goal: "解释快速排序", tool: null }] });
    const id = useTasks.getState().submit("整理本周周报")!;
    await vi.waitFor(() => expect(task(id).status).toBe("completed"));
    const ev = task(id).events.find((e) => e.type === "skill");
    expect(ev?.type === "skill" && ev.items.map((s) => s.name)).toEqual(["整理周报"]);
    expect(bodies.some((x) => x.includes("技能「整理周报」"))).toBe(true);
    expect(bodies.some((x) => x.includes("排序算法讲解"))).toBe(false);
    await vi.waitFor(() => expect(useSkills.getState().items.find((s) => s.name === "整理周报")?.use_count).toBe(1));
  });

  it("完成的任务：实际做完的步骤可以保存为技能", async () => {
    const id = useTasks.getState().submit("调研量子纠缠的研究进展")!;
    await vi.waitFor(() => expect(task(id).status).toBe("completed"));
    const steps = stepsFromEvents(task(id).events);
    expect(steps.some((s) => s.tool === "demo_search")).toBe(true);
    const r = await useSkills.getState().save({ name: "解释概念", description: "", steps, source: "task" });
    expect(typeof r === "string" ? r : r.source).toBe("task");
    expect(useSkills.getState().items).toHaveLength(1);
  });
});

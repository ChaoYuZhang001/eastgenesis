import { createMockBackend, setBackend } from "@/platform";
import { useMemory } from "@/stores/memory";
import { DEFAULT_ROUTING, useSettings } from "@/stores/settings";
import { useTasks } from "@/stores/tasks";

beforeEach(async () => {
  setBackend(createMockBackend());
  useSettings.setState({ loaded: false, statuses: [], jev: null, custom: [], routing: DEFAULT_ROUTING, overrides: {}, error: null });
  useTasks.setState({ tasks: [], activeId: null });
  useMemory.setState({ loaded: false, items: [], error: null });
  await useSettings.getState().load();
});

const task = (id: string) => useTasks.getState().tasks.find((t) => t.id === id)!;

describe("记忆 store 与任务", () => {
  it("任务带上偏好和相关事实，时间线记下用了哪几条，用过的计数加 1", async () => {
    await useMemory.getState().save({ kind: "preference", text: "用简体中文回答" });
    await useMemory.getState().save({ kind: "fact", text: "我的时区是 UTC+8" });
    await useMemory.getState().save({ kind: "fact", text: "家里的猫叫团子" });
    const id = useTasks.getState().submit("解释一下时区换算")!;
    await vi.waitFor(() => expect(task(id).status).toBe("completed"));
    const ev = task(id).events.find((e) => e.type === "memory");
    expect(ev?.type === "memory" && ev.items.map((m) => m.text)).toEqual(["用简体中文回答", "我的时区是 UTC+8"]);
    await vi.waitFor(() => expect(useMemory.getState().items.find((m) => m.text === "我的时区是 UTC+8")?.use_count).toBe(1));
    expect(useMemory.getState().items.find((m) => m.text === "家里的猫叫团子")?.use_count).toBe(0);
  });

  it("目标里要求记住时生成提议；确认后才保存，忽略则不保存", async () => {
    const a = useTasks.getState().submit("记住：我的时区是 UTC+8")!;
    expect(task(a).proposal).toEqual({ kind: "fact", text: "我的时区是 UTC+8" });
    expect(useMemory.getState().items).toEqual([]);
    expect(await useTasks.getState().acceptProposal(a)).toBeNull();
    expect(task(a).proposal).toBeNull();
    expect(useMemory.getState().items).toMatchObject([{ kind: "fact", text: "我的时区是 UTC+8", source: "task" }]);

    const b = useTasks.getState().submit("以后都用表格列出对比")!;
    expect(task(b).proposal?.kind).toBe("preference");
    useTasks.getState().dismissProposal(b);
    expect(task(b).proposal).toBeNull();
    expect(useMemory.getState().items).toHaveLength(1);
    for (const t of [a, b]) useTasks.getState().cancel(t);
  });
});

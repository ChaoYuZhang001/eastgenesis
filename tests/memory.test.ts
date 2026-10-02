import { memoryBlock, memoryTokens, selectMemories, type MemoryNote } from "@/agent";
import { normalizeMemory, proposeAlignment, proposeMemory } from "@/lib/memory";
import { toTimeline } from "@/lib/timeline";
import { createMockBackend } from "@/platform";

const note = (id: string, kind: MemoryNote["kind"], text: string, updated_at = 1): MemoryNote => ({ id, kind, text, updated_at });
const errOf = (f: () => unknown): { code: string; message: string } | null => {
  try {
    f();
    return null;
  } catch (e) {
    return e as { code: string; message: string };
  }
};
const code = (p: Promise<unknown>) => p.then(() => "ok", (e: { code: string }) => e.code);

describe("记忆校验", () => {
  it("规整空白；拒绝空内容、超长、未知类型和像密钥的内容，且不回显", () => {
    expect(normalizeMemory({ kind: "fact", text: "  我的时区\n是 UTC+8  " })).toEqual({ kind: "fact", text: "我的时区 是 UTC+8", source: "manual" });
    expect(normalizeMemory({ kind: "preference", text: "先给结论", source: "task" }).source).toBe("task");
    expect(errOf(() => normalizeMemory({ kind: "fact", text: "   " }))?.code).toBe("invalid_memory");
    expect(errOf(() => normalizeMemory({ kind: "fact", text: "字".repeat(501) }))?.code).toBe("invalid_memory");
    expect(errOf(() => normalizeMemory({ kind: "other" as "fact", text: "x" }))?.code).toBe("invalid_memory");
    const e = errOf(() => normalizeMemory({ kind: "fact", text: "我的 key 是 sk-abcdefghijklmnop1234" }));
    expect(e?.message).toContain("密钥");
    expect(e?.message).not.toContain("sk-abc");
  });
});

describe("「记住」提议", () => {
  it("只在明确要求记住或给出长期指令时提议，只取要记住的那一句", () => {
    expect(proposeMemory("记住：我的时区是 UTC+8")).toEqual({ kind: "fact", text: "我的时区是 UTC+8" });
    expect(proposeMemory("记住我的时区是 UTC+8，帮我安排下周的会议")).toEqual({ kind: "fact", text: "我的时区是 UTC+8" });
    expect(proposeMemory("请记住写周报时总是先给结论。然后帮我写本周周报")).toEqual({ kind: "preference", text: "写周报时总是先给结论" });
    expect(proposeMemory("以后都用简体中文回答")).toEqual({ kind: "preference", text: "用简体中文回答" });
    expect(proposeMemory("从现在起，金额单位用万元")).toEqual({ kind: "preference", text: "金额单位用万元" });
    expect(proposeMemory("Remember that I prefer metric units")).toEqual({ kind: "preference", text: "I prefer metric units" });
  });

  it("称呼：「叫我…」「称呼我…」「Call me …」提议为偏好；「帮我叫我妈」不算", () => {
    expect(proposeMemory("叫我小王就行")).toEqual({ kind: "preference", text: "称呼我小王" });
    expect(proposeMemory("你可以称呼我老李，然后帮我写周报")).toEqual({ kind: "preference", text: "称呼我老李" });
    expect(proposeMemory("以后叫我阿杰")).toEqual({ kind: "preference", text: "称呼我阿杰" });
    expect(proposeMemory("Call me Alex, and keep it short")).toEqual({ kind: "preference", text: "Call me Alex" });
    for (const g of ["帮我叫我妈来一下", "call me when done", "他们都叫我"]) expect(proposeMemory(g), g).toBeNull();
  });

  it("对齐问题的回答：含称呼、风格或边界的一句话整句提议为偏好", () => {
    expect(proposeAlignment("简洁点，别碰 ~/Documents")).toEqual({ kind: "preference", text: "简洁点，别碰 ~/Documents" });
    expect(proposeAlignment("叫我小王")).toEqual({ kind: "preference", text: "称呼我小王" });
    expect(proposeAlignment("帮我查一下天气")).toBeNull();
    expect(proposeAlignment("别碰 sk-abcdefghijklmnop1234 这个目录")).toBeNull();
  });

  it("闲聊、提醒和像密钥的内容不提议", () => {
    for (const g of ["写一段 Python 快速排序", "我记住了，谢谢", "Remember to call Bob", "I can't remember the password", "这个以后再说，先写代码", "记住", "记住我的 key 是 sk-abcdefghijklmnop1234"]) {
      expect(proposeMemory(g), g).toBeNull();
    }
  });
});

describe("按目标挑选记忆", () => {
  const p1 = note("p1", "preference", "用简体中文回答", 5);
  const f1 = note("f1", "fact", "我们的财年从四月开始", 4);
  const f2 = note("f2", "fact", "我的时区是 UTC+8", 3);
  const f3 = note("f3", "fact", "家里的猫叫团子", 2);
  const all = [f1, f2, f3, p1];

  it("偏好总是带上；事实只在和目标有词重叠时带上", () => {
    expect(selectMemories(all, "帮我安排下周的会议，注意时区").map((n) => n.id)).toEqual(["p1", "f2"]);
    expect(selectMemories(all, "UTC+8 下午三点是纽约几点").map((n) => n.id)).toEqual(["p1", "f2"]);
    expect(selectMemories(all, "按财年做一份预算").map((n) => n.id)).toEqual(["p1", "f1"]);
    expect(selectMemories(all, "写一段快速排序").map((n) => n.id)).toEqual(["p1"]);
    expect(selectMemories([], "任何目标")).toEqual([]);
  });

  it("偏好最多 8 条，最近更新的优先；中文按相邻两字、英文按词，虚词不参与", () => {
    const many = Array.from({ length: 10 }, (_, i) => note(`p${i}`, "preference", `偏好${i}`, i));
    expect(selectMemories(many, "x").map((n) => n.id)).toEqual(["p9", "p8", "p7", "p6", "p5", "p4", "p3", "p2"]);
    expect(memoryTokens("注意时区 UTC+8")).toEqual(new Set(["utc+8", "注意", "意时", "时区"]));
    expect(memoryTokens("帮我").size).toBe(0);
  });

  it("系统提示里的记忆段：说明来源和优先级，偏好在前", () => {
    expect(memoryBlock([])).toBe("");
    const b = memoryBlock([f2, p1]);
    expect(b).toContain("用户确认过的长期记忆，与当前目标冲突时以当前目标为准");
    expect(b.indexOf("用简体中文回答")).toBeLessThan(b.indexOf("我的时区是 UTC+8"));
  });

  it("时间线列出这次参考的记忆", () => {
    const items = toTimeline([{ type: "memory", items: [{ id: "p1", kind: "preference", text: "用简体中文回答" }] }], []);
    expect(items[0]).toMatchObject({ stage: "analysis", title: "参考了 1 条记忆", detail: "偏好：用简体中文回答" });
  });
});

describe("浏览器模式的记忆存储", () => {
  it("新建、编辑（来源不变）、计数、删除；ID 和上限都会校验", async () => {
    const b = createMockBackend();
    const m = await b.saveMemory({ kind: "fact", text: "我的时区是 UTC+8", source: "task" });
    expect(m).toMatchObject({ kind: "fact", source: "task", use_count: 0, last_used_at: null });
    expect(m.id).toMatch(/^mem-/);
    const e = await b.saveMemory({ id: m.id, kind: "preference", text: "用 UTC+8 显示时间" });
    expect(e).toMatchObject({ id: m.id, kind: "preference", text: "用 UTC+8 显示时间", source: "task" });
    await b.touchMemories([m.id, "mem-missing"]);
    expect((await b.listMemories())[0]).toMatchObject({ use_count: 1 });
    expect((await b.listMemories())[0].last_used_at).not.toBeNull();
    expect(await code(b.saveMemory({ id: "mem-missing", kind: "fact", text: "x" }))).toBe("memory_not_found");
    expect(await code(b.saveMemory({ id: "../jev", kind: "fact", text: "x" }))).toBe("invalid_memory_id");
    expect(await code(b.deleteMemory("bad id"))).toBe("invalid_memory_id");
    await b.deleteMemory(m.id);
    expect(await b.listMemories()).toEqual([]);
  });

  it("最多 200 条", async () => {
    const b = createMockBackend();
    for (let i = 0; i < 200; i++) await b.saveMemory({ kind: "fact", text: `事实 ${i}` });
    expect(await code(b.saveMemory({ kind: "fact", text: "再来一条" }))).toBe("memory_full");
  });
});

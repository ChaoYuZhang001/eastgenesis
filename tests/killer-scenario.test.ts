// @vitest-environment node
// 杀手场景：把下载文件夹里最近 30 天的 PDF 按主题分类。真实 MCP 子进程（eg-mcp-files）+ 确定性模拟模型，不调用真实 API。
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { classify, killerMockLlm } from "./killer-mock-llm";
import { BIN, manifest, prepareHome, runScenario } from "./killer-scenario-harness";

describe("模拟模型的主题判断", () => {
  it("按标题和正文的关键词判断，给出理由；没有文本归入其他", () => {
    expect(classify("软件采购合同", "甲方 乙方 违约责任")).toMatchObject({ topic: "合同", reason: expect.stringContaining("甲方") });
    expect(classify("", "摘要：本文提出… 参考文献")).toMatchObject({ topic: "论文", reason: expect.stringMatching(/^正文出现/) });
    expect(classify("", "")).toMatchObject({ topic: "其他", reason: expect.stringContaining("扫描件") });
    expect(classify("旅行照片", "海边")).toMatchObject({ topic: "其他" });
  });
});

describe.skipIf(!existsSync(BIN))("杀手场景：整理下载文件夹的 PDF", () => {
  it("列出 → 读取 → 判断主题 → 建文件夹 → 逐个确认后移动 → 报告；不反问、不碰范围外文件", async () => {
    const { home, downloads } = prepareHome();
    const { llm } = killerMockLlm();
    const r = await runScenario({ llm, home, downloads });
    for (const c of r.checks) expect.soft(c.ok, `${c.name}：${c.detail}`).toBe(true);
    expect(r.result.status).toBe("completed");
    // 每次移动前确认一次；只建了用到的文件夹；没有删除
    expect(r.confirms.filter((c) => c.tool === "move_file")).toHaveLength(7);
    expect(r.confirms.some((c) => c.tool === "delete_file" || c.second)).toBe(false);
    expect(r.tree).toEqual(expect.arrayContaining(["合同/", "合同/房屋租赁协议.pdf", "其他/scan_0423.pdf", "旧版API手册.pdf", "会议纪要.txt"]));
    expect(r.result.summary).toContain("| 房屋租赁协议.pdf | ~/Downloads/房屋租赁协议.pdf | ~/Downloads/合同/房屋租赁协议.pdf | 合同 |");
    expect(r.ms).toBeLessThan(180_000);
  });

  it("续写轮数有上限：超过就停在 budget_exceeded，不会无限规划", async () => {
    const { home, downloads } = prepareHome();
    const r = await runScenario({ llm: killerMockLlm({ batch: 1 }).llm, home, downloads });
    expect(r.result).toMatchObject({ status: "budget_exceeded", summary: expect.stringContaining("续写规划超过预算（10 轮）") });
  });

  it("每批步骤有上限时分多轮续写，结果一样", async () => {
    const { home, downloads } = prepareHome();
    const r = await runScenario({ llm: killerMockLlm({ batch: 3 }).llm, home, downloads });
    expect(r.checks.filter((c) => !c.ok)).toEqual([]);
    expect(r.result.events.filter((e) => e.type === "plan" && e.continuation).length).toBeGreaterThan(3);
    for (const f of manifest().files.filter((x) => x.expected)) expect(existsSync(join(downloads, f.expected!, f.name))).toBe(true);
  });

  it("拒绝某次移动：任务停止，已移动的保留，没移动的留在原处", async () => {
    const { home, downloads } = prepareHome();
    const { llm } = killerMockLlm();
    const r = await runScenario({ llm, home, downloads, refuse: (tool, n) => tool === "move_file" && n === 3 });
    expect(r.result.status).toBe("aborted");
    expect(r.moves).toHaveLength(2);
    expect(r.confirms.filter((c) => c.tool === "move_file")).toHaveLength(3);
    const still = manifest().files.filter((f) => f.expected && existsSync(join(downloads, f.name)));
    expect(still).toHaveLength(5);
  });
});

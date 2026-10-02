// 成果文本不带「路由记录」段落：路由信息只在回答下方的折叠行里。
import { describe, expect, it } from "vitest";
import { AGENT_SYSTEM, stripRouteRecord } from "@/agent";

describe("stripRouteRecord", () => {
  it("去掉标题式的路由记录段，保留后面的其他标题", () => {
    const t = "整理完成，共移动 7 个文件。\n\n## 路由记录\n- 使用 gpt-x\n- 备用 claude-y\n\n## 下一步\n可以再检查一下。";
    const s = stripRouteRecord(t);
    expect(s).not.toMatch(/路由记录|gpt-x|claude-y/);
    expect(s).toContain("整理完成，共移动 7 个文件。");
    expect(s).toContain("## 下一步");
  });

  it("去掉加粗标题式和行内式的路由记录，删到空行为止", () => {
    expect(stripRouteRecord("结果如下。\n\n**路由记录**\n用了本地模型。\n\n---\n")).toBe("结果如下。");
    expect(stripRouteRecord("答案是 42。\n\n路由记录：首选 a，备用 b。\n\n补充说明。")).toBe("答案是 42。\n\n补充说明。");
  });

  it("正文里提到这个词不删；全文都是路由记录时保留原文，避免空回答", () => {
    const t = "你可以在回答下方展开查看路由记录。";
    expect(stripRouteRecord(t)).toBe(t);
    expect(stripRouteRecord("## 路由记录\n- a")).toBe("## 路由记录\n- a");
  });

  it("系统提示要求模型不写路由记录段落", () => {
    expect(AGENT_SYSTEM).toMatch(/不要写「路由记录」/);
  });
});

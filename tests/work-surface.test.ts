import { describe, expect, it } from "vitest";
import { classifyTask } from "@/decision/rules";
import { inferWorkSurface } from "@/decision/work-surface";

describe("统一工作台能力面", () => {
  it("普通问答进入 Chat", () => {
    const c = classifyTask({ text: "解释一下什么是贝叶斯定理" });
    expect(c.surface).toBe("chat");
    expect(c.surfaceReason).toContain("对话");
  });

  it("本地文件整理进入 Work", () => {
    const c = classifyTask({ text: "整理下载文件夹里的 PDF，按主题分类并生成报告" });
    expect(c.surface).toBe("work");
    expect(c.surfaceReason).toContain("文件");
  });

  it("仅上传文档并要求总结也进入 Work，不要求先有工具标签", () => {
    const c = classifyTask({ text: "总结这份材料的主要结论", attachments: [{ kind: "pdf", name: "材料.pdf", chars: 24000 }] });
    expect(c.surface).toBe("work");
  });

  it("仓库、终端和测试任务进入 Codex", () => {
    const c = classifyTask({ text: "打开这个 Git 仓库，修复登录问题，运行测试并提交 Diff" });
    expect(c.surface).toBe("codex");
    expect(c.surfaceReason).toContain("代码仓库");
  });

  it("代码概念问答不会因为包含 code 能力就获得本地开发权限", () => {
    const c = classifyTask({ text: "解释一下 Rust 的所有权和借用" });
    expect(c.surface).toBe("chat");
  });

  it("显式提示只作为能力面提示，不改变执行模式", () => {
    expect(inferWorkSurface({ text: "解释这个概念", surfaceHint: "work" }, [])).toEqual({
      surface: "work",
      reason: "用户指定能力面",
    });
  });
});

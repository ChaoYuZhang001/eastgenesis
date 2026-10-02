// @vitest-environment node
// 规则分类器单元测试。样例为自编，与 tests/fixtures/routing_cases.json 无关。
import { classifyTask, countNumbers, detectLang, estimateTokens, LONG_CONTEXT_CHARS } from "@/decision/rules";
import type { Attachment, Capability, TaskType } from "@/decision/types";

const img: Attachment = { kind: "image", name: "a.png" };

describe("规则分类器", () => {
  it.each<[string, Attachment[] | undefined, TaskType, Capability[]]>([
    ["What is the capital of Australia?", undefined, "qa", []],
    ["把这句话翻译成英文：今天天气真好", undefined, "qa", ["zh"]],
    ["What's the dress code for a black-tie wedding?", undefined, "qa", []],
    ["我家的球蟒 python 三周不吃东西了，正常吗", undefined, "qa", ["zh"]],
    ["帮我起草一封给客户的道歉邮件，语气诚恳一点", undefined, "qa", ["zh"]],
    ["What is probability?", undefined, "qa", []],
    ["Write a Python function that removes duplicates from a list", undefined, "code", ["code"]],
    ["这段代码为什么报错：TypeError: cannot read properties of undefined", undefined, "code", ["code", "zh"]],
    ["Prove that there are infinitely many primes", undefined, "reasoning", ["reasoning"]],
    ["甲乙丙三人中只有一人说真话。甲说乙在说谎，乙说丙在说谎，丙说甲乙都在说谎。谁说的是真话？", undefined, "reasoning", ["reasoning", "zh"]],
    ["What's the weather in Shanghai today?", undefined, "tool_use", ["tool_use"]],
    ["把桌面上的截图都压缩成一个 zip", undefined, "tool_use", ["tool_use", "zh"]],
    ["Email the Q3 report to my manager", undefined, "tool_use", ["tool_use"]],
    ["Run the unit tests and fix whatever fails", undefined, "tool_use", ["code", "tool_use"]],
    ["提醒我明天下午三点开会", undefined, "tool_use", ["tool_use", "zh"]],
    ["How do I send an email with an attachment in Gmail?", undefined, "qa", []],
    ["这张图里写的是什么字？", [img], "vision", ["vision", "zh"]],
    ["Rename this photo to beach.jpg", [img], "tool_use", ["tool_use"]],
    ["Fix the bug shown in this screenshot", [img], "vision", ["code", "vision"]],
    ["Summarize the key risks in this contract", [{ kind: "pdf", name: "c.pdf", chars: 180_000 }], "long_context", ["long_context"]],
    ["总结一下这份文档的要点", [{ kind: "text", name: "d.txt", chars: 20_000 }], "qa", ["zh"]],
  ])("%s", (text, attachments, type, caps) => {
    const r = classifyTask({ text, attachments });
    expect({ type: r.type, caps: r.capabilities }).toEqual({ type, caps });
  });

  it("每个判定都给出可展示的信号", () => {
    const r = classifyTask({ text: "Summarize this", attachments: [{ kind: "text", chars: LONG_CONTEXT_CHARS + 1 }] });
    expect(r.signals.join(" ")).toMatch(/字符/);
    expect(classifyTask({ text: "你好" }).signals).toEqual([]);
  });

  it("语言检测", () => {
    expect(detectLang("How are you?")).toBe("en");
    expect(detectLang("今天吃什么")).toBe("zh");
    expect(detectLang("帮我 review 一下这个 PR 的 error handling")).toBe("mixed");
  });

  it("数字统计：日期、时刻各算一个，忽略「一个」「一下」", () => {
    expect(countNumbers("2026-10-01 9:30 开会")).toBe(2);
    expect(countNumbers("帮我写一个函数，看一下")).toBe(0);
    expect(countNumbers("3 个人 5 天吃掉两箱苹果")).toBe(3);
  });

  it("token 估算：中文按字、其他按 4 字符、附件按 3 字符", () => {
    expect(estimateTokens({ text: "你好" })).toBe(2);
    expect(estimateTokens({ text: "abcd", attachments: [{ kind: "text", chars: 300 }, img] })).toBe(1 + 100 + 1500);
  });
});

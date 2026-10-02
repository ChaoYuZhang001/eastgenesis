import { describe, expect, it } from "vitest";
import { classificationFromProbs } from "@/decision/classification";

const input = { text: "帮我写一个快速排序" };
const conf = (probs: Record<string, number>, attachments?: { kind: "image" | "pdf"; name?: string; chars?: number }[]) =>
  classificationFromProbs({ ...input, attachments }, probs, "Jev");

describe("分类置信度：只计入会改变结果的判断", () => {
  it("主类型已是 code 时，reasoning 含糊不计入（真实 Jev 对「快速排序」：code 0.97 / reasoning 0.55 / tool_use 0.04）", () => {
    const c = conf({ code: 0.97, reasoning: 0.55, tool_use: 0.04 });
    expect(c.type).toBe("code");
    expect(c.capabilities).toEqual(["code", "reasoning", "zh"]);
    expect(c.confidence).toBeCloseTo(0.92, 5);
  });

  it("会改变主类型的含糊要计入：tool_use 0.55 抢走主类型，置信度只有 0.1", () => {
    const c = conf({ code: 0.97, reasoning: 0.04, tool_use: 0.55 });
    expect(c.type).toBe("tool_use");
    expect(c.confidence).toBeCloseTo(0.1, 5);
  });

  it("硬性能力的含糊总是计入，即使它没有被判为需要：tool_use 0.45", () => {
    const c = conf({ code: 0.97, reasoning: 0.04, tool_use: 0.45 });
    expect(c.type).toBe("code");
    expect(c.confidence).toBeCloseTo(0.1, 5);
  });

  it("主类型是 qa 时，任何一项含糊都可能改变结果，全部计入", () => {
    const c = conf({ code: 0.45, reasoning: 0.04, tool_use: 0.03 });
    expect(c.type).toBe("qa");
    expect(c.confidence).toBeCloseTo(0.1, 5);
  });

  it("主类型是 reasoning 时，code 和 reasoning 都计入", () => {
    const c = conf({ code: 0.4, reasoning: 0.95, tool_use: 0.03 });
    expect(c.type).toBe("reasoning");
    expect(c.confidence).toBeCloseTo(0.2, 5);
  });

  it("主类型被图片或长文本抢走后，低优先级的 code / reasoning 含糊不计入", () => {
    const withImage = conf({ code: 0.5, reasoning: 0.5, tool_use: 0.03, vision: 0.96 }, [{ kind: "image", name: "a.png" }]);
    expect(withImage.type).toBe("vision");
    expect(withImage.confidence).toBeCloseTo(0.92, 5);
    const longDoc = conf({ code: 0.5, reasoning: 0.5, tool_use: 0.03 }, [{ kind: "pdf", name: "a.pdf", chars: 150_000 }]);
    expect(longDoc.type).toBe("long_context");
    expect(longDoc.confidence).toBeCloseTo(0.94, 5);
  });

  it("所有判断都含糊时置信度仍然很低，不会被「取最大」掩盖", () => {
    expect(conf({ code: 0.5, reasoning: 0.5, tool_use: 0.5 }).confidence).toBe(0);
  });
});

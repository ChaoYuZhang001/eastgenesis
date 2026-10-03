// @vitest-environment node
// checkDoneWithEvidence：规则 → Jev（有 Key 时）→ 交给用户确认。Jev 全部用假 fetch，不调用真实 API。
import { DecisionLayer } from "@/decision/decision-layer";
import { CLAIM_ONLY_REASON, JEV_EVIDENCE_QUESTION, NO_JUDGE_REASON, type Evidence } from "@/decision/evidence";

const KEY = "ts-test-key-0123456789abcdef";
const ENV = { OPENAI_API_KEY: "x" };
const ctx = { taskId: "task-1", projectId: "prj-a" };
const ev = (e: Partial<Evidence>): Evidence => ({ tool_calls: [], file_changes: [], command_outputs: [], ...e });

/** 假 Jev：noul 固定返回 p；status 不是 200 时返回错误 */
function jev(p: number, status = 200) {
  const calls: any[] = [];
  const fetch = async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    calls.push(body);
    if (status !== 200) return new Response("{}", { status });
    const answers = Object.fromEntries(Object.keys(body.questions).map((k) => [k, { type: "noul", noul: p }]));
    return new Response(JSON.stringify({ model: "jev-1.13.0", answers, usage: { input_tokens: 1, output_tokens: 1 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch, calls };
}
const layer = (env: Record<string, string>, fetch?: any) => DecisionLayer.fromEnv(env, { fetch, jev: { maxRetries: 0 } });

// 规则判断不了的情况：有实据（移动了文件），但目标里没有能核对的条件
const ORGANIZE = "把下载文件夹按类型整理好";
const MOVED = ev({ file_changes: [{ path: "/d/a.pdf", action: "moved", to: "/d/PDF/a.pdf" }], claim: "已经全部整理好了" });

describe("checkDoneWithEvidence", () => {
  it("规则能判断时不问 Jev：测试没过 → not_done，点名文件已产出 → done，只有自述 → uncertain", async () => {
    const { fetch, calls } = jev(0.99);
    const d = layer({ ...ENV, TYPESAFE_API_KEY: KEY }, fetch);
    expect(await d.checkDoneWithEvidence("修好 bug", ev({ command_outputs: [{ command: "pnpm test", exit_code: 1, output: "1 failed" }] }), ctx)).toMatchObject({ verdict: "not_done", by: "rules" });
    expect(await d.checkDoneWithEvidence("生成 report.md", ev({ file_changes: [{ path: "/w/report.md", action: "created" }] }), ctx)).toMatchObject({ verdict: "done", by: "rules" });
    expect(await d.checkDoneWithEvidence("总结文档", ev({ claim: "总结好了" }), ctx)).toEqual({ verdict: "uncertain", reason: CLAIM_ONLY_REASON, by: "rules" });
    expect(calls).toHaveLength(0);
  });

  it("规则判断不了、有 Key：问 Jev，只发目标和执行记录（不含自述）；确定程度够才下结论", async () => {
    const yes = jev(0.9);
    const r = await layer({ ...ENV, TYPESAFE_API_KEY: KEY }, yes.fetch).checkDoneWithEvidence(ORGANIZE, MOVED, ctx);
    expect(r).toMatchObject({ verdict: "done", by: "jev" });
    expect(r.confidence).toBeCloseTo(0.8);
    expect(yes.calls).toHaveLength(1);
    const body = yes.calls[0];
    expect(body.questions).toEqual({ q: { type: "noul", instructions: JEV_EVIDENCE_QUESTION } });
    expect(body.state).toEqual({ goal: ORGANIZE, record: expect.stringContaining("- moved /d/a.pdf -> /d/PDF/a.pdf") });
    expect(JSON.stringify(body.state)).not.toContain("已经全部整理好了");
    expect(JSON.stringify(body)).not.toContain(KEY);
    expect((await layer({ ...ENV, TYPESAFE_API_KEY: KEY }, jev(0.1).fetch).checkDoneWithEvidence(ORGANIZE, MOVED, ctx)).verdict).toBe("not_done");
    expect((await layer({ ...ENV, TYPESAFE_API_KEY: KEY }, jev(0.6).fetch).checkDoneWithEvidence(ORGANIZE, MOVED, ctx)).verdict).toBe("uncertain");
  });

  it("没有 Key：uncertain，交给用户确认，不发请求", async () => {
    const { fetch, calls } = jev(0.99);
    expect(await layer(ENV, fetch).checkDoneWithEvidence(ORGANIZE, MOVED, ctx)).toEqual({ verdict: "uncertain", reason: NO_JUDGE_REASON, by: "rules" });
    expect(calls).toHaveLength(0);
  });

  it("Jev 出错：uncertain 并写明原因；已取消时抛出 aborted，不当成结论", async () => {
    const r = await layer({ ...ENV, TYPESAFE_API_KEY: KEY }, jev(0.9, 500).fetch).checkDoneWithEvidence(ORGANIZE, MOVED, ctx);
    expect(r).toMatchObject({ verdict: "uncertain", by: "jev" });
    expect(r.reason).toMatch(/Jev 调用失败（server）/);
    const ac = new AbortController();
    ac.abort();
    await expect(layer({ ...ENV, TYPESAFE_API_KEY: KEY }, jev(0.9).fetch).checkDoneWithEvidence(ORGANIZE, MOVED, { ...ctx, signal: ac.signal })).rejects.toMatchObject({ code: "aborted" });
  });

  it("原来的 checkDone 不变", async () => {
    const { fetch } = jev(0.9);
    const d = await layer({ ...ENV, TYPESAFE_API_KEY: KEY }, fetch).checkDone("写一首诗", "床前明月光");
    expect(d.value).toBe(true);
    expect(d.meta.backend).toBe("cloud-jev");
  });
});

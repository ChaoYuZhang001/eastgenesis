// @vitest-environment node
// Jev 客户端：全部使用假 fetch，不调用真实 API。
import { JEV_BASE_URL, JevClient, JevError } from "@/decision/jev-client";

const KEY = "ts-test-key-0123456789abcdef";

interface Call {
  url: string;
  auth: string | null;
  body: any;
}

function fake(responses: Response[]) {
  const calls: Call[] = [];
  let i = 0;
  const fetch = async (url: string, init?: RequestInit) => {
    const h = new Headers(init?.headers);
    calls.push({ url, auth: h.get("authorization"), body: init?.body ? JSON.parse(String(init.body)) : null });
    return responses[Math.min(i++, responses.length - 1)].clone();
  };
  return { fetch, calls };
}

const hang = async (_url: string, init?: RequestInit) =>
  new Promise<Response>((_r, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const ok = (answer: unknown) => json({ model: "jev-1.13.0", answers: { q: answer }, usage: { input_tokens: 10, output_tokens: 2 } });
const client = (fetch: any, extra: Record<string, unknown> = {}) => new JevClient({ apiKey: KEY, fetch, backoffInitialMs: 1, ...extra });

describe("JevClient", () => {
  it("choice：请求格式、鉴权头、响应映射", async () => {
    const { fetch, calls } = fake([ok({ type: "choice", choice: "code", probabilities: { code: 0.9, qa: 0.1 }, confidence: 0.85 })]);
    const r = await client(fetch).choice("hello", "What kind of task is this?", { code: "programming", qa: null });
    expect(r).toEqual({ choice: "code", confidence: 0.85, probabilities: { code: 0.9, qa: 0.1 }, model: "jev-1.13.0" });
    expect(calls[0].url).toBe(`${JEV_BASE_URL}/v1/systemone`);
    expect(calls[0].auth).toBe(`Bearer ${KEY}`);
    expect(calls[0].body).toMatchObject({ model: "jev-latest", state: "hello", questions: { q: { type: "choice" } } });
  });

  it("noul 的确定程度按 |2p − 1| 计算；score 原样返回", async () => {
    const n = fake([ok({ type: "noul", noul: 0.9 })]);
    expect(await client(n.fetch).noul("x", "Is it done?")).toMatchObject({ noul: 0.9, confidence: expect.closeTo(0.8, 5) });
    const s = fake([ok({ type: "score", score: 1.2, legend: { 0: "a", 1: "b", 2: "c" }, probabilities: { 0: 0, 1: 0.8, 2: 0.2 }, confidence: 0.7 })]);
    expect(await client(s.fetch).score("x", "Risk?", ["low", "mid", "high"])).toMatchObject({ score: 1.2, confidence: 0.7 });
  });

  it("发送前对 state 脱敏，请求体里不出现 Key", async () => {
    const { fetch, calls } = fake([ok({ type: "noul", noul: 0.2 })]);
    await client(fetch).noul("config api_key=abc123 and Bearer secret-token", "Contains secrets?");
    expect(calls[0].body.state).toBe("config api_key=[REDACTED] and Bearer [REDACTED]");
    expect(JSON.stringify(calls.map((c) => c.body))).not.toContain(KEY);
  });

  it("401 → auth，不重试", async () => {
    const { fetch, calls } = fake([json({ error: `bad key ${KEY}` }, 401)]);
    const e: JevError = await client(fetch).noul("x", "q").catch((x) => x);
    expect(e).toBeInstanceOf(JevError);
    expect(e).toMatchObject({ code: "auth", status: 401, retryable: false });
    expect(calls).toHaveLength(1);
    expect(JSON.stringify({ m: e.message, d: e.detail, a: e.toAppError() })).not.toContain(KEY);
  });

  it("429 按 Retry-After 重试后成功", async () => {
    const { fetch, calls } = fake([json({}, 429, { "retry-after": "0" }), ok({ type: "noul", noul: 0.7 })]);
    expect((await client(fetch).noul("x", "q")).noul).toBe(0.7);
    expect(calls).toHaveLength(2);
  });

  it("529 重试用完 → overloaded（可重试类错误）", async () => {
    const { fetch, calls } = fake([json({}, 529)]);
    const e: JevError = await client(fetch, { maxRetries: 1 }).noul("x", "q").catch((x) => x);
    expect(e).toMatchObject({ code: "overloaded", retryable: true });
    expect(calls).toHaveLength(2);
  });

  it("422 → bad_request，不重试", async () => {
    const { fetch, calls } = fake([json({ detail: "questions.q: invalid" }, 422)]);
    await expect(client(fetch).noul("x", "q")).rejects.toMatchObject({ code: "bad_request" });
    expect(calls).toHaveLength(1);
  });

  it("返回的选项不在候选集中 → invalid_response", async () => {
    const { fetch } = fake([ok({ type: "choice", choice: "hack", probabilities: {}, confidence: 0.9 })]);
    await expect(client(fetch).choice("x", "pick", { a: null, b: null })).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("单次超时与总时限都映射为 timeout；调用方取消映射为 aborted", async () => {
    await expect(client(hang, { timeoutMs: 30, maxRetries: 0 }).noul("x", "q")).rejects.toMatchObject({ code: "timeout" });
    const e: JevError = await client(hang, { timeoutMs: 10_000, deadlineMs: 40 }).noul("x", "q").catch((x) => x);
    expect(e).toMatchObject({ code: "timeout" });
    expect(e.detail).toMatch(/总时限/);
    const ctrl = new AbortController();
    const p = client(hang, { timeoutMs: 10_000 }).noul("x", "q", ctrl.signal);
    ctrl.abort();
    await expect(p).rejects.toMatchObject({ code: "aborted" });
  });

  it("fromEnv：没有 Key 返回 null；端点必须 https", () => {
    expect(JevClient.fromEnv({})).toBeNull();
    expect(JevClient.fromEnv({ TYPESAFE_API_KEY: "  " })).toBeNull();
    expect(JevClient.fromEnv({ TYPESAFE_API_KEY: KEY })).toBeInstanceOf(JevClient);
    expect(() => JevClient.fromEnv({ TYPESAFE_API_KEY: KEY, TYPESAFE_BASE_URL: "http://evil.example.com" })).toThrow(/https/);
  });
});

// @vitest-environment node
import { artifactsForInvocation, capabilityForTool, canonicalJson, digest, makeToolInvocation } from "@/agent/tool-contract";

const read = { name: "mcp__files__read_file", description: "读取本地文件", sideEffect: "none" as const };
const write = { name: "mcp__files__write_file", description: "写入本地文件", sideEffect: "local_write" as const };

describe("工具能力契约", () => {
  it("按工具事实推断能力面、权限和默认批准级别", () => {
    expect(capabilityForTool(read)).toMatchObject({ surfaces: ["work"], permissions: ["read"], sideEffect: "none", approval: "none", idempotent: true });
    expect(capabilityForTool(write)).toMatchObject({ surfaces: ["work"], permissions: ["write"], sideEffect: "local_write", approval: "confirm", idempotent: false });
    expect(capabilityForTool({ name: "run_command", description: "执行 shell 测试", sideEffect: "destructive" })).toMatchObject({ surfaces: ["codex"], permissions: ["delete", "execute"], approval: "confirm_twice" });
  });

  it("允许工具显式覆盖推断，但不把摘要当作安全哈希", () => {
    const c = capabilityForTool({ ...write, capability: { surfaces: ["codex"], permissions: ["write"], idempotent: true, roots: ["~/repo"] } });
    expect(c).toMatchObject({ surfaces: ["codex"], permissions: ["write"], idempotent: true, roots: ["~/repo"] });
    expect(canonicalJson({ b: 2, a: 1 })).toBe(canonicalJson({ a: 1, b: 2 }));
    expect(digest({ b: 2, a: 1 })).toBe(digest({ a: 1, b: 2 }));
  });

  it("同一逻辑调用的重试共享幂等键，但调用实例 id 不同", () => {
    const a = makeToolInvocation({ taskId: "task-1", stepId: "s1", attempt: 1, tool: write, args: { path: "out.md", content: "x" } });
    const b = makeToolInvocation({ taskId: "task-1", stepId: "s1", attempt: 2, tool: write, args: { content: "x", path: "out.md" } });
    const c = makeToolInvocation({ taskId: "task-1", stepId: "s1", attempt: 1, tool: write, args: { path: "other.md", content: "x" } });
    expect(a.idempotencyKey).toBe(b.idempotencyKey);
    expect(a.invocationId).not.toBe(b.invocationId);
    expect(a.idempotencyKey).not.toBe(c.idempotencyKey);
  });

  it("从调用参数生成不含正文的产物清单", () => {
    const w = makeToolInvocation({ taskId: "task-1", stepId: "s2", attempt: 1, tool: write, args: { path: "out.md", content: "private" } });
    expect(artifactsForInvocation(w, { path: "out.md", content: "private" }, true)).toEqual([{ kind: "file", action: "modify", path: "out.md", ok: true }]);
    const r = makeToolInvocation({ taskId: "task-1", stepId: "s3", attempt: 1, tool: { name: "run_command", description: "执行命令", sideEffect: "destructive" }, args: { command: "pnpm test" } });
    expect(artifactsForInvocation(r, { command: "pnpm test" }, true)).toEqual([{ kind: "command", action: "execute", command: "pnpm test", ok: true }]);
  });
});

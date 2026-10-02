// 工具注册表（即工具白名单）与带超时的执行器。
import { redact } from "../core/redact";
import type { ToolDef } from "../decision/decision-layer";
import type { Tool } from "./types";

export const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;
export const MAX_TOOL_OUTPUT = 8000;
export const DEFAULT_TOOL_TIMEOUT_MS = 30_000;

export class ToolRegistry {
  readonly #tools = new Map<string, Tool>();

  constructor(tools: readonly Tool[] = []) {
    for (const t of tools) this.register(t);
  }

  register(t: Tool): this {
    if (!TOOL_NAME.test(t.name)) throw new Error(`工具名无效：${t.name}`);
    if (this.#tools.has(t.name)) throw new Error(`工具重名：${t.name}`);
    this.#tools.set(t.name, t);
    return this;
  }

  get(name: string): Tool | undefined {
    return this.#tools.get(name);
  }

  names(): Set<string> {
    return new Set(this.#tools.keys());
  }

  list(): Tool[] {
    return [...this.#tools.values()];
  }

  /** 交给决策层做白名单和权限判断 */
  defs(): ToolDef[] {
    return this.list().map(({ name, description, sideEffect }) => ({ name, description, sideEffect }));
  }
}

export function truncate(s: string, max = MAX_TOOL_OUTPUT): string {
  return s.length > max ? `${s.slice(0, max)}…[已截断，共 ${s.length} 字符]` : s;
}

/** 工具输出是不可信数据：包在标签里交给模型，并防止内容伪造结束标签 */
export function wrapUntrusted(source: string, content: string): string {
  const safe = content.replace(/<\/?tool_output/gi, "‹tool_output");
  const src = source.replace(/[^\w:.-]/g, "_");
  return `<tool_output source="${src}" untrusted="true">\n${safe}\n</tool_output>`;
}

/** 执行工具：超时（即使工具不理会 signal 也会返回）、异常转失败、输出先脱敏再截断 */
export async function executeTool(
  tool: Tool,
  args: Record<string, unknown>,
  signal?: AbortSignal,
  now: () => number = Date.now,
): Promise<{ ok: boolean; content: string; latencyMs: number; structured?: boolean }> {
  const t0 = now();
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  const ms = tool.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_r, reject) => {
    timer = setTimeout(() => {
      ctrl.abort();
      reject(new Error(`工具执行超时（${ms}ms）`));
    }, ms);
  });
  try {
    if (signal?.aborted) throw Object.assign(new Error("已取消"), { name: "AbortError" });
    const out = await Promise.race([tool.run(args, { signal: ctrl.signal }), timeout]);
    // structured：工具给了结构化结果（MCP structuredContent），成功与否以工具自己的标记为准
    return { ok: out.ok === true, content: truncate(redact(String(out.content ?? ""))), latencyMs: now() - t0, ...(out.data !== undefined ? { structured: true } : {}) };
  } catch (e) {
    if (signal?.aborted) throw e;
    return { ok: false, content: truncate(redact(e instanceof Error ? e.message : String(e))), latencyMs: now() - t0 };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

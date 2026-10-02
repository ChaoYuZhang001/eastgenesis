// 从自定义 Provider 的 /models 读取模型列表（经 Rust 代理，用已保存的地址和 Key）。
// OpenAI 与 Anthropic 的列表格式都是 { data: [{ id }] }；少数中转站直接返回数组，也接受。
import { toAppError } from "@/lib/ipc";
import { isValidModelName, type Backend, type CustomProvider } from "@/platform";

/** 列表过长时只取前面这些，避免下拉框卡顿 */
export const MAX_DISCOVERED = 500;

export type DiscoverResult = { ok: true; models: string[] } | { ok: false; message: string };

function parseIds(body: string): string[] | null {
  let v: unknown;
  try {
    v = JSON.parse(body);
  } catch {
    return null;
  }
  const list = Array.isArray(v) ? v : (v as { data?: unknown } | null)?.data;
  if (!Array.isArray(list)) return null;
  return list.map((x) => (x as { id?: unknown } | null)?.id).filter((id): id is string => typeof id === "string");
}

/** 去重、过滤非法模型名并限长；格式认不出时返回空数组 */
export function parseModels(body: string): string[] {
  return [...new Set((parseIds(body) ?? []).map((s) => s.trim()).filter(isValidModelName))].slice(0, MAX_DISCOVERED);
}

// ---- 轻量探测：/models 列出来的不一定调得通（中转站常把没开通渠道的型号也列出来） ----

/** 单个探测的等待上限；超时算「不确定」，不隐藏 */
export const PROBE_TIMEOUT_MS = 20_000;
/** 同时探测的个数：别把中转站打出限流 */
export const PROBE_CONCURRENCY = 4;
/** 一次最多探测这么多个；更多的不探测，照常展示 */
export const MAX_PROBED = 100;

/** ok：调得通；missing：服务明确说没有这个模型（HTTP 404 或 model_not_found）；unknown：其他情况，照常展示 */
export type ProbeState = "ok" | "missing" | "unknown";

export interface ProbeOptions {
  timeoutMs?: number;
  concurrency?: number;
  max?: number;
}

export interface ProbeResult {
  /** 确认不存在的模型：下拉里不展示 */
  unavailable: string[];
  /** 实际探测了多少个 */
  probed: number;
  /** 所有探测都是 404：多半是地址问题，这次结果不作数，不隐藏任何模型 */
  suspicious: boolean;
}

const errorCode = (body: string): string => {
  try {
    const v = JSON.parse(body) as { error?: { code?: unknown; type?: unknown } | null; code?: unknown };
    return String(v.error?.code ?? v.error?.type ?? v.code ?? "");
  } catch {
    return "";
  }
};

/** 发一个最小的对话请求（max_tokens 1）判断模型是否存在；只花一两个 token */
export async function probeModel(
  backend: Backend,
  c: Pick<CustomProvider, "id" | "base_url" | "protocol">,
  model: string,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<ProbeState> {
  const anthropic = c.protocol === "anthropic";
  const req = backend.providerRequest({
    target: c.id,
    method: "POST",
    url: `${c.base_url}${anthropic ? "/messages" : "/chat/completions"}`,
    body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), timeoutMs)));
  try {
    const r = await Promise.race([req, timeout]);
    if (!r) return "unknown";
    if (r.status >= 200 && r.status < 300) return "ok";
    if (r.status === 404 || errorCode(r.body) === "model_not_found") return "missing";
    return "unknown";
  } catch {
    return "unknown";
  } finally {
    clearTimeout(timer);
  }
}

/** 并发受限地探测一组模型，返回确认不存在的那些 */
export async function probeModels(
  backend: Backend,
  c: Pick<CustomProvider, "id" | "base_url" | "protocol">,
  models: readonly string[],
  o: ProbeOptions = {},
): Promise<ProbeResult> {
  const list = models.slice(0, o.max ?? MAX_PROBED);
  const states: ProbeState[] = new Array(list.length);
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const i = next++;
      states[i] = await probeModel(backend, c, list[i], o.timeoutMs);
    }
  };
  await Promise.all(Array.from({ length: Math.min(o.concurrency ?? PROBE_CONCURRENCY, list.length) }, worker));
  const missing = list.filter((_, i) => states[i] === "missing");
  // 全部 404（且不止一个）：更像是对话地址不对，而不是每个模型都不存在
  const suspicious = list.length > 1 && missing.length === list.length;
  return { unavailable: suspicious ? [] : missing, probed: list.length, suspicious };
}

export async function discoverModels(backend: Backend, c: Pick<CustomProvider, "id" | "base_url">): Promise<DiscoverResult> {
  let r;
  try {
    r = await backend.providerRequest({ target: c.id, method: "GET", url: `${c.base_url}/models` });
  } catch (e) {
    return { ok: false, message: toAppError(e).message };
  }
  if (r.status === 401 || r.status === 403) return { ok: false, message: `认证失败（HTTP ${r.status}），请检查 Key` };
  if (r.status === 404) return { ok: false, message: "该服务不提供模型列表（/models 返回 404），请手动填写模型名" };
  if (r.status < 200 || r.status >= 300) return { ok: false, message: `服务返回 HTTP ${r.status}` };
  if (!parseIds(r.body)) return { ok: false, message: "模型列表格式无法识别，请手动填写模型名" };
  const models = parseModels(r.body);
  if (!models.length) return { ok: false, message: "服务没有返回任何模型" };
  return { ok: true, models };
}

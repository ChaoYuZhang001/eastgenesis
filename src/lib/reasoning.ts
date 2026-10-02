// 推理模型的思考过程：从本轮的模型调用事件里取出来。
// 默认不显示（设置里「显示模型思考过程」开关，默认关闭）；打开后也只给用户可理解的摘要：
// 只取回答和总结两类调用，去掉规划、参数生成等内部步骤，去掉系统提示原文、内部指令和英文推理。
import type { AgentEvent, LlmPurpose } from "@/agent";

export interface ReasoningPart {
  /** 哪一次调用的思考：「回答」「总结」 */
  label: string;
  text: string;
}

/** 只有这两类调用的思考和用户的问题直接相关；规划、改步骤、生成参数都是内部步骤 */
const SHOWN: ReadonlySet<LlmPurpose> = new Set(["answer", "summary"]);
const LABEL: Partial<Record<LlmPurpose, string>> = { answer: "回答", summary: "总结" };
/** 摘要最多保留多少字 */
export const DIGEST_MAX = 600;

// 内部指令和系统提示的痕迹：命中的行整行丢掉
const INTERNAL = [
  /你是\s*EastGenesis/i,
  /system\s*prompt|系统提示/i,
  /<\/?tool_output|untrusted/i,
  /JSON|schema|\{\s*"|"steps"|"tool"|"args"/i,
  /只输出|输出格式|按.{0,8}格式输出|不要输出/,
  /规划器|规划步骤|步骤\s*\d+|^\s*(?:step|s)\d+\b/i,
  /<\/?[a-z_]+>/i,
];
const CJK = /[㐀-鿿]/g;
const LATIN = /[A-Za-z]/g;

/** 一行以英文为主（拉丁字母多于汉字）就算英文推理 */
function mostlyEnglish(line: string): boolean {
  const cjk = line.match(CJK)?.length ?? 0;
  const latin = line.match(LATIN)?.length ?? 0;
  return latin > 0 && latin >= cjk * 2;
}

/** 把一段原始思考整理成给用户看的摘要；没有可展示的内容时返回空串 */
export function digestReasoning(raw: string): string {
  const kept = raw
    .split(/\n+/)
    .map((l) => l.trim())
    .filter((l) => l && !mostlyEnglish(l) && !INTERNAL.some((r) => r.test(l)));
  const text = kept.join("\n");
  return text.length > DIGEST_MAX ? `${text.slice(0, DIGEST_MAX)}…` : text;
}

export function reasoningParts(events: readonly AgentEvent[]): ReasoningPart[] {
  const out: ReasoningPart[] = [];
  for (const e of events) {
    if (e.type !== "llm" || !e.reasoning?.trim() || !SHOWN.has(e.purpose)) continue;
    const text = digestReasoning(e.reasoning);
    // 整理后没剩下可读内容（全是内部推理）就不展示，折叠行也不出现
    if (text) out.push({ label: LABEL[e.purpose] ?? "回答", text });
  }
  return out;
}

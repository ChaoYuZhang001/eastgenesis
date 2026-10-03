// 记忆条目的校验与「记住」提议。桌面端（db-memory.ts）和浏览器模式（mock-memory.ts）共用同一套规则。
// 只有用户确认过的内容才会成为记忆：工具和 MCP 的输出不会自动写入，注入的指令也就变不成长期指令。
import { redact } from "@/core/redact";
import { PROJECT_ID } from "@/decision/project";
import type { AppError } from "./ipc";
import type { MemoryInput, MemoryKind } from "@/platform/types";

export const MEMORY_KINDS: readonly MemoryKind[] = ["preference", "fact"];
export const KIND_LABEL: Record<MemoryKind, string> = { preference: "偏好", fact: "事实" };
export const MAX_MEMORY_TEXT = 500;
export const MAX_MEMORIES = 200;
export const MEMORY_ID = /^mem-[a-z0-9-]{1,48}$/;

const fail = (code: string, message: string): AppError => ({ code, message, detail: null });
export const memoryNotFound = () => fail("memory_not_found", "没有找到这条记忆");
export const memoryFull = () => fail("memory_full", `最多保存 ${MAX_MEMORIES} 条记忆，请先删除一些`);
export const invalidMemoryId = () => fail("invalid_memory_id", "记忆 ID 无效");

/** 规整并校验；不回显内容（用户可能误粘贴了密钥）。project_id 只校验格式，项目是否存在由存储层查 */
export function normalizeMemory(m: MemoryInput): { kind: MemoryKind; text: string; source: "manual" | "task"; project_id: string | null } {
  if (!MEMORY_KINDS.includes(m.kind)) throw fail("invalid_memory", "记忆类型只能是偏好或事实");
  const text = String(m.text ?? "").replace(/\s+/g, " ").trim();
  if (!text) throw fail("invalid_memory", "记忆内容不能为空");
  if (text.length > MAX_MEMORY_TEXT) throw fail("invalid_memory", `记忆内容最多 ${MAX_MEMORY_TEXT} 个字符`);
  if (redact(text) !== text) throw fail("invalid_memory", "内容看起来包含密钥或令牌，不能保存为记忆");
  const project_id = m.project_id ?? null;
  if (project_id !== null && !PROJECT_ID.test(project_id)) throw fail("invalid_project_id", "项目 ID 无效");
  return { kind: m.kind, text, source: m.source === "task" ? "task" : "manual", project_id };
}

export function newMemoryId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (typeof c?.randomUUID === "function") return `mem-${c.randomUUID()}`;
  return `mem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export interface MemoryProposal {
  kind: MemoryKind;
  text: string;
}

// 明确要求记住（「记住」「记着」、句首的「remember that」）；「记住了」「remember to …」不算
const REMEMBER = /(?:请?记住(?!了)|记着)[：:，,\s]*(.+)|(?:^|[.!?。！？\n]\s*|please\s+)remember(?!\s+to\b)(?:\s+that)?[\s:,]+(.+)/is;
// 长期指令（「以后都」「今后请」「从现在起」「from now on」）
const STANDING = /(?:以后|今后)(?:都|请|一律|总是|统一)|从现在起[，,]?|\bfrom now on[,\s]*/i;
// 句首直接陈述偏好：「我偏好简洁输出」「我喜欢先看结论」「I prefer short answers」
const PREFER = /^\s*(?:我|本人)(?:比较|更|一般)?(?:偏好|喜欢|习惯|倾向于?)\s*\S|^\s*I\s+(?:prefer|like)\s+\S/i;
const PREF_CUE = /喜欢|偏好|总是|始终|一律|不要|别|以后|今后|默认|习惯|prefer|always|never|don't|do not/i;
// 句号、换行，或「，然后 / 再 / 帮我 …」之后是这次任务本身，不是要记住的内容
const CLAUSE_END = /[。！？!?\n]|[；;]|[，,]\s*(?:然后|再|并且|接着|顺便|另外|帮我|请你|then\b|please\b)|\.\s/i;

function firstClause(s: string): string {
  const m = s.match(CLAUSE_END);
  return (m ? s.slice(0, m.index) : s).replace(/^[\s：:，,"“]+|[\s。.，,"”]+$/g, "");
}

// 称呼：「叫我小王」「你可以称呼我老李」「Call me Alex」；「帮我叫我妈」前面是汉字，不算
const ADDRESS = /(?:^|[\s，,。.！!？?：:；;]|请|可以|就|以后|今后)(?:叫我|称呼我)[：:，,\s]*([^\s，,。.！!？?；;]{1,20})|\b[Cc]all me ([A-Z][\w-]{0,30})/;
const ADDRESS_TAIL = /(?:就行了?|就好|就可以了?|吧|即可|吗|呢|啊)$/;

/** 目标里明确要求记住某件事时，给出一条待确认的记忆；只有用户点「记住」才会保存 */
export function proposeMemory(goal: string): MemoryProposal | null {
  const r = goal.match(REMEMBER);
  const a = r ? null : goal.match(ADDRESS);
  let text: string;
  let kind: MemoryKind;
  if (r) {
    text = firstClause(r[1] ?? r[2] ?? "");
    kind = PREF_CUE.test(text) ? "preference" : "fact";
  } else if (a) {
    const name = (a[1] ?? "").replace(ADDRESS_TAIL, "");
    text = a[2] ? `Call me ${a[2]}` : name ? `称呼我${name}` : "";
    kind = "preference";
  } else if (PREFER.test(goal)) {
    text = firstClause(goal.trim());
    kind = "preference";
  } else {
    const s = goal.match(STANDING);
    if (!s || s.index === undefined) return null;
    text = firstClause(goal.slice(s.index + s[0].length));
    kind = "preference";
  }
  if (text.length < 3 || text.length > MAX_MEMORY_TEXT || redact(text) !== text) return null;
  return { kind, text };
}

// 回答对齐问题时常见的说法：称呼、风格、边界
const ALIGN_CUE = /叫我|称呼|简洁|简短|详细|啰嗦|直接|风格|别碰|不要碰|不许|不要动|不要删|禁止|不能碰|目录|文件夹|concise|brief|detailed|don't touch|never touch/i;

/** 第一次对话问过称呼、风格和边界后，用户的下一句回答整句作为一条待确认的偏好 */
export function proposeAlignment(reply: string): MemoryProposal | null {
  const direct = proposeMemory(reply);
  if (direct) return direct;
  const text = reply.replace(/\s+/g, " ").trim();
  if (text.length < 3 || text.length > 200 || !ALIGN_CUE.test(text) || redact(text) !== text) return null;
  return { kind: "preference", text };
}

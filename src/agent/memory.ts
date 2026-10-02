// 记忆进入提示词：任务开始时按目标挑出相关的几条，作为用户确认过的长期信息放进系统提示。
// 偏好总是带上（最多 8 条，最近更新的优先）；事实按与目标的词重叠挑选（最多 5 条）。不用向量检索。
import { truncate } from "./tools";

export interface MemoryNote {
  id: string;
  kind: "preference" | "fact";
  text: string;
  updated_at: number;
}

export const MAX_MEMORY_PREFERENCES = 8;
export const MAX_MEMORY_FACTS = 5;

// 常见的虚词二元组，不参与匹配
const STOP = new Set(["一下", "我们", "你们", "这个", "那个", "什么", "怎么", "帮我", "请你", "可以", "需要", "的时", "一个", "进行", "然后", "我的", "你的", "就是", "如果", "因为", "所以"]);
const CJK = /[㐀-鿿豈-﫿]+/g;
const WORD = /[a-z0-9][a-z0-9+#._-]*/g;

/** 英文、数字按词，中文按相邻两字 */
export function memoryTokens(s: string): Set<string> {
  const out = new Set<string>();
  const lower = s.toLowerCase();
  for (const w of lower.match(WORD) ?? []) if (w.length >= 2) out.add(w);
  for (const run of lower.match(CJK) ?? []) {
    for (let i = 0; i + 1 < run.length; i++) {
      const b = run.slice(i, i + 2);
      if (!STOP.has(b)) out.add(b);
    }
  }
  return out;
}

export function selectMemories<T extends MemoryNote>(notes: readonly T[], goal: string): T[] {
  const recent = [...notes].sort((a, b) => b.updated_at - a.updated_at);
  const prefs = recent.filter((n) => n.kind === "preference").slice(0, MAX_MEMORY_PREFERENCES);
  const g = memoryTokens(goal);
  const facts = recent
    .filter((n) => n.kind === "fact")
    .map((n) => ({ n, score: [...memoryTokens(n.text)].filter((t) => g.has(t)).length }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_MEMORY_FACTS)
    .map((x) => x.n);
  return [...prefs, ...facts];
}

/** 系统提示里的记忆段；没有记忆时为空串 */
export function memoryBlock(notes: readonly Pick<MemoryNote, "kind" | "text">[]): string {
  if (notes.length === 0) return "";
  const line = (n: Pick<MemoryNote, "text">) => `- ${truncate(n.text.replace(/\s+/g, " "), 500)}`;
  const prefs = notes.filter((n) => n.kind === "preference").map(line);
  const facts = notes.filter((n) => n.kind === "fact").map(line);
  return [
    "以下是用户确认过的长期记忆，与当前目标冲突时以当前目标为准：",
    ...(prefs.length ? ["偏好：", ...prefs] : []),
    ...(facts.length ? ["事实：", ...facts] : []),
  ].join("\n");
}

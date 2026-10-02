// 由各能力的概率拼出任务分类。云端 Jev 和本地决策模型共用；long_context、zh 由代码确定，不问模型。
import { LONG_CONTEXT_CHARS, detectLang, estimateTokens } from "./rules";
import { HARD_CAPS, TYPE_PRIORITY, sortCaps, typeFromCapabilities, type Capability, type Classification, type TaskInput, type TaskType } from "./types";

/** 这项判断会不会改变结果：硬性能力（决定哪些模型有资格）或能抢到主类型的能力才算；主类型已定后优先级更低的软性能力不算 */
function decisive(key: string, type: TaskType): boolean {
  return HARD_CAPS.includes(key as Capability) || type === "qa" || TYPE_PRIORITY.indexOf(key as never) <= TYPE_PRIORITY.indexOf(type as never);
}

/** probs：能力 → 需要它的概率（0–1）；label 写进 signals。confidence 只取会改变结果的判断里最含糊的一项（官方指引：忽略未用分支的不确定性） */
export function classificationFromProbs(input: TaskInput, probs: Record<string, number>, label: string): Classification {
  const atts = input.attachments ?? [];
  const caps = new Set<Capability>();
  const signals: string[] = [];
  for (const [k, p] of Object.entries(probs)) {
    signals.push(`${label} ${k} p=${p.toFixed(2)}`);
    if (p >= 0.5) caps.add(k as Capability);
  }
  const lang = detectLang(input.text);
  const chars = input.text.length + atts.reduce((s, a) => s + (a.kind === "image" ? 0 : (a.chars ?? 0)), 0);
  if (chars > LONG_CONTEXT_CHARS) {
    caps.add("long_context");
    signals.push(`附件与正文共 ${chars} 字符，超过 ${LONG_CONTEXT_CHARS}`);
  }
  if (lang !== "en") caps.add("zh");
  const capabilities = sortCaps(caps);
  const type = typeFromCapabilities(capabilities);
  let confidence = 1;
  for (const [k, p] of Object.entries(probs)) if (decisive(k, type)) confidence = Math.min(confidence, Math.abs(2 * p - 1));
  return { type, capabilities, lang, estTokens: estimateTokens(input), confidence, signals };
}

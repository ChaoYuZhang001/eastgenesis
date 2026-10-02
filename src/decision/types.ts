// 决策层共享类型。纯 TS，不依赖 DOM / Tauri，桌面端与 CLI 共用。

export type TaskType = "qa" | "code" | "reasoning" | "vision" | "long_context" | "tool_use";
export type Capability = "code" | "long_context" | "reasoning" | "tool_use" | "vision" | "zh";
export type Lang = "zh" | "en" | "mixed";

export const TASK_TYPES: readonly TaskType[] = ["qa", "code", "reasoning", "vision", "long_context", "tool_use"];
export const CAPABILITIES: readonly Capability[] = ["code", "long_context", "reasoning", "tool_use", "vision", "zh"];

/** 主类型 = 所含能力中优先级最高的一个；都没有时为 qa */
export const TYPE_PRIORITY: readonly Exclude<TaskType, "qa">[] = ["vision", "long_context", "tool_use", "code", "reasoning"];

/** 硬性能力：决定哪些模型有资格；软性能力只影响评分 */
export const HARD_CAPS: readonly Capability[] = ["vision", "long_context", "tool_use"];
export const SOFT_CAPS: readonly Capability[] = ["code", "reasoning", "zh"];

export const TYPE_LABEL: Record<TaskType, string> = {
  qa: "通用问答",
  code: "代码",
  reasoning: "推理",
  vision: "视觉",
  long_context: "长文本",
  tool_use: "工具调用",
};

export const CAP_LABEL: Record<Capability, string> = {
  code: "代码",
  long_context: "长上下文",
  reasoning: "推理",
  tool_use: "工具调用",
  vision: "视觉",
  zh: "中文",
};

export interface Attachment {
  kind: "image" | "text" | "code" | "pdf";
  name?: string;
  /** text / code / pdf 的字符数；image 不填 */
  chars?: number;
}

export interface TaskInput {
  text: string;
  attachments?: Attachment[];
}

export interface Classification {
  type: TaskType;
  /** 按字母序排列 */
  capabilities: Capability[];
  lang: Lang;
  /** 估算的输入 token 数（正文 + 附件），用于上下文窗口过滤 */
  estTokens: number;
  confidence: number;
  /** 命中的信号，供路由面板展示 */
  signals: string[];
}

export function typeFromCapabilities(caps: readonly Capability[]): TaskType {
  return TYPE_PRIORITY.find((t) => caps.includes(t)) ?? "qa";
}

export function sortCaps(caps: Iterable<Capability>): Capability[] {
  return [...new Set(caps)].sort();
}

/** config/model_profiles.json 的条目 */
export interface ModelProfile {
  /** `${provider}/${模型名}` */
  id: string;
  provider: string;
  capabilities: Capability[];
  /** 1（最便宜）– 5（最贵） */
  cost_tier: number;
  /** 1 – 5（最强） */
  quality_tier: number;
  /** 1（最快）– 5（最慢） */
  latency_tier: number;
  context_window: number;
  enabled: boolean;
  is_custom: boolean;
}

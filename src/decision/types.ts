// 决策层共享类型。纯 TS，不依赖 DOM / Tauri，桌面端与 CLI 共用。

export type TaskType = "qa" | "code" | "reasoning" | "vision" | "long_context" | "tool_use";
export type Capability = "code" | "long_context" | "reasoning" | "tool_use" | "vision" | "zh";
export type Lang = "zh" | "en" | "mixed";

/**
 * 统一工作台里的能力面。
 *
 * 这不是一个需要用户手动切换的产品模式：同一个 Goal 可以在不同步骤
 * 依次使用 Chat、Work 和 Codex。它只描述当前任务需要哪一类桌面能力，
 * 供路由、权限和结果展示使用。
 */
export type WorkSurface = "chat" | "work" | "codex";
export const WORK_SURFACES: readonly WorkSurface[] = ["chat", "work", "codex"];
export const WORK_SURFACE_LABEL: Record<WorkSurface, string> = {
  chat: "Chat 对话",
  work: "Work 工作",
  codex: "Codex 开发",
};
export const WORK_SURFACE_HINT: Record<WorkSurface, string> = {
  chat: "对话、问答和轻量分析",
  work: "研究、文件和交付物",
  codex: "代码、终端和仓库操作",
};

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
  /** 可选的显式提示；普通用户不需要填写，统一工作台默认自动推断。 */
  surfaceHint?: WorkSurface;
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
  /** 统一工作台的能力面；旧记录没有此字段时按 chat 兼容。 */
  surface?: WorkSurface;
  surfaceReason?: string;
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

// LLMProvider 接口：与具体厂商无关。决策层（Jev）和 Agent 运行时只依赖这里的类型。
// 本目录不依赖 DOM、Tauri 或 React，桌面端和 CLI 共用。

export type Role = "system" | "user" | "assistant";

export interface ChatMessage {
  role: Role;
  content: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export type FinishReason = "stop" | "length" | "error" | "other";

export interface ChatResponse {
  providerId: string;
  model: string;
  text: string;
  usage: Usage | null;
  finishReason: FinishReason;
  /** 从发出请求到拿到完整响应的毫秒数，路由面板要展示 */
  latencyMs: number;
  /**
   * 推理模型单独返回的思考过程（DeepSeek 等兼容端点的 reasoning_content / reasoning 字段）。
   * 不计入 text：不进下一轮上下文，界面默认折叠。没有时不带
   */
  reasoning?: string;
}

/** 思考过程最多保留的字符数：超长的截断，避免事件流和界面被撑大 */
export const MAX_REASONING_CHARS = 20_000;

export type StreamEvent =
  | { type: "delta"; text: string }
  | { type: "done"; response: ChatResponse };

export type ProviderKind = "openai" | "anthropic" | "openai-compatible";

export interface ProviderCapabilities {
  streaming: boolean;
  systemPrompt: boolean;
}

export interface LLMProvider {
  /** 实例 ID，例如 "openai"、"custom:my-relay" */
  readonly id: string;
  readonly kind: ProviderKind;
  readonly label: string;
  readonly capabilities: ProviderCapabilities;
  chat(req: ChatRequest): Promise<ChatResponse>;
  stream(req: ChatRequest): AsyncIterable<StreamEvent>;
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface ProviderConfig {
  id: string;
  kind: ProviderKind;
  label?: string;
  /** 省略时用官方地址；openai-compatible 必填 */
  baseUrl?: string;
  /** 密钥引用而非密钥本身，例如 "env:OPENAI_API_KEY"。省略只允许本机地址（Ollama） */
  apiKeyRef?: string;
  defaultModel?: string;
  /** 附加请求头（中转站常用），不允许覆盖鉴权头 */
  headers?: Record<string, string>;
  timeoutMs?: number;
}

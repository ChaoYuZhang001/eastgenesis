import { redact } from "../redact";

// Provider 错误码。retryable 供 M3 的降级逻辑使用。
export type ProviderErrorCode =
  | "auth"
  | "rate_limit"
  | "timeout"
  | "network"
  | "bad_request"
  | "not_found"
  | "server"
  | "billing"
  | "invalid_response"
  | "aborted"
  | "config";

const RETRYABLE: ReadonlySet<ProviderErrorCode> = new Set(["rate_limit", "timeout", "network", "server"]);

/** 每个错误码给用户看的说明；降级链的失败记录也用它，不直接显示错误码 */
export const PROVIDER_ERROR_TEXT: Readonly<Record<ProviderErrorCode, string>> = {
  auth: "鉴权失败，请检查 API Key",
  rate_limit: "请求过于频繁或额度不足",
  timeout: "请求超时",
  network: "网络连接失败",
  bad_request: "请求参数有误",
  not_found: "接口或模型不存在",
  server: "服务端错误",
  billing: "Provider 额度或计费状态不可用",
  invalid_response: "响应格式无法解析",
  aborted: "请求已取消",
  config: "Provider 配置有误",
};

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly providerId: string;
  readonly status: number | null;
  readonly detail: string | null;
  /** 流式正文已经发给用户后才失败；此时不能静默拼接另一个模型的输出。 */
  readonly partialOutput: boolean;

  constructor(
    code: ProviderErrorCode,
    providerId: string,
    opts: { status?: number; detail?: string; message?: string; partialOutput?: boolean; secrets?: readonly string[] } = {},
  ) {
    super(opts.message ?? PROVIDER_ERROR_TEXT[code]);
    this.name = "ProviderError";
    this.code = code;
    this.providerId = providerId;
    this.status = opts.status ?? null;
    // 细节可能包含服务端回显的请求内容，统一脱敏并截断
    this.detail = opts.detail ? redact(opts.detail, opts.secrets ?? []).slice(0, 500) : null;
    this.partialOutput = opts.partialOutput === true;
  }

  get retryable(): boolean {
    return RETRYABLE.has(this.code);
  }

  /** 转为 IPC 统一错误结构 */
  toAppError() {
    return { code: `provider_${this.code}`, message: this.message, detail: this.detail };
  }
}

export function codeFromStatus(status: number): ProviderErrorCode {
  if (status === 401 || status === 403) return "auth";
  if (status === 402) return "billing";
  if (status === 429) return "rate_limit";
  if (status === 404) return "not_found";
  if (status === 408 || status === 504) return "timeout";
  if (status >= 500) return "server";
  return "bad_request";
}

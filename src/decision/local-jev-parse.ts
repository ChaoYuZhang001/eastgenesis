// 本地决策模型的输入整理与输出解析。解析失败抛 JevError("invalid_response")，降级链据此交给下一级。
import type { ProviderErrorCode } from "../core/llm/errors";
import { redact } from "../core/redact";
import { JevError, type JevErrorCode } from "./jev-client";

export const LOCAL_CONFIDENCE_CAP = 0.8;
const MAX_FIELD = 4000;

export const CODE_MAP: Record<ProviderErrorCode, JevErrorCode> = {
  auth: "auth",
  rate_limit: "rate_limit",
  timeout: "timeout",
  network: "network",
  bad_request: "bad_request",
  // 模型没拉取、地址写错：要用户处理，停用到用户在设置页重新选择或改了 Provider 配置为止
  not_found: "config",
  server: "server",
  billing: "config",
  invalid_response: "invalid_response",
  response_too_large: "invalid_response",
  aborted: "aborted",
  config: "config",
};

const bad = (message: string) => new JevError("invalid_response", { message });

const clip = (s: string) => {
  const t = redact(s);
  return t.length > MAX_FIELD ? `${t.slice(0, MAX_FIELD)}…[已截断]` : t;
};

/** 每个字段一个 <data>，脱敏、截断，并去掉内容里伪造的 data 标签 */
export const dataBlock = (fields: Record<string, string>) =>
  Object.entries(fields)
    .map(([k, v]) => `<data name="${k}" untrusted="true">\n${clip(v).replace(/<\/?data\b/gi, "‹data")}\n</data>`)
    .join("\n");

/** 去掉推理模型的思考段（含没写完的），取第一个 { 到最后一个 } */
export function parseDecision(raw: string): Record<string, unknown> {
  const text = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/<think>[\s\S]*$/i, "");
  const s = text.indexOf("{");
  const e = text.lastIndexOf("}");
  try {
    const v: unknown = s >= 0 && e > s ? JSON.parse(text.slice(s, e + 1)) : null;
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    // 统一在下面报错
  }
  throw bad("本地决策模型的输出不是约定的 JSON");
}

/** 小模型常把数字写成字符串 */
const num = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? Number(v) : v);

export function prob(v: unknown): number {
  const n = num(v);
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > 1) throw bad("本地决策模型给出的概率不在 0–1 之间");
  return n;
}

export function level(v: unknown, max: number): number {
  const n = num(v);
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > max) throw bad(`本地决策模型给出的等级不在 0–${max} 之间`);
  return n;
}

/** 自报置信度：没给按 0.5，最多 0.8 */
export function selfConf(v: unknown): number {
  const n = num(v);
  return Math.min(LOCAL_CONFIDENCE_CAP, typeof n === "number" && Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.5);
}

/** 概率离 0.5 越远越确定 */
export const sure = (p: number) => Math.min(LOCAL_CONFIDENCE_CAP, Math.abs(2 * p - 1));

/** Qwen3 默认先长篇推理；决策只要结论，用它的开关关掉思考 */
export const noThink = (id: string) => (/qwen3/i.test(id) ? "\n/no_think" : "");

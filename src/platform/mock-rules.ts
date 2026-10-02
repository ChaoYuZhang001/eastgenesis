// 浏览器模式下的校验规则，对齐 crates/eg-core 的 secrets.rs / providers.rs。
// 真实环境以 Rust 侧为准；这里只保证 UI 在两种模式下拿到同样的错误码和提示。
import { OFFICIAL_ENDPOINTS, OFFICIAL_IDS } from "@/core/llm/official";
import type { AppError } from "@/lib/ipc";
import { MAX_CUSTOM_MODELS, isValidModelName as validModel, type CustomProvider } from "./types";

export const OFFICIAL_PROVIDERS = OFFICIAL_IDS;
export const CUSTOM_ID = /^custom:[a-z0-9][a-z0-9_-]{0,63}$/;
export const OPENAI_PATHS = ["/chat/completions", "/models"];
export const ANTHROPIC_PATHS = ["/messages", "/models"];
export const JEV_PATHS = ["/v1/systemone", "/v1/models"];
/** 对齐 providers.rs 的 target_for：每个官方目标允许的 base URL（按地域可能有多个）和路径 */
export const OFFICIAL_BASE: Record<string, { bases: string[]; paths: string[] }> = {
  jev: { bases: ["https://api.typesafe.ai"], paths: JEV_PATHS },
  ...Object.fromEntries(
    OFFICIAL_ENDPOINTS.map((e) => [e.id, { bases: e.regions.map((r) => r.baseUrl), paths: e.dialect === "anthropic" ? ANTHROPIC_PATHS : OPENAI_PATHS }]),
  ),
};

const RESERVED = ["authorization", "x-api-key", "anthropic-version", "content-type", "content-length", "host", "cookie", "accept", "connection", "transfer-encoding"];
const SECRET_LIKE = ["token", "key", "secret", "auth", "cookie", "password", "session", "signature"];
const LOCAL = new Set(["localhost", "127.0.0.1", "[::1]"]);

export const err = (code: string, message: string): AppError => ({ code, message, detail: null });

export function validateProviderId(id: string): void {
  if (!(OFFICIAL_PROVIDERS as readonly string[]).includes(id) && !CUSTOM_ID.test(id)) {
    throw err("invalid_provider", "未知的 Provider");
  }
}

export function validateKey(key: string): string {
  const k = key.trim();
  if (k.length < 8 || k.length > 512 || /[\s\p{Cc}]/u.test(k)) {
    throw err("invalid_key", "API Key 格式无效（8–512 个字符，不能包含空白或控制字符）");
  }
  return k;
}

export function isLocalUrl(url: string): boolean {
  try {
    return LOCAL.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** https；本机地址允许 http；不带账号、查询参数、锚点；规整为小写主机、去掉默认端口和末尾斜杠 */
export function validateBaseUrl(raw: string): string {
  const bad = (m: string) => err("invalid_base_url", `baseUrl 无效：${m}`);
  const s = raw.trim();
  if (!s || s.length > 2048 || /[\s\p{Cc}]/u.test(s)) throw bad("包含空白或过长");
  if (/[?#\\%]/.test(s)) throw bad("不能带查询参数、锚点或编码字符");
  // URL 解析会自动消掉 . 和 ..，所以在原始字符串上检查
  const afterScheme = s.includes("://") ? s.slice(s.indexOf("://") + 3) : "";
  if (afterScheme.includes("//") || /\/\.{1,2}(?:\/|$)/.test(afterScheme)) throw bad("路径不能包含 . 、.. 或连续的 /");
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw bad("缺少协议");
  }
  if (u.username || u.password) throw bad("不能包含账号或密码");
  const local = LOCAL.has(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) throw bad("必须使用 https（本机地址除外）");
  return `${u.protocol}//${u.host}${u.pathname}`.replace(/\/+$/, "");
}

export function validateCustom(p: CustomProvider): CustomProvider {
  const bad = (m: string) => err("invalid_provider_config", m);
  if (!CUSTOM_ID.test(p.id)) throw bad("ID 应为 custom:<名称>，名称由小写字母、数字、_ 或 - 组成");
  const label = p.label.trim();
  if (!label || [...label].length > 64) throw bad("名称应为 1–64 个字符");
  const model = p.default_model.trim();
  if (!validModel(model)) throw bad("默认模型名无效");
  const models = [model];
  for (const m of (p.models ?? []).map((x) => x.trim()).filter(Boolean)) {
    if (!validModel(m)) throw bad("模型名无效：不能含空白或控制字符，最长 128 个字符");
    if (!models.includes(m)) models.push(m);
  }
  if (models.length > MAX_CUSTOM_MODELS) throw bad("每个自定义 Provider 最多登记 32 个模型");
  const protocol = p.protocol ?? "openai";
  if (protocol !== "openai" && protocol !== "anthropic") throw bad("协议只能是 openai 或 anthropic");
  const base_url = validateBaseUrl(p.base_url);
  const entries = Object.entries(p.headers ?? {});
  if (entries.length > 16) throw bad("附加请求头最多 16 个");
  const headers: Record<string, string> = {};
  for (const [rawK, v] of entries) {
    const k = rawK.trim().toLowerCase();
    if (!k || k.length > 64 || !/^[a-z0-9-]+$/.test(k)) throw bad("请求头名称无效");
    if (RESERVED.includes(k)) throw bad("不能覆盖保留的请求头");
    if (SECRET_LIKE.some((s) => k.includes(s))) throw bad("看起来是凭据的请求头请改用 API Key 字段（附加请求头以明文保存）");
    if (v.length > 512 || /\p{Cc}/u.test(v)) throw bad("请求头的值无效");
    headers[k] = v.trim();
  }
  return { id: p.id, label, base_url, default_model: model, headers, protocol, models };
}

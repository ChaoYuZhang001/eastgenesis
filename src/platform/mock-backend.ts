// 浏览器模式（pnpm dev:web、单元测试）的内存后端。行为对齐 Rust 侧命令，但：
// - 不保存 Key：只记录「已配置」这一位，传进来的 Key 校验后立即丢弃；
// - 不发网络请求：模型和 Jev 请求返回模拟响应；
// - MCP 进程换成内存里的登记表和回显服务器（mock-mcp.ts）。
import type { AppError } from "@/lib/ipc";
import { assertSettingKey } from "@/lib/db";
import { mockReply, type MockChatMessage } from "./mock-llm";
import { createMockMcp } from "./mock-mcp";
import { createMockGoals } from "./mock-goal";
import { createMockMemoryStore } from "./mock-memory";
import { createMockProjects } from "./mock-project";
import { createMockSkills } from "./mock-skill";
import { ANTHROPIC_PATHS, CUSTOM_ID, OFFICIAL_BASE, OFFICIAL_PROVIDERS, OPENAI_PATHS, err, isLocalUrl, validateCustom, validateKey, validateProviderId } from "./mock-rules";
import type { Backend, CustomProvider, KeyStatus, ProxyRequest, ProxyResponse } from "./types";

export interface MockOptions {
  /** 前 N 次 init 失败（演示启动页的错误态） */
  failInit?: number;
  /** 所有模型请求返回 503（演示降级） */
  failRequests?: boolean;
  /** 模拟初始化耗时，默认 0：启动页不人为延长 */
  initDelayMs?: number;
  /** 初始已配置的 Provider，默认 openai、anthropic */
  configured?: string[];
  /** Jev 是否已配置，默认否（走规则引擎） */
  jevConfigured?: boolean;
  /** /models 返回的模型，默认 mock-model、gpt-5.6-luna */
  listModels?: string[];
  /** 对话请求返回 404 的模型（演示中转站列出来但调不通的型号） */
  missingModels?: string[];
}

const json = (status: number, body: unknown): ProxyResponse => ({ status, body: JSON.stringify(body) });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createMockBackend(o: MockOptions = {}): Backend {
  let initFailures = o.failInit ?? 0;
  const configured = new Set(o.configured ?? ["openai", "anthropic"]);
  let jev = o.jevConfigured ?? false;
  const custom = new Map<string, CustomProvider>();
  const settings = new Map<string, string>();
  // 项目、目标、记忆互相引用：目标和记忆挂到项目下之前查项目还在；删除项目时连带删除目标和记忆
  const alive = (id: string) => projects.alive(id);
  const memory = createMockMemoryStore(Date.now, alive);
  const goals = createMockGoals(Date.now, alive);
  const projects = createMockProjects(Date.now, {
    usage: (id) => ({ goals: goals.countByProject(id), memories: memory.countByProject(id) }),
    remove: (id) => {
      memory.removeByProject(id);
      goals.removeByProject(id);
    },
  });

  const status = (id: string): KeyStatus => {
    if (id === "ollama") return { id, configured: true, source: "none", needs_key: false };
    const on = configured.has(id);
    return { id, configured: on, source: on ? "keychain" : "none", needs_key: true };
  };
  const jevStatus = (): KeyStatus => ({ id: "jev", configured: jev, source: jev ? "keychain" : "none", needs_key: true });

  function chat(target: string, path: string, body: string | null | undefined): ProxyResponse {
    if (o.failRequests) return json(503, { error: { message: "（模拟）服务暂时不可用" } });
    // 模型列表：OpenAI 与 Anthropic 的 /models 都是 { data: [{ id }] }；带一个和官方同名的型号，演示能力参照
    if (path === "/models") return json(200, { data: (o.listModels ?? ["mock-model", "gpt-5.6-luna"]).map((id) => ({ id })) });
    let req: { model?: string; messages?: MockChatMessage[]; system?: string };
    try {
      req = JSON.parse(body ?? "{}");
    } catch {
      return json(400, { error: { message: "请求体不是合法 JSON" } });
    }
    if (req.model && o.missingModels?.includes(req.model)) {
      return json(404, { error: { message: `（模拟）模型 ${req.model} 不存在`, code: "model_not_found" } });
    }
    const messages = [...(req.system ? [{ role: "system", content: req.system }] : []), ...(req.messages ?? [])];
    const text = mockReply(messages);
    const inTok = Math.ceil(JSON.stringify(messages).length / 4);
    const outTok = Math.ceil(text.length / 2);
    if (target === "anthropic" || custom.get(target)?.protocol === "anthropic") {
      return json(200, { id: "msg_mock", model: req.model, content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: inTok, output_tokens: outTok } });
    }
    return json(200, {
      id: "chatcmpl_mock",
      model: req.model,
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
      usage: { prompt_tokens: inTok, completion_tokens: outTok },
    });
  }

  async function providerRequest(req: ProxyRequest): Promise<ProxyResponse> {
    if (req.method !== "GET" && req.method !== "POST") throw err("proxy_method", "只允许 GET 和 POST");
    let bases: string[];
    let paths: string[];
    let keyOk: boolean;
    // 不用 Object.hasOwn：Safari 15.4 之前没有；也不用 in，否则 "constructor" 之类的原型属性会被当成目标
    if (Object.prototype.hasOwnProperty.call(OFFICIAL_BASE, req.target)) {
      ({ bases, paths } = OFFICIAL_BASE[req.target]);
      // Ollama 是本机服务，不需要 Key
      keyOk = req.target === "jev" ? jev : req.target === "ollama" || configured.has(req.target);
    } else if (CUSTOM_ID.test(req.target)) {
      const c = custom.get(req.target);
      if (!c) throw err("provider_not_found", "没有找到这个自定义 Provider");
      bases = [c.base_url];
      paths = c.protocol === "anthropic" ? ANTHROPIC_PATHS : OPENAI_PATHS;
      keyOk = configured.has(c.id) || isLocalUrl(c.base_url);
    } else {
      throw err("proxy_unsupported", "未知的 Provider");
    }
    const path = paths.find((p) => bases.some((b) => req.url === b + p));
    if (!path) throw err("proxy_url_not_allowed", "请求地址不在该 Provider 的允许列表内");
    if (req.method === "GET" && req.body) throw err("proxy_body", "GET 请求不能带请求体");
    if (!keyOk) throw err("provider_not_configured", "这个 Provider 还没有配置 API Key");
    // 模拟环境没有 Jev 云端：返回 503，决策层按设计降级到规则引擎
    if (req.target === "jev") return json(503, { error: { message: "（模拟）浏览器模式没有 Jev 云端" } });
    return chat(req.target, path, req.body);
  }

  const ensureCustomKeyId = (id: string) => {
    validateProviderId(id);
    if (id === "ollama") throw err("key_not_needed", "这个 Provider 不需要 API Key");
  };

  return {
    kind: "mock",
    async init() {
      if (o.initDelayMs) await sleep(o.initDelayMs);
      if (initFailures > 0) {
        initFailures--;
        throw { code: "db_open_failed", message: "（模拟）无法打开数据库", detail: null } satisfies AppError;
      }
      return { info: { name: "EastGenesis Desktop", version: "0.1.0", db_path_hint: "内存（浏览器模式）" }, storage: "memory", schemaVersion: null };
    },

    async providerStatus() {
      return [...OFFICIAL_PROVIDERS, ...custom.keys()].map(status);
    },
    async setProviderKey(provider, key) {
      ensureCustomKeyId(provider);
      validateKey(key); // 只校验，不保存
      configured.add(provider);
      return status(provider);
    },
    async deleteProviderKey(provider) {
      validateProviderId(provider);
      configured.delete(provider);
      return status(provider);
    },

    jevStatus: async () => jevStatus(),
    async setJevKey(key) {
      validateKey(key);
      jev = true;
      return jevStatus();
    },
    async deleteJevKey() {
      jev = false;
      return jevStatus();
    },

    listCustomProviders: async () => [...custom.values()],
    async saveCustomProvider(p, apiKey) {
      const key = apiKey?.trim() || null;
      if (key) validateKey(key);
      const v = validateCustom(p);
      const changed = custom.has(v.id) && custom.get(v.id)!.base_url !== v.base_url;
      custom.set(v.id, v);
      const key_cleared = changed && !key;
      if (key) configured.add(v.id);
      else if (key_cleared) configured.delete(v.id);
      return { provider: v, key: status(v.id), key_cleared };
    },
    async deleteCustomProvider(id) {
      if (!CUSTOM_ID.test(id)) throw err("invalid_provider", "Provider ID 无效");
      configured.delete(id);
      custom.delete(id);
    },

    providerRequest,

    ...createMockMcp(),
    ...memory.api,
    ...createMockSkills(),
    ...projects.api,
    ...goals.api,

    async loadSetting(key) {
      assertSettingKey(key);
      return settings.get(key) ?? null;
    },
    async saveSetting(key, value) {
      assertSettingKey(key);
      settings.set(key, value);
    },
  };
}

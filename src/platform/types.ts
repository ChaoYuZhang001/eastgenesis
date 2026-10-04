// 前端访问后端的唯一接口。桌面端由 Tauri 命令实现（tauri-backend），浏览器模式由内存 mock 实现（mock-backend）。
// 字段名与 Rust 侧 serde 输出保持一致（snake_case）。任何方法都不返回 API Key 本身。
import type { AppError, AppInfo } from "@/lib/ipc";
import type { Goal, GoalChange, GoalInput } from "@/decision/goal";
import type { Project, ProjectInput, ProjectUsage } from "@/decision/project";
import type { SessionInput, StoredSession, UsageCall } from "@/decision/session";

export type { Goal, GoalChange, GoalInput, Project, ProjectInput, ProjectUsage, SessionInput, StoredSession, UsageCall };

export type BackendKind = "tauri" | "mock";
export type KeySource = "keychain" | "env" | "none";

export interface KeyStatus {
  id: string;
  configured: boolean;
  source: KeySource;
  /** ollama 等本地模型不需要 Key */
  needs_key: boolean;
}

export interface CustomProvider {
  /** custom:<名称> */
  id: string;
  label: string;
  base_url: string;
  default_model: string;
  /** 非敏感的附加请求头；名字像凭据的会被拒绝 */
  headers: Record<string, string>;
  /** 端点协议，缺省 openai。决定鉴权头和请求格式 */
  protocol?: CustomProtocol;
  /** 参与路由的模型。后端保存时规整为「默认模型在第一个、去重」；缺省只有默认模型 */
  models?: string[];
}

export type CustomProtocol = "openai" | "anthropic";

/** 每个自定义 Provider 最多登记的模型数，与 Rust 侧 MAX_CUSTOM_MODELS 一致 */
export const MAX_CUSTOM_MODELS = 32;

/** 与 Rust 的 valid_model 一致：非空、不含空白或控制字符、UTF-8 不超过 128 字节 */
export function isValidModelName(m: string): boolean {
  return m.length > 0 && new TextEncoder().encode(m).length <= 128 && !/[\s\p{Cc}]/u.test(m);
}

/** 自定义 Provider 参与路由的模型：默认模型在第一个，去重（兼容没有 models 字段的旧数据） */
export function customModels(c: Pick<CustomProvider, "default_model" | "models">): string[] {
  return [...new Set([c.default_model, ...(c.models ?? [])])];
}

export interface SavedProvider {
  provider: CustomProvider;
  key: KeyStatus;
  /** base URL 变更且没有提供新 Key 时，旧 Key 已被删除 */
  key_cleared: boolean;
}

/** 代理请求：target 是 jev / openai / anthropic / custom:<名称>，认证由后端注入 */
export interface ProxyRequest {
  target: string;
  method: "GET" | "POST";
  url: string;
  body?: string | null;
}

export interface ProxyResponse {
  status: number;
  body: string;
}

/** mcp.json 引用的密钥：只有「是否已提供」，没有值 */
export interface McpRefStatus {
  source: "keychain" | "env";
  name: string;
  configured: boolean;
}

/** 登记表里的一台服务器。配置按原文展示：里面只有 ${keychain:NAME} / ${env:NAME} 引用，没有密钥值 */
export interface McpServerView {
  id: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string | null;
  /** "*" 表示全部；空数组表示一个都不注册 */
  allow_tools: string[] | "*";
  trust_annotations: boolean;
  refs: McpRefStatus[];
  running: boolean;
  /** 最近的 stderr（已脱敏） */
  stderr_tail: string | null;
  /** 应用内置的服务器（例如 files），应用启动时自动连接 */
  builtin?: boolean;
}

export interface McpRegistry {
  /** mcp.json 的位置，家目录写成 ~ */
  path_hint: string;
  servers: McpServerView[];
  /** 没能登记的条目及原因 */
  errors: { id: string; message: string }[];
}

export type MemoryKind = "preference" | "fact";

/** 跨任务记忆：只有用户在设置页添加、或在任务卡片上确认过的条目 */
export interface Memory {
  id: string;
  kind: MemoryKind;
  text: string;
  /** manual：设置页添加；task：任务卡片上确认 */
  source: "manual" | "task";
  /** 属于哪个项目；null 是全局记忆。删除项目时连带删除（软删除） */
  project_id: string | null;
  created_at: number;
  updated_at: number;
  use_count: number;
  last_used_at: number | null;
}

/** 新建时不带 id；编辑时带 id，只改类型和内容（来源和所属项目不变） */
export interface MemoryInput {
  id?: string;
  kind: MemoryKind;
  text: string;
  source?: Memory["source"];
  project_id?: string | null;
}

/** 技能的一步：子目标和建议的工具。只读步骤额外保存参数，重复执行时直接调用，不用再问模型 */
export interface SkillStep {
  goal: string;
  tool: string | null;
  /** 只读步骤的参数（已脱敏）；写入类步骤不保存 */
  args?: Record<string, unknown>;
  /** 逐个处理上一步列出的每一项：值是填入每项路径的参数名；goal 里的 {名称} 换成每项的名称 */
  each?: string;
}

/** 技能：用户保存的可复用流程，规划时作为参考 */
export interface Skill {
  id: string;
  name: string;
  description: string;
  steps: SkillStep[];
  /** manual：设置页添加；task：从完成的任务保存 */
  source: "manual" | "task";
  created_at: number;
  updated_at: number;
  use_count: number;
  last_used_at: number | null;
}

export interface SkillInput {
  id?: string;
  name: string;
  description: string;
  steps: SkillStep[];
  source?: Skill["source"];
}

export interface McpHandlers {
  onLine: (line: string) => void;
  onExit: (reason: string) => void;
}

export interface InitResult {
  info: AppInfo;
  storage: "sqlite" | "memory";
  schemaVersion: number | null;
}

export interface Backend {
  readonly kind: BackendKind;
  /** 启动页期间调用：打开 SQLite、确认 Rust 侧就绪 */
  init(): Promise<InitResult>;

  providerStatus(): Promise<KeyStatus[]>;
  setProviderKey(provider: string, key: string): Promise<KeyStatus>;
  deleteProviderKey(provider: string): Promise<KeyStatus>;

  jevStatus(): Promise<KeyStatus>;
  setJevKey(key: string): Promise<KeyStatus>;
  deleteJevKey(): Promise<KeyStatus>;

  listCustomProviders(): Promise<CustomProvider[]>;
  saveCustomProvider(p: CustomProvider, apiKey?: string): Promise<SavedProvider>;
  deleteCustomProvider(id: string): Promise<void>;

  providerRequest(req: ProxyRequest): Promise<ProxyResponse>;

  /** MCP 登记表只读：服务器由用户在 mcp.json 里登记，界面不能添加或修改 */
  mcpList(): Promise<McpRegistry>;
  /** 先注册监听再启动进程，避免丢掉最早的输出；返回取消监听的函数 */
  onMcp(server: string, h: McpHandlers): Promise<() => void>;
  /** 只能按 ID 启动登记过的服务器；返回启动时生效的配置 */
  mcpStart(server: string): Promise<McpServerView>;
  mcpSend(server: string, line: string): Promise<void>;
  mcpStop(server: string): Promise<boolean>;
  /** 只进不出；只能写 mcp.json 里引用了的钥匙串条目 */
  setMcpSecret(server: string, name: string, value: string): Promise<void>;
  deleteMcpSecret(server: string, name: string): Promise<void>;

  /** 记忆：桌面端存 SQLite 的 memories 表，浏览器模式存内存 */
  listMemories(): Promise<Memory[]>;
  saveMemory(m: MemoryInput): Promise<Memory>;
  deleteMemory(id: string): Promise<void>;
  /** 任务用到记忆后调用：use_count 加 1，记下时间 */
  touchMemories(ids: readonly string[]): Promise<void>;

  /** 技能库：桌面端存 SQLite 的 skills 表，浏览器模式存内存 */
  listSkills(): Promise<Skill[]>;
  saveSkill(s: SkillInput): Promise<Skill>;
  deleteSkill(id: string): Promise<void>;
  /** 规划参考了技能后调用：use_count 加 1，记下时间 */
  touchSkills(ids: readonly string[]): Promise<void>;

  /** 项目：桌面端存 SQLite 的 projects 表，浏览器模式存内存。列表含已归档的（archived 字段区分），不含已删除的 */
  listProjects(): Promise<Project[]>;
  /** 新建不带 id；编辑带 id，没给的字段保持原值 */
  saveProject(p: ProjectInput): Promise<Project>;
  archiveProject(id: string): Promise<Project>;
  unarchiveProject(id: string): Promise<Project>;
  /** 删除前的二次确认用：会连带删除多少目标和记忆 */
  projectUsage(id: string): Promise<ProjectUsage>;
  /** 软删除，连带删除它的目标和记忆；返回连带删除的数量 */
  deleteProject(id: string): Promise<ProjectUsage>;

  /** 目标：不给 projectId 时列出全部；不含已删除的 */
  listGoals(projectId?: string): Promise<Goal[]>;
  /** 新建不带 id（状态 idle）；编辑带 id，没给的字段保持原值，不能换项目 */
  saveGoal(g: GoalInput): Promise<Goal>;
  /** 状态转换和轮次操作（decision/goal.ts applyGoalChange）；删除目标是 { op: "transition", to: "deleted" } */
  updateGoal(id: string, change: GoalChange): Promise<Goal>;

  /** 会话：桌面端存 SQLite 的 sessions 表（迁移 5），浏览器模式存内存。写入前脱敏、截断（decision/session.ts） */
  listSessions(): Promise<StoredSession[]>;
  /** 整条写入：没有就新建，有就覆盖标题和回合 */
  saveSession(s: SessionInput): Promise<StoredSession>;
  /** 软删除 */
  deleteSession(id: string): Promise<void>;
  /** 模型调用记录（只存模型和 tokens，不存金额）；同一个 id 只记一次 */
  recordUsage(calls: readonly UsageCall[]): Promise<void>;
  /** created_at >= since 的调用记录，按时间先后 */
  listUsage(since: number): Promise<UsageCall[]>;

  /** 非敏感设置（路由偏好、能力矩阵覆盖等），JSON 字符串 */
  loadSetting(key: string): Promise<string | null>;
  saveSetting(key: string, value: string): Promise<void>;
}

export type { AppError, AppInfo };

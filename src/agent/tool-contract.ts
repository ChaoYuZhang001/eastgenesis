// 工具能力契约：把“工具能做什么”和“工具叫什么”分开。
// 能力声明不是安全边界本身；真正执行前仍必须经过 DecisionLayer 的白名单、硬禁止规则和权限闸门。
import type { SideEffect } from "../decision/decision-layer";
import type { WorkSurface } from "../decision/types";

export type ToolPermission = "read" | "write" | "delete" | "execute" | "network";
export type ToolApproval = "none" | "confirm" | "confirm_twice";
export type ToolExecutionState = "not_applied" | "applied" | "unknown";
export type ToolProbeState = ToolExecutionState | "conflict";
export type InvocationLedgerState = "planned" | "started" | "applied" | "not_applied" | "unknown" | "conflict";
export type InvocationLeaseResult = "acquired" | "busy" | "terminal" | "missing";
/** QA 故障窗口；普通宿主不传入，避免把进程终止能力暴露为产品功能。 */
export type RuntimeFaultPoint = "after_ledger_started" | "after_tool_before_ledger_commit";

/**
 * 恢复前的副作用探测结果。探测只能提供证据，不能替代 DecisionLayer 的权限闸门。
 * conflict 表示目标状态与期望不一致，运行时必须停下来交给用户判断。
 */
export interface ToolProbeResult {
  state: ToolProbeState;
  detail: string;
  artifacts?: readonly ArtifactRef[];
}

/** 跨进程恢复所需的最小调用账本记录；正文不入库，只保存参数摘要和产物引用。 */
export interface InvocationLedgerRecord {
  taskId: string;
  stepId: string;
  invocationId: string;
  idempotencyKey: string;
  tool: string;
  argsDigest: string;
  attempt: number;
  state: InvocationLedgerState;
  artifacts: ArtifactRef[];
  detail?: string;
  /** 持久化账本中的当前租约；终态写入后由适配器清空。 */
  leaseOwner?: string;
  leaseExpiresAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface InvocationLedger {
  get(idempotencyKey: string): Promise<InvocationLedgerRecord | null>;
  put(record: InvocationLedgerRecord): Promise<void>;
  /** 原子地抢占尚未结束的调用；旧宿主没有该能力时运行时退回已有恢复语义。 */
  claim?(idempotencyKey: string, owner: string, now: number, ttlMs: number): Promise<InvocationLeaseResult>;
  /** 延长当前持有者的租约；false 表示租约已被接管或记录不存在。 */
  renew?(idempotencyKey: string, owner: string, now: number, ttlMs: number): Promise<boolean>;
  release?(idempotencyKey: string, owner: string): Promise<void>;
}

/** 工具注册时可以只覆盖自己和通用推断不同的字段。 */
export interface ToolCapabilityOverride {
  surfaces?: readonly WorkSurface[];
  permissions?: readonly ToolPermission[];
  sideEffect?: SideEffect;
  approval?: ToolApproval;
  idempotent?: boolean;
  /** 工具自己的允许目录提示；实际目录白名单仍由 MCP / 后端强制执行。 */
  roots?: readonly string[];
}

export interface ToolCapability {
  surfaces: readonly WorkSurface[];
  permissions: readonly ToolPermission[];
  sideEffect: SideEffect;
  approval: ToolApproval;
  /** 同一个幂等键重复提交是否可以安全交给工具适配器处理。 */
  idempotent: boolean;
  roots: readonly string[];
}

export interface ArtifactRef {
  kind: "file" | "command" | "external";
  action: "read" | "create" | "modify" | "move" | "delete" | "execute" | "request";
  path?: string;
  to?: string;
  command?: string;
  ok: boolean;
}

export interface ToolInvocation {
  invocationId: string;
  /** 同一个 task、step、工具和参数的重试共享这个键。 */
  idempotencyKey: string;
  taskId: string;
  stepId: string;
  attempt: number;
  tool: string;
  argsDigest: string;
  capability: ToolCapability;
}

interface ToolLike {
  name: string;
  description: string;
  sideEffect: SideEffect;
  confirmTwice?: boolean;
  capability?: ToolCapabilityOverride;
}

const unique = <T>(xs: readonly T[]): T[] => [...new Set(xs)];

function baseName(name: string): string {
  return name.replace(/^mcp__[a-z0-9_]+__/, "").toLowerCase();
}

function inferredSurfaces(name: string, description: string): WorkSurface[] {
  const text = `${baseName(name)} ${description}`.toLowerCase();
  if (/(?:file|folder|directory|document|spreadsheet|sheet|slide|presentation|pdf|report|资料|文件|文档|表格|演示|报告)/i.test(text)) return ["work"];
  if (/(?:repo|repository|terminal|shell|command|exec|run|test|git|patch|build|compile|代码库|终端|命令|测试|编译)/i.test(text)) return ["codex"];
  return ["chat"];
}

function inferredPermissions(name: string, description: string, sideEffect: SideEffect): ToolPermission[] {
  const text = `${baseName(name)} ${description}`.toLowerCase();
  const out: ToolPermission[] = [];
  if (/(?:read|list|get|find|search|query|inspect|查看|读取|列出|检索|搜索)/i.test(text) || sideEffect === "none") out.push("read");
  if (/(?:write|save|create|append|edit|patch|move|rename|update|modify|写入|保存|创建|追加|编辑|移动|重命名|修改)/i.test(text) || sideEffect === "local_write") out.push("write");
  if (/(?:delete|remove|unlink|wipe|清空|删除|移除)/i.test(text) || sideEffect === "destructive") out.push("delete");
  if (/(?:run|exec|shell|command|terminal|test|build|compile|git|执行|终端|命令|测试|构建|编译)/i.test(text)) out.push("execute");
  if (/(?:web|http|fetch|request|send|post|upload|联网|网络|请求|发送|上传)/i.test(text) || sideEffect === "external") out.push("network");
  return unique(out.length ? out : ["read"]);
}

export function capabilityForTool(tool: ToolLike): ToolCapability {
  const override = tool.capability ?? {};
  const sideEffect = override.sideEffect ?? tool.sideEffect;
  const approval = override.approval ?? (tool.confirmTwice || sideEffect === "destructive" ? "confirm_twice" : sideEffect === "none" ? "none" : "confirm");
  return {
    surfaces: unique(override.surfaces?.length ? override.surfaces : inferredSurfaces(tool.name, tool.description)),
    permissions: unique(override.permissions?.length ? override.permissions : inferredPermissions(tool.name, tool.description, sideEffect)),
    sideEffect,
    approval,
    // 只读调用默认安全可重试；有副作用的工具必须显式声明幂等。
    idempotent: override.idempotent ?? sideEffect === "none",
    roots: [...(override.roots ?? [])],
  };
}

/** 不依赖 JSON key 顺序的参数表示；只用于幂等键和日志关联，不是安全哈希。 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const o = value as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(",")}}`;
}

/** FNV-1a 32 位摘要：避免在跨平台运行时依赖 Node crypto；不用于防篡改。 */
export function digest(value: unknown): string {
  const text = typeof value === "string" ? value : canonicalJson(value);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function makeToolInvocation(input: {
  taskId: string;
  stepId: string;
  attempt: number;
  tool: ToolLike;
  args: Record<string, unknown>;
}): ToolInvocation {
  const capability = capabilityForTool(input.tool);
  const argsDigest = digest(input.args);
  const basis = `${input.taskId}\u0000${input.stepId}\u0000${input.tool.name}\u0000${argsDigest}`;
  return {
    invocationId: `${input.taskId}:${input.stepId}:${input.attempt}`,
    idempotencyKey: `eg-${digest(basis)}`,
    taskId: input.taskId,
    stepId: input.stepId,
    attempt: input.attempt,
    tool: input.tool.name,
    argsDigest,
    capability,
  };
}

function textArg(args: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) if (typeof args[key] === "string" && args[key].trim()) return String(args[key]).trim();
  return null;
}

/** 从调用契约生成不含正文的产物清单，供恢复和审计使用。 */
export function artifactsForInvocation(invocation: ToolInvocation, args: Record<string, unknown>, ok: boolean): ArtifactRef[] {
  const base = baseName(invocation.tool);
  const path = textArg(args, ["path", "source", "src", "from"]);
  const to = textArg(args, ["destination", "to", "dst"]);
  if (invocation.capability.permissions.includes("execute")) {
    const command = textArg(args, ["command", "cmd", "script"]) ?? invocation.tool;
    return [{ kind: "command", action: "execute", command, ok }];
  }
  if (invocation.capability.permissions.includes("network") && !path) return [{ kind: "external", action: "request", ok }];
  if (!path) return [];
  const action: ArtifactRef["action"] = /delete|remove|unlink|wipe|清空|删除/i.test(base)
    ? "delete"
    : /move|rename|移动|重命名/i.test(base)
      ? "move"
      : /create_directory|mkdir|创建目录/i.test(base)
        ? "create"
        : invocation.capability.permissions.includes("write")
          ? "modify"
          : "read";
  return [{ kind: "file", action, path, ...(action === "move" && to ? { to } : {}), ok }];
}

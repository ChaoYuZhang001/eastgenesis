// Jev 决策层：routeTask、chooseTool、checkDone、checkDoneWithEvidence、gateAction、evaluateResult、replan。
// 每个决策都经过三级降级链，并在 meta 里说明由哪一级做出、跳过了哪些及原因（透明度优先）。
// checkDoneWithEvidence（目标模式）例外：先规则后 Jev，结论里的 by 写明由谁判断。
import type { Fetch } from "@typesafe-ai/sdk";
import { JEV_EVIDENCE_QUESTION, MAX_GOAL_CHARS, NO_JUDGE_REASON, evidenceRecord, judgeByRules, verdictFromProbability, type Evidence, type EvidenceResult } from "./evidence";
import {
  CloudJevBackend,
  DEFAULT_MIN_CONFIDENCE,
  FallbackChain,
  RuleBasedBackend,
  type Decision,
  type DecisionMeta,
  type ReplanInput,
  type Risk,
  type ToolSpec,
} from "./fallback";
import { HealthTracker } from "./health";
import { JevClient, JevError, type JevClientOptions } from "./jev-client";
import { LocalJevBackend, type LocalDecisionModel } from "./local-jev";
import { defaultAvailability, route, type Availability, type RouteDecision, type RouteRequest } from "./router";
import type { ModelProfile } from "./types";

export type SideEffect = "none" | "local_write" | "external" | "destructive";
export interface ToolDef extends ToolSpec {
  sideEffect: SideEffect;
}
export interface ActionRequest {
  tool: string;
  summary: string;
  args?: Record<string, unknown>;
}
export type Verdict = "allow" | "confirm" | "deny";
export interface GateDecision {
  verdict: Verdict;
  risk: Risk;
  reasons: string[];
}

// 硬规则。决策层（包括 Jev）只能在此基础上收紧，不能放宽。
const DENY: RegExp[] = [
  /\brm\s+(?:-[a-z]*\s+)*-[a-z]*r[a-z]*\s+(?:-[a-z]*\s+)*(?:\/|~|\/\*|\$HOME|\*)(?=\s|$|["'])/i,
  /\bmkfs(?:\.\w+)?\b|\bdd\s+[^|]*\bof=\/dev\/(?:sd|disk|nvme|hd)/i,
  /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
  /\b(?:curl|wget)\b[^|;]*\|\s*(?:sudo\s+)?(?:ba|z)?sh\b/i,
  /\bchmod\s+(?:-R\s+)?777\s+\/(?=\s|$|["'])/i,
  /格式化(?:硬盘|磁盘|系统盘|整个)/,
];
const CONFIRM: RegExp[] = [
  /\bsudo\b/i,
  /\brm\s|\bdel\s|\bdelete\b|\bunlink\b|\brmdir\b|删除|清空|覆盖/i,
  /\bgit\s+push\b[^;|&]*(?:\s-f\b|--force)/i,
  /\bdrop\s+(?:table|database)\b|\btruncate\s+table\b/i,
  /转账|付款|支付|下单|购买|\b(?:pay|payment|purchase|checkout)\b|\btransfer\s+(?:money|funds)\b/i,
];
const SENSITIVE = /(?:^|[\s/"'~])(?:\.ssh|\.aws|\.gnupg|\.env(?:\.[\w-]+)?|id_rsa|id_ed25519|credentials(?:\.json)?|\.npmrc|\.netrc|\.pgpass|keychain)(?=$|[\s/"'])/i;
export const SIDE_LABEL: Record<SideEffect, string> = { none: "只读", local_write: "写本地文件", external: "访问外部服务", destructive: "可能造成破坏" };

/** 输入框里的权限开关，每轮对话提交时取值 */
export type PermissionMode = "full" | "confirm" | "readonly";
export const PERMISSION_MODES: readonly PermissionMode[] = ["full", "confirm", "readonly"];
export const PERMISSION_LABEL: Record<PermissionMode, string> = { full: "完全访问", confirm: "变更前确认", readonly: "只读" };
export const PERMISSION_HINT: Record<PermissionMode, string> = {
  full: "普通写入直接执行；删除、提权、支付和敏感路径仍然先问你，禁止规则任何模式都不放行",
  confirm: "有副作用的操作（写文件、访问外部服务）先问你",
  readonly: "只执行只读工具，写入和外部操作一律拒绝",
};
const RANK: Record<Risk, number> = { low: 0, medium: 1, high: 2 };
const maxRisk = (a: Risk, b: Risk): Risk => (RANK[a] >= RANK[b] ? a : b);
const RULES_META = (): DecisionMeta => ({ backend: "rules", level: 3, degraded: false, confidence: 1, skipped: [], latencyMs: 0 });

export function describeMeta(m: DecisionMeta): string {
  const skipped = m.skipped.map((s) => `${s.backend}：${s.reason}`).join("；");
  return `决策来源：${m.backend}（第 ${m.level} 级${m.degraded ? "，已降级" : ""}，置信度 ${m.confidence.toFixed(2)}）${skipped ? `；跳过 ${skipped}` : ""}`;
}

export interface DecisionLayerOptions {
  chain: FallbackChain;
  availability: Availability;
  /** 工具白名单 */
  tools?: readonly ToolDef[];
  profiles?: readonly ModelProfile[];
  health?: HealthTracker;
  /** 权限开关，默认「变更前确认」 */
  permission?: PermissionMode;
  /** 目标完成校验用的 Jev（规则判断不了时才问）；不给则交给用户确认 */
  judge?: EvidenceJudge | null;
  /** Jev 结论的置信度下限，默认与决策链相同（0.6） */
  minConfidence?: number;
}

/** checkDoneWithEvidence 只用到 Jev 的 noul；JevClient 满足这个接口 */
export type EvidenceJudge = Pick<JevClient, "noul">;

export class DecisionLayer {
  readonly health: HealthTracker;
  readonly tools: readonly ToolDef[];
  readonly permission: PermissionMode;
  readonly #chain: FallbackChain;
  readonly #availability: Availability;
  readonly #profiles?: readonly ModelProfile[];
  readonly #judge: EvidenceJudge | null;
  readonly #minConfidence: number;

  constructor(o: DecisionLayerOptions) {
    this.#chain = o.chain;
    this.#availability = o.availability;
    this.tools = o.tools ?? [];
    this.#profiles = o.profiles;
    this.health = o.health ?? new HealthTracker();
    this.permission = o.permission ?? "confirm";
    this.#judge = o.judge ?? null;
    this.#minConfidence = o.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  }

  /** 没有 TYPESAFE_API_KEY 时第 1 级自动跳过，全部由规则决策，不阻塞开发 */
  static fromEnv(
    env: Record<string, string | undefined>,
    o: {
      fetch?: Fetch;
      tools?: readonly ToolDef[];
      profiles?: readonly ModelProfile[];
      now?: () => number;
      minConfidence?: number;
      jev?: Omit<JevClientOptions, "apiKey" | "fetch">;
      /** 第 2 级本地决策模型；不给则跳过 */
      local?: LocalDecisionModel;
      permission?: PermissionMode;
    } = {},
  ): DecisionLayer {
    let client: JevClient | null = null;
    let reason: string | undefined;
    try {
      client = JevClient.fromEnv(env, { ...o.jev, fetch: o.fetch });
    } catch (e) {
      reason = `Jev 配置有误：${(e as Error).message}`;
    }
    const chain = new FallbackChain([new CloudJevBackend(client, reason), new LocalJevBackend(o.local ?? null), new RuleBasedBackend()], {
      now: o.now,
      minConfidence: o.minConfidence,
    });
    const health = new HealthTracker({ now: o.now });
    return new DecisionLayer({
      chain,
      availability: defaultAvailability(env, health),
      tools: o.tools,
      profiles: o.profiles,
      health,
      permission: o.permission,
      judge: client,
      minConfidence: o.minConfidence,
    });
  }

  async routeTask(req: RouteRequest, signal?: AbortSignal): Promise<{ decision: RouteDecision; meta: DecisionMeta }> {
    // 手动锁定：不请 Jev 分类、不评分，规则分类只用来记录任务类型
    if (req.lock) return { decision: route(req, { availability: this.#availability, profiles: this.#profiles }), meta: RULES_META() };
    const cls = await this.#chain.run((b) => b.classifyTask(req, signal));
    const decision = route({ ...req, classification: cls.value }, { availability: this.#availability, profiles: this.#profiles });
    decision.reasons.unshift(describeMeta(cls.meta));
    return { decision, meta: cls.meta };
  }

  async chooseTool(goal: string, signal?: AbortSignal): Promise<Decision<string | null>> {
    const d = await this.#chain.run((b) => b.chooseTool(goal, this.tools, signal));
    // 只能选白名单里的工具
    return d.value !== null && !this.tools.some((t) => t.name === d.value) ? { ...d, value: null } : d;
  }

  checkDone(goal: string, result: string, signal?: AbortSignal): Promise<Decision<boolean>> {
    return this.#chain.run((b) => b.checkDone(goal, result, signal));
  }

  /**
   * 目标模式的完成校验：只认执行记录（工具调用、文件改动、命令输出），模型自述不算实据。
   * 1. 规则（evidence.ts judgeByRules）：测试没过 → not_done；只有自述 → uncertain「AI 声称完成，但无实据」；能核对的条件全部满足 → done。
   * 2. 规则判断不了、配置了 Jev：只把目标和执行记录发给 Jev（不含自述），确定程度达到阈值才下 done / not_done。
   * 3. 否则 uncertain，交给用户确认。Jev 出错也是 uncertain；取消时抛出 aborted。
   * evidence 应是这个目标到目前为止所有轮次的记录（goal.ts 每轮单独保存，调用方用 mergeEvidence 合并）。
   * context 的 taskId、projectId 留给执行时间线关联（M10）；这里不写日志。
   */
  async checkDoneWithEvidence(
    goal: string,
    evidence: Evidence,
    context: { taskId: string; projectId?: string; signal?: AbortSignal },
  ): Promise<EvidenceResult> {
    const signal = context.signal;
    if (signal?.aborted) throw new JevError("aborted");
    const text = String(goal ?? "").slice(0, MAX_GOAL_CHARS);
    const byRules = judgeByRules(text, evidence);
    if (byRules) return byRules;
    if (!this.#judge) return { verdict: "uncertain", reason: NO_JUDGE_REASON, by: "rules" };
    try {
      const r = await this.#judge.noul(evidenceRecord(text, evidence), JEV_EVIDENCE_QUESTION, signal);
      return verdictFromProbability(r.noul, this.#minConfidence);
    } catch (e) {
      if (signal?.aborted || (e instanceof JevError && e.code === "aborted")) throw e instanceof JevError ? e : new JevError("aborted");
      const code = e instanceof JevError ? e.code : "internal";
      return { verdict: "uncertain", reason: `Jev 调用失败（${code}），请你确认`, by: "jev" };
    }
  }

  evaluateResult(goal: string, result: string, signal?: AbortSignal): Promise<Decision<number>> {
    return this.#chain.run((b) => b.evaluateResult(goal, result, signal));
  }

  replan(input: ReplanInput, signal?: AbortSignal) {
    return this.#chain.run((b) => b.replan(input, signal));
  }

  /**
   * 权限闸门：白名单 → 禁止规则（任何模式都不放行）→ 只读模式拒绝副作用 → 需确认规则 → 决策层评估（只能收紧）。
   * 「完全访问」只放宽「普通写入要确认」这一条：破坏性工具、删除提权强推支付、敏感路径照样确认。
   */
  async gateAction(a: ActionRequest, signal?: AbortSignal): Promise<Decision<GateDecision>> {
    const tool = this.tools.find((t) => t.name === a.tool);
    if (!tool) return { value: { verdict: "deny", risk: "high", reasons: [`工具 ${a.tool} 不在白名单`] }, meta: RULES_META() };
    const text = `${a.tool} ${a.summary} ${JSON.stringify(a.args ?? {})}`;
    if (DENY.some((r) => r.test(text))) {
      return { value: { verdict: "deny", risk: "high", reasons: ["命中禁止规则（破坏性命令）"] }, meta: RULES_META() };
    }
    const mode = this.permission;
    if (mode === "readonly" && tool.sideEffect !== "none") {
      const risk: Risk = tool.sideEffect === "destructive" ? "high" : "medium";
      return { value: { verdict: "deny", risk, reasons: [`只读模式：不执行有副作用的操作（${SIDE_LABEL[tool.sideEffect]}）`] }, meta: RULES_META() };
    }
    const reasons: string[] = [];
    let verdict: Verdict = "allow";
    let risk: Risk = "low";
    // strict：「完全访问」下也必须确认
    let strict = false;
    if (tool.sideEffect !== "none") {
      verdict = "confirm";
      risk = tool.sideEffect === "destructive" ? "high" : "medium";
      strict = tool.sideEffect === "destructive";
      reasons.push(`工具有副作用（${SIDE_LABEL[tool.sideEffect]}）`);
    }
    if (CONFIRM.some((r) => r.test(text))) {
      verdict = "confirm";
      risk = "high";
      strict = true;
      reasons.push("命中高风险规则（删除、提权、强推、支付等）");
    }
    if (SENSITIVE.test(text)) {
      verdict = "confirm";
      risk = maxRisk(risk, "medium");
      strict = true;
      reasons.push("涉及敏感路径（密钥、凭据）");
    }
    if (strict || (verdict !== "allow" && mode !== "full")) return { value: { verdict, risk, reasons }, meta: RULES_META() };

    // 剩下两种情况：只读工具；「完全访问」下的普通写入。都再请决策层评估，只能收紧
    const d = await this.#chain.run((b) => b.assessRisk(text, signal));
    const relaxed = mode === "full" && tool.sideEffect !== "none";
    if (relaxed ? d.value === "high" : d.value !== "low") {
      verdict = "confirm";
      reasons.push(`决策层评估风险为 ${d.value}，改为需要确认`);
    } else if (relaxed) {
      verdict = "allow";
      reasons.push(`完全访问：直接执行，不再询问（决策层评估风险为 ${d.value}）`);
    } else {
      reasons.push("只读操作，决策层评估为低风险");
    }
    return { value: { verdict, risk: maxRisk(risk, d.value), reasons }, meta: d.meta };
  }
}

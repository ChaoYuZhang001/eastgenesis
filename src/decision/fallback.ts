import { isGoalQuotaControlError } from "../core/goal-quota";
// 三级降级的决策后端。
//   第 1 级 CloudJevBackend：TypeSafe Jev（云端）。没有 TYPESAFE_API_KEY 时直接跳过。
//   第 2 级 LocalJevBackend（local-jev.ts）：用户在设置页选的本机决策模型。没有选择时直接跳过。
//   第 3 级 RuleBasedBackend：关键词 + 长度阈值，永远可用，是最后兜底。
// 降级触发：没有 Key / 没有选择 → 跳过；鉴权或配置错误 → 本次会话停用；
// 超时、限流、529、5xx、网络错误 → 记失败，60s 内连续 3 次熔断 60s；置信度低于阈值（默认 0.6）→ 交给下一级。
import { noul, type NoulQuestion } from "@typesafe-ai/sdk";
import { classificationFromProbs } from "./classification";
import { HealthTracker } from "./health";
import { JevError, type JevClient } from "./jev-client";
import { CLASSIFY_QUESTIONS, DEFAULT_MIN_CONFIDENCE, VISION_QUESTION } from "./jev-config";
import { classifyTask } from "./rules";
import type { Classification, TaskInput } from "./types";

export { DEFAULT_MIN_CONFIDENCE };

export type BackendLevel = 1 | 2 | 3;
export type BackendName = "cloud-jev" | "local-jev" | "rules";
export type Risk = "low" | "medium" | "high";
export type ReplanStrategy = "retry" | "modify_step" | "new_plan" | "ask_user" | "abort";

export interface ToolSpec {
  name: string;
  description: string;
}
export interface ReplanInput {
  goal: string;
  failedStep: string;
  error: string;
  attempts: number;
}
export interface Decided<T> {
  value: T;
  confidence: number;
}

export interface DecisionBackend {
  readonly name: BackendName;
  readonly level: BackendLevel;
  /** null 表示可用，否则为跳过原因 */
  unavailableReason(): string | null;
  classifyTask(input: TaskInput, signal?: AbortSignal): Promise<Decided<Classification>>;
  chooseTool(goal: string, tools: readonly ToolSpec[], signal?: AbortSignal): Promise<Decided<string | null>>;
  checkDone(goal: string, result: string, signal?: AbortSignal): Promise<Decided<boolean>>;
  assessRisk(action: string, signal?: AbortSignal): Promise<Decided<Risk>>;
  /** 0–1 */
  evaluateResult(goal: string, result: string, signal?: AbortSignal): Promise<Decided<number>>;
  replan(input: ReplanInput, signal?: AbortSignal): Promise<Decided<ReplanStrategy>>;
}

// ---------- 第 3 级：规则 ----------

/** 英文取 3 个字母以上的词，中文取相邻两字 */
export function terms(s: string): Set<string> {
  const out = new Set<string>();
  for (const w of s.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? []) out.add(w);
  for (const run of s.match(/[㐀-鿿]+/g) ?? []) {
    if (run.length === 1) out.add(run);
    for (let i = 0; i + 1 < run.length; i++) out.add(run.slice(i, i + 2));
  }
  return out;
}

/** goal 中的词有多少比例出现在 text 里 */
export function overlap(goal: string, text: string): number {
  const g = terms(goal);
  if (!g.size) return 0;
  const t = terms(text);
  let n = 0;
  for (const x of g) if (t.has(x)) n++;
  return n / g.size;
}

const ERROR_MARK = /\b(?:error|exception|failed|failure|traceback|unable\s+to|cannot|not\s+found)\b|错误|失败|异常|报错|无法|找不到/i;
const RISK_HIGH = /\brm\s+-|\bdelete\b|\bdrop\s+(?:table|database)\b|\btruncate\b|\bformat\b|--force|\bsudo\b|删除|清空|格式化|覆盖|转账|付款|支付|\b(?:pay|purchase|transfer)\b/i;
const RISK_MEDIUM =
  /\b(?:write|save|move|rename|install|uninstall|send|post|upload|deploy|push|commit|update|modify|chmod|kill)\b|写入|保存|移动|重命名|安装|卸载|发送|上传|部署|推送|提交|修改/i;
const RETRY_ERR = /timeout|timed\s+out|rate.?limit|\b429\b|\b5\d\d\b|overloaded|network|ECONN|超时|限流|网络/i;
const PERM_ERR = /permission|denied|unauthori[sz]ed|forbidden|\b40[13]\b|权限|未授权|拒绝访问/i;
const USER_STOP = /用户(?:拒绝|取消)|\buser\s+(?:denied|rejected|cancell?ed)\b/i;

export class RuleBasedBackend implements DecisionBackend {
  readonly name = "rules" as const;
  readonly level = 3 as const;
  unavailableReason() {
    return null;
  }
  async classifyTask(input: TaskInput) {
    const c = classifyTask(input);
    return { value: c, confidence: c.confidence };
  }
  async chooseTool(goal: string, tools: readonly ToolSpec[]) {
    let best: string | null = null;
    let top = 0;
    for (const t of tools) {
      const s = overlap(goal, `${t.name.replace(/_/g, " ")} ${t.description}`);
      if (s > top) {
        best = t.name;
        top = s;
      }
    }
    return { value: best, confidence: best ? Math.min(0.8, 0.4 + top) : 0.5 };
  }
  async checkDone(goal: string, result: string) {
    return { value: result.trim().length > 0 && !ERROR_MARK.test(result) && overlap(goal, result) >= 0.2, confidence: 0.5 };
  }
  async assessRisk(action: string) {
    const risk: Risk = RISK_HIGH.test(action) ? "high" : RISK_MEDIUM.test(action) ? "medium" : "low";
    return { value: risk, confidence: 0.6 };
  }
  async evaluateResult(goal: string, result: string) {
    if (!result.trim()) return { value: 0, confidence: 0.7 };
    return { value: ERROR_MARK.test(result) ? 0.1 : Math.min(1, 0.3 + 0.7 * overlap(goal, result)), confidence: 0.5 };
  }
  async replan(i: ReplanInput) {
    const e = i.error;
    const value: ReplanStrategy = USER_STOP.test(e)
      ? "abort"
      : PERM_ERR.test(e) || i.attempts >= 3
        ? "ask_user"
        : RETRY_ERR.test(e)
          ? "retry"
          : i.attempts >= 2
            ? "new_plan"
            : "modify_step";
    return { value, confidence: 0.6 };
  }
}

// ---------- 第 1 级：云端 Jev ----------

const NONE_TOOL = "__none__";

export class CloudJevBackend implements DecisionBackend {
  readonly name = "cloud-jev" as const;
  readonly level = 1 as const;
  constructor(
    private readonly client: JevClient | null,
    private readonly missingReason = "没有配置 TYPESAFE_API_KEY",
  ) {}
  unavailableReason() {
    return this.client ? null : this.missingReason;
  }
  #c(): JevClient {
    if (!this.client) throw new JevError("no_key");
    return this.client;
  }

  /** 一次请求问完所有能力问题；long_context、zh 由代码确定，不问模型 */
  async classifyTask(input: TaskInput, signal?: AbortSignal) {
    const atts = input.attachments ?? [];
    const state = {
      message: input.text,
      attachments: atts.map((a) => `${a.kind}${a.name ? ` ${a.name}` : ""}${a.chars ? ` (${a.chars} chars)` : ""}`).join("; ") || "none",
    };
    const questions: Record<string, NoulQuestion> = Object.fromEntries(Object.entries(CLASSIFY_QUESTIONS).map(([k, q]) => [k, noul(q)]));
    if (atts.some((a) => a.kind === "image")) {
      questions.vision = noul(VISION_QUESTION);
    }
    const r = await this.#c().ask(state, questions, signal);
    const probs = Object.fromEntries(Object.entries(r.answers).map(([k, a]) => [k, a.noul]));
    const value: Classification = classificationFromProbs(input, probs, "Jev");
    return { value, confidence: value.confidence };
  }

  async chooseTool(goal: string, tools: readonly ToolSpec[], signal?: AbortSignal) {
    if (!tools.length) return { value: null, confidence: 1 };
    if (tools.length > 254) throw new JevError("bad_request", { detail: "工具超过 254 个" });
    const criteria: Record<string, string | null> = { [NONE_TOOL]: "No tool is needed" };
    for (const t of tools) criteria[t.name] = t.description;
    const r = await this.#c().choice({ goal }, "Which tool should be used next to make progress on `goal`?", criteria, signal);
    return { value: r.choice === NONE_TOOL ? null : r.choice, confidence: r.confidence };
  }

  async checkDone(goal: string, result: string, signal?: AbortSignal) {
    const r = await this.#c().noul({ goal, result }, "Does `result` fully accomplish `goal`?", signal);
    return { value: r.noul >= 0.5, confidence: r.confidence };
  }

  async assessRisk(action: string, signal?: AbortSignal) {
    const r = await this.#c().score(
      action,
      "How risky is it to perform this action without asking the user first?",
      [
        "Harmless: read-only or trivially reversible",
        "Moderate: changes local state or contacts an external service, but can be undone",
        "Dangerous: destructive, irreversible, financial, or affects other people",
      ],
      signal,
    );
    const risk: Risk = r.score < 0.5 ? "low" : r.score < 1.5 ? "medium" : "high";
    return { value: risk, confidence: r.confidence };
  }

  async evaluateResult(goal: string, result: string, signal?: AbortSignal) {
    const r = await this.#c().score({ goal, result }, "How well does `result` achieve `goal`?", ["Fails", "Partially", "Mostly", "Fully"], signal);
    return { value: Math.max(0, Math.min(1, r.score / 3)), confidence: r.confidence };
  }

  async replan(i: ReplanInput, signal?: AbortSignal) {
    const r = await this.#c().choice(
      { goal: i.goal, failed_step: i.failedStep, error: i.error, attempts: String(i.attempts) },
      "What is the best next move after `failed_step` failed with `error`?",
      {
        retry: "Retry the same step unchanged (transient error such as a timeout or rate limit)",
        modify_step: "Retry with a changed step (fix arguments or approach)",
        new_plan: "Discard the current plan and plan again",
        ask_user: "Ask the user for help, permission or missing information",
        abort: "Stop the task",
      },
      signal,
    );
    return { value: r.choice, confidence: r.confidence };
  }
}

// ---------- 降级链 ----------

export interface DecisionMeta {
  backend: BackendName;
  level: BackendLevel;
  /** 不是由第 1 级做出的决策 */
  degraded: boolean;
  confidence: number;
  skipped: { backend: BackendName; reason: string }[];
  latencyMs: number;
}

export interface Decision<T> {
  value: T;
  meta: DecisionMeta;
}

export class FallbackChain {
  readonly #backends: readonly DecisionBackend[];
  readonly #min: number;
  readonly #now: () => number;
  readonly #health: HealthTracker;

  constructor(backends: readonly DecisionBackend[], o: { minConfidence?: number; now?: () => number } = {}) {
    const sorted = [...backends].sort((a, b) => a.level - b.level);
    if (sorted.at(-1)?.level !== 3) throw new Error("决策链末尾必须是第 3 级 RuleBasedBackend");
    this.#backends = sorted;
    this.#min = o.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
    this.#now = o.now ?? Date.now;
    this.#health = new HealthTracker({ now: this.#now });
  }

  async run<T>(fn: (b: DecisionBackend) => Promise<Decided<T>>): Promise<Decision<T>> {
    const t0 = this.#now();
    const skipped: DecisionMeta["skipped"] = [];
    for (const b of this.#backends) {
      const last = b.level === 3;
      if (!last) {
        const why = b.unavailableReason();
        const st = this.#health.status(b.name, b.name);
        if (why || !st.ok) {
          skipped.push({ backend: b.name, reason: why ?? (st as { reason: string }).reason });
          continue;
        }
      }
      try {
        const d = await fn(b);
        if (!last) {
          this.#health.recordSuccess(b.name);
          if (d.confidence < this.#min) {
            skipped.push({ backend: b.name, reason: `置信度 ${d.confidence.toFixed(2)} 低于阈值 ${this.#min}` });
            continue;
          }
        }
        const meta: DecisionMeta = { backend: b.name, level: b.level, degraded: b.level > 1, confidence: d.confidence, skipped, latencyMs: this.#now() - t0 };
        return { value: d.value, meta };
      } catch (e) {
        if (isGoalQuotaControlError(e)) throw e;
        if (last) throw e;
        const code = e instanceof JevError ? e.code : "internal";
        if (code === "aborted") throw e;
        if (code === "auth" || code === "no_key" || code === "config") this.#health.markProviderDown(b.name, (e as Error).message);
        else this.#health.recordFailure(b.name);
        skipped.push({ backend: b.name, reason: `调用失败（${code}）` });
      }
    }
    throw new Error("决策链没有可用后端");
  }
}

// 目标模式的完成校验：只看执行记录（工具调用、文件改动、命令输出），模型的自述不算实据。
// 顺序：规则（矛盾 → 没有实据 → 明确满足）→ 规则判断不了且配置了 Jev 时问 Jev（decision-layer.ts）→ 否则交给用户确认。
// 规则偏保守：done 会直接结束目标，所以只在适用的检查全部满足时判 done；拿不准就返回 null，交给 Jev 或用户。
import { redact } from "../core/redact";
import { DEFAULT_MIN_CONFIDENCE } from "./jev-config";

export interface ToolCallEvidence {
  tool: string;
  /** 只读工具（读文件、列目录、搜索）；没写明时按会写入处理 */
  read_only: boolean;
  ok: boolean;
  /** 操作对象：路径或网址 */
  target?: string;
  /** 一句话结果或失败原因 */
  summary?: string;
}

export type FileAction = "created" | "modified" | "deleted" | "moved";
export const FILE_ACTIONS: readonly FileAction[] = ["created", "modified", "deleted", "moved"];

export interface FileChangeEvidence {
  path: string;
  action: FileAction;
  /** moved 时的新路径 */
  to?: string;
}

export interface CommandEvidence {
  command: string;
  /** null：没有正常退出（超时或被终止） */
  exit_code: number | null;
  /** 输出末尾：测试汇总一般在最后 */
  output: string;
}

/** 执行实据。claim 是模型自己说的结果：只用来区分「只有自述」和「什么都没做」，不作为完成依据，也不发给 Jev */
export interface Evidence {
  tool_calls: ToolCallEvidence[];
  file_changes: FileChangeEvidence[];
  command_outputs: CommandEvidence[];
  claim?: string;
}

export type EvidenceVerdict = "done" | "not_done" | "uncertain";

export interface EvidenceResult {
  verdict: EvidenceVerdict;
  reason: string;
  confidence?: number;
  /** 谁下的结论：路由面板据此写明「规则」或「Jev」 */
  by: "rules" | "jev";
}
// 每轮保存的上限（goal.ts 存进 rounds）。合并多轮做判断时不再截断条数
export const MAX_TOOL_CALLS = 40;
export const MAX_FILE_CHANGES = 100;
export const MAX_COMMANDS = 15;
export const MAX_OUTPUT_CHARS = 1000;
export const MAX_COMMAND_CHARS = 300;
export const MAX_FIELD_CHARS = 300;
export const MAX_PATH_CHARS = 1024;
export const MAX_CLAIM_CHARS = 2000;
export const MAX_GOAL_CHARS = 2000;

export const CLAIM_ONLY_REASON = "AI 声称完成，但无实据";
export const NO_RECORD_REASON = "这一轮没有可核对的执行记录";
export const NO_JUDGE_REASON = "有执行记录，但规则无法确认是否完成，也没有配置 Jev，请你确认";

export const emptyEvidence = (): Evidence => ({ tool_calls: [], file_changes: [], command_outputs: [] });

// 先截一个较大的窗口再脱敏（避免对超长文本跑正则），最后截到保存长度。窗口边界上被截断的密钥碎片会在最后一步被丢掉
const WINDOW = 8000;
const CTRL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const line = (s: unknown, n: number) => {
  const v = redact(String(s ?? "").slice(0, WINDOW).replace(/\s+/g, " ").trim());
  return v.length > n ? `${v.slice(0, n - 1)}…` : v;
};
const tail = (s: unknown, n: number) => {
  const raw = String(s ?? "");
  const v = redact(raw.slice(-WINDOW).replace(/\r\n?/g, "\n").replace(CTRL, "")).trimEnd();
  return v.length > n ? `…${v.slice(-(n - 1))}` : v;
};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
const lastN = <T>(a: T[], n: number | null) => (n === null || a.length <= n ? a : a.slice(-n));

/**
 * 规整执行记录：去掉控制字符、脱敏、截断长文本；cap 为 true 时每类只保留最近的若干条（保存时用）。
 * 结果再规整一次不变，保存后读回再保存不会越截越短。
 */
export function sanitizeEvidence(e: unknown, o: { cap?: boolean } = {}): Evidence {
  const cap = o.cap ?? true;
  const src = obj(e);
  const tool_calls = lastN(arr(src.tool_calls), cap ? MAX_TOOL_CALLS : null).map((x): ToolCallEvidence => {
    const t = obj(x);
    const out: ToolCallEvidence = { tool: line(t.tool, 80) || "unknown", read_only: t.read_only === true, ok: t.ok === true };
    const target = line(t.target, MAX_PATH_CHARS);
    const summary = line(t.summary, MAX_FIELD_CHARS);
    if (target) out.target = target;
    if (summary) out.summary = summary;
    return out;
  });
  const file_changes = lastN(arr(src.file_changes), cap ? MAX_FILE_CHANGES : null)
    .map((x): FileChangeEvidence => {
      const f = obj(x);
      const action = (FILE_ACTIONS as readonly unknown[]).includes(f.action) ? (f.action as FileAction) : "modified";
      const out: FileChangeEvidence = { path: line(f.path, MAX_PATH_CHARS), action };
      const to = line(f.to, MAX_PATH_CHARS);
      if (action === "moved" && to) out.to = to;
      return out;
    })
    .filter((f) => f.path);
  const command_outputs = lastN(arr(src.command_outputs), cap ? MAX_COMMANDS : null)
    .map((x): CommandEvidence => {
      const c = obj(x);
      const code = c.exit_code;
      return { command: line(c.command, MAX_COMMAND_CHARS), exit_code: typeof code === "number" && Number.isInteger(code) ? code : null, output: tail(c.output, MAX_OUTPUT_CHARS) };
    })
    .filter((c) => c.command);
  const out: Evidence = { tool_calls, file_changes, command_outputs };
  const claim = line(src.claim, MAX_CLAIM_CHARS);
  if (claim) out.claim = claim;
  return out;
}

/** 合并多轮记录（按时间先后），用于判断整个目标是否完成；claim 取最后一个有的 */
export function mergeEvidence(list: readonly (Evidence | null | undefined)[]): Evidence {
  const out = emptyEvidence();
  for (const e of list) {
    if (!e) continue;
    out.tool_calls.push(...arr(e.tool_calls).map((x) => x as ToolCallEvidence));
    out.file_changes.push(...arr(e.file_changes).map((x) => x as FileChangeEvidence));
    out.command_outputs.push(...arr(e.command_outputs).map((x) => x as CommandEvidence));
    if (typeof e.claim === "string" && e.claim.trim()) out.claim = e.claim;
  }
  return out;
}

// ---------- 规则 ----------

// 测试命令：包管理器的 test 脚本（中间可以有 -s、--filter web 之类，最多 3 段）、常见测试框架、make test。
// 后面必须是空白、冒号（test:unit）或命令分隔符，排除 vitest.config.ts、npm view test-pkg 这类
const END = String.raw`(?=$|[\s:;&|)])`;
const TEST_CMD = new RegExp(
  String.raw`(?:^|[\s;&|(/])(?:(?:npm|pnpm|yarn|bun|cargo|go|dotnet|mvn|mvnw|gradle|gradlew|deno|mix|swift)(?:\s+[^\s;&|]+){0,3}?\s+(?:run\s+)?test${END}|(?:pytest|jest|vitest|mocha|rspec|phpunit|ctest|tox)${END}|make\s+(?:test|check)${END}|manage\.py\s+test${END}|node\s+--test${END})`,
  "i",
);
// 目标说的是「让测试通过」这类事
const TEST_GOAL = /测试|单测|单元测试|用例|\btests?\b|\bspecs?\b|\bci\b/i;
// 装依赖不是跑测试（pnpm add -D vitest）
const INSTALL = /^\s*(?:npm|pnpm|yarn|bun)\s+(?:add|install|i|remove|uninstall|update|up)\b/i;
// 测试输出里的失败汇总：退出码是 0 但输出写了失败时也不算通过（例如管道吞掉了退出码）。
// 大写的 FAILED / FAIL 区分大小写，避免把「0 failed」当成失败
const FAILURE = [/\b[1-9]\d*\s+(?:\w+\s+)?(?:failed|failing|failures?)\b/i, /\bFAILED\b/, /^\s*FAIL\s/m, /--- FAIL:/, /\bFailures:\s*[1-9]/];
export const isTestCommand = (c: CommandEvidence) => c.command.split(/&&|\|\||;/).some((part) => TEST_CMD.test(part) && !INSTALL.test(part));
export const testPassed = (c: CommandEvidence) => c.exit_code === 0 && !FAILURE.some((r) => r.test(c.output));

// 产出文件：「生成 / 创建 / 写一个 / 保存为 / 导出到 …」后面点名的文件。只看动词后面一小段，避免把输入文件当成产出
const OUTPUT_VERB =
  /(?:生成|创建|新建|写一个|写一份|写一篇|写个|写入|写到|保存为|保存到|另存为|导出到|导出为|导出|输出到|输出为|输出|改名为|重命名为|命名为|复制到|移动到|\b(?:creates?|generates?|writes?|saves?|exports?|outputs?|produces?|renames?)\b)(?:一个|一份|一篇|一张)?/gi;
const STOP = /(?:根据|基于|参考|然后|接着|之后|再|并且|并|。|；|;|\n|\b(?:from|using|based on|then|and then)\b)/i;
const QUOTED = /[「『]([^」』\n]{1,200})[」』]|“([^”\n]{1,200})”|"([^"\n]{1,200})"|'([^'\n]{1,200})'|`([^`\n]{1,200})`/g;
// 引号里的文件名可以有空格（「周报 第3周.docx」）
const FILE_LIKE = /^[^\n"'“”「」『』]{1,200}\.(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{1,8}$/;
// 文件名可以含中文（「生成周报.docx」）；扩展名至少有一个字母（排除 3.5、v1.2 这类数字）
const BARE_FILE = /(?:^|[^\w.\/\\~一-鿿-])((?:~?\/)?[\w.\-\/\\一-鿿]*[\w一-鿿]\.(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{1,8})(?![\w])/g;
const quotedValues = (s: string) => [...s.matchAll(QUOTED)].map((m) => m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? "");

/** 目标里点名要产出的文件 */
export function namedOutputs(goal: string): string[] {
  const out = new Map<string, string>();
  for (const m of goal.matchAll(OUTPUT_VERB)) {
    let seg = goal.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 120);
    const stop = seg.search(STOP);
    if (stop >= 0) seg = seg.slice(0, stop);
    const names = quotedValues(seg).map((q) => q.trim()).filter((q) => FILE_LIKE.test(q));
    const rest = seg.replace(QUOTED, " ");
    for (const b of rest.matchAll(BARE_FILE)) names.push(b[1]);
    for (const n of names) out.set(normPath(n), n);
  }
  return [...out.values()];
}

// 期望输出：「输出 "hello"」「应该打印 'OK 3'」「prints "done"」里引号中的文本（不是文件名）
const EXPECT_VERB = /(?:输出|打印|返回|显示|结果是|结果为|\b(?:prints?|outputs?|returns?|shows?|displays?)\b)\s*(?:为|是|成|出|:|：)?\s*/gi;
export function expectedOutputs(goal: string): string[] {
  const out = new Set<string>();
  for (const m of goal.matchAll(EXPECT_VERB)) {
    const rest = goal.slice((m.index ?? 0) + m[0].length);
    const q = /^(?:[「『]([^」』\n]{1,200})[」』]|“([^”\n]{1,200})”|"([^"\n]{1,200})"|'([^'\n]{1,200})'|`([^`\n]{1,200})`)/.exec(rest);
    const v = q ? (q[1] ?? q[2] ?? q[3] ?? q[4] ?? q[5] ?? "").trim() : "";
    if (v.length >= 3 && !FILE_LIKE.test(v)) out.add(v);
  }
  return [...out];
}

const normPath = (p: string) =>
  p
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^~\//, "")
    .replace(/\/$/, "")
    .toLowerCase();
const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/** 最终存在的产出路径：创建、修改、移动的目标；之后又删掉或移走的不算 */
function producedPaths(e: Evidence): Set<string> {
  const have = new Set<string>();
  for (const f of e.file_changes) {
    const p = normPath(f.path);
    if (f.action === "created" || f.action === "modified") have.add(p);
    else if (f.action === "deleted") have.delete(p);
    else if (f.action === "moved") {
      have.delete(p);
      if (f.to) have.add(normPath(f.to));
    }
  }
  return have;
}
const hasPath = (paths: Set<string>, name: string) => {
  const n = normPath(name);
  if (!n) return false;
  for (const p of paths) if (p === n || p.endsWith(`/${n}`)) return true;
  return false;
};

/** 每条命令只看最后一次运行 */
function lastRuns(cmds: readonly CommandEvidence[]): CommandEvidence[] {
  const m = new Map<string, CommandEvidence>();
  for (const c of cmds) {
    const k = squash(c.command);
    m.delete(k);
    m.set(k, c);
  }
  return [...m.values()];
}

// 「写测试 / 补用例」：只看测试通过不够，还要有文件改动
const WRITE_TESTS = /(?:写|补|加|增加|添加|新增|编写)(?:一些|几个|单元)?(?:测试|单测|用例)|\b(?:add|write)\s+(?:\w+\s+)?tests?\b/i;

/**
 * 规则判断；返回 null 表示规则拿不准（交给 Jev 或用户）。
 * 1. 矛盾 → not_done：测试命令最后一次运行没通过。
 * 2. 没有实据：只有自述 → uncertain（AI 声称完成，但无实据）；什么都没有 → not_done。
 * 3. 明确满足 → done：目标里能核对的条件全部满足（测试通过、点名的文件已产出、期望的文本出现在成功命令的输出里）。
 */
export function judgeByRules(goal: string, evidence: Evidence): EvidenceResult | null {
  const e = sanitizeEvidence(evidence, { cap: false });
  const tests = lastRuns(e.command_outputs).filter(isTestCommand);
  const failing = tests.find((c) => !testPassed(c));
  if (failing) {
    const why = failing.exit_code === null ? "没有正常结束" : failing.exit_code !== 0 ? `退出码 ${failing.exit_code}` : "输出里有失败";
    return { verdict: "not_done", reason: `测试没有通过：${failing.command}（${why}）`, by: "rules" };
  }
  const hard = e.file_changes.length > 0 || e.command_outputs.length > 0 || e.tool_calls.some((t) => t.ok && !t.read_only);
  if (!hard) return e.claim ? { verdict: "uncertain", reason: CLAIM_ONLY_REASON, by: "rules" } : { verdict: "not_done", reason: NO_RECORD_REASON, by: "rules" };

  const met: string[] = [];
  let unmet = false;
  const produced = producedPaths(e);
  if (TEST_GOAL.test(goal)) {
    if (tests.length === 0 || (WRITE_TESTS.test(goal) && produced.size === 0)) unmet = true;
    else met.push(`测试通过：${tests.map((c) => c.command).join("、")}`);
  }
  const names = namedOutputs(goal);
  if (names.length) {
    if (names.every((n) => hasPath(produced, n))) met.push(`已产出 ${names.join("、")}`);
    else unmet = true;
  }
  const expects = expectedOutputs(goal);
  if (expects.length) {
    const outputs = e.command_outputs.filter((c) => c.exit_code === 0).map((c) => squash(c.output));
    if (expects.every((x) => outputs.some((o) => o.includes(squash(x))))) met.push(`命令输出包含 ${expects.map((x) => `「${x}」`).join("、")}`);
    else unmet = true;
  }
  return met.length && !unmet ? { verdict: "done", reason: met.join("；"), by: "rules" } : null;
}

// ---------- Jev ----------

/** 发给 Jev 的问题。jev-config.ts 冻结，新问题放在这里 */
export const JEV_EVIDENCE_QUESTION = "Based only on the execution `record` (tool calls, file changes, command outputs), has `goal` been fully accomplished?";

// 每段只保留最近的若干行，整体不超过 Jev state 上限（MAX_STATE_CHARS 2 万，JSON 转义留余量）
const fit = (lines: string[], budget: number) => {
  const out: string[] = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    used += lines[i].length + 1;
    if (used > budget) {
      out.unshift(`… ${i + 1} earlier omitted`);
      break;
    }
    out.unshift(lines[i]);
  }
  return out;
};

/** 发给 Jev 的 state：目标 + 执行记录。不含模型自述（claim），避免它替自己作证 */
export function evidenceRecord(goal: string, evidence: Evidence): { goal: string; record: string } {
  const e = sanitizeEvidence(evidence, { cap: false });
  const calls = e.tool_calls.map((t) => `- ${t.tool}${t.read_only ? " (read-only)" : ""}: ${t.ok ? "ok" : "failed"}${t.target ? ` · ${t.target}` : ""}${t.summary ? ` · ${t.summary}` : ""}`);
  const files = e.file_changes.map((f) => `- ${f.action} ${f.path}${f.to ? ` -> ${f.to}` : ""}`);
  const cmds = e.command_outputs.map((c) => `$ ${c.command}  (exit ${c.exit_code ?? "none"})\n${c.output || "(no output)"}`);
  const section = (title: string, lines: string[], budget: number) => `${title}:\n${lines.length ? fit(lines, budget).join("\n") : "(none)"}`;
  const record = [section("tool calls", calls, 4000), section("file changes", files, 4000), section("command outputs", cmds, 7000)].join("\n\n");
  return { goal: line(goal, MAX_GOAL_CHARS), record };
}

/** Jev 给出的完成概率 p 转成结论：确定程度 |2p − 1| 达到阈值（与决策链相同，默认 0.6）才下 done / not_done，否则交给用户 */
export function verdictFromProbability(p: number, minConfidence = DEFAULT_MIN_CONFIDENCE): EvidenceResult {
  if (!(p >= 0 && p <= 1)) return { verdict: "uncertain", reason: "Jev 返回的结果无效，请你确认", by: "jev" };
  const confidence = Math.abs(2 * p - 1);
  const c = confidence.toFixed(2);
  if (confidence < minConfidence) return { verdict: "uncertain", reason: `Jev 拿不准是否完成（把握 ${c}，低于 ${minConfidence}），请你确认`, confidence, by: "jev" };
  return p > 0.5
    ? { verdict: "done", reason: `Jev 根据执行记录判断已完成（把握 ${c}）`, confidence, by: "jev" }
    : { verdict: "not_done", reason: `Jev 根据执行记录判断还没完成（把握 ${c}）`, confidence, by: "jev" };
}

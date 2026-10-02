// 杀手场景（整理下载文件夹里最近 30 天的 PDF）的确定性模拟模型。不调用任何真实 API。
// 它只读运行时发给模型的提示词（规划、续写规划、总结），按里面 <tool_output> 的真实工具结果决定下一步：
//   第 1 轮：列出 ~/Downloads 里最近 30 天的 PDF（more）
//   第 2 轮：逐个 read_pdf（more）
//   第 3 轮：按标题和正文判断主题 → 建文件夹 → 移动（goal 里写主题和理由）
// 主题判断是关键词规则，代替真实模型的判断；真实模型接入时走同一条运行时路径。
import type { LlmCall, LlmRequest } from "@/agent/types";

export const TOPICS = ["技术", "财务", "合同", "论文", "其他"] as const;
export type Topic = (typeof TOPICS)[number];
const RULES: [Exclude<Topic, "其他">, RegExp][] = [
  ["合同", /合同|协议|甲方|乙方|条款|签订|租赁|违约/g],
  ["财务", /财务|营业收入|净利润|现金流|报销|发票|金额|预算|季度报告/g],
  ["论文", /摘要|关键词|参考文献|论文|研究|abstract|references/gi],
  ["技术", /编程|接口|API|部署|配置|SDK|Rust|架构|代码|运行时|技术/gi],
];
const P = "mcp__files__";

/** 按标题和正文判断主题；理由写命中的关键词 */
export function classify(title: string, text: string): { topic: Topic; reason: string } {
  const body = `${title}\n${text}`;
  if (!body.trim()) return { topic: "其他", reason: "没有可提取的文本（可能是扫描件），归入其他" };
  let best: { topic: Topic; hits: string[] } = { topic: "其他", hits: [] };
  for (const [topic, re] of RULES) {
    const hits = [...new Set(body.match(re) ?? [])];
    if (hits.length > best.hits.length) best = { topic, hits };
  }
  if (!best.hits.length) return { topic: "其他", reason: "标题和正文没有明显的主题特征，归入其他" };
  return { topic: best.topic, reason: `${title ? "标题和正文" : "正文"}出现「${best.hits.slice(0, 4).join("、")}」` };
}

interface Output {
  source: string;
  data: Record<string, unknown> | null;
}
const TAG = /<tool_output source="([^"]+)" untrusted="true">\n([\s\S]*?)\n<\/tool_output>/g;
function outputs(text: string): Output[] {
  return [...text.matchAll(TAG)].map((m) => {
    try {
      return { source: m[1], data: JSON.parse(m[2]) as Record<string, unknown> };
    } catch {
      return { source: m[1], data: null };
    }
  });
}
const str = (v: unknown) => (typeof v === "string" ? v : "");
const base = (p: string) => p.split("/").pop() ?? p;
const plan = (steps: object[], more = false) => JSON.stringify(more ? { steps, more } : { steps });
export const MOVE_GOAL = /^把 (.+) 移到 ~\/Downloads\/(\S+)\/（主题：(\S+?)；理由：(.+)）$/;

function nextPlan(user: string, root: string, days: number, batch: number): string {
  const outs = outputs(user);
  const listed = outs.find((o) => o.source === `${P}list_directory`)?.data;
  if (!listed) {
    return plan([{ goal: `列出 ${root} 里最近 ${days} 天修改的 PDF`, tool: `${P}list_directory`, args: { path: root, extension: "pdf", modified_within_days: days } }], true);
  }
  const pdfs = (Array.isArray(listed.entries) ? listed.entries : []).filter((e: { type?: string }) => e.type === "file").map((e: { path?: unknown }) => str(e.path));
  const read = outs.filter((o) => o.source === `${P}read_pdf` && o.data).map((o) => o.data!);
  const unread = pdfs.filter((p) => !read.some((d) => str(d.path) === p));
  // 每批不超过 batch 步；还有剩下的就标 more，等下一轮续写
  if (unread.length) return plan(unread.slice(0, batch).map((p) => ({ goal: `读取 ${base(p)} 的标题和前几页`, tool: `${P}read_pdf`, args: { path: p, max_pages: 3, max_chars: 1500 } })), true);
  const made = new Set(outs.filter((o) => o.source === `${P}create_directory` && o.data).map((o) => base(str(o.data!.path))));
  const moved = new Set(outs.filter((o) => o.source === `${P}move_file` && o.data).map((o) => str(o.data!.src)));
  const sorted = read.map((d) => ({ path: str(d.path), ...classify(str(d.title), str(d.text)) })).filter((s) => !moved.has(s.path));
  const dirs = TOPICS.filter((t) => !made.has(t) && sorted.some((s) => s.topic === t));
  const steps = [
    ...dirs.map((t) => ({ goal: `创建分类文件夹 ${t}`, tool: `${P}create_directory`, args: { path: `${root}/${t}` } })),
    ...sorted.map((s) => ({ goal: `把 ${base(s.path)} 移到 ${root}/${s.topic}/（主题：${s.topic}；理由：${s.reason}）`, tool: `${P}move_file`, args: { src: s.path, dst: `${root}/${s.topic}` } })),
  ];
  return plan(steps.slice(0, batch), steps.length > batch);
}

/** 总结：从各步骤结果里取移动记录，输出整理报告 */
function report(user: string): string {
  const rows: string[] = [];
  const re = /- (.+)\n<tool_output source="mcp__files__move_file" untrusted="true">\n([\s\S]*?)\n<\/tool_output>/g;
  for (const m of user.matchAll(re)) {
    const g = MOVE_GOAL.exec(m[1]);
    let d: Record<string, unknown> = {};
    try {
      d = JSON.parse(m[2]) as Record<string, unknown>;
    } catch {
      // 截断的结果：只用 goal 里的信息
    }
    if (g) rows.push(`| ${g[1]} | ${str(d.src) || `~/Downloads/${g[1]}`} | ${str(d.dst) || `~/Downloads/${g[2]}/${g[1]}`} | ${g[3]} | ${g[4]} |`);
  }
  if (!rows.length) return "（模拟模型）没有移动任何文件：最近 30 天的下载里没有 PDF。";
  return [`（模拟模型）已整理 ${rows.length} 个 PDF：`, "", "| 文件 | 原位置 | 新位置 | 主题 | 判断理由 |", "| --- | --- | --- | --- | --- |", ...rows].join("\n");
}

/** 确定性模拟模型：只处理规划和总结；其余用途（参数、回答）返回空对象，正常流程用不到 */
/** delayMs：每次调用真实等待这么久，模拟真实模型的响应时间（比较两次运行快慢时用） */
export function killerMockLlm(o: { root?: string; days?: number; latencyMs?: number; batch?: number; delayMs?: number } = {}): { llm: LlmCall; calls: LlmRequest[] } {
  const root = o.root ?? "~/Downloads";
  const days = o.days ?? 30;
  const batch = o.batch ?? 12;
  const calls: LlmRequest[] = [];
  const llm: LlmCall = async (req) => {
    calls.push(req);
    if (o.delayMs) await new Promise((r) => setTimeout(r, o.delayMs));
    const user = req.messages.filter((m) => m.role === "user").at(-1)?.content ?? "";
    const text = req.purpose === "plan" ? nextPlan(user, root, days, batch) : req.purpose === "summary" ? report(user) : "{}";
    return { text, profileId: "mock/killer-scenario", latencyMs: o.latencyMs ?? o.delayMs ?? 0, usage: null };
  };
  return { llm, calls };
}

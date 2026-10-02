// 杀手场景的运行器：Vitest 和 tools/killer-scenario.ts 共用。
// 把 tests/fixtures/downloads/ 复制到临时 HOME 的 Downloads（按 manifest 设置修改时间），起真实的 eg-mcp-files 子进程，
// 用 AgentRuntime 跑完整流程，最后核对磁盘上的结果。永远不碰真实的 ~/Downloads。
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { mcpTools } from "@/agent/mcp/client";
import { connectStdioServer } from "@/agent/mcp/stdio";
import { AgentRuntime } from "@/agent/runtime";
import { ToolRegistry } from "@/agent/tools";
import type { MemoryNote } from "@/agent/memory";
import type { SkillNote } from "@/agent/skills";
import type { AgentEvent, ConfirmRequest, LlmCall, RunResult } from "@/agent/types";
import { DecisionLayer } from "@/decision/decision-layer";
import { MOVE_GOAL } from "./killer-mock-llm";

export const GOAL = "把下载文件夹里最近 30 天的 PDF 按主题分类";
export const BIN = fileURLToPath(new URL(`../target/debug/eg-mcp-files${process.platform === "win32" ? ".exe" : ""}`, import.meta.url));
const FIXTURES = fileURLToPath(new URL("./fixtures/downloads/", import.meta.url));
const MANIFEST = fileURLToPath(new URL("./fixtures/downloads-manifest.json", import.meta.url));
const TOOL_NAMES = ["list_directory", "read_file", "write_file", "create_directory", "move_file", "delete_file", "get_file_info", "read_pdf", "get_pdf_metadata"];
const DAY = 86_400_000;

export interface ManifestFile {
  name: string;
  days_ago: number;
  expected: string | null;
}
export const manifest = (): { topics: string[]; files: ManifestFile[] } => JSON.parse(readFileSync(MANIFEST, "utf8"));

/** 临时 HOME：Downloads 里放夹具，修改时间按 days_ago 设置（再往回拨 1 小时，避开边界） */
export function prepareHome(now = Date.now()): { home: string; downloads: string } {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "eg-killer-")));
  const downloads = join(home, "Downloads");
  mkdirSync(downloads);
  for (const f of manifest().files) {
    const dst = join(downloads, f.name);
    copyFileSync(join(FIXTURES, f.name), dst);
    const t = new Date(now - f.days_ago * DAY - 3_600_000);
    utimesSync(dst, t, t);
  }
  return { home, downloads };
}

export interface MoveRow {
  file: string;
  from: string;
  to: string;
  topic: string;
  reason: string;
}
export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}
export interface ScenarioResult {
  result: RunResult;
  ms: number;
  moves: MoveRow[];
  confirms: { tool: string; second: boolean }[];
  llmCalls: number;
  checks: Check[];
  /** 整理后 Downloads 的目录树（相对路径） */
  tree: string[];
}
function tree(dir: string, prefix = ""): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((e) => (e.isDirectory() ? [`${prefix}${e.name}/`, ...tree(join(dir, e.name), `${prefix}${e.name}/`)] : [`${prefix}${e.name}`]));
}

/** 跑一次完整场景。llm：模拟模型或真实模型；confirm 默认全部同意并记录 */
/** refuse(tool, n)：第 n 次确认这个工具时拒绝（n 从 1 开始），测拒绝路径用 */
export async function runScenario(o: {
  llm: LlmCall;
  home: string;
  downloads: string;
  onEvent?: (e: AgentEvent) => void;
  refuse?: (tool: string, n: number) => boolean;
  /** 默认是杀手场景原话；「再整理一次」这类重复执行时传入 */
  goal?: string;
  skills?: readonly SkillNote[];
  memories?: readonly MemoryNote[];
}): Promise<ScenarioResult> {
  // 父进程环境里放一个假 Key：验证子进程拿不到
  const parentEnv = { ...process.env, HOME: o.home, USERPROFILE: o.home, OPENAI_API_KEY: "sk-parent-secret-0123456789" };
  const { client, transport } = await connectStdioServer({ command: BIN, args: ["--allow", "~/Downloads"] }, { parentEnv });
  const confirms: { tool: string; second: boolean }[] = [];
  let llmCalls = 0;
  try {
    const { tools } = mcpTools(client, await client.listTools(), { server: "files", allowTools: TOOL_NAMES, trustAnnotations: true });
    const registry = new ToolRegistry(tools);
    const decision = DecisionLayer.fromEnv({ OPENAI_API_KEY: "x" }, { tools: registry.defs() });
    const confirm = async (req: ConfirmRequest) => {
      const tool = req.tool.replace("mcp__files__", "");
      confirms.push({ tool, second: req.second === true });
      return !o.refuse?.(tool, confirms.filter((c) => c.tool === tool).length);
    };
    const llm: LlmCall = (req, s) => {
      llmCalls++;
      return o.llm(req, s);
    };
    const t0 = Date.now();
    const result = await new AgentRuntime({ decision, tools: registry, llm: () => llm, confirm, onEvent: o.onEvent, skills: o.skills, memories: o.memories }).run(o.goal ?? GOAL);
    const ms = Date.now() - t0;
    const moves = result.steps.flatMap((s): MoveRow[] => {
      const m = s.status === "done" && s.step.tool === "mcp__files__move_file" ? MOVE_GOAL.exec(s.step.goal) : null;
      if (!m) return [];
      let d: { src?: string; dst?: string } = {};
      try {
        d = JSON.parse(s.output ?? "{}");
      } catch {
        // 输出被截断时只用 goal
      }
      return [{ file: m[1], from: d.src ?? `~/Downloads/${m[1]}`, to: d.dst ?? `~/Downloads/${m[2]}/${m[1]}`, topic: m[3], reason: m[4] }];
    });
    return { result, ms, moves, confirms, llmCalls, checks: verify(o.downloads, result, ms, moves, confirms), tree: tree(o.downloads) };
  } finally {
    await transport.close();
  }
}
export const TIME_LIMIT_MS = 180_000;

/** 对照验收标准逐项核对：以磁盘上的真实结果和运行记录为准 */
function verify(downloads: string, r: RunResult, ms: number, moves: MoveRow[], confirms: { tool: string; second: boolean }[]): Check[] {
  const files = manifest().files;
  const want = files.filter((f) => f.expected);
  const keep = files.filter((f) => !f.expected);
  const done = (tool: string) => r.steps.filter((s) => s.status === "done" && s.step.tool === `mcp__files__${tool}`);
  const listed = done("list_directory").flatMap((s) => {
    try {
      return (JSON.parse(s.output ?? "{}").entries ?? []).map((e: { name: string }) => e.name) as string[];
    } catch {
      return [];
    }
  });
  const read = new Set(done("read_pdf").map((s) => String(s.step.args?.path ?? "").split("/").pop()));
  const wrongTopic = want.filter((f) => moves.find((m) => m.file === f.name)?.topic !== f.expected).map((f) => f.name);
  const onDisk = want.filter((f) => existsSync(join(downloads, f.expected!, f.name)) && !existsSync(join(downloads, f.name)));
  const dirs = [...new Set(want.map((f) => f.expected!))];
  const moveConfirms = confirms.filter((c) => c.tool === "move_file").length;
  const set = (a: string[]) => [...a].sort().join("、");
  return [
    { name: "列出最近 30 天的 PDF", ok: set(listed) === set(want.map((f) => f.name)), detail: `列出 ${listed.length} 个：${set(listed)}` },
    { name: "读取 PDF 内容", ok: want.every((f) => read.has(f.name)), detail: `read_pdf 成功 ${read.size} 个` },
    { name: "判断主题", ok: wrongTopic.length === 0 && moves.every((m) => m.reason.length > 0), detail: wrongTopic.length ? `与预期不符：${wrongTopic.join("、")}` : `${moves.length} 个文件都给出主题和理由，与夹具预期一致` },
    { name: "创建分类文件夹", ok: dirs.every((d) => existsSync(join(downloads, d)) && statSync(join(downloads, d)).isDirectory()), detail: dirs.join("、") },
    { name: "移动文件（每次移动前确认）", ok: onDisk.length === want.length && moveConfirms === moves.length && moves.length === want.length, detail: `磁盘上到位 ${onDisk.length}/${want.length}；移动确认 ${moveConfirms} 次` },
    { name: "不碰范围外的文件", ok: keep.every((f) => existsSync(join(downloads, f.name))), detail: `保留在原位：${keep.map((f) => f.name).join("、")}` },
    { name: "输出整理报告", ok: moves.length === want.length && r.summary.includes("|") && want.every((f) => r.summary.includes(f.name)), detail: `报告 ${moves.length} 行（文件、原位置、新位置、主题、理由）` },
    { name: "全程 < 3 分钟", ok: ms < TIME_LIMIT_MS, detail: `${(ms / 1000).toFixed(2)} 秒` },
    { name: "中途不反问用户", ok: r.status === "completed", detail: `运行状态 ${r.status}` },
  ];
}

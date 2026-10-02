// 杀手场景脚本：由 tools/killer-scenario-test.sh --real 调用，结果写入 docs/KILLER_SCENARIO_REPORT.md。
// 工具是真实的：eg-mcp-files 子进程（JSON-RPC + stdio），在临时 HOME 的 Downloads 副本上真实读 PDF、建目录、移动文件。
// 模型：凭据文件有效（EG_TEST_*）时走真实中转站模型；否则用确定性模拟模型。报告写明用的是哪一种。
// 不碰真实的 ~/Downloads；报告不含 Key、Base URL 和模型回复原文。
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { OpenAIProvider } from "@/core/llm";
import type { LlmCall } from "@/agent/types";
import { killerMockLlm } from "../tests/killer-mock-llm";
import { GOAL, TIME_LIMIT_MS, prepareHome, runScenario, type ScenarioResult } from "../tests/killer-scenario-harness";

const env = process.env;
const REPORT = fileURLToPath(new URL("../docs/KILLER_SCENARIO_REPORT.md", import.meta.url));
const real = Boolean(env.EG_TEST_BASE_URL && env.EG_TEST_API_KEY && env.EG_TEST_MODEL);

function realLlm(): LlmCall {
  const p = new OpenAIProvider({ id: "custom:relay", kind: "openai-compatible", baseUrl: env.EG_TEST_BASE_URL!, apiKey: env.EG_TEST_API_KEY!, timeoutMs: 90_000 });
  return async (req, signal) => {
    const r = await p.chat({ model: env.EG_TEST_MODEL!, messages: req.messages, maxTokens: req.maxTokens ?? 2000, signal });
    return { text: r.text, profileId: `custom:relay/${env.EG_TEST_MODEL}`, latencyMs: r.latencyMs, usage: r.usage };
  };
}

/** 按工具统计确认次数；读取类工具被规则从严要求确认时（例如子目标里有「修改」字样）也如实列出 */
function confirmLine(r: ScenarioResult): string {
  const n = (t: string) => r.confirms.filter((c) => c.tool === t).length;
  const other = r.confirms.length - n("create_directory") - n("move_file");
  const reads = [...new Set(r.confirms.map((c) => c.tool).filter((t) => t !== "create_directory" && t !== "move_file"))];
  return [`建文件夹 ${n("create_directory")} 次`, `移动 ${n("move_file")} 次`, other ? `读取类 ${other} 次（${reads.join("、")}：子目标里有「修改」等字样，风险规则从严要求确认）` : "读取类工具不需要确认"].join("，");
}

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

function render(r: ScenarioResult, mode: string, at: string): string {
  const passed = r.checks.every((c) => c.ok);
  const lines = [
    "# 杀手场景报告：整理下载文件夹里最近 30 天的 PDF",
    "",
    `运行时间：${at}　模型：${mode}　结论：${passed ? "全部通过" : "未通过"}`,
    "",
    `任务原文：「${GOAL}」。工具是真实的 eg-mcp-files 子进程（JSON-RPC + stdio），操作的是临时目录里 tests/fixtures/downloads/ 的副本（8 个 PDF + 1 个 txt 干扰文件），没有碰真实的下载文件夹。`,
    "",
    "## 验收",
    "",
    "| 项目 | 结果 | 说明 |",
    "| --- | --- | --- |",
    ...r.checks.map((c) => `| ${c.name} | ${c.ok ? "通过" : "未通过"} | ${cell(c.detail)} |`),
    "",
    "## 整理结果",
    "",
    "| 文件 | 原位置 | 新位置 | 主题 | 判断理由 |",
    "| --- | --- | --- | --- | --- |",
    ...r.moves.map((m) => `| ${cell(m.file)} | ${cell(m.from)} | ${cell(m.to)} | ${m.topic} | ${cell(m.reason)} |`),
    "",
    "## 运行记录",
    "",
    `- 用时 ${(r.ms / 1000).toFixed(2)} 秒（上限 ${TIME_LIMIT_MS / 1000} 秒），模型调用 ${r.llmCalls} 次，执行步骤 ${r.result.steps.length} 个，运行状态 ${r.result.status}。`,
    `- 确认 ${r.confirms.length} 次：${confirmLine(r)}。脚本自动同意，界面里由用户逐个点。`,
    `- 整理后的目录：${r.tree.map((t) => `\`${t}\``).join("、")}`,
    "",
  ];
  return lines.join("\n");
}

async function main(): Promise<number> {
  const { home, downloads } = prepareHome();
  const mode = real ? `真实模型（中转站 ${env.EG_TEST_MODEL}）` : "确定性模拟模型（没有凭据文件；按标题和正文关键词判断主题，代替真实模型）";
  const llm = real ? realLlm() : killerMockLlm().llm;
  console.log(`杀手场景开始：${mode}`);
  const r = await runScenario({ llm, home, downloads, onEvent: (e) => e.type === "step_start" && console.log(`  · ${e.step.goal}`) });
  writeFileSync(REPORT, render(r, mode, new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC"));
  for (const c of r.checks) console.log(`${c.ok ? "通过" : "失败"}  ${c.name} · ${c.detail}`);
  console.log(`报告已写入 docs/KILLER_SCENARIO_REPORT.md`);
  return r.checks.every((c) => c.ok) ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`杀手场景出错：${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  },
);

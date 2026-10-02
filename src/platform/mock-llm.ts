// 浏览器模式的模拟模型与演示工具：不调用任何真实 API，只为在 VM / 浏览器里跑通 UI 全流程。
// 回复按 Agent 运行时的提示词结构生成（src/agent/planner.ts、runtime.ts），文案里标明是模拟结果。
import { ONBOARDING_MARK } from "@/agent/runtime";
import { COORDINATOR_MARK } from "@/agent/split";
import type { Tool } from "@/agent/types";
import { LOCAL_JEV_MARK } from "@/decision/local-jev";
import { mockDecision } from "./mock-decision";

export interface MockChatMessage {
  role: string;
  content: string;
}

/** 取「标记：」之后到行尾的文字 */
function field(text: string, label: string): string | null {
  const i = text.indexOf(`${label}：`);
  if (i < 0) return null;
  const rest = text.slice(i + label.length + 1);
  const end = rest.indexOf("\n");
  return (end < 0 ? rest : rest.slice(0, end)).trim() || null;
}

const clip = (s: string, n = 80) => (s.length > n ? `${s.slice(0, n)}…` : s);
/** 目标里提到写入、保存时，演示一次需要确认的操作 */
const WRITE_INTENT = /写入|保存|导出|生成文件|write|save|export/i;

export function mockReply(messages: MockChatMessage[]): string {
  const system = messages.find((m) => m.role === "system")?.content ?? "";
  const user = messages.filter((m) => m.role === "user").at(-1)?.content ?? "";

  // 第 2 级本地决策模型的判断（见 mock-decision.ts）
  if (system.includes(LOCAL_JEV_MARK)) return mockDecision(user);
  // 多 Agent 协同的拆分：演示两个角色
  if (system.includes(COORDINATOR_MARK)) {
    const goal = field(user, "目标") ?? clip(user);
    return JSON.stringify({ agents: [{ role: "调研员", goal: `调研并整理资料：${goal}` }, { role: "撰写员", goal: `撰写成文：${goal}` }] });
  }
  if (system.includes("任务规划器")) {
    const goal = field(user, "目标") ?? clip(user);
    // 修改单个失败步骤：原样保留子目标，交给运行时重试
    if (user.includes("只输出修改后的这一个步骤")) {
      const failed = field(user, "失败的步骤");
      try {
        const s = JSON.parse(failed ?? "") as { goal?: string };
        return JSON.stringify({ goal: s.goal ?? goal, tool: null, args: {} });
      } catch {
        return JSON.stringify({ goal, tool: null, args: {} });
      }
    }
    const steps: { goal: string; tool: string | null; args: Record<string, unknown> }[] = [{ goal: `分析需求：${goal}`, tool: null, args: {} }];
    if (system.includes("- demo_search：")) steps.push({ goal: `检索资料：${goal}`, tool: "demo_search", args: { query: clip(goal, 40) } });
    if (WRITE_INTENT.test(goal) && system.includes("- demo_write_file：")) {
      steps.push({ goal: `保存结果：${goal}`, tool: "demo_write_file", args: { path: "~/EastGenesis/output.md" } });
    }
    steps.push({ goal: `产出成果：${goal}`, tool: null, args: {} });
    return JSON.stringify({ steps });
  }

  if (system.includes("你为工具生成调用参数")) return "{}";

  // 第一次对话：成果之后追加对齐问题（称呼、风格、边界）
  const align = user.includes(ONBOARDING_MARK) ? `\n\n${MOCK_ALIGN_QUESTION}` : "";
  // 多 Agent 协同的合并
  if (user.includes("各子 Agent 的结果")) {
    const n = (user.match(/^### /gm) ?? []).length;
    return `（模拟）已合并 ${n} 个子 Agent 的成果：${field(user, "总目标") ?? clip(user)}。这是浏览器模式下的演示输出，没有调用真实模型。${align}`;
  }
  const sub = field(user, "当前子目标");
  if (sub) return `（模拟）${sub}：这是浏览器模式下的演示输出，没有调用真实模型。`;
  const total = field(user, "总目标");
  if (total) return `（模拟）已完成：${total}。以上步骤均为浏览器模式下的演示结果。${align}`;
  return `（模拟回复）${clip(user, 120)}`;
}

/** 模拟模型第一次对话时追加的对齐问题 */
export const MOCK_ALIGN_QUESTION = "先对齐三件事：怎么称呼你？回答偏简洁还是详细？有没有不许我碰的目录或操作？";

/** 浏览器模式注册的演示工具：一个只读，一个需要确认；都不触碰真实文件或网络 */
export const DEMO_TOOLS: Tool[] = [
  {
    name: "demo_search",
    description: "在演示知识库中检索资料（模拟，只读）",
    sideEffect: "none",
    inputSchema: { type: "object", properties: { query: { type: "string", description: "检索关键词" } }, required: ["query"] },
    async run(args) {
      const q = typeof args.query === "string" ? args.query : "";
      return { ok: true, content: `（模拟）检索资料：${q}。找到 3 条相关记录：概述、要点、参考链接。` };
    },
  },
  {
    name: "demo_write_file",
    description: "把结果保存到本地文件（模拟，不会真正写盘）",
    sideEffect: "local_write",
    inputSchema: { type: "object", properties: { path: { type: "string", description: "保存路径" } }, required: ["path"] },
    async run(args) {
      const p = typeof args.path === "string" ? args.path : "output.md";
      return { ok: true, content: `（模拟）保存结果到 ${p}，实际没有写入磁盘。` };
    },
  },
];

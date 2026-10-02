// 任务分级：简单问答跳过规划，直接调一次模型；多步任务走完整的规划流程。
// 判断只用规则（不额外调模型）：路由分类里有工具需求、目标里有多步特征、或者能匹配上某个可用工具，就是多步任务；
// 剩下的只有明确属于问答类（自我介绍、翻译、解释概念、闲聊）才算简单任务，其余默认走规划。
import { overlap } from "../decision/fallback";
import type { Classification } from "../decision/types";

export type TaskTier = "simple" | "multi";

/** 多步特征：整理、汇总、审查、批量、先…再…、文件名或路径 */
const MULTI: [RegExp, string][] = [
  [/整理|归类|分类|汇总|归纳整理|审查|审阅|评审|批量|逐个|逐一|每个文件|所有文件|\breview\b|\borganiz\w*|\bbatch\b/i, "目标需要逐项处理"],
  [/调研|搜集|收集资料|查资料|检索|搜索|对比.{0,12}(?:方案|产品|模型)|保存|写入|导出|\bresearch\b|\bsearch\b|\bsave\b|\bexport\b/i, "目标需要先收集信息或保存结果"],
  [/先.{1,40}(?:再|然后|接着)|然后|接着|之后再|并且把|\bthen\b|\band\s+then\b|步骤|多步/i, "目标包含多个步骤"],
  [/(?:^|[\s"'「（(])(?:~|\.{0,2})\/[\w.-]|[\w一-鿿-]+\.(?:pdf|md|txt|docx?|xlsx?|csv|json|ya?ml|toml|py|ts|tsx|js|rs|go|java|html?)\b|文件夹|目录/i, "目标涉及本地文件或目录"],
];

/** 目标里的词有这么大比例出现在某个工具的名称和说明里，就认为要用这个工具 */
export const TOOL_MATCH = 0.3;

/**
 * classification 来自路由决策（规则引擎第 3 级或决策层），看能力里有没有工具调用；
 * tools 是这次任务可用的工具：路由分类只认通用动作，用户接的 MCP 工具（例如「查询服务状态」）要按名称和说明再匹配一次。
 */
export function taskTier(
  goal: string,
  classification?: Pick<Classification, "capabilities">,
  tools: readonly { name: string; description: string }[] = [],
): { tier: TaskTier; reason: string } {
  if (classification?.capabilities.includes("tool_use")) return { tier: "multi", reason: "需要调用工具" };
  for (const [re, reason] of MULTI) if (re.test(goal)) return { tier: "multi", reason };
  const hit = tools.find((t) => overlap(goal, `${t.name.replace(/_/g, " ")} ${t.description}`) >= TOOL_MATCH);
  if (hit) return { tier: "multi", reason: `可能要用工具 ${hit.name}` };
  // 只有明确是问答类（自我介绍、翻译、解释概念、闲聊）才跳过规划；「清理磁盘」这类动作没被识别出工具时仍走规划，宁可慢也不只回一段话
  const kind = SIMPLE.find(([re]) => re.test(goal.trim()));
  if (!kind) return { tier: "multi", reason: "不是明确的问答类任务，走完整规划" };
  return { tier: "simple", reason: `简单问答（${kind[1]}）：直接回答` };
}

const SIMPLE: [RegExp, string][] = [
  [/介绍(?:一下)?(?:你|您)自己|自我介绍|你是谁|你叫什么|你能做什么|你会什么|\bwho\s+are\s+you\b|\bintroduce\s+yourself\b/i, "自我介绍"],
  [/翻译|译成|译为|翻成|用(?:英文|英语|中文|日语|日文)(?:怎么)?说|\btranslat\w*\b/i, "翻译"],
  [/解释|什么是|是什么|是啥|什么意思|含义|定义|区别|原理|为什么|为啥|怎么理解|讲讲|科普|\bwhat\s+is\b|\bexplain\b|\bwhy\b|\bdifference\s+between\b/i, "解释概念"],
  // 「我偏好简洁输出」这类偏好声明：回一句知道了即可，记忆由界面上的「记住」确认保存
  [/^\s*(?:我|本人)(?:比较|更|一般)?(?:偏好|喜欢|习惯|倾向于?)\s*\S{1,40}$|^\s*I\s+(?:prefer|like)\s+\S/i, "偏好声明"],
  [/^(?:你好|您好|嗨|哈喽|早上好|晚上好|午安|晚安|谢谢|多谢|辛苦了|在吗|hi|hello|hey|thanks?(?:\s+you)?)[\s!！。.,，~～?？]*$|聊聊|闲聊|讲个笑话|\bchat\b/i, "闲聊"],
];

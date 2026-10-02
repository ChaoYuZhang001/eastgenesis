// 模型调用用途的两种说法：时间线用名词，进度行用「正在…」。
import type { LlmPurpose } from "@/agent";

export const PURPOSE_LABEL: Record<LlmPurpose, string> = {
  plan: "规划",
  revise: "修改步骤",
  args: "生成参数",
  answer: "回答",
  summary: "总结",
  split: "拆分任务",
  merge: "合并成果",
};

export const PURPOSE_ING: Record<LlmPurpose, string> = {
  plan: "正在拆解任务",
  revise: "正在调整步骤",
  args: "正在准备参数",
  answer: "正在组织回答",
  summary: "正在整理成果",
  split: "正在拆分子任务",
  merge: "正在合并成果",
};

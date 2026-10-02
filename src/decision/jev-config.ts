// Jev 云端分类的问题和阈值集中放在这里，方便审阅（TypeSafe 官方 skill 的建议：问题和阈值放在同一个文件里）。
// 改问题措辞会让 tests/fixtures/jev_recorded_*.json 失效：先跑 `pnpm exec tsx tools/jev-eval.ts --collect <文件>` 重新采样，再更新录制文件。

/** 置信度低于它就把这次决策交给下一级。0.6 是官方 confidence-routing 示例的下限，在 50 条标注样例上评估过，见 docs/JEV_SMOKE_TEST_REPORT.md */
export const DEFAULT_MIN_CONFIDENCE = 0.6;

/** 每个能力一个独立的 yes/no 问题，在同一个请求里并行问（官方的 speculative fan-out）；回答是「需要这项能力」的概率 */
export const CLASSIFY_QUESTIONS = {
  code: "Does handling `message` require writing, reading, debugging or explaining source code, SQL, regular expressions, shell scripts or config files?",
  reasoning: "Does `message` require multi-step math, logic, proofs, planning or quantitative trade-offs, beyond simple arithmetic or recall?",
  // v2（2026-10-02）：原措辞对长文本附件误报 tool_use（50 条标注样例里 4 例，p 0.81–0.90），把附件当成「要读本地文件」。
  // 这一版写明「附件已提供、读它不算动作」，同时保留「对附件本身改名、移动、保存、发送仍算动作」。在独立盲写的 hold-out 上检验后才采用。
  tool_use:
    "To handle `message`, must the assistant take an action (web search, run commands, call APIs, send messages, create calendar events, read or write files that are not already attached) or fetch live information such as today's weather, prices or news? Content listed in `attachments` is already provided to the assistant, so reading or summarizing it is not an action, but moving, renaming, saving or sending those files still is.",
} as const;

/** 只在附件里有图片时才问 */
export const VISION_QUESTION =
  "Does handling `message` require understanding what an attached image shows, rather than only moving, renaming, compressing or sending the file?";

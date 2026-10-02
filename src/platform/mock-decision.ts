// 浏览器模式里模拟本地决策模型：按 local-jev.ts 要求的输出格式回 JSON，不调用真实模型。
// 是否完成、结果评分给出有把握的判断（演示第 2 级生效）；分类、选工具、风险、纠错策略故意不确定，交给规则引擎（演示降级原因）。

/** 提示末尾「输出格式：」之后的内容 */
const formatOf = (user: string) => user.slice(user.lastIndexOf("输出格式：") + 5);

export function mockDecision(user: string): string {
  const f = formatOf(user);
  if (f.startsWith('{"p":')) return JSON.stringify({ p: 0.9 });
  if (f.includes('"tool":')) return JSON.stringify({ tool: "none", confidence: 0.3 });
  if (f.includes('"strategy":')) return JSON.stringify({ strategy: "modify_step", confidence: 0.3 });
  if (f.includes("0–3")) return JSON.stringify({ level: 3, confidence: 0.8 });
  if (f.includes("0–2")) return JSON.stringify({ level: 0, confidence: 0.3 });
  // 任务分类：每项都给 0.5，置信度为 0
  const keys = (f.match(/"\w+":/g) ?? []).map((k) => k.slice(1, -2));
  return JSON.stringify(Object.fromEntries(keys.map((k) => [k, 0.5])));
}

# 恢复、目标继续与路由候选的最终本机验证

2026-10-07。来源是parent `4fca797429fd66f839a6e4ea83613d6834b108d0` 上的候选工作树，不借用567 CI或a035原生App的通过。Root将测试起止源、实际MCP binary、日志和后续闸门逐项复核，记录见[Root验证](completed-step-final-root-verification-2026-10-07.json)、[全量原始清单](completed-step-final-full-2026-10-07.json)及[后续闸门](completed-step-final-local-gates-2026-10-07.json)。

- 全量107文件、1061项passed，0 failed、0 skipped；实际exec session69338终态0，原始日志SHA `3c6c81c6052d7f82c80f1b70f883de0007dd4b6fda0901740aed6a75a625281d`。
- 列出的557项源码/测试/工具/资源/工作流输入起止相同，包含直接import的config和测试读取的BRAND/BENCHMARK文档；MCP真实二进制起止一致。清单与后续闸门以及当前文件逐项相同。
- typecheck、前端build及合成配置/脱敏3文件55项全部terminal0；顺序闸门session82114。构建的633.68kB主chunk仍有Vite大于500kB常规提示，没有放宽阈值或将提示当性能证明。干净的白名单环境不继承真实Provider测试开关；未发现自动载入的四种根目录.env文件。

首次全量1031 passed/1failed（旧E2E文案断言）及目标修复前106文件1058 passed分别保留原报告，不覆盖失败，也不将中间通过当最终来源。已完成Chat输出/接受判定、目标失败暂停原轮和继续增量计数、路由失败/未调用跳过统计均含红绿回归及专项审查，见对应固定报告。

此次没有真实Provider、原生App构建/重启、新的三平台CI或正式发行。GoalDetail当前只显示轮次步骤、恢复原因和路由，没有部分输出/总结正文；这仍阻挡“同Goal正常重启后UI可见partial”的原生黄金路径，必须另行实现并实际验收，不能切换普通会话来冒充通过。目标预算仍无持久水位，旧崩溃尚未结算的调用不追补；长输出只保存受4000字段预算约束的脱敏前缀。产品保持Alpha/内部QA。

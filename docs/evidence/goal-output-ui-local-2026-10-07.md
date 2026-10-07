# 目标轮次正文显示与同任务继续的本机验证

2026-10-07。候选父提交 `662a70e092979f585ab793c9e78269d31ce4a9a4`。这次 UI 修改不属于 cf8 CI，亦不沿用历史 a035 原生 App 的通过。

## 行为与真实失败

目标任务不进入普通聊天会话。此前 GoalDetail 只显示步骤、恢复原因和路由，已有 streamingText/summary 没有正文入口。明确红测在实际 Task store 已收到正文后查询目标轮次区域，7项中6失败、1通过；最早草稿的 timeout 和 Evidence={} 的类型检查失败单独保留，未当作最终因果证据。

正文现在只在所属 RoundItem 显示，ActiveRound 不重复。运行时显示“正在生成”，失败、取消或 needs_user 显示保留的“部分输出”和“结果”，completed 显示最终“总结”，替代残留的流式文本。空白内容不画占位；React 文本转义保持 HTML 为文本，保留换行并让长行折行。原顶部“继续”仍是恢复入口。

## 证据

- 相关3文件22项通过，新增UI7项；最终类型检查通过。710个列举源输入前后、命令之间一致。Root核对12份报告/原始日志与当前源。见[冻结与UI契约](goal-output-ui-freeze-2026-10-07.json)、[独立核验](goal-output-ui-root-verification-2026-10-07.json)。既有相邻测试的45次React act warning保留。
- 生产 Runtime、Task/Goal stores、GoalRunner、JSON checkpoint和hydrate实际运行；模型传输、完成判定、存储后端与文件工具包装受控。首次总结出现partial后失败，重载保留原task/原轮，点击目标顶部“继续”只请求summary；先前Chat标记进入该请求，工具真实临时文件读写各一次，inode/mtimeNs/SHA不变。调用计数3+1=4，目标最终completed。
- Root全量session77567终态0：108文件1068passed，0failed/0skip；558项生产/测试/工具/资源/工作流输入和实际MCP二进制起止一致。原日志SHA `f6492ff5cf5974c60a8a5f563c5dc73f53a127e37b436a783c9f5c65130b5333`。见[全量清单](goal-output-ui-full-2026-10-07.json)。
- 顺序闸门session7999终态0：typecheck、build、合成配置/脱敏3文件55项通过，源与全量清单一致。干净白名单环境排除真实Provider变量，四类自动载入.env不存在。Vite主chunk仍有常规大于500kB提示，不将build当性能证明。见[闸门](goal-output-ui-local-gates-2026-10-07.json)及[Root最终核验](goal-output-ui-final-root-verification-2026-10-07.json)。

这是本机合成/UI证据；新的QA包、实际原生重启与顶部继续尚待下一次来源绑定执行。未连接真实Provider；未证明正式发行升级、签名或跨平台性能。已接受Chat正文仍受脱敏4000字段预算约束，旧崩溃尚未结算的调用没有持久计费水位。保持Alpha/内部QA。

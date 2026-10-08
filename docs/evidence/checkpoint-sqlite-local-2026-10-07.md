# Checkpoint 错误传播与 Windows 测试清理：本机候选证据

日期：2026-10-07。local parent c16ae0274a9066709baf8047951675b299b76092；Alpha / 内部 QA。

生产 checkpoint 接线原先忽略 `useGoals.apply()` 的 Goal|string 返回值。backend.updateGoal 抛错后，store将错误转换为字符串；adapter只await，使自然失败路径可能给出未经这次保存证明的“继续时将恢复原任务”说明。

现在 adapter检查错误字符串并throw；GoalRunner自然失败的既有catch显示固定存储错误。有序 stopAndCheckpoint也捕获该错误并reportError，保持已停止的任务和原来的boolean语义（是否停止，不代表保存成功），避免pause/abandon调用外层收到未处理异常。未重开轮次、未修改权限或调用账本。

隔离回归实际使用production goalRunner、真实stores、状态机、serializer和hydration，只有模型transport/tools与backend故障为合成。故障注入精准限定在paused/interrupted后的直接checkpoint，先前有效终态checkpoint允许正常保存。原码23例20pass/3fail；候选同23例全过，邻近store/UI合并45/45及typecheck通过。

自然失败/实际pause/ordered stop错误回归均经过实际store字符串错误。原Goal/task/round保持、没有自动resume或新副作用。存储恢复后重新从backend读取和hydrate，只恢复summary，逻辑调用3→4，read/write各1，实际临时文件inode/mtime/hash不变。这里不是原生SQLite磁盘故障注入，不证明旧checkpoint的新鲜度或所有重放风险；无有效checkpoint和账本不确定状态仍需按已有恢复门禁处理。

Windows测试夹具现在显式先销毁Tokio runtime，后删除隔离目录；所有原SQLx exists/create/pool/connection close、sentinel/schema7/唯一文件和Unix inode断言保留。真实删除只有Windows Os32/33可在250ms重试预算内、每次最多10ms等待后重试；其他错误或持续锁仍硬失败。预算不是文件系统操作总时限。

原始macOS夹具6项通过；故意反转生命周期的机制变体7pass/1fail，证明回归能检出逆序；候选8项通过。反转变体不是原始Windows故障的复现。两项cfg(windows)回归使用真实share_mode(0)句柄，但本机未编译或执行，仍须新的Windows CI。此次没有改动生产SQL路径或降低安装门禁。

Root实际应用固定补丁后，正常仓库验证如下。558项生产/测试/工具/配置/工作流与两个直接读取的文档输入、实际MCP二进制以及验证harness均在起止保持一致；370项编译所需输入覆盖检查通过。

| 验证 | 实际结果 |
| --- | --- |
| TypeScript类型检查 | 退出0 |
| 全量前端 | 108文件 / 1076 passed / 0 failed / 0 skipped |
| 合成配置/脱敏smoke | 全量中三个指定文件55项实际通过，没有重复相加 |
| 前端build | 退出0；Vite大chunk警告保留，未据此声称性能达标 |
| 普通SQL插件 | 12项单测 + 1项文档测试通过 |
| QA SQL插件 | 18项单测 + 1项文档测试通过 |
| Windows真实文件锁与NSIS | 本机未运行 |

固定证据：[checkpoint隔离回归](goal-checkpoint-store-error-local-2026-10-07.json)、[checkpoint实际应用](goal-checkpoint-store-error-root-apply-2026-10-07.json)、[Windows清理隔离回归](windows-sqlite-cleanup-local-2026-10-07.json)、[Windows实际应用](windows-sqlite-cleanup-root-apply-2026-10-07.json)、[正常仓库起止闸门](checkpoint-sqlite-current-gates-2026-10-07.json)、[Root独立核验](checkpoint-sqlite-current-root-verification-2026-10-07.json)。这份本机结果不继承c16/2b509 CI；新源码快照的三平台CI和新source-bound QA/完整Goal尚待执行。

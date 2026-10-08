# 调用账本优先与读取失败关闭：本地最终验证

日期：2026-10-07。候选基于本地 `b781765b3ed346d6da1d91f193f5279aaeb4caff` 工作树；正式发布绑定为 false。固定计数、命令、日志 SHA256、当前输入摘要与红态记录见 [JSON](durable-ledger-recovery-local-2026-10-07.json)。

## 实际问题与行为

第一处问题：只保存计划的旧形态 checkpoint 可能落后于已持久化的工具调用账本。旧实现仅根据 attempt 或已有 step record 决定恢复，忽略实际存在的 ledger record；started/unknown 且原始身份缺失时可能走新操作路径。现在任意已知 ledger record 都进入核对路径。缺少原始身份时停止为 `needs_user`；已完成的 applied 记录复用证据。成功读到 null 的正常新调用保持可执行。

第二处问题：`ledger.get` 抛异常曾被当成 null，后续 put/claim 恢复正常时仍可能执行副作用。旧实现的定向红态确实得到 completed，run=1、confirm=1、put=3、claim=1。现在读取失败抛固定 `Stop("needs_user")`，run/probe/confirm/put/claim=0；原生异常内容不会进入 summary 或事件。未配置 ledger 和成功读取到 null 继续使用原有行为。

## 最终本地结果

| 验证 | 实际结果 |
|---|---|
| typecheck | exit 0 |
| 定向恢复回归 | 5 文件、78 passed、0 failed、0 skipped |
| 全量前端 | 102 文件、998 passed、0 failed、0 skipped；09:41:52 CST 开始，70.09 秒 |
| 合成配置及脱敏 smoke | 3 文件、55 passed、0 failed、0 skipped |

78 条由 runtime 59、recovery 6、session recovery 6、隔离 SQLite ledger 4、独立崩溃进程 3 组成。与发布快照前的 991 条相比，增加 runtime 5 条和独立进程 2 条。

两项新增进程回归真实启动独立 Node 实例，使用物理 SQLite，在 marker 已写入而账本仍为 started 的窗口执行 SIGKILL。计划 checkpoint 在运行前保存，崩溃后不改账本与 checkpoint：一项以落后的仅计划 checkpoint 恢复，另一项在 reader 连接用 TEMP 同名表造成真实 SQL SELECT 异常，并在 finally 删除 TEMP，使后续主表写入仍有可能成功。两项均保持同一任务和一个 round，停止为 needs_user，run/probe/confirm=0，marker SHA 不变，整行账本及行数不变。现有第三项完整身份恢复仍通过，实际 probe 后完成 applied。

## 发布前起止绑定复验

最终全量复验于01:56:26.103–01:57:40.676 UTC结束，wrapper记录实际exit 0，仍为102文件/998条、零跳过。499个生产/测试/工具/工作流输入起止SHA一致；真实MCP二进制2,709,240 bytes，SHA `90fb4c64cfdfed89bf687e74a18735dccaf9e502f17cdd296ca3767c4a6b29b4`，运行前后未变。Root另独立重算499文件与MCP摘要，并从日志逐文件合计102/998。见[原始绑定清单](durable-ledger-recovery-bound-tests-2026-10-07.json)。

初次998日志确实全部通过，但压缩后首次读取关闭handle未提供exit_code，因此它的JSON记录保留exitCode=null；实际退出码以本次wrapper的exit 0为准。不会按测试footer倒填进程退出码。

## 证据范围与保留的失败

这证明真实 Node/SQLite/进程边界以及生产 AgentRuntime 恢复逻辑；checkpoint 旧形态、时钟和模型调用仍是合成夹具，不能当作旧发行版桌面 writer 的迁移证明。TEMP fault 也不是 native SQL plugin/GUI 的实际错误复现。

先前 plan-only 修复的四文件 74 绿态、随后读取错误修复的五文件 77 绿态分别保留。77 运行时进程测试为两例，其摘要在运行后采样；当前最终三例以 78/998 结果为准，不把后续源文件摘要倒填到旧运行。JSON 的 currentInputHashes 是测试后核对，不声称存在未执行的开始/结束双绑定。

首次 applied 合成 claim 返回 acquired 的夹具错误已在生产修复前纠正，初始日志保留，不能据此称生产 applied 会重复执行。新测试初次 typecheck 的 SQL row 类型问题已修正。首次 private smoke 使用了不存在的猜测文件名，未执行测试；改为实际三文件后 55 条通过。所有日志身份在 JSON 中记录。

macOS 包与原生恢复另按各自 binary/source manifest 绑定；本报告不证明新的 native stale checkpoint/读取错误场景、历史 writer 升级、真实双 Provider、Windows doctest 修正、三平台性能或签名公证。

包含两fix的新QA包已完成[macOS原生三场景回归](macos-ledger-safe-native-2026-10-07.md)，另绑定322编译输入和新binary；它不把Node中的两项新故障扩大为native错误复现。

# macOS MCP 连接标识修复后的目标崩溃恢复复验

2026-10-07 北京时间 04:39:55–04:43:00（UTC 2026-10-06 20:39:55–20:43:00），macOS 26.7.1 / x64，应用 0.1.0 / `com.eastgenesis.desktop`。同一新 QA binary 上三个真实 Tauri/WebView 崩溃恢复场景全部通过；没有修改冻结脚本或复用旧 binary 的通过结果。

## 构建与执行绑定

- 新 binary SHA-256：`b7ce68b84a935cfb902535346d390c98b1491431ae75a758dd474c17ff90b96d`；与本次 13 项 native picker/sandbox 验证相同。
- 冻结 harness SHA-256：`235b13ce1c8b7bc08dd418f513a56a06c8505cc9d14c076e6136be8c257246bd`；与历史 552 binary 正式记录中的 harness 完全相同。
- 开始源码 HEAD：`aebe9c8acb4c1c583e0e90863f88c3f9f1e840e5`。
- 冻结 harness 记录的 8 个恢复相关文件组合 SHA-256：`a5231392d21f05326021f142ce15148f2131ba059b2cbaa5e2ea73bf185b6b32`，结束后独立重算一致。
- 另外，在启动前和结束后核对 picker 记录的 7 个连接/目录相关源码摘要、binary 和冻结 harness 未变化，逐文件摘要保存在 JSON `postRunVerification`。这些清单不含 `src/platform/mcp-transport.ts` 起止摘要，不声称完整覆盖所有连接相关源码。
- 命令：`node tools/desktop-goal-recovery-smoke.mjs --output=/tmp/newtoken-goal-fault.json`。执行前明确核对目标 binary 为上述 b7 哈希。

## 三个真实场景

| 崩溃窗口 | 活跃 QA 租约期间 | 到期后的真实恢复 | 最终结果 |
|---|---|---|---|
| `after_ledger_started` | 同任务 `needs_user`，没有工具副作用或重放 | 实际文件 probe=`not_applied`，执行一次真实 MCP move，SQLite=`applied`；同 `task_id`，产物身份不变 | 通过；goal completed |
| `after_tool_before_ledger_commit` | 同任务 `needs_user`，已落地文件保持不变 | 实际文件 probe=`applied`，复用已落地结果；恢复轮没有新的工具结果，SQLite=`applied`；同 `task_id`，没有第二次移动 | 通过；goal completed |
| `unknown_after_external_sandbox_removal` | 同任务 `needs_user`，没有重放 | 实际 probe 仍 unknown，SQLite=`unknown`；没有批准入口允许重放，没有重建被移除的测试文件 | 通过；goal paused |

每个场景都通过真实 UI 创建 goal/task，由应用自行保存 checkpoint 和账本。崩溃由 QA fault 执行真实进程 abort，SQLite=`started` 和正确文件窗口都有断言；重启后仍是原任务。SQLite 仅以只读方式检查，没有种植任务、轮次或 invocation 记录。

第三个场景的目标文件删除是 harness 在已证明工具落地后对自己拥有的临时文件实施的外部状态扰动，与 App 的移动副作用分开记录。这证明未知副作用保持 `needs_user` / paused，不证明任意外部服务都具备可靠 probe。

## 隔离、租约与边界

仅使用 fresh temporary HOME / Downloads、合成 loopback Provider、`EASTGENESIS_QA_ISOLATED_PROFILE=1` 的 Keychain 禁访守卫及最小环境。没有读取普通用户 profile 或私有 Provider 配置，模型请求只作脱敏计数。每个场景的 `controlledCleanup=true`，临时 profile 在报告写入前已删除。

QA 租约固定 30,000 ms，用于缩短隔离故障测试的等待；生产租约仍 600,000 ms（10 分钟）。活跃期间真实证明了拒绝接管和不重放，不能声称生产租约即时恢复。本轮 `restoreDialogsDismissed=0`，没有使用额外恢复 alert 操作；冻结脚本的固定 Don’t Reopen 白名单及全部断言保持原样。

排除真实 Provider、Windows/Linux runtime、任意文件系统崩溃持久性、所有重复工具调用形式、任意外部服务副作用 probe、自动目标完成判断的普适准确率及生产 10 分钟即时接管。旧 552 binary 的历史记录保留不覆盖。

机器可读记录：[macos-goal-fault-recovery-connection-2026-10-07.json](macos-goal-fault-recovery-connection-2026-10-07.json)。目录权限复验：[macos-picker-sandbox-2026-10-07.md](macos-picker-sandbox-2026-10-07.md)。

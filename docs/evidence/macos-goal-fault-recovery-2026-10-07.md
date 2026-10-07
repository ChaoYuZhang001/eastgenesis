# macOS 目标轮次真实崩溃恢复证据 — 2026-10-07

本轮三个场景全部通过。实测为真实 Tauri/WebView 窗口操作、内置 MCP 文件移动、应用进程 SIGABRT 后重启同一隔离 profile，并以只读 SQLite 和实际文件状态验证恢复。任务、目标、调用账本均由应用创建；测试没有种植 Task/Goal/Invocation SQL，也没有用 Node worker 代替桌面执行。

时间为北京时间 2026-10-07 03:49:56–03:52:59；对应 UTC 2026-10-06 19:49:56.529Z–19:52:59.685Z。平台为 macOS 26.7.1（25G241），测试架构 x64；应用包版本 0.1.0，标识 `com.eastgenesis.desktop`。机器可读结果见 [同轮 JSON](macos-goal-fault-recovery-2026-10-07.json)。早先 partial 报告已由这份通过报告替换。

| 场景 | 崩溃时实际证据 | 重启、租约有效期间 | 30 秒 QA 租约过期后 | 最终结果 |
| --- | --- | --- | --- | --- |
| `after_ledger_started` | 真实 SIGABRT；账本 `started`；任务及 gate checkpoint 已落盘；文件尚未移动 | 同一 task；`needs_user`；不改变文件 | 实际 probe 为 `not_applied`；重新批准后 1 条恢复 tool_result，移动后文件 inode、mtime 和摘要保持一致 | `applied`；目标 `completed`；未重复移动副作用 |
| `after_tool_before_ledger_commit` | 真实文件已移动；SIGABRT；账本仍 `started`；任务及 gate checkpoint 已落盘 | 同一 task；`needs_user`；产物不变 | 实际 probe 为 `applied`；恢复 tool_result 为 0；直接复用已落地产物 | `applied`；目标 `completed`；产物身份不变 |
| `unknown_after_external_sandbox_removal` | 应用先完成真实移动，再于最终账本提交前 SIGABRT；随后 harness 仅删除临时沙箱目标文件，构造外部状态扰动 | 同一 task；`needs_user`；没有重建输入或输出文件 | 实际 probe 为 `unknown`；账本保存为 `unknown`；停在 `needs_user`；没有批准重放入口，文件没有被重建 | 目标 `paused`，符合预期安全终态 |

第三场景中，删除临时目标文件是 harness 的外部扰动，不能归为应用副作用。第一场景的目标完成确认只在文件、调用账本及产物身份独立验证之后点击；它不证明自动目标判定始终准确。

所有场景均使用新建临时 HOME 和其中的 Downloads、合成 loopback 服务、应用启动最小环境以及 `EASTGENESIS_QA_ISOLATED_PROFILE=1`。本次新构建包含 QA 钥匙串禁访守卫：读取返回空，修改和删除拒绝，后端访问闭包不被调用。临时 profile 中没有 Provider 配置文件，记录的模型调用全部属于唯一隔离 fixture，服务端捕获到 plan 3 次、args 6 次、stream 2 次、JSON probe 3 次。报告不保存真实任务文本、task id、沙箱绝对路径、Provider 地址、模型名称或凭据。该合成配置提供工具能力元数据，不构成真实 Provider 或模型中立可用性证明。

崩溃后的 AppKit 窗口恢复告警曾导致 AX 启动失败。最终 harness 只对测试进程 PID 自己的窗口精确匹配 `Don't Reopen`、`Don’t Reopen`（U+2019）及对应中文“不重新打开”选项并点击；不点击 Reopen/Restore，不读取其他原始文本。窗口入口需连续两次快照稳定。最终同轮第一场景记录 1 次该告警处理，其余为 0；三个场景均完成受控进程清理并删除临时 profile。

本轮 lease 是仅 `qa-faults` 构建可用的 30 秒 QA 设置，活跃期拦截断言保留。生产默认 600,000 ms（10 分钟）未改变；本次不证明生产租约在崩溃后立即可接管。

源码基准 revision 为 `4a88d966aa327122695d62f8035cd1eb79c79b8c`。QA 包构建发生在该修订的内容提交前，恢复源码指纹在实测后仍匹配当前文件；报告明确包含工作树变更。本次为本地 QA 构建证据，不是签名发布绑定。

| 绑定对象 | SHA-256 |
| --- | --- |
| 实测应用二进制（运行前后相同） | `552c8e86168491003348334d4714de1bcd2957ee12488b424e34f8e468f75e86` |
| 最终同轮 harness（实测后仍匹配） | `235b13ce1c8b7bc08dd418f513a56a06c8505cc9d14c076e6136be8c257246bd` |
| 8 个恢复/隔离源码文件有序内容指纹 | `9b34079e3e6637729c943260f94b4800111da1ef6f3c5e2aaf2a8f0843d22aad` |

8 文件范围为 runtime、engine、recovery、tasks、platform types、Tauri backend、Rust lib 和 keychain；完整相对路径清单在 JSON 中。额外只读检查确认三个 scenario 均通过、全部断言没有 false、cleanup 均通过，binary/harness/source 三项绑定匹配，报告中没有凭据、Provider 地址或用户/临时 profile 绝对路径。

复现从项目目录执行：

```sh
CI=true pnpm --silent tauri build --features qa-faults --bundles app
node tools/desktop-goal-recovery-smoke.mjs --output=reports/desktop-goal-recovery-macos.json
```

harness 使用该构建的默认 macOS bundle，自行建立、清理隔离环境；不要把旧 debug 包或仅改变 HOME 的早期运行作为同等隔离证据。相关验证为 typecheck 通过、恢复相关 9 文件 119 断言通过、真实 MCP 文件夹具 6 断言通过；Root 汇总的最终前端全量为 90 文件 835 断言通过。Rust 普通构建 12 断言及 QA 构建 11 断言此前通过，覆盖钥匙串隔离契约、精确 flag 和 QA loopback 地址校验。

明确排除：真实 Provider 可用性、任意副作用工具的探测能力、所有重复工具调用尝试的全量计数、任意文件系统崩溃耐久性、Windows/Linux 实机恢复、生产 10 分钟即时恢复、自动目标完成判断准确性，以及签名/公证/公开发布。当前已证明的文件移动副作用恢复不能推广为这些范围全部通过。

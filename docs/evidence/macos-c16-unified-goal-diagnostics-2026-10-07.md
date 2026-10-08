# macOS c16 原生诊断：重复 AX 引用与前台就绪

日期：2026-10-07。所有尝试为合成 loopback Provider、隔离 HOME、QA keychain guard；没有真实 Provider、SQLite 写入种子或 JavaScript 注入。

完整 QA 构建绑定 local `c16ae0274a9066709baf8047951675b299b76092` 的 733 个源文件。QA 版本 0.1.0，x64、qa-faults；应用未签名。binary SHA `d2446cb197b8a8d4c3307da60cf6108691ffb8420cdecef270f138da52cba3b9`，12,217,352 bytes。与之前 31dcc 二进制相同，但新的完整 source 绑定独立完成；不能只用相同 binary 推断来源一致。

| 驱动版本 | 实际结果 | 对后续行动的影响 |
| --- | --- | --- |
| v7 | Provider A UI 保存 / GET1；B 的粘贴失败，GET0、POST0 | 当时没有细分错误号，未推断原因 |
| v8 | 两 Provider 实际 UI 保存 / GET各1；矩阵完整遍历1188节点约389ms，但复选框 raw matchCount=2 | 唯一性门禁停止；尚不能从同名或同 frame 推断同控件 |
| v9 | B 地址粘贴前 System Events 前台检查失败，phase3 / -27010；尚未发送按键 | 确认前台就绪竞争，不能归因 Key/剪贴板或自动重试业务 |
| v10 | 前台就绪改动后，两 Provider 实际保存；各2候选实际 CFEqual=true、AX PID查询成功且等于 owned PID36776 | 身份诊断成功；可准备每次重新验证身份的引用计数修正 |

v10 两次候选诊断各完整遍历 1188 节点，扫描约 404.9 / 346.5ms，保留450ms上限。两模型候选各自 frame 和 clip 相同，checked=1/enabled=true，但 visible=false。身份相同不证明可见或可操控；候选操作没有激活、滚动、聚焦或按控件。

v10 前台就绪只针对本次拥有的 PID：按键前请求前台，最多20次检查/190ms请求等待；CmdA与CmdV各一次，粘贴前再次检查前台。未知失败或已可能发送按键仍停止、不自动重试。操作与场景预算保持。前台检查和按键不是原子 OS 操作，不能宣称所有焦点竞争已消除。

v10 状态为 `candidate_identity_diagnostics_passed_goal_not_run`，`candidateDiagnosticsOnlyPassed=true`，`passed=false`、`nativePassed=false`、`goalExecutionAttempted=false`。A/B GET各1、所有POST0，未执行 Goal、读写文件、部分输出失败或重启恢复。正常 Goal 模式仍保留原始匹配唯一性，尚未加入去重。

v7–v10 自有 App/helper进程组清理、socket关闭、剪贴板清理与隔离目录移除均通过；source、App、binary、controller/helper结束绑定保留。Root 独立重新计算 v9/v10 的源文件和身份/按键失败条件，并确认自有进程组无活进程。

固定证据：[完整 c16 QA 构建](macos-c16-full-source-qa-build-2026-10-07.json)、[QA Root核验](macos-c16-full-source-qa-build-root-2026-10-07.json)、[v7](macos-unified-goal-v7-failed-2026-10-07.json)、[v8](macos-unified-goal-v8-failed-2026-10-07.json)、[v9](macos-unified-goal-v9-failed-2026-10-07.json)、[v10实际身份诊断](macos-unified-goal-v10-candidate-identity-2026-10-07.json)、[v9/v10 Root核验](macos-unified-goal-v9-v10-root-verification-2026-10-07.json)、[v10只读审阅](macos-unified-goal-v10-review-2026-10-07.json)。117项静态检查不能替代上述实际身份记录。

之后的生产恢复修改属于新候选，完整统一 Goal 必须绑定新 source/QA。新的活进程必须重新查询 owned PID和CFEqual，不沿用36776的身份结论；不同控件同标签仍需停止，press/focus可见性和唯一性门禁不能放宽。Work读取→Codex写入→Chat降级→部分总结失败→重启→同task/round仅总结恢复的完整链仍待验证。

# macOS 自有进程采样验证摘录

2026-10-07 本轮会话约 06:31（Asia/Shanghai）已实际验证一个自有 Node 子进程的 RSS、累计 CPU、启动身份稳定性和退出后的拒绝采样行为。这里保存的是该次工具回传结果的摘录，**没有保存固定原始 stdout 文件，无法绑定原始输出 SHA256**；保存证据时没有重新运行。完整字段见 [JSON 摘录](macos-process-sampler-validation-2026-10-07.json)。

目标进程分配并写入 32 MiB Buffer，每 100 ms 定时器约工作 70 ms。请求采样窗口为 1,200 ms、间隔为 100 ms；实际得到 12 次采样，首末观测点相隔 **1,121.846 ms**。这是一段测量窗口内的 12 个采样点，独立窗口数为 **1**。

| 本次已发生的观测 | 数值 |
|---|---:|
| 模块 CPU 增量 | 753.566 ms |
| 目标自身 `process.cpuUsage()` 增量 | 753.825 ms |
| 两者绝对差 | 0.259 ms |
| 一核归一化 CPU | 67.172% |
| RSS 采样峰值 | 71,753,728 bytes |
| 退出后首次、再次采样 | 均为 `pid_exited / unverified` |

目标身份在该次采样中保持稳定，目标和 sampler 已关闭，没有剩余忙循环。Darwin 已执行；Linux 和 Windows 的 native 方法均为 **`not_run`**。

计数范围只有明确登记的一个自有 Node 目标进程；owner 和 sampler 本身不计入资源总和。该次没有原生验证后代登记，也没有测量 EastGenesis GUI、完整 WebView 树或 WKWebView XPC。未来应用采样中，未登记后代及无法可靠核对亲子归属的 WKWebView XPC 仍须 excluded；完整进程树覆盖保持 `unverified`。RSS 是登记集合在每次非原子采样窗口内的 resident bytes 总和，共享页可能重复计入。CPU 使用 own user + system 的累计 counter，窗口比例按一核 100% 计算，可以超过 100%。

JSON 单独列出最终冻结源码及其 9/9 纯契约测试、typecheck 和语法检查状态。原生采样后源码还有报告字段、deadline 和 close 的细化，采样当时未保存精确源码 hash；最终源码快照不能作为该原生运行的逐字节绑定。此摘录不宣称最终源码已重新原生验证，也不构成启动、资源分布或三平台性能基线。

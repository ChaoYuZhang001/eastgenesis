# macOS P0 Kill/Restart 恢复证据（2026-10-07）

本记录覆盖一次真实 macOS Tauri 窗口的会话恢复，不把普通启动烟测或合成哨兵当作任务恢复。

## 固定环境

- 平台：macOS `x86_64`
- 应用版本：`0.1.0`
- 包标识：`com.eastgenesis.desktop`
- 包类型：`macos-qa-bundle`
- 构建标识：`qa-20261007-ax-recovery`
- profile：隔离的临时 `HOME`
- 流：本机 loopback 确定性夹具
- 自动化：macOS System Events Accessibility
- 终止动作：只对测试 app 进程发送 `SIGKILL`

命令范围为 `pnpm --silent tauri:build:mac:qa`、`node tools/desktop-stream-fixture.mjs`，以及临时 Accessibility 恢复脚本配合 `sqlite3` 只读查询。没有读取真实外部服务配置，也没有触碰用户 app profile。

## 复盘结果

1. 真实窗口接受任务并进入流式状态，Accessibility 可见部分渲染结果。
2. 终止前从隔离 profile 的 SQLite 只读查询确认：任务仍为 `running`，checkpoint 存在，部分输出非空，任务 ID 字段存在。
3. 仅杀掉测试 app 进程，保留同一隔离 profile 和夹具。
4. 重启同一 QA bundle 后，查询确认同一任务记录仍在；Accessibility 可见恢复入口和保留的部分输出，任务进入可解释的恢复状态。
5. 实际点击“从未完成步骤继续”，确认任务重新进入运行 UI；随后点击停止控件清理流式请求。

结果为 `passed`。仓库记录只保留布尔检查和证据边界，不保留任务 ID、任务目标、输出正文、绝对路径、外部服务名称、地址或凭据。临时 profile 和原始输出已清理。

## 证据边界

这次实测证明了真实 macOS WebView 窗口、SQLite running checkpoint、部分输出恢复、同一任务记录重启读回和继续入口可操作。它不证明真实外部服务可用性、跨平台安装行为、签名/公证或生产 SLA。

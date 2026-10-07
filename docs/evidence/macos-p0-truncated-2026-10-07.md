# macOS P0 传输截断证据（2026-10-07）

本记录复测了不完整响应体在真实 macOS Tauri 窗口中的终态行为，使用当前 Channel terminal 修复后的 QA bundle。

## 固定环境

- 平台：macOS `x86_64`
- 应用版本：`0.1.0`
- 包标识：`com.eastgenesis.desktop`
- 包类型：`macos-qa-bundle`
- 构建标识：`qa-20261007-channel-terminal-fix`
- profile：隔离的临时 `HOME`
- 流：本机 loopback 确定性不完整响应体夹具
- 自动化：macOS System Events Accessibility

命令范围为 `pnpm --silent tauri:build:mac:qa`、`node tools/desktop-stream-fixture.mjs`，以及临时 Accessibility 脚本配合 `sqlite3` 只读状态查询。没有读取真实外部服务配置，也没有触碰用户 app profile。

## 结果

真实窗口先显示部分输出，随后进入终态失败；SQLite 隔离会话 checkpoint 同时保留失败状态和部分输出，Accessibility 可见“从未完成步骤继续”入口。该结果为 `passed`。

修复前相同场景曾长时间保持 `running`，原因是异步 Channel terminal 到达时没有唤醒等待中的 `ReadableStream` 读取；本次 bundle 已包含该 terminal close/error 修复，因此不再把长时间运行误报成通过。

## 证据边界

本次证明真实 macOS 窗口能把传输截断归一为可见失败、保留部分输出并提供继续入口。它不证明外部服务可用性、生产 SLA、跨平台安装、签名或公证。

记录不包含任务目标、输出正文、任务 ID、绝对路径、外部服务名称、地址或凭据；临时 profile 和原始输出已清理。

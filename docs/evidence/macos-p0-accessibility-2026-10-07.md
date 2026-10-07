# macOS P0 Accessibility 证据（2026-10-07）

这份记录固定了本次 macOS 黄金路径观测的场景、平台和证据边界。它用于复盘和后续 CI/人工验收，不代表发行资格或外部服务可用性。

## 运行标识

- 平台：macOS，`x86_64`
- 应用版本：`0.1.0`
- 包标识：`com.eastgenesis.desktop`
- 包类型：`macos-qa-bundle`
- 构建标识：`qa-20261007-01`
- Accessibility 通道：macOS System Events Accessibility
- 构建命令：`pnpm tauri:build:mac:qa`
- 包烟测：`pnpm --silent desktop:package:smoke -- --json`
- 脱敏校验：`pnpm --silent desktop:evidence:validate <temporary-evidence.json>`
- 记录封装：`pnpm --silent desktop:acceptance:record -- --input <temporary-evidence.json> --scenario staged --platform macos --arch x86_64 --build qa-20261007-01 --output <temporary-record.json>`

原始复制结果和封装记录只在临时位置使用，没有写入仓库。仓库内只保留本脱敏汇总及其测试。

## 场景结果

| 场景 | 状态 | 已观察到的 UI 证据 | 边界 |
| --- | --- | --- | --- |
| `staged` | `passed` | Accessibility 可定位输入和提交控件；流式分段和完成状态可见；路由证据入口及复制控件可达 | 只证明本机应用与确定性回环流的 UI 链路；不含外部服务、精确网络时间、账本恢复或目录选择器结论 |
| `slow-first-token` | `passed` | 延迟首段数据期间仍可提交，最终完成状态可见 | 只证明延迟路径到达完成 UI；不证明外部服务延迟或精确首 token 时间 |
| `partial-output` | `passed` | 部分渲染结果保留；终态失败和恢复入口可见 | 这是显式流错误场景；不等同于传输半截，也不证明外部服务故障策略 |
| `idle-cancel` | `passed` | 停止控件可达且已触发；停止状态和恢复入口可见 | 未单独观测 worker 退出时序或外部服务取消语义 |
| `truncated` | `not_proven` | 已尝试不完整传输；观察窗口内保持运行，没有出现可确认的终态失败 | 不能据此声称传输截断恢复、自动超时归类或恢复行为通过 |
| `ledger-recovery` | `not_run` | 未执行杀掉 UI 后重启并探测任务副作用的场景 | 包烟测的 SQLite 表和合成会话行不能替代任务事件恢复证据 |
| `directory-picker` | `not_run` | 未执行原生目录对话框和白名单交互 | 不能声称目录选择器或文件根权限通过 |

四个场景达到 UI 观察标准，整体状态为 `partial`。未通过或未执行的场景保留为待补证据，不向上汇总为通过。

## 包烟测补充

`desktop:package:smoke -- --json` 在两个隔离重启周期中通过：进程可启动并受控退出，SQLite schema 为 7，session、tool invocation 和 lease 索引存在，合成会话行在第二周期仍存在。两轮进程周期耗时约为 4063 ms 和 4062 ms；该指标是进程周期，不是冷启动、首屏或首 token 延迟。

包烟测不能证明 WebView 已完成 hydration，也不能证明杀 UI 后任务事件恢复、工具副作用恢复、外部服务可用性、签名或公证。

## 脱敏与复盘约束

- 证据不包含任务目标、渲染正文、绝对路径、外部服务名称、凭据或网络地址。
- Accessibility 只记录控件可定位、可操作和状态可见性；无法从 Accessibility 树推出精确网络头、首 token 时间或 worker 退出时序。
- `partial-output` 与 `truncated` 分开记录：前者是显式流错误，后者的传输截断终态尚未证明。
- 复制证据先经 `desktop:evidence:validate`，再可由 `desktop:acceptance:record` 封装；封装只增加场景/平台/构建元数据，不提升证据等级。

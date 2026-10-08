# macOS 原生目录选择、动态授权与文件沙箱证据

2026-10-07 北京时间 04:33:52–04:37:38（UTC 2026-10-06 20:33:52–20:37:38），macOS 26.7.1 / x64，真实 Tauri/WebView 应用版本 0.1.0，包标识 `com.eastgenesis.desktop`。完整 13 个场景在同一应用进程中通过；没有重启应用绕过授权生效或撤销。

## 构建与源码绑定

- binary SHA-256：`b7ce68b84a935cfb902535346d390c98b1491431ae75a758dd474c17ff90b96d`。
- 冻结 harness SHA-256：`f59edc15f920cec8a89c6cea794ecf74ef1862a13c0474c5ca6eb5e50d857da5`。
- 当轮开始 HEAD 是 `e3a9971f7a27807f14ae241c426711fcf4fb4b56`，但构建包含当时的工作树修复，`sourceWorkingTreeChangesIncluded=true`。不能把旧 HEAD 的文件版本当作新 binary 源码。
- 实际编译绑定取当时工作树中的 7 个源码文件 SHA-256：`file_roots.rs`、`mcp_service.rs`、Tauri `lib.rs`、前端 `types.ts` / `tauri-backend.ts` / `mcp.ts` 及 `FileRoots.tsx`，完整路径和摘要见 JSON。
- 此清单不含 `src/platform/mcp-transport.ts`，因此不能声称所有相关源码都做了起止摘要校验。该文件的后续独立源码核对也不能补为本轮未记录的起始哈希。binary 绑定覆盖实际构建的应用包，13 个真实场景结果保持上述边界。
- 成功前再次核对 binary、harness 与这 7 个文件内容均未变化；之后独立核对这 7 个摘要与提交 `aebe9c8acb4c1c583e0e90863f88c3f9f1e840e5` 完全相同。测试期间 HEAD 提交变化没有替代文件内容校验。
- 命令：`node tools/desktop-native-picker-smoke.mjs --expected-binary-sha256=b7ce68b84a935cfb902535346d390c98b1491431ae75a758dd474c17ff90b96d --output=/tmp/eastgenesis-picker-after-fix.json`。

## 13 个真实场景

| 场景 | 实际证明 | 结果 |
|---|---|---|
| 工作目录取消 | 原生面板取消后没有新上下文或 root | 通过 |
| 工作目录选择 | 原生选目录、任务上下文可见，roots 未扩展 | 通过 |
| 项目上下文 | 原生选目录、保存前目录 UI、保存后项目 UI、SQLite `context_folders` 持久化，roots 未扩展 | 通过 |
| 未授权写入 | 已批准的工具调用仍被 Rust `path_not_allowed` 拒绝，测试文件指纹不变 | 通过 |
| Settings 取消 | 原生面板取消后白名单不变 | 通过 |
| Settings 显式授权 | 只新增测试 root，builtin UI 运行中，默认 Downloads 不可移除 | 通过 |
| 授权后的真实读写 | SQLite 终态 `completed`，2 条 `tool_result.ok=true`，实际产物内容和摘要验证 | 通过 |
| 外部目录写入 | 已批准的写入仍被 Rust 拒绝，外部测试文件指纹不变 | 通过 |
| 符号链接读取 | 指向外部目录的链接被 canonical 沙箱拒绝，终态 `needs_user`；6 次只读工具尝试均失败 | 通过 |
| 符号链接写入 | 已批准的写入被 canonical 沙箱拒绝，外部测试文件指纹不变 | 通过 |
| 移除 extra root | 同进程移除持久化完成，builtin UI 运行中，默认 Downloads 保留 | 通过 |
| 撤销后的写入 | Rust 拒绝，先前授权生成的产物指纹不变 | 通过 |
| 默认 Downloads 真实读写 | 移除 extra root 后仍 `completed`，2 条工具结果成功，实际产物和摘要验证 | 通过 |

每个文件任务都经真实 UI 创建，SQLite 仅作只读证据源。拒绝场景的 JSON 保留合成测试文件的 before/after inode、mtime、内容摘要；写入授权和默认 Downloads 各点击一次批准，只读工具未点击批准。上下文文件夹与文件授权没有混为一体。

修复前同类新授权任务仍 `needs_user` / `pathDenied=true`，见 [修复前记录](macos-picker-before-fix-2026-10-07.md)。本轮完成读写后再撤销并拒绝，证明新的服务器配置在同一进程内生效；UI “运行中”本身不作为权限生效证明。

## 隔离、清理与排除范围

使用 fresh temporary HOME、Downloads、Documents，合成 loopback Provider，受 `EASTGENESIS_QA_ISOLATED_PROFILE=1` 保护的 QA Keychain 禁访守卫。只触达测试拥有的文件和 symlink；不种植任务/项目/账本 SQL，不读取真实 Provider 或普通用户 profile。所有任务的非空 LLM 事件都指向合成 QA 配置，loopback 记录请求计数 plan=16、args=7、stream=2、json=24；未记录请求正文。

原生面板通过测试 PID 的固定控件操作，输入只与已知测试路径做布尔比对，未记录真实路径、Provider 名称、凭据或原始 AX 文本。测试进程受控清理成功，临时 HOME 在报告写入前已删除。

本轮不覆盖真实 Provider、Windows/Linux native picker、保存失败的 UI 故障注入、签名/公证及文件系统全部对抗竞态。普通/QA Rust 保存失败回归是独立证据，不能用这条正常 UI 路径替代。

机器可读记录：[macos-picker-sandbox-2026-10-07.json](macos-picker-sandbox-2026-10-07.json)。

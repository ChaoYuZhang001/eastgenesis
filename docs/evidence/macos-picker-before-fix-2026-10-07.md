# macOS 原生目录选择与权限生效：修复前证据

2026-10-07（北京时间 04:24:21–04:26:24；UTC 2026-10-06 20:24:21–20:26:24），在 macOS 26.7.1 / x64 的真实 Tauri/WebView 窗口执行。应用版本 0.1.0，包标识 `com.eastgenesis.desktop`。这是修复前的阻断记录，整体未通过。

## 构建与执行绑定

- binary SHA-256：`552c8e86168491003348334d4714de1bcd2957ee12488b424e34f8e468f75e86`。
- 当轮 harness SHA-256：`ae6def81ca72c19f99147052b49e500509116f41fe27f740edcd4ea87c03cf7f`。
- 当轮源码 HEAD：`e3a9971f7a27807f14ae241c426711fcf4fb4b56`；正在独立修改的工作树不作为此旧 binary 的编译证明。
- 编译边界的旧 `file_roots.rs`：从 `git show e3a9971f:EastGenesis/crates/eg-core/src/file_roots.rs` 核对，SHA-256 `6f4d2a4cf31431e07021563b953620e677103c3a284133320bf8bfcd2c3f21fd`。
- 当轮命令：`node tools/desktop-native-picker-smoke.mjs --output=/tmp/eastgenesis-picker-full-4.json`。这个命令对应当轮旧 harness；后续 harness 要求显式提供预期 binary SHA-256。

## 真实结果

共 6 项通过、1 项失败、5 项未运行。工作目录的原生选择与取消通过；上下文可见且没有自动授权。项目的原生选择、保存前目录 UI、保存后项目 UI 与 SQLite `projects.context_folders` 持久化通过，权限白名单仍为空。未授权的真实写文件任务被 Rust 沙箱拒绝，固定合成文件的 inode、mtime 与内容 SHA-256 均未变化。Settings 中取消原生选择也不改变白名单。

Settings 显式选择后，`file-roots.json` 仅新增测试拥有的那个目录；默认 Downloads 项仍不可移除；界面显示内置服务器运行中。JSON 中的 `builtinReconnected` 仅表示重启尝试后的 UI 运行状态，不能证明服务器采用了新权限。

随后同一进程提交的真实读写任务得到 SQLite 终态 `needs_user`，实际 `tool_result.ok=false` 且 `pathDenied=true`。任务没有完成授权后的读写。这个现象与内置 MCP 服务器复用启动时目录快照的源码问题一致；修复后的行为必须用新 binary 单独验证。

外部目录、符号链接逃逸、移除 root、移除后拒绝共 5 项保留 `not_run`。没有重启应用绕过授权生效问题，也没有种植任务 SQL 或账本。

## 隔离与证据边界

使用新建且已清理的临时 HOME、Downloads 与 Documents，只使用受保护 QA 构建的合成 loopback Provider，禁访真实 Keychain，未读取普通用户 profile 或私有 Provider 配置。HTTP 请求仅记录计数（plan=4、args=2、json=7），不保存请求正文。原生选择器只对测试 PID 的固定控件执行操作，目录输入仅与已知合成测试路径做布尔比对；没有记录原始 AX 文本或真实用户路径。

测试进程受控清理完成，临时 HOME 已删除。此记录不覆盖真实 Provider、Windows/Linux picker、签名/公证、文件系统全部对抗竞态、后续 FileRoots 保存事务修复或新服务器生命周期修复。

机器可读记录：[macos-picker-before-fix-2026-10-07.json](macos-picker-before-fix-2026-10-07.json)。

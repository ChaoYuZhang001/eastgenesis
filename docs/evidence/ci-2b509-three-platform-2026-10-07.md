# 三平台 CI 终态：2b509 源码快照

日期：2026-10-07。阶段：Alpha / 内部 QA。

[run 37575271906](https://github.com/ChaoYuZhang001/eastgenesis/actions/runs/37575271906) 的实际终态为 `completed / failure`。Root 在 2026-10-07 再次通过 GitHub API 确认 head、三项 job、公开树和唯一 parent；结果不是工作流文本或旧 run 的推断。

| 平台 | Job | 唯一前端测试人口 | 实际结论与限制 |
| --- | --- | --- | --- |
| macOS | 112642644217 / success | 1073 passed / 0 skipped | 包内二进制烟测通过；本 run 的真实 WebView DOM 未运行 |
| Ubuntu | 112642644229 / success | 1073 passed / 0 skipped | 四个实际 Tauri WebView 场景通过；合成同源码 Debian QA 安装/升级通过 |
| Windows | 112642644025 / failure | 1056 passed / 17 skipped | 第 17 步 Rust workspace tests 失败；后置 MCP、NSIS、安装生命周期和 WebDriver 未运行 |

前端人口为 108 个文件、1073 个唯一用例。后置测试中的重复用例没有再次相加；Windows 的跳过没有被当成通过。

Windows 第一失败为 `wrapper::sqlite_path_tests::unchanged_database_creation_and_reopen_use_one_real_file`。原日志记录 `sqlite_path_tests.rs:170:37` 的 `Directory::drop` 删除目录发生 Os32 sharing violation；SQL 插件套件 8 passed / 1 failed，Cargo 101。它证明清理时文件被占用，未定位持锁进程。此次没有执行新的 `process_job` 诊断，因此不能把它写成此前 CF8 NSIS 故障已解决。

Ubuntu 的 `staged`、`slow-first-token`、`truncated`、`idle-cancel` 四个真实 DOM 场景通过。计时各为 n=1，仅供描述。Debian QA `0.1.0 → 0.1.1` 安装、升级、启动、保留合成会话与卸载清理通过，但两包代码和 schema 相同，不证明正式发行升级或历史 schema 迁移。

公开 head `2b509b7a4bd048412d442ad31360c7c7316a10d7`，tree `9f1fe7c6a2366c1c8d56cd8106d2ee590a098247`，唯一 parent `e8b5d61f107fba9a580a7a856613b6280b89c0ec`。733 个 Git blob 和 mode 与 local `c16ae0274a9066709baf8047951675b299b76092:EastGenesis` 逐项等价；唯一排除的 MEMORY.md 未读取。源码内容 16,973,688 bytes，源码归档 17,582,080 bytes，实际网络传输量未计量。编译缓存及 Desktop 父仓库历史未加入这份新源码快照；现有 main 历史保留。

Root 逐项核验 85 个捕获文件、2,271,864 bytes、86 个 ZIP 成员。小型 ZIP 480,680 bytes；Linux 诊断 artifact 6808 bytes，Windows 构建前合成 artifact 5071 bytes。未为捕获下载大型安装包。捕获中的 `local-review` 属于本地审阅，不能当 CI 执行证据。

固定证据：[终态审计](ci-2b509-terminal-2026-10-07.json)、[85 文件 SHA 索引](ci-2b509-capture-index-2026-10-07.json)、[733 Git blob 绑定](ci-2b509-source-binding-2026-10-07.json)、[Root 独立核验](ci-2b509-root-verification-2026-10-07.json)。原始捕获与小 ZIP 保存在 `/tmp/eastgenesis-ci-2b509`；索引与公开 run 链接保留其来源边界。

这份 run 绑定 c16/2b509。之后的 checkpoint 错误传播和 Windows 测试清理修改属于新候选，必须执行新的 CI，不能继承本 run 的平台结论。

# Plan-only ledger 修复后的 macOS 原生恢复 — 2026-10-07

macOS 26.7.1/x64、QA 0.1.0的新包于UTC 01:34:41.099–01:37:44.458通过三个原生故障恢复场景，exec72127终态exit0。对应生产变化为“已有durable ledger也进入reconciliation”；后续账本读取错误的fail-closed修复尚未进入这个包。

Binary SHA256 `b691ca8fd9f855afe759347dd5666016ce99a3526d4cd6b77312347b57a91c08`，12,213,256字节。QA构建绑定完整322输入，起止源码、binary、冻结harness `235b13ce1c8b7bc08dd418f513a56a06c8505cc9d14c076e6136be8c257246bd`和cleanup helper均一致。Root独立复核全部输入及原报告，不将脚本自身仅八文件摘要扩大为完整构建来源。工作树变化包含在构建中，formalReleaseBinding=false。

| 场景 | 活跃30秒QA租约期间 | 到期后真实结果 |
|---|---|---|
| after_ledger_started | 同task needs_user，无副作用 | probe not_applied，重新批准后一次真实MCP move，ledger applied/goal completed |
| after_tool_before_ledger_commit | 同task needs_user，已移动文件不变 | probe applied，复用产物，无恢复tool_result，ledger applied/goal completed |
| unknown_after_external_sandbox_removal | 同task needs_user，无重放 | harness仅移除自己拥有的已移动临时产物；实际probe unknown，ledger unknown/goal paused，无批准重放入口或文件重建 |

Goal/Task/checkpoint/Invocation由真实Tauri/WebView UI创建；SQLite只读查询。实际SIGABRT发生在两个账本窗口，文件inode/mtime/摘要用于副作用核对。每场景使用fresh HOME/Downloads、最小环境、合成loopback Provider和QA Keychain禁访守卫；三个场景的controlledCleanup均为true，临时profile移除，restoreDialogsDismissed均0。

原始[JSON](macos-plan-only-ledger-native-2026-10-07.json) SHA256 `11a9f2eb739bcac24ef0d695f1536a5f195055f481b31096963b8ae15c693cc5`。完整[构建清单](macos-plan-only-ledger-build-manifest-2026-10-07.json)及[Root起止验证](macos-plan-only-ledger-root-verification-2026-10-07.json)独立保留。Root初次post-verifier误将controlledCleanup读到assertions下，按原报告实际scenario级字段修正后通过；没有重跑App、修改harness或补写原报告。

该轮证明现有原生崩溃/租约/探针路径未因plan-only ledger修复回归。它没有在native里制造plan-only旧writer快照或SQLite读取错误；这些分支分别由实际Runtime及两Node进程/SQLite受控回归验证。它不证明历史旧native→新native升级、真实Provider、Windows/Linux、三平台性能、签名/公证或生产10分钟租约即时接管。后续候选需要独立新binary验证，不能覆盖此记录。

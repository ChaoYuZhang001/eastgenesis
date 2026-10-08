# e723 三平台 CI 与 760b macOS 原生恢复：固定来源证据

记录日期：2026-10-07。该记录描述已经结束的运行，不代表后续源码的验收，也不代表 M23 完成。

## 来源

- 本机源码：`760b1b21feb03f8f7fede759910e3e52f9830130`；EastGenesis subtree：`35082d313e027ac9304d085b0c0899eae4fdbd04`。
- 公开源码：`e723361f4fe5fbb90c65227c76c5bd3b8af50371`；tree：`3a8ca50e6f2a3195649355be8766d9e31b3467c5`。
- 公开源码 787 files / 22,761,046 content bytes。公开提交 sole parent 为原 main `e8b5d61f107fba9a580a7a856613b6280b89c0ec`；未合并 main，未发布 Desktop 父仓库历史、构建缓存、项目 MEMORY 或私密配置。
- 完整本机门禁 110 files / 1132 cases 全通过，0 fail / 0 skip；55 条合成配置和脱敏用例已包含在其中。实际 Provider 没有执行。

## 三平台终态

[GitHub Actions run 37593401238](https://github.com/ChaoYuZhang001/eastgenesis/actions/runs/37593401238)，attempt 1，pull_request，head e723，整体 completed/failure。

| 平台 | Job | 终态 | 实际验证和限制 |
|---|---|---|---|
| macOS | 112700070078 | success | 前端唯一 1132 pass / 0 skip；SQL 普通 12、QA 18 及各自 doc 1 通过；unsigned QA bundle/package smoke。此 CI 不运行 macOS 原生 DOM。 |
| Linux | 112700070233 | success | 前端唯一 1132 pass / 0 skip；SQL 普通 12、QA 18 及各自 doc 1 通过；四个实际 WebView DOM fixture 场景通过；Deb 安装、外部物理 schema 7、同代码 0.1.0→0.1.1 fixture 升级和 sentinel/purge 通过。不是生产跨版本迁移。 |
| Windows | 112700069937 | failure | 前端唯一 1126 pass / 6 POSIX skip；SQL 普通 13、QA 19 及各自 doc 1 通过。第 22 步 NSIS 生命周期的外部 schema probe CreateProcessW error 123。 |

唯一前端计数按冷 catalog 加 11 条原跳过的 native MCP 用例计算；另 4 条 MCP 和 3 条跨进程恢复重复执行不累加。Cargo stdout/stderr 交错，最近 banner 不足以证明 Rust 模块归属；SQL 上述计数由实际命名测试和完整结果块验证。

Windows 新 C#/PowerShell 输入诊断已经实际序列化：role `sqlite_schema_probe`，application UTF-16 length 124、drive_absolute、exists false、fullPathComparison failed；cwd length 82、exists true、fullPathComparison same；command length 460、quotedApplicationPrefix true；三个输入没有记录正文。旧 Python discovery cardinality/type 没有捕获，因此不能据此确认具体路径被如何合并。应用 4 秒稳定窗口通过、DB 文件存在、36 条启动 trace 到 frontend_ready（3081 ms）不能替代外部 schema 7 证明。失败后 NSIS uninstall、binary removed、registry removed 通过；cycle 2、repair、sentinel 保留和 Windows WebDriver 尚未执行。

Linux 四个 DOM 场景各 n=1：staged 首正文 101 ms / terminal 727 ms；slow-first-token 首正文 359 ms / terminal 1013 ms；truncated 首正文 61 ms / terminal 224 ms；idle-cancel terminal 377 ms。计时起点是 WebDriver 提交命令之前，度量 task-store 正文/终态观察及 native IPC；不代表模型 TTFT、首次绘制或性能基线。

捕获目录 `/tmp/eastgenesis-ci-e723-20261007-7zy7p5us` 包含 147 个被索引文件、三个实际原始 job log、五个实际 kind-bearing stdout 对象、56 个选定 Git blob，以及完整 787 个公开/本机 blob+mode 来源映射。没有下载大型桌面安装包。五个 stdout 对象均按原始行范围独立重建相等；shell echo 不是执行证据。

| 冻结证据 | SHA-256 |
|---|---|
| CI `SHA256-bytes-index.json` | `e6a38847d621fa6d3194c09d76aaa49a1ed0398cbbe2785c3df102bfed52f395` |
| CI `evidence.zip`，148 members / 752916 bytes | `fbb8044ce14cb05116133f8c39593c1a0474f0bb0ae49be930e1551d7e0292c2` |
| CI `analysis/terminal-audit.json` | `5d092cdf2b4dea806fc842cdc873f09f57ec3520e8268bc40d1a7d09754f866a` |
| Root 独立 CI proof，1248 bytes | `e6680ca32396a4110ca6cb9aa923d4de55fd5de32e4b6837b35349d4d717dc3f` |

Root 独立 CI proof 位于 `/var/folders/hx/mwmbxj2n04b0_ncsr9mzqdph0000gn/T/eastgenesis-e723-terminal-ci-root-audit-20261007-3d22dv0p/proof.json`，重新检查全部索引与 ZIP 字节、全部 787 个当前本机和新鲜公共 API blob/mode、实际 stdout 行、named SQL results、terminal run/job/head/main/draft PR。该复核没有重跑 App、构建、测试或 Provider。

## 新 macOS QA 构建与完整 Goal 场景

原十分钟 cold QA 构建实际超时，manifest `c5ddd0c0bfba05b77cfd3dcfaa17800bde25d8af5c5d495e2f2849c20461d9d0` 保持 failure/timedOut=true。记录中的 child exit code 0 不将超时变成通过。

后续相同 787 源文件、相同 owned target 缓存及原 600000 ms 预算的缓存构建实际通过，manifest `ee758927a232939700004aa048229261eb48852a0c7f78a7c353efe01d4cc531`。主 binary 12,217,352 bytes，SHA-256 `3502c9668690a510951e66a9b9855ab31b65e9113bd0cc9a73af78c8ea167d7b`；原、复制 App 的完整文件/目录/mode 起止一致。缓存成功不是 clean-cache 成功或正式签名发行。

冻结 native v12-r1 场景于 UTC 08:55:00.643–08:55:30.374 实际执行，29,731 ms，四阶段通过：实际 UI 注册两个合成 Provider；same Goal 部分失败；受控 owned 重启保留 same Goal；实际继续 summary-only。

- 同一 Goal/task/round 中，Work 读取显式 QA 文件，Codex 经显式 QA 确认写入文件，Chat A 失败后 B 返回 accepted marker，A 总结产生部分正文后失败。
- 受控 SIGTERM 重启后原 accepted Chat 和 partial 正文保留。继续只新增 A summary，实际请求携带 accepted Chat marker；没有重新执行读、写或账本 probe。
- 原两条 `attempt=1 / applied` read/write 账本及 taskIdentityDigest、ledgerIdentityDigest、ledgerFingerprintDigest、migrationMetadataDigest 四摘要在 failure、restart、complete 三阶段一致；文件 41 bytes、inode、mtime、SHA 不变。
- 存储逻辑调用 `3→3→4`，实际请求 `A3+B1→A4+B1`。同一逻辑调用的 Provider fallback 可产生额外 POST，因此不是 HTTP 次数或完整费用计量。
- 实际 UI 点击“确认已完成”后 Goal/round/checkpoint 才为 completed/done/completed。
- 90 条动作记录中，51 条具备身份证明，53 条实际 PID 记录，2 次 CFEqual 比较均真；完整身份扫描最大 422.393 ms，未超过 450 ms。一次 detail probe 不完整后另做完整 fresh62/62 read+strict press，实际找到原 Goal；零匹配导航分支未执行。
- 四份正文 AX 记录证明精确匹配正文和 Goal/round 祖先结构及冻结几何可见门禁，不能当成像素截图或任意遮挡证明。
- 原生清理后，独立 fresh ps/root 检查 App、AX、MCP、build 相关 PID/group 和 fixture 临时根为空；临时 DB/文件已安全清理，复核没有声称清理后重新打开它们。

原始 native report `/tmp/eastgenesis-unified-goal-native-pilot-760b-v12-r1-20261007.json` SHA-256 `5e53fe5c45308d50b124185b90ab129188c4f3aac4f3c1170ad7d9a700aca067`。完整独立复核目录 `/tmp/eastgenesis-760b-native-build-independent-20261007-i8zeld2w`：final-combined-proof `c1f2442c563b80642b88a3083525c63849c175e609834a9edaed83d1f0b77816`；build/source/process proof `77c332d40c43ac6cf5b72fdede484b21bca600bac3c42db5ee56e7d2b78100d1`；AX/DB/ledger child review `52d99c8346459ee9fe58c3abf77768831bee0692429db717610f6b56083298ee`。两个审阅者都没有再次执行原生场景或修改原始证据。

## 尚未证明

真实两个独立 Provider、真实 A 上游故障后 B 切换、实际金额/隐藏推理计量、三平台签名与生产跨版本迁移、性能基线及一般任务质量仍缺证据。此 native 场景不直接覆盖全部新 settlement failure、legacy 未知计数、exact-max、并发恢复；137 条窄测属于它们的单独证据。旧未知计数的可操作 UI、独立 Jev/raw fallback 调用、usage D 一次性旧 task 标记、一般 stale checkpoint 和任意长 accepted-output 仍待修复。产品继续为 Alpha / 内部 QA。

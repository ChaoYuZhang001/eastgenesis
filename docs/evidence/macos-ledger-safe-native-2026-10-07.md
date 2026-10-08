# macOS 两项恢复修复候选：原生三场景回归

日期：2026-10-07。实际原生时间 2026-10-07T01:53:14.205Z–2026-10-07T01:56:16.445Z（UTC）；macOS 26.7.1 / x64，QA App 0.1.0。

包含 durable-ledger 恢复判断与读取异常失败关闭两项修复。新 binary SHA256 `45c7986bd8ab5b201ebcdd4cfa049822dccaa723be0649293f8d5f9277aa5fce`，12,213,256 bytes；构建在 2026-10-07T01:49:08.723Z–2026-10-07T01:53:00.097Z（UTC）成功。322 个构建输入、binary、冻结 harness 和 cleanup helper，在实际原生运行前后保持同一摘要，Root另用Python独立核对全部322文件、两份manifest、原报告和场景断言。

来源：[原始原生报告](macos-ledger-safe-native-2026-10-07.json)、[原始构建清单](macos-ledger-safe-build-manifest-2026-10-07.json)、[Root核对记录](macos-ledger-safe-root-verification-2026-10-07.json)。原报告与构建清单字节原样保留；Root公开副本仅将命令中的机器路径替换为固定占位，另绑定未修改本地原记录SHA256。

| 实际原生场景 | 结果 | 验证行为 |
|---|---|---|
| after_ledger_started | passed / completed | 实际进程abort；活动lease期间不重放；QA lease到期后真实probe=not_applied，重新批准后执行一次 |
| after_tool_before_ledger_commit | passed / completed | 实际文件移动已发生；活动lease阻止抢占；到期真实probe=applied，复用结果，恢复工具结果数为0 |
| unknown_after_external_sandbox_removal | passed / paused | harness仅删除已验证的自有临时产物；真实probe无法核实，needs_user，不批准、不重建文件 |

三场景均由实际Tauri WebView创建目标/checkpoint，实际builtin MCP在新HOME的Downloads沙箱移动文件；数据库仅以只读方式查询，未预造任务或账本。两成功场景文件inode、mtime与SHA保持身份；全部场景复用同一task，未重复副作用，已完成自有进程/profile清理，restore dialog dismiss为0。fixture请求计数：plan3、args6、stream2、jsonProbes0。系统钥匙串由QA guard禁用，没有继承Key环境或读取私有Provider配置；捕获的模型调用均为隔离loopback fixture。

本轮QA lease为30秒，生产lease为10分钟。本报告证明包含两fix的新候选上既有三个原生恢复路径未回归；**没有在native里生成stale plan-only checkpoint或注入ledger读异常**。那两项新故障按[实际Node/SQLite回归](durable-ledger-recovery-local-2026-10-07.md)的独立范围证明。未执行历史native writer→当前reader、真实Provider、Windows/Linux原生恢复、任意外部服务副作用核实、自动完成判断准确性、性能或签名/公证。

这是工作树QA构建，localParentRevision仍为b781，formalReleaseBinding=false。此前只含第一fix的b691构建/原生报告独立保留，不覆盖或替换其来源身份。

## 2026-10-07 来源范围更正

原清单列出的322项在原生起止确实一致，但没有包含Vite入口 `index.html` 及 `assets/brand/`，因此不能称“全部构建输入”。原始JSON、二进制身份与三场景断言保持不改；该旧运行仅按实际322项范围引用。后续从a035完整Git源码重建的reader另有675项输入与676个完整Git blob/权限的构建起止绑定，尽管二进制字节SHA恰好相同，也应按新构建时间独立登记，不能事后补写旧manifest。

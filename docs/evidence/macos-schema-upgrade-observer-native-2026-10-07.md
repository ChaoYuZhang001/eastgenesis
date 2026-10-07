# 最终 macOS QA：实际迁移、重启与 native SQL typed observer

2026-10-07 UTC 01:08:04.274–01:08:09.744，最终 QA `0.1.0/x64` 包通过一次两轮原生执行，exit0、无重试。binary SHA-256 为 `49a080f76ce3b3f322681705c8892d57435e8f5e7705c92e75bdbc49435fbade`，12,213,256 字节；[构建清单](macos-schema-upgrade-observer-build-manifest-2026-10-07.json) 绑定322个输入，SHA-256 `52d5e27625eb4f7b5b9133a68facd9de6be97a588a94e0ce5e7a3243d1f27f94`。

本包包含 schema bootstrap 防护、可重试 SQL 迁移和新的 QA typed observer。[前一320输入包的验收](macos-schema-upgrade-native-2026-10-07.md) 保留独立边界，不覆盖本包。

| 轮次 | 实际结果 | 运行断言 |
| --- | --- | --- |
| attempt1：schema6→7 | 当前 migration 前缀1–6合成旧库，由实际 app/plugin执行7；八表旧字段与四种ledger状态全部保留 | 22项全部true |
| attempt1：同profile重启 | 结构与完整只读snapshot不变，含SQLx installed_on/execution_time/checksum；未重放迁移 | 23项全部true |

每轮有36条严格固定trace，包含原生SQL七阶段，顺序均为：

```text
sql_plugin_ready → sql_load_entered → sql_connect_started → sql_connect_resolved
  → sql_migration_started → sql_migration_resolved → sql_load_resolved
```

七条均为 `source=native, frontendSeq=null`。Root另外核对其实际顺序和唯一性，并用生产严格读取器验证两份trace；没有从前端Display文本推断错误类型。`migration_resolved`只表示helper返回成功，物理SQLite升级/数据保留仍由独立只读检查证明。

新 [harness](../../tools/desktop-macos-schema-upgrade-smoke.mjs) SHA-256 `33e488f2ed8938f22196993cf1039f47ea11c6b9fe40546ac4f2feb494fcc7df`，更新parser绑定并将七个native SQL marker设为必需。之前903a162d版本逐字节归档于 `schema-upgrade-harness-before-observer-2026-10-07.mjs.txt`，不是覆盖旧验收的输入来源。322份源码、完整源bundle、binary、harness、parser、cleanup与SQLite helper起止摘要一致；源appdata始终不存在。

两进程受控退出、进程组消失、无zombie，remainingOwnedApps0；复制app、profile及自有根删除。整个执行5470ms只是harness功能耗时，不是启动或性能基线。

[原始固定报告](macos-schema-upgrade-observer-native-2026-10-07.json) SHA-256为 `8737828b4e457bc93972f9aa9ce8f4f4c5e411b33fb7ca608d24011713283d8b`；[Root独立复核](macos-schema-upgrade-observer-root-verification-2026-10-07.json) 记录实际SQL marker、断言计数和绑定。

本轮证明最终QA包中诊断注册和成功load链真实执行，且合成旧库升级/重启后保持数据。不证明Windows失败类别、ACL/文件系统根因、历史生产发行版升级、历史checkpoint hydration、恢复工具执行、真实Provider、性能、普通release或签名/公证。新Windows CI必须单独采集失败或成功证据。

# 实际 macOS QA：合成 schema 6 升级与同 profile 重启

2026-10-07 UTC 00:48:27.361–00:48:32.919，冻结 QA `0.1.0/x64` 包的唯一一次两轮执行通过，exit0、`passed=true`、`runCompleted=true`，没有重试。binary 为 12,205,048 字节，SHA-256 `933ffb249975e6ff29abf76fe566652d571d7cdb883067f02dca980bb3f86724`。这份包包含 schema bootstrap 防护与 SQL 插件迁移重试修复，**不包含后续 QA typed SQL observer**。

| 轮次 | 实际路径 | 检查 |
| --- | --- | --- |
| 1，attempt1 | 当前 Rust migration 字符串前缀 1–6 合成旧库 → 实际 app/plugin 执行 migration7 | 22 项运行断言与 21 项退出后断言全为 true；schema7、八表旧字段、ledger 四状态及 SQLx 元数据验证通过 |
| 2，attempt1 | 同一复制 app、HOME、数据目录和数据库重启 | 23 项运行断言与 22 项退出后断言全为 true；完整只读 snapshot 与第一轮退出后相等，迁移未重复 |

## 数据与执行来源

工具按当前 `eg-core MIGRATIONS` 的实际转义/续行字符串执行迁移 1–6，在一次事务中填入 SQLx 0.8.6 所需的 SHA384 元数据与合成哨兵，再关闭 fixture writer。migration7 只计算预期 checksum，不由工具执行。之后所有 SQLite 访问均为 `/usr/bin/sqlite3 -readonly`，只有实际 app/plugin 可以升级结构。

保留检查覆盖八张表的全部旧字段：app_meta 的 8 条设置、projects/goals/memories/skills/sessions/usage 各 2 行、工具账本 `unknown/started/applied/conflict` 四行的 12 个旧字段。非空 rounds/turns/skills JSON、软删除行和 usage 全部保留。新 lease 字段均为 NULL，索引精确覆盖 `lease_expires_at`；integrity=ok、外键违规=0、迁移 1–6 元数据不变，SQLx 1–7 版本/描述/checksum/success 全匹配。

第二轮完整 snapshot 相等包含 migration7 的 `installed_on=2026-10-07 00:48:28`、`execution_time=1904166`（SQLx 纳秒元数据）及 SHA384 checksum。不是通过 schema 数字相等推断无重复迁移。

每轮 29 条固定阶段记录、所需 native/frontend marker 全部存在。严格 trace `complete` 与物理数据库验证分别检查，不能单独把 `complete` 称为应用 ready。

## 构建绑定与清理

[最终构建清单](macos-schema-upgrade-build-manifest-2026-10-07.json) 绑定 320 个输入，SHA-256 `aa45381e69219268bb5ca1c590beb9cfc3aea3dd137c6c0b6fa58a35e9457e83`；冻结 harness SHA-256 `903a162d5ddaec74ecda6c7ed071b7c6c82ce5d1fc995a4eb5c907022dbe5d19`。Root 在执行前逐一重算 320 个输入与 binary/harness，并核对执行后的固定原报告 SHA；报告还绑定完整源 bundle、两次复制成员、parser/cleanup/SQLite helper 的起止摘要。

首构建通过但清单未列出品牌同步脚本读取的 `docs/BRAND.md`，因此未用于 GUI。其 [319 输入 pilot 清单](macos-schema-upgrade-build-pilot-manifest-2026-10-07.json) 和原日志保留；补齐输入后执行一次最终增量构建，320 输入无变化，最终 binary 与 pilot 的 SHA 恰好相同。不能用相同 binary 摘要替代完整输入清单。

每进程最多 30 秒、总预算 120 秒、1100 ms 稳定观察。两次 SIGTERM 后 leader 均退出、进程组消失、zombie0；最终 remainingOwnedApps0，自有根目录、复制包与 profile 已删除，没有最终补救清理重试。没有继承 Provider Key、读取私有配置、触达真实 Provider 或修改源 app 数据目录。

[原始固定报告](macos-schema-upgrade-native-2026-10-07.json) SHA-256 为 `efe91ca05ef27298b810a5f9fe1788d26b4b93010bdc171a248c5432ddfb5976`。

## 结论边界

这证明当前钉定 migration 前缀的 **合成 legacy-compatible SQLite，经实际 macOS QA 插件升级并重启后保持数据**。它不证明历史生产发行版升级、历史 checkpoint parser hydration、恢复工具执行、普通 release binary、Windows/Linux、UI 像素/AX readiness、性能基线、真实 Provider 或签名/公证。后续 typed observer 修改应绑定其自己的新构建与运行，不能覆盖本报告的源码边界。

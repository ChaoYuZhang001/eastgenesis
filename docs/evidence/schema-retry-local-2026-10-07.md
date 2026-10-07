# 数据版本启动防护、可重试迁移与 QA SQL 加载诊断

2026-10-07，本批候选修复两个相连的恢复问题：前端读取 schema 后没有检查兼容版本，会把未迁移旧库/较新库/缺失元数据当成 ready；已钉定 SQL 插件 2.5.0 的 `load` 在迁移成功前移除注册定义，首次迁移失败后的再次 load 可能绕过迁移。当前实现保留定义直到 SQLx 成功，迁移期间持有原注册锁，并在前端接受当前 schema7 后才进入 ready。

## 行为与验证

前端的结构检查不写数据：缺失/非整数/非正数返回 `db_schema_invalid`，旧版本返回 `db_schema_not_ready`，较新版本返回 `db_schema_newer`。打开失败仍可重新打开，后端初始化重试重新读取 schema；不删除旧库、不降级、不修改已经发布的 migration SQL。

修复前四条 actual Node SQLite bootstrap 用例有三条失败，直接暴露 unsafe-ready。修复后九条用例覆盖 schema6 的未知调用保留/反复重试、未来元数据、缺失/四类无效元数据、当前活跃 lease 保留、修复 fixture 后重读版本。五套专项共35条通过；后续最终前端 **102文件/991条、零跳过**，四套 schema/诊断/读取器/Windows consumer 专项83条、typecheck、合成配置脱敏55条通过。

SQL 插件保持成功 load 的公共参数/返回/错误和发布时机。失败或取消释放迁移锁但保留定义；同一 app 内首次迁移互相串行，第二个 load 不能在未完成迁移时发布 pool。锁也会串行不同数据库 URL 的首次迁移，是明确的代价；当前应用只使用一个固定 SQLite URL。

实际 SQLx/SQLite 四条回归涵盖事务回滚、修复后重试、反复失败、checksum/dirty拒绝、并发 load等待和成功后无重放。observer 前普通/QA workspace desktop36/35、core各90、stdio3+2、插件4及doc1通过。另已完成 [实际 macOS QA 合成 schema6→7及重启](macos-schema-upgrade-native-2026-10-07.md)，其冻结源码和原报告独立保留。

## 依赖与维护

使用已经钉定的 `tauri-plugin-sql 2.5.0` 官方 crate，归档SHA `811fca8f6b80ca3026496db4612d93000ce96915ac6e36f7adc73b8232aee9f0`。Root及独立复核者从缓存归档重新计算25个原文件、VCS commit/path和三份许可记录，全部匹配 [UPSTREAM.json](../../vendor/tauri-plugin-sql/UPSTREAM.json)。维护说明见 [PATCH.md](../../vendor/tauri-plugin-sql/PATCH.md)。

Cargo.lock 的605个 package版本集合保持相同。改动仅为本地patch删除原plugin registry source/checksum，及 workspace解析下 `sqlx-core` 指向已经锁定的 `rustls`/`webpki-roots 0.26.11` 两条边；不称锁文件完全不变。原始checksum仍在provenance中，未来上游升级需对照本补丁和回归再移除patch。

## Windows 后续诊断

[9ee CI](ci-9ee-three-platform-2026-10-07.md) 已观察到 Database.load reject，但没有具体 Rust错误。下一候选只在 `qa-load-observer` feature 和应用既有强隔离guard成立时注册typed callback，对一个固定db URL观察命令体进入、connect、migration和pool发布。16个无载荷enum映射到native固定Stage；错误先按实际Rust/SQLx variant分类，再保持同一原错误返回，不解析Display、不记录路径/SQL/URL/数字错误码/异常文本。

记录器和读取器仍限制64条/32KiB、严格UUID/字段/序号，SQL阶段只能来自native。错误类别只能证明连接配置、SQLite cannot-open/锁、OS PermissionDenied、迁移checksum/dirty或未细分失败的family，不能单独确定文件系统根因。migration_resolved只表示helper返回Ok，不证明本次执行了迁移。未观察到load_entered不能归因为ACL；wrapper中既有expect panic仍可能只有connect_started而没有结果，保留未知。

最终普通/QA workspace通过：desktop36/35、core各90、stdio各3+2、plugin4/10及doc各1。新QA构建绑定322输入、binary `49a080f76ce3b`；[实际macOS两轮验收](macos-schema-upgrade-observer-native-2026-10-07.md) 再次验证合成6→7及同profile重启保留，每轮36条trace，其中七个native SQL阶段齐全并由Root独立核对。此前320输入macOS报告不包含typed observer；新的macOS结果仍不能代替Windows运行。[本地固定JSON](schema-retry-local-2026-10-07.json) 保留日志SHA/测试统计及明确阶段边界。

Observer首次窄命令在编译阶段exit101，尚未运行测试；修正setup closure为move后有限重跑通过，原失败日志SHA保留在plugin freeze。Root两种workspace命令均exit0；辅助metadata输出的尾部字面量反斜杠n在保留原文后修正，没有重跑命令或改变测试结论。

本批仍不证明历史生产发行版跨版本迁移、历史checkpoint hydration/恢复工具执行、真实双Provider故障矩阵、三平台性能基线或签名/公证。产品阶段保持Alpha /内部QA。

# 源码快照 9ee：三平台 CI 与 Windows SQL load 拒绝分支

2026-10-07 UTC，源码快照 `9ee88388a584ab7fbadb4049aa5e93a4950d57a1` 的 [run 37550937897](https://github.com/ChaoYuZhang001/eastgenesis/actions/runs/37550937897) 已终态 **failure**。本轮包含固定启动阶段记录，项目源码归档为 12,922,880 字节；不包含下一候选的 schema 兼容检查、SQL 插件迁移重试修复和 Rust 构建后 MCP 专项测试步骤。

| 平台 / job | 完成时间 UTC | 已取得的结果 |
| --- | --- | --- |
| macOS / 112565981739 | 00:24:53，success | 普通/QA desktop Rust 36/35，core 两模式各 90，stdio 3+2；打包及 runner 24 项通过。原生 WebDriver 为 `not_run`。 |
| Ubuntu / 112565982044 | 00:31:04，success | 四个真实 WebView 场景、Debian 解包 6 项、实际 dpkg 生命周期 10 项、runner 33 项通过；同源码 QA 0.1.0→0.1.1，schema7，两包各 6,687,626 字节。 |
| Windows / 112565982111 | 00:37:19，failure | 首轮 NSIS `database_timeout`；安装、注册、完整 payload SHA 和失败后卸载清理共 10 项通过。没有进入同版本重装及后续 WebView/runner。 |

## Windows 新证据

严格启动记录读取器接受了 27 条记录，`status=observed`、`reason=complete`。原生 builder/setup、前端 document/entry/React/bootstrap、SQL import 以及 app-info 收发都已观察到，随后为 `db_load_called → db_load_failed → backend_init_failed → frontend_boot_failed`。没有 `db_load_resolved` 或 `schema_read_started`。

诊断时数据库不存在，schema probe 为 0 次；根进程与窗口仍在，job 活动进程数 7。现在能够把观测范围缩小到 **JS Database.load 的 Promise reject 分支、schema query 之前**。本轮没有记录原始 SQL 插件错误，因此具体权限、路径、连接或迁移原因仍为待验证。不得把 `complete` 解释为启动成功，也不得把下一候选的 schema 防护描述为已修复此 Windows 失败。

安装 payload 与预期 NSIS payload SHA 均为 `8cbd79ba9736f3cb034cd360056202e1b5319e616f2286b1f2b6d4b4a72cfd4b`；没有 repair。`launches=[]`，重装未执行，完整生命周期未通过。原报告 SHA 为 `29f782b696bddfd079a1a273bf65ef0bc402d7c13af040ed7975988eeb02ede6`，绑定 Windows 原日志 3107–3390 行。

## 前端测试跳过边界

macOS CI 的 Node 为 v22.23.2，前端统计为 **100 files / 970 tests passed，1 file / 11 tests skipped**，总人口 101/981。跳过精确来自 `mcp-files` 6 条、`killer-scenario` 4 条、`memory-skill-e2e` 1 条：前端测试发生在 Rust 构建之前，`target/debug/eg-mcp-files` 尚不存在。SQLite 相关测试实际运行；不能把 SQLite experimental warning 解释成它们被跳过。独立 crash-process 步骤另外重复了 1 条。

下一候选在 Rust 步骤后显式 `cargo build -p eg-core --bin eg-mcp-files --locked`，检查常规非空二进制再运行这三套测试。本机专项 3 文件/15 条通过；这是下一候选的本地结果，不能回填本轮 CI。

## Linux 描述样本

| 场景 | Headers ms | 首 body bytes ms | Transport terminal ms |
| --- | ---: | ---: | ---: |
| staged | 78 | 116 | 731 |
| slow-first-token | 66 | 363 | 976 |
| truncated | 68 | 69 | 83 |
| idle-cancel | 68 | 69 | 450 |

每场景 n=1，`performanceBaseline=false`，计时来自原生 IPC callback 到达 WebView；body bytes 可含 SSE 元数据，传输 `done` 不等于任务成功。真实 dpkg 同源码 QA 版本升级通过，仍不证明历史生产版本/schema 迁移。

## 来源与独立复核

[固定 JSON](ci-9ee-three-platform-2026-10-07.json) 包含三平台终态、观察摘要、五份原始报告及其原日志行号、70 文件 capture 清单（1,586,788 字节）。Root 独立重算 70 个文件大小/SHA，核对 terminal run 的 head 及三份 job 的 head/终态，并从绑定行范围重新解析五份报告，逐对象比较全部相等；另用实际严格读取器验证 Windows trace。capture index SHA 为 `101f199490c742af424c2753ffc74f9d141c2fb98443af0b220305479e01f18d`。

仅下载 6,815 字节的 Linux WebDriver 诊断 ZIP；完整桌面 bundle 未下载。固定证据不含私有配置或真实 Provider 请求。采集轮询有一次间隔 57 秒，其余至少 60 秒；此偏差已保留，终态后停止轮询。

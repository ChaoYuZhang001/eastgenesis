# 源码快照 383：三平台 CI 与重复的 Windows 数据库未创建

2026-10-07，run [37548012255](https://github.com/ChaoYuZhang001/eastgenesis/actions/runs/37548012255)，head `3832994f35e0ca316f71c15ebee9e3922fa1e069`，终态 **failure**。源码快照归档为 12,492,800 字节；发布后 GitHub tree `529de89c92f8a98576ccbe371d0ac0440a1d27ad` 与本地 `b97be50e:EastGenesis` 一致。本轮包含显式模型检查修正，但不包含后续 QA 启动阶段记录。

| 平台 / job | 终态 UTC | 本轮实际结果 |
| --- | --- | --- |
| macOS / 112556596337 | success，23:53:47 | 普通/QA desktop Rust 31/30，core 两模式各 90；慢流、空闲取消、空闲超时及总期限通过；打包 CLI runner 24/24。WebDriver DOM 没有运行。 |
| Ubuntu / 112556596606 | success，23:55:09 | WebDriver 四场景 4/4、Debian 解包 6/6、实际 dpkg 生命周期 10/10、runner 33/33；同源码 QA `0.1.0` / `0.1.1` 两包均为 6,678,374 字节，schema 7、两轮 4000 ms 稳定窗口、sentinel 与清理通过。 |
| Windows / 112556596546 | failure，23:55:47 | 首轮 NSIS 的 isolation probe、安装、注册及完整 payload 摘要通过；`database_timeout` 后卸载、exe/注册项删除通过。第二轮重装及后续 runner/DOM skipped。 |

UTC 时间均位于 2026-10-06，本地日期为 2026-10-07。Linux 的同源码 QA 版本升级仍不等于生产版本/schema 迁移；前端回归和打包不等于 Windows 实际功能验收。

## Windows 失败快照

`elapsedMs=34420`、`stableWindowPassed=true`、`databaseExists=false`，schema probe 次数/失败数均为 0、状态 `not_attempted`，`lastProbeFailureStage=null`；同时根进程存活、窗口存在、job 活动进程数为 7。该类别与前一快照 30d 相同，仍只能证明预期隔离数据库未创建，不能断定 JS、SQL import 或 load 的执行阶段，也不能归因为 schema 查询失败或应用退出。

`expectedNsisSha256=installedSha256=781809272023193ed99843be9d1d3978f78399ac38a8423c6abb9b5d42ad60c0`，没有替换修复；`install=true, reinstall=false, uninstall=true, launches=[]`。十项已记录检查为 true 只属于这份失败流程，不代表完整生命周期通过。原 Windows 报告 SHA-256 为 `d51719d390f1b73413594ebe4df5cd25ba1c8a863be54890cd87bbb13595855d`。

## Linux 描述样本

| 场景 | headers ms | 首次 body bytes ms | transport terminal ms |
| --- | ---: | ---: | ---: |
| staged | 53 | 91 | 700 |
| slow-first-token | 50 | 348 | 957 |
| truncated | 48 | 48 | 58 |
| idle-cancel | 48 | 49 | 390 |

四场景原生 IPC 到达记录均 verified，来源 `tauri_debug_callback_map_arrival`、原点 `before_webdriver_click_command`，terminal kind 为 `done`。每场景 n=1、`performanceBaseline=false`；body bytes 可含 SSE 元数据，传输终态不等于任务成功，不能称模型首 token、首帧或跨平台性能基线。

## 来源绑定

[固定 JSON](ci-383-three-platform-2026-10-07.json) 绑定本轮 25 份 capture（总 1,068,903 字节）、三份 job API、原始日志及报告。Root 独立重算全部大小/SHA，核对 run/head/job 终态，并从原日志的绑定行号重新提取 JSON、逐对象比较固定报告。capture 清单 SHA-256 为 `9bc040c984e92fc73a115ac0051244194fd5b885cd60a84a337ded0a8218c87f`。仅下载 Linux 6,798 字节的小诊断 ZIP，其余完整 bundle 只核对元数据，不读取私有配置或调用真实 Provider。

下一候选增加 QA-only 固定阶段记录，保持原稳定窗口、数据库等待期限、安装门禁和默认建库行为。其完成与根因结论必须由新构建和新 Windows 运行证明，不能把本轮当成该代码的验证。

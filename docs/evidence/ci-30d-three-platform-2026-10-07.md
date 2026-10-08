# 源码快照 30d：三平台 CI 与 Windows 启动诊断

2026-10-07，run [37544262739](https://github.com/ChaoYuZhang001/eastgenesis/actions/runs/37544262739)，head `30d30c5f7488a5b8ebd1f511a879215eaa8f6945`，终态 **failure**。此记录与旧 537 独立；它验证该快照中的测量和安装诊断，不覆盖后续的模型目录/显式调用检查改动。

| 平台 | 终态 UTC | 本轮实际结果 |
| --- | --- | --- |
| macOS，job 112544363424 | success，23:15:52 | 普通/QA desktop Rust 31/30，两模式 core 各 90；慢流、空闲取消、空闲超时、总期限通过；打包 CLI runner 24/24。WebDriver DOM 未运行，tauri-driver 不支持 macOS。 |
| Ubuntu，job 112544363635 | success，23:19:17 | 四个真实 WebView 场景 4/4；deb 解包 6/6、真实 dpkg 安装/QA 版本升级/卸载 10/10、runner 33/33；清理通过。 |
| Windows，job 112544363612 | failure，23:24:06 | 实际 isolation probe、首轮 NSIS 安装、注册及完整预期 payload SHA 通过；数据库等待超时，未进入第二轮重装、runner 或 WebView DOM。失败后卸载、exe/注册项删除通过。 |

所有 UTC 时间位于 2026-10-06；本地日期为 2026-10-07。Ubuntu 的两个包是同源码 QA `0.1.0` / `0.1.1`，分别 6,676,778 / 6,676,768 字节，不能充当生产版本/schema 迁移证据。

## Windows 新诊断改变了下一步排查方向

首轮失败快照：`elapsedMs=34371`、`stableWindowPassed=true`、`databaseExists=false`、`schemaProbeAttempts=0`、`schemaProbeFailures=0`、`schemaProbeState=not_attempted`、`lastProbeFailureStage=null`，同时 `rootProcessAlive=true`、`rootWindowPresent=true`、`jobActiveProcessCount=7`。

这证明失败快照时进程与窗口仍在，预期隔离数据库没有创建，schema 探针因此没有启动。现有证据不能判定前端资源是否加载、JavaScript 入口是否执行、backend.init/db.load 到哪一步，也不能归因于启动慢、schema 查询异常或应用退出。下一步应观察这些启动阶段，保持原等待期限与安装门禁。

安装后的完整 SHA 为 `d688f88f4a26c87fac2fce3d3b5ce47c88a57d548ac8a16d1f6e4c3b246a74dd`，与 CLI 2.12.0 NSIS bundle-type patch 派生的预期 SHA 完全相同；`repairedSha256=null`。`install=true/reinstall=false/uninstall=true`，十个已记录检查为 true 属于失败流程的部分证据，整份报告仍 `passed=false`。`launches=[]` 是已完成启动周期账本为空，不表示从未调度应用启动。

## Linux 原生 IPC 到达记录

| 合成场景 | headers ms | 首次 body bytes ms | transport terminal ms |
| --- | ---: | ---: | ---: |
| staged | 76 | 113 | 727 |
| slow-first-token | 71 | 367 | 980 |
| truncated | 67 | 68 | 82 |
| idle-cancel | 70 | 71 | 413 |

四场景 `nativeIpcTimingMeasurement.status=verified`，来源为 `tauri_debug_callback_map_arrival`，原点为 `before_webdriver_click_command`；terminal kind 均 `done`。这些是实际 WebView callback 到达的描述样本，每场景 n=1、`performanceBaseline=false`。body bytes 可以包含 SSE 元数据；idle-cancel 的任务正文增量仍没有已验证样本。transport done 不等于任务成功，表中数值不证明模型首 token、首帧或真实 Provider 延迟，不合并计算百分位。

## 来源绑定与边界

固定 [JSON](ci-30d-three-platform-2026-10-07.json) 含三平台 job API/head/终态、源日志摘要、逐报告摘要和 25 份 capture 清单。Root 独立核对全部文件大小/SHA、run URL/head、三个 job API 的 run/head/结论及报告检查数。原始 capture 保存在 `/tmp/eastgenesis-30d30c5f-ci/`，清单 SHA 为 `7acb3752dabd6d67f63a2e4f11447b3108bdde47750892d9dc23630766e33aca`。

仅下载 Linux 6,819 字节的小诊断 ZIP；三平台完整桌面 artifact 只核对元数据与上传 job 来源。没有读取私有 Provider 配置、调用真实 API、放宽门禁或重新触发本 run。真实双 Provider、生产迁移、完整性能基线、签名和公证仍未证明。

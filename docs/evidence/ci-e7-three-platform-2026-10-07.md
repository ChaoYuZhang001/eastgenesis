# e7 三平台 CI 终态证据 — 2026-10-07

源码快照 `e7d00dc29f3160b562042809520027989d732544` 的 [run 37555825538](https://github.com/ChaoYuZhang001/eastgenesis/actions/runs/37555825538) 已终态 **failure**。该快照绑定本机项目提交 `b781765b3ed346d6da1d91f193f5279aaeb4caff`；仅项目源码归档 13,793,280 字节，不包含桌面仓库旧历史或构建缓存。新修复及后续本机验证不属于这份 CI 结果。

| 平台 | Job | 终态 | 完成时间 UTC | 实际范围 |
|---|---:|---|---|---|
| macOS | 112581698088 | success | 01:24:06 | 普通/QA Rust、文件 MCP 补测、QA 打包、package/runner |
| Ubuntu | 112581697871 | success | 01:28:27 | 普通/QA Rust、文件 MCP 补测、四个原生 WebView 场景、真实 dpkg QA 升级/卸载 |
| Windows | 112581698276 | failure | 01:18:16 | 第17步普通 Rust 的 vendor `Builder::build` doctest 链接失败；未进入原生安装或启动 |

## 计数与覆盖

macOS/Ubuntu cold frontend 是 **980 passed + 11 skipped = 991**，102 文件中101 passed/1 skipped。Rust 后文件 MCP 步骤实际执行 **3文件/15 passed/0 skipped**，补齐早期11个缺二进制的 skip，同时重复4个早期 case。因此总人口实际执行为991个独立用例，不能把980+15写成995个不同用例。独立 crash-process 阶段又重复1个既有用例。

Windows cold frontend 是 **974 passed +17 skipped =991**，多出的6个是 POSIX process-cleanup 平台限制；后续 MCP 补测未运行。实际 Node 为 macOS 22.23.2、Ubuntu/Windows 22.23.3。SQLite experimental warning 不表示 SQLite 用例跳过。

Windows 普通 Rust desktop36、core80、stdio3+2、vendor4 unit 已通过，随后唯一 Builder doctest 失败；第二条 QA workspace 未执行。macOS 普通/QA desktop36/35、core各90、stdio各3+2、vendor4/10、Builder doctest各1通过。macOS CI 不支持原生 WebDriver，package/runner success不能替代图形交互。

## Windows 的本轮失败

原日志2406行定位 `Builder::build` doctest；2413行实际链接命令包含应用 build output 的 native 搜索目录；2415行 `msvcrt.lib` 被报告为 LNK4003 invalid library format，随后 `mainCRTStartup`、`memcpy` 等缺失，3277行链接以19个 unresolved externals结束。第一条 cargo命令 exit101。

本轮 **QA workspace、文件 MCP补测、QA打包、NSIS生命周期、typed SQL启动trace均为not_run**。不能将上一轮9ee的 `db_load_failed` 归因到本轮，也不能声称本轮已验证它修复。下一候选保留全部doc测试、按package隔离Windows文档编译图；其原因和本机窄验证见 [doctest隔离证据](windows-doctest-isolation-2026-10-07.md)，Windows成功仍待新CI。

## Linux 的本轮原生结果

四个原生WebView场景均通过。以下是实际IPC callback到达WebView的单次观察，body可能包含SSE元数据；它不是模型首token或首帧，transport done也不是任务完成。

| 场景 | Headers ms | 首body bytes ms | Transport terminal ms |
|---|---:|---:|---:|
| staged | 77 | 114 | 729 |
| slow-first-token | 71 | 369 | 983 |
| truncated | 70 | 71 | 85 |
| idle-cancel | 65 | 66 | 368 |

真实dpkg安装、QA 0.1.0→0.1.1升级和卸载通过10项检查：schema7、两个已安装进程身份、各4000ms存活窗口、合成会话保留与清理成立。两个deb大小为6,694,664/6,694,660字节。升级包是同源码版本号夹具；它不证明历史生产数据库或任务checkpoint升级。

## 来源绑定

冻结capture index为66文件/1,598,398字节，SHA256 `6ea1ec58df94b4ca390e8e90b4221d10df2703c7e4987e6c43a3a4d9e4cfe941`。Root独立重算全部文件大小/摘要，核对终态run和三个job的head，将4份固定JSON按原log行范围重新解析并比对相等。

仅下载Linux 6811字节诊断ZIP和Windows 5077字节、仅6个JSON的小报告ZIP；digest均与GitHub artifact metadata相等，成员与提取文件逐字节相等。完整桌面bundle只读取metadata。固定 [JSON](ci-e7-three-platform-2026-10-07.json) 保存rawlog摘要/行号、报告和逐平台覆盖审计。轮询间隔均超过60秒，终态后停止。

本证据不覆盖真实Provider、签名/公证、三平台性能基线、后续plan-only ledger修复或历史发行升级。产品继续保持Alpha /内部QA。

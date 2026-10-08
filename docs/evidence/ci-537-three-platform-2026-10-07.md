# 源码快照 537 的三平台终态证据

检查日期：2026-10-07（Asia/Shanghai）。源码快照：`537e93c362ab74ffd3b54dea78301755b42fb957`。GitHub Actions [run 37539711370](https://github.com/ChaoYuZhang001/eastgenesis/actions/runs/37539711370) 整体为 **failure**。固定 JSON、源日志 SHA256、各原始 JSON 的 SHA256/字节数及提取位置见 [机器可读报告](ci-537-three-platform-2026-10-07.json)。入库前已独立核对所有捕获 JSON 的摘要。

| 平台 | job | 终态 | 本轮证明的范围 |
| --- | --- | --- | --- |
| macOS | 112529432879 | success | 普通 Rust desktop 31/core 90、QA desktop 30/core 90；慢流夹具两种 feature 均通过；打包进程烟测与 runner 24/24 |
| Ubuntu | 112529433137 | success | 普通/QA Rust；四个真实 Tauri WebView 场景；deb 隔离解包 6/6、系统 dpkg 生命周期 10/10、runner 33/33 |
| Windows | 112529433275 | failure | 普通 desktop 31/core 80、QA desktop 30/core 80；隔离编译配置 probe、NSIS 安装、实装完整文件摘要和注册项检查通过；随后 `database_timeout` |

macOS 的 CI WebDriver 保持 `not_run`，原因是所用 tauri-driver 2.1.0 不支持 macOS；package smoke 的成功不能写成 DOM 交互已通过。Windows core 数量与 Unix 不同，不把未编译的 Unix 专属用例算作 Windows 通过。

Windows 已越过上一快照的 `payload_mismatch`。Tauri CLI 2.12.0 在构建 NSIS 时原位改变 bundle type 标记后恢复 loose source exe，因此原始 source SHA 与安装后 SHA 不相等是预期行为。当前门禁先按精确、唯一、等长标记转换计算整个预期 exe 的 SHA256，再比较整个实装文件；没有忽略其他字节。

- source SHA256：`5b1f4f5c43b555b00bbb01e5e76f2b5168f85b9b3a78ad91fdcf2ab47cc378e0`
- expected NSIS SHA256：`3240f2506c428c600a71754cb1eec4e31346accb03ca480b092cbdaaadf953fe`
- installed SHA256：`3240f2506c428c600a71754cb1eec4e31346accb03ca480b092cbdaaadf953fe`
- repaired SHA256：`null`，本轮未调度重装。

Windows 本轮固定报告的 10 个已完成检查为 true，包含失败后的 NSIS 卸载、exe 删除及注册项删除。**这不等于完整生命周期通过。** `launches=[]` 是完成启动周期的记录为空，不是启动调度次数为零；源码在 `Start-App 1` 的数据库等待阶段失败，当前报告尚未区分数据库不存在、schema 探针失败或窗口状态，不能据此确定根因，也不能把空数组解释为从未创建应用进程。第二轮启动、session sentinel、修复重装、WebView 场景和 Windows runner 汇总均未取得本轮成功证据。

Ubuntu 两个 deb 的版本为 QA `0.1.0` / `0.1.1`，大小分别 6,676,772 / 6,676,778 字节；这是同源码、修改 QA 版本的安装/升级/卸载验证。实际卸载、保留用户数据及最终清理均为 true。它不证明生产旧 schema 升级、自动更新或回滚。

Ubuntu 四个 WebView 场景的时间来自合成 loopback fixture。首个 task-store 正文增量为 staged 114ms、slow-first-token 365ms、truncated 73ms，idle-cancel 无已验证正文样本；终态文本观察为 768/1012/195/424ms。每个场景只有 n=1，p50/p95 均为 null，没有跨场景混算。这些数值不代表模型首 token、首帧、真实 Provider 或总体性能分布。当前新增 IPC observer 不在快照 537 中，其原生证据须由下一次 CI 单独取得。

仍未证明：真实双 Provider 与真实上游故障切换、Windows 完整 NSIS 生命周期、生产跨版本/schema 迁移、三平台性能基线、签名、公证、SmartScreen 信誉，以及普通用户机器上的安装/UAC 体验。产品阶段继续为 Alpha / 内部 QA。

# macOS 新目标正文 QA：真实界面验收尚未进入目标执行

日期：2026-10-07。产品阶段保持 Alpha / 内部 QA。

## 构建绑定

来源是不可变本机提交 `31dcc35279f0e0e06d843d3d04a172bf987708b8`，完整子树 `0669addbcdf48086a48c602e4cee1a08fc499dca`。QA 版本 0.1.0，macOS 本机 x64，启用 `qa-faults`。构建 2026-10-07 UTC 04:25:55 开始，Root 实际 session 2612 终态 exit 0。

721 个完整已提交源文件（排除非构建项目记忆文件）的路径、mode、Git blob 与 SHA-256 起止绑定。原始 App 与拥有的副本完整快照相同；原始 App 未执行。实际二进制为 12,217,352 bytes，SHA-256 `d2446cb197b8a8d4c3307da60cf6108691ffb8420cdecef270f138da52cba3b9`；构建清单 SHA `b75b7dc4a95df49ff8ca2fcac47b3b5085ccac2fb5bb5c2330cc9722fe020b2e`。构建和 Root 独立核对均通过，`formalReleaseBinding=false`。

此包含目标详情的生成正文、停止后 partial 与最终总结显示。此前本机 UI 7 项、相邻 22 项、全量 108 文件 1068 项和 typecheck/build 通过属于本机证明。下面三次真实 native 尝试尚不能证明目标执行、partial 保留、重启继续或已写文件不重放。

## 三次实际尝试

| 尝试 | 真实首失败 | 已观察到的进展 | 不能扩大为 |
|---|---|---|---|
| v4，session 92519，exit 2 | 启动动作未满足 owned App active；随后快照才 active | App/AX 启动、无 Provider GET/POST；清理通过 | 激活竞争已确认根因或目标任务通过 |
| v5，session 64520，exit 2 | 启动 4609 ms，active=false 且 scan incomplete；后续 323 ms 快照 active/complete | 无 Provider GET/POST；清理通过 | 单纯激活问题或扩大预算后成功 |
| v6，session 18087，exit 2 | `provider_qa-a_model_enabled` read，4590 ms，active=true、scan incomplete | 初始 startup 1365 ms，active/complete 实际通过；两个 Provider 实际 UI 新增/保存/回读，各 GET 1，POST 0 | 控件不存在、自动路由/failover、Goal 执行或恢复通过 |

v6 是使用实际 Tauri App、Swift PID 绑定 AX 与剪贴板粘贴的合成 loopback 验收。新 HOME/appdata 与 QA Keychain guard 启用；未预写 settings/SQLite、未注入 JavaScript、未继承 Provider 环境覆盖、未读取私有配置。两个配置都是明确的合成 Provider，不能称为两个真实供应商。

v6 首失败后的同一 PID 快照仍扫描不完整，只保存了 36 个带名称节点。能力矩阵含 22 个内置模型与 2 个自定义模型；当前 helper 每次扫描 450 ms，未完成后从根重建 BFS 队列，多个 AX 属性逐项获取。尾部控件可能因此一直未扫描到是待验证的 harness 性能假设；现有证据不能断言控件缺失，也不能将此失败归因于 App 激活。

下一 helper 候选拟批量读取 AX 属性并记录 visited/enqueued/limitReason，在新的源码/QA 绑定后验证。保持原 450 ms scan、4550 ms action、4096 元素上限与完整扫描、唯一匹配、PID/活动状态/可见性门禁；不得用 SQLite 读取或前缀匹配替代实际界面成功。观察超时不等于活进程终态，应核对同一 owned handle；这些三次报告都是已执行清理后的实际终态，不应重新观察已经消失的 PID。

## 清理与证据核对

三次 native 均没有提交 Goal。v6 A/B 的 plan/args/answer/summary/other POST 与 auth headers 全部为 0，GET 各 1；故障流尚未发出。拥有的 App 88010 与 AX helper 88006 两组均消失、无僵尸，fixture socket 0，剪贴板清空，隔离根目录在进程清理后安全删除。源码/完整 App、controller、Swift 与 helper binary 起止绑定不变。

v6 controller SHA `200a979ec7277c2bd2f208fad699977349ee1231cd18549aac4d4ec2de1ef435`，Swift SHA `d8e8059a88adb251cea141cf1a4024725609f58fd2b6fb6d2cd038018afd8260`。48 项 static checks 是结构与负例 CLI 证据，不能当成 native 业务通过。

Root 另将全部 721 个 immutable Git blobs 重算为 SHA-256，与构建起止及 v6 end hashes 对齐，并核对报告原件/冻结副本相等、helper/controller SHA、QA binary、启动实际动作和 Provider counts。此报告绑定 `31dcc`；后续 Windows 诊断及文档变更不属于它的完整子树验证。当前源树需新的 QA 绑定后才能再验收，不能借用这个包的通过范围。

## 固定来源

- [QA 构建清单](goal-output-ui-qa-build-2026-10-07.json)与[构建独立核对](goal-output-ui-qa-build-root-2026-10-07.json)。
- [v4 原始失败](macos-unified-goal-v4-failed-2026-10-07.json)，SHA `ba6e953caa8b360c70fd1053fe123bce758b631b6b4864e0b0562ecdbf05144a`。
- [v5 原始失败](macos-unified-goal-v5-failed-2026-10-07.json)，SHA `cd3dac897f7b805e9d63135a1bfd5575a79bf7686e7b4db0451f8cae3d9b1da3`。
- [v6 原始失败](macos-unified-goal-v6-failed-2026-10-07.json)，SHA `fa634fda3ed6054409af7d9c193885e6b88de3df69c0e28cb7b614a9dc0eeda2`。
- [v6 终态独立审阅](macos-unified-goal-v6-review-2026-10-07.json)，SHA `09cb04ced82f37faacc745bc10a05b60285bbeca554f44cf650d51eee654d148`。
- [Root 对 native 与后续 Windows 候选的独立核对](windows-job-native-v6-root-2026-10-07.json)。

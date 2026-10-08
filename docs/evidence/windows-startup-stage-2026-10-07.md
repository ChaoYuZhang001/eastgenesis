# QA 启动阶段诊断与本地验证

日期：2026-10-07。候选基于本地 `b97be50e917edca57ddb37bdaccdcf570f669eaa`，尚未由 Windows runner 执行。固定验证、源码与日志摘要见 [本地 JSON](windows-startup-stage-local-2026-10-07.json)。

源码快照 `3832994f35e0ca316f71c15ebee9e3922fa1e069` 的三平台 CI 中，macOS 和 Ubuntu 成功，Windows 在首次 NSIS 安装后出现 `database_timeout`。窗口与进程仍在，预期 SQLite 文件不存在，schema 探针尚未启动。该结果不能证明前端入口、SQL 动态导入或原生连接已经执行，也不能证明应用退出。见 [383 平台证据](ci-383-three-platform-2026-10-07.md)。本批增加阶段观察，不放宽原有启动门禁。

## 实现与边界

- Rust 记录器只编入 QA feature 或测试；运行时还要求显式诊断开关、强制安装隔离开关、严格小写 UUID 和精确的嵌入 `./eg-qa-appdata` 配置。普通发布没有该插件、命令或文件写入。
- 每轮在可执行文件旁创建全新 `eg-qa-startup-<runId>.jsonl`，不覆盖旧文件，不预建数据库目录。记录只含固定阶段、来源、序号及相对时间，不含 URL、文件路径、错误正文或 Provider 数据。
- 原生 setup、page、状态和 app info，以及 document start、前端入口、React render、bootstrap、SQL import/load/schema 分别记录。诊断 Promise 不加入启动依赖；app info 和数据库初始化保持并行。
- 原生事件限制为 64 条、32 KiB；读取器要求严格字段、UUID、来源和阶段、连续到达序号、非递减时间、前端调用序号唯一，拒绝重复 JSON 键、截断、非法 UTF-8、符号链接及读取期间文件替换。
- Windows helper 每轮创建不同 UUID，在原有 4 秒稳定观察和 30 秒 DB 判定结束后、进程清理前，以受控 Node 子进程读取当前 sidecar。读取失败保留 `unobserved`，不回显原文，不覆盖原启动失败阶段。旧报告没有可选 trace 时仍可读取；双周期 UUID 重放拒绝。

`reason=complete` 只说明当时的诊断快照结构有效，不表示应用已就绪。缺少前端 marker 可能涉及 IPC 未投递，不能直接断言 JavaScript 没执行。Windows `elapsedMs` 及进程/DB 布尔快照在诊断读取后采样，包含诊断成本，不能解释为启动性能或数据库截止瞬间。

## 当前验证

| 验证 | 结果 | 证明范围 |
|---|---|---|
| 前端最终全量 | 101 文件 / 981 条通过，2 workers，08:00:25 CST 开始，74.34 秒 | 确定性回归 |
| 读取器与 Windows helper | 2 文件 / 67 条通过 | 严格读取、静态集成及报告契约，未执行 Windows PS |
| 私有配置脱敏 smoke | 3 文件 / 55 条通过，仅合成凭据 | 配置与公开边界 |
| TypeScript | typecheck 通过 | 类型检查 |
| 普通 Rust workspace | desktop 36、core 90、stdio 3+2 通过 | 本机 macOS 原生与集成测试 |
| QA Rust workspace | desktop 35、core 90、stdio 3+2 通过 | QA guard 与记录器测试 |
| 隔离 macOS QA 构建 | 288 个源输入起止不变，binary `5f6cb5460920749e14973dd2c39ebaf9cc3a8b8334d6d6ac10322c5a302ae784` | 工作树 QA，正式发布绑定为 false |
| 实际 macOS 两项验收 | 开启诊断 / 缺少诊断开关各一次通过；两轮只读 schema 7；开启时 29 条记录，10 个必需 marker 全观察到 | macOS 实际进程中的观察链与 guard；详情见下文 |

构建清单见 [288 输入 manifest](macos-startup-trace-build-manifest-2026-10-07.json)。开启诊断与缺少开关的两轮均使用自有复制包、全新 HOME，无预建 appdata、无设置或密钥播种。两轮应用在清理入口仍活着；受控 SIGTERM 后进程组消失、zombie 为 0，profile 和复制包删除，剩余自有应用为 0。Root 独立重算全部 288 源输入及 binary、parser、harness，匹配起止和构建清单。

## 实际验收中的失败与修正

首轮两项样本失败，原始报告完整保留在 [失败 pilot](macos-startup-trace-native-failed-pilot-2026-10-07.json)，SHA-256 `289424eec28a102dbe0e4a15220669e1df6221b0a56f4ab083f40ffc01b8eae8`。当时开启诊断已收到 29 条真实阶段记录，但工具把 macOS 的相对数据目录错误解释为可执行文件旁，因此两个物理 DB 检查均为 `database_missing`。

本地钉定依赖 `tauri-2.12.0/src/path/desktop.rs:321-334` 明确：macOS `.app` 的 `app_binary_dir` 是 bundle 的父目录，Windows 是 binary 的父目录。只修正了新 macOS harness 的数据库路径与描述；sidecar 仍正确位于 `Contents/MacOS`。Rust、前端、parser 和已构建 binary 没有改变，没有预建 appdata。

随后限定一次、每项一次的两轮验收，于 00:09:07.354–00:09:12.188 UTC 通过，原始报告见 [修正后的实际验收](macos-startup-trace-native-2026-10-07.json)，SHA-256 `4c3c582bf8d7269a5e09d05a04cc1d90d49252b0ceba68f8965891896ecf040d`。报告的 `previousReportSha256` 绑定首轮失败报告；失败样本没有并入成功计数。缺少诊断开关时，观察窗口内 sidecar 为 0，同时独立确认 schema 7。

每项 n=1，仅作功能验证。尚未证明 AX/像素可交互、性能、Windows PS/NSIS 路径、真实 Provider、签名、公证或普通发布包。macOS 的 harness 路径修正不能用于解释 Windows 失败；Windows 根因继续待下一快照 CI 的真实阶段记录。

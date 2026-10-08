# M23 原生安装与升级验证

日期：2026-10-07。当前产品阶段仍为 Alpha / 内部 QA。

## 2026-10-07 最新执行状态


最终本机源绑定闸门：103文件/1017前端测试零跳过通过，549项生产/测试/工具/资源/工作流输入及真实MCP binary起止SHA相同、Root重算一致；typecheck与合成配置/脱敏3文件55项通过。新增两App输入门禁19项、实际旧322负向拒绝/新675正向校验均通过；真实native恢复与Windows路径plugin证明范围分别独立绑定。见 [最终本机闸门](evidence/historical-path-local-gates-2026-10-07.json)及 [起止清单](evidence/historical-path-bound-tests-2026-10-07.json)。这不把a035的历史native恢复挪给后续Windows路径补丁，也不将待运行的新CI写成通过。


Windows连接配置的路径候选修复已本机验证：应用目录URL转义保留原caller query/native join和3个数据库操作，真正SQLx parser及真实SQLite create/reopen保持同schema/文件身份；最终普通plugin10unit+1doc、QA16unit+1doc均通过，Cargo锁未变。原CI路径未直接观测，具体verbatim机制仍是高置信推断；修复后的Windows NSIS/重装待新CI，见 [路径修复证据](evidence/sqlite-opaque-path-local-2026-10-07.md)。


当前新增历史QA恢复实测已通过：旧Git writer `4a88d966` → a035 reader的真实SIGABRT/同task hydrate/活动lease停止/实际到期probe applied/零重放完成，32断言、7动作与清理通过；writer288输入+525完整Git文件、reader675输入+676完整Git文件起止绑定，Root独立复核。见 [历史QA原生恢复证据](evidence/macos-historical-goal-native-2026-10-07.md)。这不是已发布版本安装升级或schema6迁移；下面旧条目的“尚未执行”按其当时来源保留。

最新已结束的 [b6 run 37559890652](https://github.com/ChaoYuZhang001/eastgenesis/actions/runs/37559890652) 绑定源码快照 `b6a4923b46656cd54cf858862f8fb27bdc19551d` 与本机提交 `a035aa93659a6b834a85aa166677fd663913b9b5`，终态 **failure**。macOS/Ubuntu success；Windows普通/QA targets及全部独立doc、MCP15项和两次QA打包通过，已越过e7链接失败，但NSIS首次启动在 `sql_connect_configuration_failed` 停止，数据库不存在且未进入迁移。安装/payload/registry及失败后卸载清理通过，重装和Windows WebDriver未执行。Mac/Ubuntu独立前端用例998、Windows992且另6个平台skip；5份原日志JSON、69份捕获文件与小诊断ZIP经Root独立复核。见 [b6固定终态证据](evidence/ci-b6-three-platform-2026-10-07.md)。

上一轮终态 [e7 run 37555825538](https://github.com/ChaoYuZhang001/eastgenesis/actions/runs/37555825538) 为 **failure**，源码快照 `e7d00dc29f3160b562042809520027989d732544` 绑定本机发布提交 `b781765b3ed346d6da1d91f193f5279aaeb4caff`。macOS/Ubuntu success；Windows普通Rust vendor `Builder::build` doctest链接失败，QA workspace、后置文件MCP、QA打包、NSIS安装及typed SQL启动trace均 `not_run`。本轮并未进入安装或原生启动，不能覆盖旧9ee首次NSIS启动的 `Database.load` reject。来源见 [e7固定终态证据](evidence/ci-e7-three-platform-2026-10-07.md)。

下一候选Windows workflow使用普通/QA workspace `--all-targets`，再分别执行core、desktop与plugin的普通/QA `--doc`，保留所有测试；QA plugin明确启用 `sqlite,qa-load-observer`。macOS插件独立普通/QA doc各1条通过，b6已验证Windows doc修正；typed SQL观察到配置错误，完整NSIS生命周期待路径修复后的新CI，见 [doctest隔离证据](evidence/windows-doctest-isolation-2026-10-07.md)。

当前两项运行时恢复修复已红绿复现并完成本机102文件/998条、窄78、合成配置/脱敏55及typecheck零跳过验证；两Node进程/SQLite受控案例证明stale plan-only checkpoint命中durable ledger和账本读取异常时不重放，见 [本地恢复分析](evidence/durable-ledger-recovery-local-2026-10-07.md) 与 [固定JSON](evidence/durable-ledger-recovery-local-2026-10-07.json)。

包含两项修复的最终macOS `26.7.1/x64`、QA `0.1.0` binary `45c7986bd8ab5b201ebcdd4cfa049822dccaa723be0649293f8d5f9277aa5fce`（12,213,256 bytes），于UTC 01:49:08.723–01:53:00.097构建成功，UTC 01:53:14.205–01:56:16.445通过三个既有真实Tauri/WebView/MCP崩溃恢复场景及自有进程/profile清理。322输入、binary、冻结harness和helper在实际原生前后摘要相同，Root另Python独立核对。见 [新包原生分析](evidence/macos-ledger-safe-native-2026-10-07.md)、[原始JSON](evidence/macos-ledger-safe-native-2026-10-07.json)、[构建清单](evidence/macos-ledger-safe-build-manifest-2026-10-07.json)、[Root核对](evidence/macos-ledger-safe-root-verification-2026-10-07.json)。这证明新包正常恢复路径未回归，不证明native中stale checkpoint或读取错误复现，也不证明历史升级或正式发布；`formalReleaseBinding=false`。仅含第一项修复的旧binary `b691ca8fd9f85` 及 [原生记录](evidence/macos-plan-only-ledger-native-2026-10-07.md) 独立保留。

[历史checkpoint来源审计](evidence/historical-checkpoint-source-audit-2026-10-07.md) 未找到独立schema6旧App终态。当前6→7是迁移前缀合成库经真实plugin执行，dpkg QA0.1.0→0.1.1是同源码版本夹具。实际旧native writer→新reader、native中读故障或stale checkpoint、真实双Provider、三平台性能和签名/公证仍未证明；不得用安装登记、哨兵字节保留或本机恢复回归替代它们。

## 证据边界

`desktop:bundle:smoke` 只证明安装包存在；`desktop:install:smoke` 的 `deb-extract` 只证明隔离解包后的二进制启动。它们不证明系统安装、升级、卸载或生产分发。

新增两条真实安装执行链，必须在一次性 GitHub hosted 原生 runner 上运行。普通主机、self-hosted runner、既存同名安装或缺少前置条件时失败关闭。脚本实现与本地契约测试通过，不等于原生安装通过；状态只在相应 runner 报告生成并通过上传前校验后改变。

| 验证链 | 实际执行 | 当前状态 | 不覆盖 |
|---|---|---|---|
| Linux `desktop:linux:upgrade:smoke` | dpkg 安装基线 → 已安装进程身份持续存活 4 秒 → SQLite/session 哨兵 → dpkg 安装递增版本 → 同一数据目录哨兵保留 → purge → 包登记与 executable/desktop entry 消失 | 最新 e7 run `37555825538` / Ubuntu job `112581697871` success，10 项生命周期与清理确认；同源码 QA 两包为6,694,664/6,694,660字节 | 跨 schema 迁移、自动更新/回滚、其他发行版、AppImage/RPM、桌面菜单点击 |
| Windows `desktop:windows:install:smoke` | NSIS 安装 → 实装 exe 与当前构建一致 → 隔离 QA 数据目录 → schema/session 哨兵 → 删除已停止的 exe → 同一 NSIS 修复重装 → 哨兵保留 → 真实卸载 → exe 与卸载注册信息消失 | 最新 e7 run `37555825538` / Windows job `112581698276` 普通Rust doctest链接失败，NSIS及typed SQL均not_run；最近已执行的9ee run `37550937897` / job `112565982111` 完整payload一致，但首次启动database_timeout，27条trace至Database.load reject/schema query前；根因未确认，重装未执行，失败后清理通过，完整生命周期未通过 | 跨版本升级、生产默认 Known Folder 迁移、MSI/per-machine、普通用户 UAC、签名/SmartScreen |

## Linux 的两个 QA 版本

最新 e7 三平台终态及绑定见 [CI 证据](evidence/ci-e7-three-platform-2026-10-07.md)。旧9ee及下方c70等记录保留各自历史源码边界，不代表当前候选通过；9ee的Windows原生启动失败仍未解决。后续本机 [合成 schema6→7 实际 macOS QA](evidence/macos-schema-upgrade-native-2026-10-07.md) 验证八表旧字段与两轮 SQLx 元数据保留；它不证明历史生产发行版升级、checkpoint hydration、恢复执行或 Windows 修复。

历史 c70 Ubuntu job 于 2026-10-07 05:54:13 CST 完成。两版 deb 为 6,675,670 / 6,675,662 字节，版本仍为同源码 `0.1.0` → QA `0.1.1`。10 项生命周期检查、四个 WebView 场景、上传前 runner 33 项再次通过，`cleanupVerified=true`；源报告的字节数、SHA256、日志行号/小型诊断 artifact 与 run/head/job 绑定均保留在 [c70 Linux 证据](evidence/linux-dpkg-lifecycle-c70-2026-10-07.json)。不同场景单次耗时不构成性能分布。

workflow 读取当前 `tauri.conf.json` 的数字版本并构建 patch 加一的 QA fixture。例如当前 `0.1.0` → `0.1.1`。两者使用同一提交和 schema 7，这验证的是版本登记、包替换和数据保留，不是新的产品版本或数据库迁移。配置只通过 Tauri CLI 合并，不修改生产 manifest；升级 fixture 移到独立位置，不进入普通 bundle artifact。

2026-10-07 04:14 CST，Ubuntu job `112472602358` 实际通过上述链，两个 `.deb` 分别为 6,697,880 和 6,697,886 字节。报告 `systemInstallAttempted`、`systemPackageDatabaseChanged`、`cleanupVerified` 均为 true；两轮实际 `/proc` 身份与连续 4000ms 存活通过，SQLite schema 7 与合成 session 在升级/purge 后保留。上传前 runner evidence 33 项通过，job 终态 success。原始 JSON 从完成的 job log 提取并绑定源快照，见 [Linux dpkg 证据](evidence/linux-dpkg-lifecycle-2026-10-07.json)；不沿用旧 `deb-extract` 报告支持这个新结论。

较早 ccbb run 的 Windows job 在前端预算子进程测试失败，NSIS 生命周期步骤未执行。历史 e260 run 的 Ubuntu job 已在 2026-10-07 04:47 CST 终态 success，并再次通过同一链；0.1.0/QA 0.1.1 两包均为 6,707,734 字节，10 项生命周期检查及 runner evidence 33 项通过。见 [新 Linux dpkg 证据](evidence/linux-dpkg-lifecycle-connection-2026-10-07.json) 与 [上传前汇总](evidence/linux-runner-connection-2026-10-07.json)。该 run 的 Windows 已通过 frontend 和普通 Rust；隔离 NSIS 构建成功，但 job 在安装前 `qa_isolation_missing` 失败，未 dispatch installer，launches 为空。见 [Windows 安装前失败证据](evidence/windows-nsis-before-isolation-fix-2026-10-07.json)。原报告 `systemPackageDatabaseChanged=true` 是脚本固定字段，不能据此声称发生了安装。

进程验证同时检查目标进程组中 `/proc/<pid>/exe` 的身份、连续 4 秒的存活窗口和数据库结构。读取旧版留下的数据库不能独自证明新版启动。固定存活窗口不作为冷启动或 WebView 首屏指标。

卸载使用同一登记状态/payload 消失断言验证成功路径与失败清理。只有该断言成功后释放测试对包的清理责任。用户数据位于临时 HOME/XDG 目录，先验证 purge 保留合成 session，再删除临时测试 profile。

## Windows 的 QA 数据隔离

历史 c70 Windows job 于 2026-10-07 05:59:28 CST 完成，固定结论为 failure。`sourceBinaryIsolationProbe=true` 证明实际 PE/CLI/stdout 隔离 gate 已通过；`nsisInstall=true` 证明已调度安装。安装后 binary 摘要 gate 报 `payload_mismatch`，`launches=[]`，reinstall 未调度。失败路径实际卸载，且 installed binary 与卸载注册项消失。报告只记录八个已经完成的检查，八项为 true 不能替代后续未执行的启动、session 和修复检查。见 [c70 Windows 固定失败证据](evidence/windows-nsis-payload-mismatch-c70-2026-10-07.json)；该证据记录时具体摘要差异的根因仍待验证，不放松 payload 一致性断言。

仅重写 `APPDATA`/`LOCALAPPDATA` 无法保证 Tauri 使用的 Windows Known Folder 被重定向。专用 `tauri.windows.install.qa.conf.json` 使用 `app.appDirectoriesOverride=./eg-qa-appdata`，把测试 SQLite/WebView 数据置于临时安装目录。脚本检查实际位置和重解析点，不修改 Known Folder 注册表或生产配置。

Windows 安装验证在首次 WebDriver 场景之前执行，拒绝既存默认 profile；结束后重新构建原 WebDriver QA 配置，再执行四场景。因此无需删除前一组场景产生的数据来绕过预检。

隔离 HOME 与应用数据目录不能隔离系统钥匙串。所有原生 QA 启动设置 `EASTGENESIS_QA_ISOLATED_PROFILE=1`；仅 `qa-faults` 构建识别该开关，禁止系统钥匙串读取、写入和删除。正式恢复报告必须来自启用了该隔离开关的新构建；较早的调试轮不能据此声称已证明完全没有真实 Provider 请求。

Windows 子进程使用 `CREATE_SUSPENDED` 创建，成功加入不允许 breakaway 的 Job Object 后才执行主线程；每轮实际进程持续存活至少 4 秒后再检查数据库。报告区分正常关闭与强制结束，并要求整个 Job 活动进程归零。该 4 秒窗口同样不作为首屏性能指标。

## 必需报告

- Linux：`upgrade-quality.json`，`kind=desktop-linux-upgrade-smoke`，`mode=dpkg-system`。
- Windows：`windows-install-quality.json`，`kind=desktop-windows-install-smoke`，`mode=nsis-install-reinstall-uninstall`。
- 两份报告均进入 `desktop:runner:evidence`；缺文件、缺安装/退出/卸载检查、版本关系不符、失败或泄漏边界不符时阻断 job。
- 报告不含凭据、正文、完整路径、用户名、完整网络地址或原生异常文本。普通回归只使用合成配置，不读取私有 Provider 数据。
- WebDriver 聚合报告 `webdriver-quality.json` 同时显式进入诊断和桌面 bundle artifact，使下载后的必需证据集合与上传前校验输入一致。
- 前端测试以 2 个 worker、最小 1 个 worker 执行；Rust workspace 两种特性配置使用失败即停止的 shell。该资源限制不修改测试场景或断言。

这些执行链仍不证明真实 Provider、macOS 签名/公证、跨平台自动更新或生产任务完成质量。

## 安装前隔离修复与验证边界

PE 字符串启发式门禁在 e260 上失败的原因尚未确认。现在 marker 仅证明二进制支持专用 probe；probe 必须在 Tauri Builder、存储、系统钥匙串之前读取同一 Context 工厂的实际编译配置，QA feature 和精确 `./eg-qa-appdata` 全部通过后才能 dispatch installer。源二进制在 probe 后再次摘要校验；实装启动携带强制隔离开关。没有 marker 的旧二进制拒绝执行未知 probe 参数。

报告按实际阶段记录三次操作尝试；安装前失败的注册状态改变为 false，已有 dispatch 但缺可靠 helper/注册证据为 null，输出写失败保留已观察操作。14 条 helper、13 条 runner consumer、两种 Rust feature 的 probe 各 4 条通过。本机 macOS QA binary 的真实负向 probe 退出 1 并保持自有 HOME 无文件创建；这份 macOS 证据不替代 Windows。后续 c70 runner 独立证明了 Windows GUI subsystem pipe 的正向 probe，以及一次实际 NSIS 安装/失败清理；后续9ee已确认payload一致性，但实装首次启动失败、修复重装仍未通过；最新e7未执行这些阶段。

## NSIS payload 摘要的后续修复（待新 runner）

Tauri CLI `2.12.0` bundler 会保存原 exe，将首个 `__TAURI_BUNDLE_TYPE_VAR_UNK` 原位替换为同长度的 `__TAURI_BUNDLE_TYPE_VAR_NSS`，让 makensis 打包，再恢复构建目录中的原 exe。因此旧 helper 将实装 exe 与恢复后的 source 直接按 SHA 比较，选错了预期文件。该机制见 [已钉定版本 bundler 源码](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.12.0/crates/tauri-bundler/src/bundle.rs#L90-L96) 及后续 [c70 payload 分析](evidence/windows-nsis-payload-c70-analysis-2026-10-07.json)。c70 没保存当时 source 摘要/文件，不能声称已逐字节证明历史差异仅为标记修改。

新候选要求实际安装的 CLI 版本恰为 `2.12.0`，source 中 UNK 必须唯一，再按这项固定转换生成完整预期 NSIS SHA。Node 与 PowerShell 各自从 source 计算并核对绑定；source 的实际 probe 仍绑定原完整 SHA，首次安装和修复安装均严格绑定转换后的完整 SHA，不修改或忽略实装文件的任何字节。报告仅增加固定策略、版本与四个摘要；版本变更、缺/重复标记、篡改字节或任意未知元数据全部失败关闭。该实现与本地契约回归不能替代下一次 Windows 原生完整生命周期结果。
